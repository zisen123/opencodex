import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { anthropicToResponsesTranslation } from "../src/claude/inbound";
import { parseRequest } from "../src/responses/parser";
import { uuidFromHex } from "../src/lib/session-id";
import { createTestTranslatorBudget } from "./helpers/translator-budget";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

const baseProvider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://www.sophnet.com/api/open-apis/v1",
  apiKey: "sk-test",
  authMode: "key",
};

/** A Responses-shaped parsed request as the CC replay would hand the adapter. */
function parsedWithCacheKey(key: string, claudeSession = true): OcxParsedRequest {
  const parsed: OcxParsedRequest = {
    modelId: "GLM-5.3",
    context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    stream: true,
    options: { promptCacheKey: key },
    ...(claudeSession ? { _claudeSessionPromptCacheKey: true } : {}),
  };
  return parsed;
}

function bodyFor(
  provider: OcxProviderConfig,
  parsed: OcxParsedRequest,
  incomingHeaders: Record<string, string> = {},
) {
  const adapter = createOpenAIChatAdapter(provider);
  const request = adapter.buildRequest(parsed, {
    headers: new Headers(incomingHeaders),
    translatorBudget: createTestTranslatorBudget(),
  });
  return { request, body: JSON.parse(request.body) as Record<string, unknown> };
}

/** Derive the per-session key exactly as the inbound translator does. */
function sessionKeyFor(userId: string): string {
  const { body } = anthropicToResponsesTranslation({
    model: "GLM-5.3",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
    metadata: { user_id: userId },
  });
  return body.prompt_cache_key as string;
}

describe("claude -> openai-chat prompt-cache continuity", () => {
  test("claude surface forwards prompt_cache_key to the chat body WITHOUT provider opt-in", () => {
    const key = sessionKeyFor("user-abc");
    const { body } = bodyFor(baseProvider, parsedWithCacheKey(key));
    expect(body.prompt_cache_key).toBe(key);
  });

  test("same user_id yields a stable key across turns and identical upsteam key", () => {
    const turnA = sessionKeyFor("user-abc");
    const turnB = sessionKeyFor("user-abc");
    expect(turnA).toBe(turnB);
    expect(turnA).toMatch(/^[0-9a-f]{32}$/);

    const { body } = bodyFor(baseProvider, parsedWithCacheKey(turnA));
    expect(body.prompt_cache_key).toBe(turnB);
  });

  test("different user_id yields a different key (cache rebuild from scratch)", () => {
    expect(sessionKeyFor("user-abc")).not.toBe(sessionKeyFor("user-xyz"));
  });

  test("openai-chat mirrors the synthesized session_id header upstream (uuid-shaped)", () => {
    const key = sessionKeyFor("user-abc");
    const { request } = bodyFor(baseProvider, parsedWithCacheKey(key), {
      session_id: uuidFromHex(key),
    });
    expect(request.headers["session_id"]).toBe(uuidFromHex(key));
    expect(request.headers["session_id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("non-claude surface does NOT inject prompt_cache_key (opt-in gate intact)", () => {
    const key = "a".repeat(32);
    const { body } = bodyFor(baseProvider, parsedWithCacheKey(key, false));
    expect(body.prompt_cache_key).toBeUndefined();
  });

  test("provider explicit promptCacheKey opt-in wins for non-claude callers", () => {
    const key = "b".repeat(32);
    const { body } = bodyFor(
      { ...baseProvider, promptCacheKey: true },
      parsedWithCacheKey(key, false),
    );
    expect(body.prompt_cache_key).toBe(key);
  });

  test("shared system/tools cohort key (claude flag absent) does NOT bypass the opt-in gate", () => {
    const key = "c".repeat(32);
    const { body } = bodyFor(baseProvider, parsedWithCacheKey(key, false));
    expect(body.prompt_cache_key).toBeUndefined();
    // And even a claude-flagged empty key is refused.
    const { body: emptyBody } = bodyFor(baseProvider, {
      ...parsedWithCacheKey(""),
      options: { promptCacheKey: "" },
    });
    expect(emptyBody.prompt_cache_key).toBeUndefined();
  });

  test("the claude provenance flag never leaks into the serialized chat body", () => {
    const key = sessionKeyFor("user-abc");
    const { body } = bodyFor(baseProvider, parsedWithCacheKey(key));
    for (const k of Object.keys(body)) {
      expect(k.toLowerCase()).not.toContain("claudesession");
      expect(k.toLowerCase()).not.toContain("_claude");
    }
  });

  test("replay integration: translated Anthropic body parses and the parsed key is forwarded", () => {
    const translation = anthropicToResponsesTranslation({
      model: "GLM-5.3",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      metadata: { user_id: "user-abc" },
    });
    // Mimic the replay's parser → adapter handoff (chat route).
    const parsed = parseRequest(translation.body);
    expect(parsed.options.promptCacheKey).toBe(translation.body.prompt_cache_key);
    parsed._claudeSessionPromptCacheKey = true;
    const { body } = bodyFor(baseProvider, parsed);
    expect(body.prompt_cache_key).toBe(translation.body.prompt_cache_key);
  });
});