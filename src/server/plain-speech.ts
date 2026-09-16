/**
 * Plain-speech rewrite (opt-in, whitelist-only).
 *
 * For a turn whose requested model is listed in `config.plainSpeech.models`, the final
 * assistant prose is rewritten by a cheap model so it explains jargon and reads simply.
 * Only the final answer of a NON-tool turn is rewritten; tool-call turns and every
 * non-whitelisted model are passed through unchanged. This module NEVER throws: on any
 * routing/network/timeout/empty-result failure it returns the original text verbatim, so a
 * rewrite failure can never turn a good answer into an error.
 *
 * The rewriter is invoked the same way the web-search sidecar calls its model: resolve the
 * configured model through this proxy's router, then POST directly to the resolved upstream
 * (no loopback HTTP, so no data-plane token dance). The rewriter runs non-streaming and its
 * body is bounded.
 */
import { FORWARD_HEADERS } from "../adapters/openai-responses";
import { signalWithTimeout, cancelBodyOnAbort } from "../lib/abort";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { routeModel } from "../router";
import type { OcxConfig } from "../types";
import { modelInList } from "../types";

type Rec = Record<string, unknown>;

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_REWRITE_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_REASONING_EFFORT = "low";

const DEFAULT_PROMPT =
  "你是一个「说人话」改写器。把下面这段助手的最终回复改写得通俗、流畅、易懂：\n" +
  "- 用简单直白的语言，解释其中出现的专业术语和缩写（首次出现时补一句白话解释）。\n" +
  "- 去掉行业黑话、套话、空话，让每句话都有具体信息。\n" +
  "- 保持原意、事实、数字、结论完全不变，不要新增或删减信息，不要发表评论。\n" +
  "- 原样保留代码块、命令、文件路径、URL、标识符（```、`inline code`、路径等），一个字符都不要改。\n" +
  "- 保留原有的 Markdown 结构（标题、列表、表格、代码围栏）。\n" +
  "- 直接输出改写后的正文，不要加任何前言、说明或“改写如下”之类的话。";

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Whether plain-speech rewrite applies to this requested model. */
export function plainSpeechAppliesTo(config: OcxConfig, requestedModel: string): boolean {
  const cfg = config.plainSpeech;
  if (!cfg || cfg.enabled !== true) return false;
  if (!cfg.rewriterModel || typeof cfg.rewriterModel !== "string") return false;
  return modelInList(cfg.models, requestedModel);
}

/**
 * Rewrite the assistant prose of a Chat Completion object in place, when it is a final
 * non-tool answer. Tool-call turns (finish_reason `tool_calls`, or a message carrying
 * `tool_calls`) are left untouched — only the last prose answer of a turn is rewritten.
 * Never throws.
 */
export async function applyPlainSpeechToChatCompletion(
  config: OcxConfig,
  completion: Rec,
  abortSignal?: AbortSignal,
): Promise<void> {
  const choices = Array.isArray(completion.choices) ? completion.choices : [];
  const choice = isRec(choices[0]) ? choices[0] : null;
  if (!choice) return;
  const finish = typeof choice.finish_reason === "string" ? choice.finish_reason : "";
  if (finish === "tool_calls") return;
  const message = isRec(choice.message) ? choice.message : null;
  if (!message) return;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return;
  const content = typeof message.content === "string" ? message.content : "";
  if (content.trim().length === 0) return;
  message.content = await rewriteToPlainSpeech(config, content, abortSignal);
}

/** Extract concatenated `output_text` from a /responses JSON body. */
function outputTextFromResponses(json: unknown): string {
  if (!isRec(json)) return "";
  const output = Array.isArray(json.output) ? json.output : [];
  let text = "";
  for (const raw of output) {
    if (!isRec(raw) || raw.type !== "message" || !Array.isArray(raw.content)) continue;
    for (const part of raw.content) {
      if (isRec(part) && part.type === "output_text" && typeof part.text === "string") {
        text += part.text;
      }
    }
  }
  return text;
}

/** Extract assistant content from a Chat Completions JSON body (fallback for chat upstreams). */
function contentFromChatCompletion(json: unknown): string {
  if (!isRec(json)) return "";
  const choices = Array.isArray(json.choices) ? json.choices : [];
  const choice = isRec(choices[0]) ? choices[0] : null;
  const message = choice && isRec(choice.message) ? choice.message : null;
  return message && typeof message.content === "string" ? message.content : "";
}

/**
 * Rewrite `text` into plain speech. Returns the rewritten string, or the original `text`
 * unchanged on any failure (never throws, never returns empty when given non-empty input).
 */
export async function rewriteToPlainSpeech(
  config: OcxConfig,
  text: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const cfg = config.plainSpeech;
  if (!cfg || cfg.enabled !== true || !cfg.rewriterModel) return text;
  if (typeof text !== "string" || text.trim().length === 0) return text;

  let route;
  try {
    route = routeModel(config, cfg.rewriterModel);
  } catch {
    return text;
  }
  const provider = route.provider;
  const isResponses = provider.adapter === "openai-responses";
  const isChat = provider.adapter === "openai-chat";
  // Only the two OpenAI-compatible upstreams are supported for the rewriter. Anything
  // else (anthropic/google/cursor/kiro) falls back to the original text rather than
  // risk a malformed request; pick a chat/responses model as the rewriter.
  if (!isResponses && !isChat) return text;
  if (!provider.baseUrl) return text;

  const instruction = typeof cfg.prompt === "string" && cfg.prompt.trim().length > 0
    ? cfg.prompt
    : DEFAULT_PROMPT;
  const effort = cfg.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
  const timeoutMs = typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (provider.headers) Object.assign(headers, provider.headers);
  if (provider.apiKey) headers["Authorization"] = `Bearer ${provider.apiKey}`;
  // Preserve any forwarded auth headers the caller may have set on the provider.
  void FORWARD_HEADERS;

  let url: string;
  let body: Rec;
  if (isResponses) {
    url = `${provider.baseUrl}/responses`;
    body = {
      model: route.modelId,
      instructions: instruction,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }],
      reasoning: { effort },
      store: false,
      stream: false,
    };
  } else {
    url = `${provider.baseUrl}/chat/completions`;
    body = {
      model: route.modelId,
      messages: [
        { role: "system", content: instruction },
        { role: "user", content: text },
      ],
      reasoning_effort: effort,
      stream: false,
    };
  }

  const linkedSignal = signalWithTimeout(timeoutMs, abortSignal);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: linkedSignal.signal,
      redirect: "manual",
    });
    const detachBodyGuard = cancelBodyOnAbort(res.body, linkedSignal.signal);
    try {
      if (!res.ok) return text;
      const bounded = await readBoundedResponseBody(res, {
        signal: linkedSignal.signal,
        maxBytes: MAX_REWRITE_RESPONSE_BYTES,
      });
      if (bounded.oversized || !bounded.displaySafe) return text;
      let parsed: unknown;
      try {
        parsed = JSON.parse(bounded.text);
      } catch {
        return text;
      }
      const rewritten = isResponses ? outputTextFromResponses(parsed) : contentFromChatCompletion(parsed);
      return rewritten.trim().length > 0 ? rewritten : text;
    } finally {
      detachBodyGuard();
    }
  } catch {
    return text;
  } finally {
    linkedSignal.cleanup();
  }
}
