import { afterEach, describe, expect, test } from "bun:test";
import {
  applyPlainSpeechToChatCompletion,
  plainSpeechAppliesTo,
  rewriteToPlainSpeech,
} from "../src/server/plain-speech";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Minimal config with a whitelisted primary model and a registered rewriter model. */
function makeConfig(overrides?: Partial<NonNullable<OcxConfig["plainSpeech"]>>): OcxConfig {
  return {
    providers: {
      sophnet: {
        adapter: "openai-chat",
        baseUrl: "https://upstream.test/v1",
        apiKey: "sk-test",
      },
      "sophnet-responses": {
        adapter: "openai-responses",
        baseUrl: "https://upstream.test/v1",
        apiKey: "sk-test",
      },
    },
    defaultProvider: "sophnet",
    customModels: [
      { provider: "sophnet", modelId: "gpt-5.4", publicAlias: "gpt-5.4" },
      {
        provider: "sophnet-responses",
        modelId: "DeepSeek-V4-Flash-Vision-Exp",
        publicAlias: "DeepSeek-V4-Flash-Vision-Exp",
      },
    ],
    plainSpeech: {
      enabled: true,
      models: ["gpt-5.4"],
      rewriterModel: "DeepSeek-V4-Flash-Vision-Exp",
      ...overrides,
    },
  } as unknown as OcxConfig;
}

function responsesJson(text: string): Response {
  return new Response(
    JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text }] }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("plainSpeechAppliesTo", () => {
  test("true only for whitelisted model when enabled", () => {
    const config = makeConfig();
    expect(plainSpeechAppliesTo(config, "gpt-5.4")).toBe(true);
    expect(plainSpeechAppliesTo(config, "DeepSeek-V4-Flash-Vision-Exp")).toBe(false);
    expect(plainSpeechAppliesTo(config, "qwen3.8-flash")).toBe(false);
  });

  test("false when disabled or unconfigured", () => {
    expect(plainSpeechAppliesTo(makeConfig({ enabled: false }), "gpt-5.4")).toBe(false);
    expect(plainSpeechAppliesTo(makeConfig({ models: [] }), "gpt-5.4")).toBe(false);
    expect(plainSpeechAppliesTo(makeConfig({ rewriterModel: undefined }), "gpt-5.4")).toBe(false);
    const noPlainSpeech = makeConfig();
    delete (noPlainSpeech as { plainSpeech?: unknown }).plainSpeech;
    expect(plainSpeechAppliesTo(noPlainSpeech, "gpt-5.4")).toBe(false);
  });
});

describe("rewriteToPlainSpeech", () => {
  test("returns rewritten text from the responses upstream", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init?.body));
      return responsesJson("通俗版正文");
    }) as unknown as typeof fetch;

    const out = await rewriteToPlainSpeech(makeConfig(), "jargon-heavy original");
    expect(out).toBe("通俗版正文");
    expect(capturedUrl).toBe("https://upstream.test/v1/responses");
    expect((capturedBody as { model?: string }).model).toBe("DeepSeek-V4-Flash-Vision-Exp");
    expect((capturedBody as { stream?: boolean }).stream).toBe(false);
  });

  test("returns original text on upstream HTTP error", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const out = await rewriteToPlainSpeech(makeConfig(), "original text");
    expect(out).toBe("original text");
  });

  test("returns original text when upstream returns empty output", async () => {
    globalThis.fetch = (async () => responsesJson("   ")) as unknown as typeof fetch;
    const out = await rewriteToPlainSpeech(makeConfig(), "original text");
    expect(out).toBe("original text");
  });

  test("returns original text on network throw", async () => {
    globalThis.fetch = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const out = await rewriteToPlainSpeech(makeConfig(), "original text");
    expect(out).toBe("original text");
  });

  test("no-op for empty input without calling upstream", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return responsesJson("x");
    }) as unknown as typeof fetch;
    expect(await rewriteToPlainSpeech(makeConfig(), "")).toBe("");
    expect(await rewriteToPlainSpeech(makeConfig(), "   ")).toBe("   ");
    expect(called).toBe(false);
  });
});

describe("applyPlainSpeechToChatCompletion", () => {
  test("rewrites final prose of a non-tool turn", async () => {
    globalThis.fetch = (async () => responsesJson("说人话版")) as unknown as typeof fetch;
    const completion = {
      choices: [{ index: 0, message: { role: "assistant", content: "black-box jargon" }, finish_reason: "stop" }],
    };
    await applyPlainSpeechToChatCompletion(makeConfig(), completion);
    expect((completion.choices[0].message as { content: string }).content).toBe("说人话版");
  });

  test("does not rewrite a tool_calls turn", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return responsesJson("should not be used");
    }) as unknown as typeof fetch;
    const completion = {
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "I will call a tool",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "x", arguments: "{}" } }],
        },
        finish_reason: "tool_calls",
      }],
    };
    await applyPlainSpeechToChatCompletion(makeConfig(), completion);
    expect((completion.choices[0].message as { content: string }).content).toBe("I will call a tool");
    expect(called).toBe(false);
  });

  test("leaves original content when upstream fails", async () => {
    globalThis.fetch = (async () =>
      new Response("err", { status: 502 })) as unknown as typeof fetch;
    const completion = {
      choices: [{ index: 0, message: { role: "assistant", content: "keep me" }, finish_reason: "stop" }],
    };
    await applyPlainSpeechToChatCompletion(makeConfig(), completion);
    expect((completion.choices[0].message as { content: string }).content).toBe("keep me");
  });

  test("skips empty content without calling upstream", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return responsesJson("x");
    }) as unknown as typeof fetch;
    const completion = {
      choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
    };
    await applyPlainSpeechToChatCompletion(makeConfig(), completion);
    expect(called).toBe(false);
  });
});
