import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter as createOpenAIChatAdapterProduction } from "../src/adapters/openai-chat";
import { modelInList } from "../src/types";
import type { OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createOpenAIChatAdapter = (...args: Parameters<typeof createOpenAIChatAdapterProduction>) =>
  withTestTranslatorBudget(createOpenAIChatAdapterProduction(...args));

/**
 * modelUpstreamNonStream (types.ts): gateways whose STREAMING usage drops
 * prompt_tokens_details.cached_tokens (sophnet gpt-5.5 since 2026-09-02) get a
 * bounded JSON upstream. The force lives in the ROUTE layers
 * (responses/core normalization, chat-completions fallback, chat-native
 * passthrough); the adapter itself just obeys parsed.stream, so these tests
 * pin the two contract halves: the list semantics and the adapter's
 * stream:false wire shape.
 */
const provider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://example.test/v1",
  apiKey: "key",
  modelUpstreamNonStream: ["gpt-5.5"],
};

describe("modelUpstreamNonStream (bounded JSON upstream policy)", () => {
  test("modelInList semantics: exact match, no match for others or undefined", () => {
    expect(modelInList(provider.modelUpstreamNonStream, "gpt-5.5")).toBe(true);
    expect(modelInList(provider.modelUpstreamNonStream, "GLM-5.3")).toBe(false);
    expect(modelInList(provider.modelUpstreamNonStream, "gpt-5.5-x")).toBe(false);
    expect(modelInList(undefined, "gpt-5.5")).toBe(false);
  });

  const mkParsed = (modelId: string, stream: boolean) => ({
    modelId,
    stream,
    context: { messages: [{ role: "user", content: "hi" }], tools: [] },
    options: { toolChoice: undefined },
  });

  test("adapter obeys parsed.stream=false: wire body carries stream:false and no stream_options", async () => {
    const adapter = createOpenAIChatAdapter(provider);
    const request = await adapter.buildRequest(mkParsed("gpt-5.5", false) as Parameters<typeof adapter.buildRequest>[0]);
    const body = JSON.parse(request.body as string);
    expect(body.stream).toBe(false);
    expect(body.stream_options).toBeUndefined();
  });

  test("adapter keeps streaming default for models NOT in the list", async () => {
    const adapter = createOpenAIChatAdapter(provider);
    const request = await adapter.buildRequest(mkParsed("GLM-5.3", true) as Parameters<typeof adapter.buildRequest>[0]);
    const body = JSON.parse(request.body as string);
    expect(body.stream).toBe(true);
    // include_usage rides along on the streaming path as usual
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  test("non-streaming response with prompt_tokens_details maps cachedInputTokens (the point of the policy)", async () => {
    const adapter = createOpenAIChatAdapter(provider);
    const events = await adapter.parseResponse?.(new Response(JSON.stringify({
      choices: [{ message: { content: "ok" } }],
      usage: {
        prompt_tokens: 15323,
        completion_tokens: 24,
        prompt_tokens_details: { cached_tokens: 14848 },
      },
    })));
    expect(events).toEqual([
      { type: "text_delta", text: "ok" },
      { type: "done", usage: { inputTokens: 15323, outputTokens: 24, cachedInputTokens: 14848 } },
    ]);
  });
});
