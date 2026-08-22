import { afterEach, beforeEach, expect, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-claude-provider-passthrough-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-claude-provider-passthrough-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

interface Captured { path: string; headers: Headers; body: any }

function mockAnthropicUpstream(captured: Captured[]) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      captured.push({ path: url.pathname + url.search, headers: req.headers, body: await req.json() });
      if (url.pathname.endsWith("/count_tokens")) {
        return Response.json({ input_tokens: 4242 });
      }
      const frames = [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_up", type: "message", role: "assistant", content: [], model: "ox-alpha", stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "provider hi" } })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      ];
      return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
}

/** Provider passthrough config: `aitokens` provider with anthropicPassthrough:true. */
function cfg(upstreamBaseUrl: string, opts: {
  providerName?: string;
  apiKey?: string;
  apiKeyTransport?: "x-api-key" | "bearer";
  passthrough?: boolean;
  extraProviders?: Record<string, unknown>;
} = {}): OcxConfig {
  const {
    providerName = "aitokens",
    apiKey = "sk-provider-key-123",
    apiKeyTransport,
    passthrough = true,
    extraProviders,
  } = opts;
  return {
    port: 0,
    defaultProvider: providerName,
    providers: {
      [providerName]: {
        adapter: "anthropic",
        baseUrl: upstreamBaseUrl,
        apiKey,
        ...(apiKeyTransport ? { apiKeyTransport } : {}),
        ...(passthrough ? { anthropicPassthrough: true } : {}),
        allowPrivateNetwork: true,
        liveModels: false,
        models: ["ox-alpha"],
      },
      ...extraProviders,
    },
    connectTimeoutMs: 250,
    claudeCode: { anthropicBaseUrl: "http://127.0.0.1:1/v1" }, // 故意指向错误地址，验证 provider.baseUrl 被优先使用
  } as OcxConfig;
}

function claudeBody(model: string): Record<string, unknown> {
  return {
    model,
    max_tokens: 32000,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  };
}

test("provider passthrough: routes to provider.baseUrl with provider.apiKey, model replaced", async () => {
  const captured: Captured[] = [];
  const upstream = mockAnthropicUpstream(captured);
  saveConfig(cfg(upstream.url.toString()));
  const server = startServer(0);
  try {
    // 用可读 alias 发请求（Claude Code picker 形态）
    const res = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-opencodex-api-key": "test",
      },
      body: JSON.stringify(claudeBody("claude-ocx-aitokens--ox-alpha")),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("provider hi");
    expect(text).toContain("message_stop");

    expect(captured).toHaveLength(1);
    const hit = captured[0];
    expect(hit.path).toBe("/v1/messages");
    // provider.apiKey injected, no client credential leaked
    expect(hit.headers.get("x-api-key")).toBe("sk-provider-key-123");
    expect(hit.headers.get("authorization")).toBeNull();
    // model replaced from alias to provider modelId
    expect(hit.body.model).toBe("ox-alpha");
    expect(hit.body.messages).toEqual([{ role: "user", content: "hi" }]);
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("provider passthrough: apiKeyTransport bearer uses Authorization header", async () => {
  const captured: Captured[] = [];
  const upstream = mockAnthropicUpstream(captured);
  saveConfig(cfg(upstream.url.toString(), { apiKeyTransport: "bearer" }));
  const server = startServer(0);
  try {
    const res = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-opencodex-api-key": "test",
      },
      body: JSON.stringify(claudeBody("claude-ocx-aitokens--ox-alpha")),
    });
    expect(res.status).toBe(200);
    await res.text();
    const hit = captured[0];
    expect(hit.headers.get("authorization")).toBe("Bearer sk-provider-key-123");
    expect(hit.headers.get("x-api-key")).toBeNull();
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("provider passthrough: bare publicAlias model also routes to provider", async () => {
  const captured: Captured[] = [];
  const upstream = mockAnthropicUpstream(captured);
  saveConfig(cfg(upstream.url.toString()));
  const server = startServer(0);
  try {
    const res = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-opencodex-api-key": "test",
      },
      body: JSON.stringify(claudeBody("ox-alpha")),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(captured).toHaveLength(1);
    expect(captured[0].body.model).toBe("ox-alpha");
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("provider passthrough: count_tokens also forwards to provider", async () => {
  const captured: Captured[] = [];
  const upstream = mockAnthropicUpstream(captured);
  saveConfig(cfg(upstream.url.toString()));
  const server = startServer(0);
  try {
    const res = await fetch(new URL("/v1/messages/count_tokens", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-opencodex-api-key": "test",
      },
      body: JSON.stringify({ model: "claude-ocx-aitokens--ox-alpha", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ input_tokens: 4242 });
    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe("/v1/messages/count_tokens");
    expect(captured[0].headers.get("x-api-key")).toBe("sk-provider-key-123");
    expect(captured[0].body.model).toBe("ox-alpha");
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("provider passthrough: provider WITHOUT the flag keeps translate-and-replay", async () => {
  const captured: Captured[] = [];
  const upstream = mockAnthropicUpstream(captured);
  // passthrough=false → normal translate path (provider adapter "anthropic").
  saveConfig(cfg(upstream.url.toString(), { passthrough: false }));
  const server = startServer(0);
  try {
    await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-opencodex-api-key": "test",
      },
      body: JSON.stringify(claudeBody("claude-ocx-aitokens--ox-alpha")),
    });
    // Without the passthrough flag the request is translated (anthropicToResponses →
    // anthropic adapter replay). The anthropic adapter still POSTs to /v1/messages,
    // so distinguish by BODY SHAPE: translated content is an array with cache_control,
    // while passthrough would relay the raw string content verbatim.
    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe("/v1/messages");
    const content = captured[0].body?.messages?.[0]?.content;
    // translated form: array of blocks, NOT the raw "hi" string
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]?.type).toBe("text");
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});
test("provider passthrough: baseUrl with /v1 suffix still routes to /v1/messages (URL normalization)", async () => {
  const captured: Captured[] = [];
  const upstream = mockAnthropicUpstream(captured);
  // baseUrl 带 /v1 → 容错归一化到 origin，转发仍打 /v1/messages（而非 /v1/v1/messages）
  saveConfig(cfg(`${upstream.url}/v1`));
  const server = startServer(0);
  try {
    const res = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-opencodex-api-key": "test",
      },
      body: JSON.stringify(claudeBody("claude-ocx-aitokens--ox-alpha")),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe("/v1/messages");
    expect(captured[0].body.model).toBe("ox-alpha");
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("provider passthrough: baseUrl with /v1/messages suffix also normalizes", async () => {
  const captured: Captured[] = [];
  const upstream = mockAnthropicUpstream(captured);
  saveConfig(cfg(`${upstream.url}/v1/messages`));
  const server = startServer(0);
  try {
    const res = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-opencodex-api-key": "test",
      },
      body: JSON.stringify(claudeBody("claude-ocx-aitokens--ox-alpha")),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(captured[0].path).toBe("/v1/messages");
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});
