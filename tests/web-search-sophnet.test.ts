import { afterEach, describe, expect, mock, test } from "bun:test";
import * as oauthModule from "../src/oauth";

// The sophnet backend never touches stored OAuth; stub the module so importing the web-search
// index doesn't read a real credential store (mirrors tests/web-search-anthropic.test.ts).
mock.module("../src/oauth", () => ({ ...oauthModule, getValidAccessToken: async () => "test-token-xyz" }));

import { parseRequest } from "../src/responses/parser";
import {
  findSophnetSidecarProvider,
  planWebSearch,
  resolveSidecarBackend,
  shouldResolveOpenAiWebSearchSidecar,
} from "../src/web-search";
import { runSophnetWebSearch } from "../src/web-search/sophnet-executor";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const routedProvider: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://routed.test/v1", apiKey: "routed-key" };
const forwardProvider: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" };
const sophnetProvider: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://www.sophnet.com/api/open-apis/v1", apiKey: "soph-key" };

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "routed",
    providers: { routed: routedProvider, chatgpt: forwardProvider },
    webSearchSidecar: { backend: "sophnet" },
    ...overrides,
  };
}

function parsedWithWebSearch() {
  return parseRequest({ model: "routed/model", input: "Search current docs", stream: true, tools: [{ type: "web_search" }] });
}

describe("web-search sophnet backend resolution", () => {
  afterEach(() => mock.restore());

  test("resolveSidecarBackend: explicit sophnet wins, unset defaults to openai", () => {
    expect(resolveSidecarBackend("sophnet")).toBe("sophnet");
    expect(resolveSidecarBackend("anthropic")).toBe("anthropic");
    expect(resolveSidecarBackend(undefined)).toBe("openai");
  });

  test("findSophnetSidecarProvider picks the well-known provider name", () => {
    const cfg = config({ providers: { routed: routedProvider, chatgpt: forwardProvider, sophnet: sophnetProvider } });
    expect(findSophnetSidecarProvider(cfg)?.providerName).toBe("sophnet");
  });

  test("findSophnetSidecarProvider falls back to any keyed provider on the sophnet origin", () => {
    const alias: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://www.sophnet.com/api/open-apis/anthropic", apiKey: "alias-key" };
    const cfg = config({ providers: { routed: routedProvider, chatgpt: forwardProvider, mychannel: alias } });
    expect(findSophnetSidecarProvider(cfg)?.providerName).toBe("mychannel");
  });

  test("findSophnetSidecarProvider ignores disabled or keyless providers", () => {
    const cfg = config({ providers: {
      routed: routedProvider,
      chatgpt: forwardProvider,
      sophnet: { ...sophnetProvider, disabled: true },
      nokey: { adapter: "openai-chat", baseUrl: "https://www.sophnet.com/api/open-apis/v1" },
    } });
    expect(findSophnetSidecarProvider(cfg)).toBeUndefined();
  });

  test("planWebSearch returns a sophnet plan without needing ChatGPT/OAuth credentials", () => {
    const cfg = config({ providers: { routed: routedProvider, chatgpt: forwardProvider, sophnet: sophnetProvider } });
    const plan = planWebSearch(cfg, parsedWithWebSearch(), false, routedProvider, "model", undefined);
    expect(plan?.backend).toBe("sophnet");
    expect(plan?.sophnetSidecar?.provider.apiKey).toBe("soph-key");
  });

  test("planWebSearch fails closed when the sophnet backend has no usable provider", () => {
    const cfg = config();
    expect(planWebSearch(cfg, parsedWithWebSearch(), false, routedProvider, "model", undefined)).toBeUndefined();
  });

  test("shouldResolveOpenAiWebSearchSidecar is false for the sophnet backend", () => {
    const cfg = config({ providers: { routed: routedProvider, chatgpt: forwardProvider, sophnet: sophnetProvider } });
    expect(shouldResolveOpenAiWebSearchSidecar(cfg, parsedWithWebSearch(), false)).toBe(false);
  });

  test("runSophnetWebSearch formats hits and collects sources", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      status: 0,
      result: [
        { title: "Result A", url: "https://a.test/x", content: "alpha content" },
        { title: "Result B", url: "https://b.test/y", content: "" },
        { title: "dup", url: "https://a.test/x", content: "ignored dup" },
      ],
    }), { status: 200 })) as typeof fetch;
    try {
      const out = await runSophnetWebSearch("q", "sophnet", sophnetProvider, { model: "sophnet-search", reasoning: "low", timeoutMs: 5000 });
      expect(out.error).toBeUndefined();
      expect(out.sources).toEqual([
        { url: "https://a.test/x", title: "Result A" },
        { url: "https://b.test/y", title: "Result B" },
      ]);
      expect(out.text).toContain("1. Result A");
      expect(out.text).toContain("URL: https://a.test/x");
      expect(out.text).toContain("3. dup");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("runSophnetWebSearch degrades gracefully on HTTP and API errors", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("boom", { status: 502 })) as typeof fetch;
    try {
      const out = await runSophnetWebSearch("q", "sophnet", sophnetProvider, { model: "x", reasoning: "low", timeoutMs: 5000 });
      expect(out.error).toContain("sophnet HTTP 502");
      expect(out.sources).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
    globalThis.fetch = (async () => new Response(JSON.stringify({ status: 7, message: "bad key" }), { status: 200 })) as typeof fetch;
    try {
      const out2 = await runSophnetWebSearch("q", "sophnet", sophnetProvider, { model: "x", reasoning: "low", timeoutMs: 5000 });
      expect(out2.error).toContain("bad key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("runSophnetWebSearch fails closed without an apiKey", async () => {
    const out = await runSophnetWebSearch("q", "sophnet", { ...sophnetProvider, apiKey: undefined }, { model: "x", reasoning: "low", timeoutMs: 5000 });
    expect(out.error).toContain("no apiKey");
  });
});
