import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyProxyEnv } from "../src/config";
import { providerOutboundProxyInit, providerOutboundProxyUrl } from "../src/lib/provider-proxy";
import { providerFetch } from "../src/server/responses/fetch-helpers";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "OCX_TEST_PROXY_REF"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of PROXY_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of PROXY_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function configWithProxy(proxy?: string): OcxConfig {
  return { proxy, providers: {} } as unknown as OcxConfig;
}

describe("applyProxyEnv", () => {
  test("no-op when config.proxy is unset", () => {
    applyProxyEnv(configWithProxy(undefined));
    expect(process.env.HTTP_PROXY).toBeUndefined();
    expect(process.env.HTTPS_PROXY).toBeUndefined();
    expect(process.env.NO_PROXY).toBeUndefined();
  });

  test("mirrors config.proxy into HTTP(S)_PROXY and excludes loopback (IPv4 + IPv6)", () => {
    applyProxyEnv(configWithProxy("http://proxy.corp:8080"));
    expect(process.env.HTTP_PROXY).toBe("http://proxy.corp:8080");
    expect(process.env.HTTPS_PROXY).toBe("http://proxy.corp:8080");
    expect(process.env.NO_PROXY).toBe("localhost,127.0.0.1,::1,[::1]");
  });

  test("user-set env vars win over config", () => {
    process.env.HTTPS_PROXY = "http://user-proxy:3128";
    applyProxyEnv(configWithProxy("http://proxy.corp:8080"));
    expect(process.env.HTTPS_PROXY).toBe("http://user-proxy:3128");
    expect(process.env.HTTP_PROXY).toBe("http://proxy.corp:8080");
  });

  test("appends loopback entries to an existing NO_PROXY without duplicating", () => {
    process.env.NO_PROXY = "internal.corp,localhost";
    applyProxyEnv(configWithProxy("http://proxy.corp:8080"));
    expect(process.env.NO_PROXY).toBe("internal.corp,localhost,127.0.0.1,::1,[::1]");
  });

  test("dedup is case-insensitive against existing entries", () => {
    process.env.NO_PROXY = "LOCALHOST,[::1]";
    applyProxyEnv(configWithProxy("http://proxy.corp:8080"));
    expect(process.env.NO_PROXY).toBe("LOCALHOST,[::1],127.0.0.1,::1");
  });

  test("resolves ${VAR}-style env references like other config secrets", () => {
    process.env.OCX_TEST_PROXY_REF = "http://ref-proxy:9999";
    applyProxyEnv(configWithProxy("${OCX_TEST_PROXY_REF}"));
    expect(process.env.HTTP_PROXY).toBe("http://ref-proxy:9999");
  });
});

describe("providerOutboundProxyUrl", () => {
  test("absent provider proxy means no override", () => {
    expect(providerOutboundProxyUrl({} as OcxProviderConfig)).toBeUndefined();
    expect(providerOutboundProxyUrl({ proxy: undefined } as OcxProviderConfig)).toBeUndefined();
  });

  test("returns a plain URL trimmed", () => {
    expect(providerOutboundProxyUrl({ proxy: "  http://127.0.0.1:7890  " } as OcxProviderConfig))
      .toBe("http://127.0.0.1:7890");
  });

  test("resolves ${VAR} and $VAR env references with the global-field semantics", () => {
    process.env.OCX_TEST_PROXY_REF = "http://ref-proxy:9999";
    expect(providerOutboundProxyUrl({ proxy: "${OCX_TEST_PROXY_REF}" } as OcxProviderConfig))
      .toBe("http://ref-proxy:9999");
    expect(providerOutboundProxyUrl({ proxy: "$OCX_TEST_PROXY_REF" } as OcxProviderConfig))
      .toBe("http://ref-proxy:9999");
  });

  test("an env reference that resolves to nothing is unset, not an error", () => {
    delete process.env.OCX_TEST_PROXY_REF;
    expect(providerOutboundProxyUrl({ proxy: "${OCX_TEST_PROXY_REF}" } as OcxProviderConfig))
      .toBeUndefined();
    expect(providerOutboundProxyInit({ proxy: "${OCX_TEST_PROXY_REF}" } as OcxProviderConfig))
      .toEqual({});
  });

  test("blank values degrade to no override", () => {
    expect(providerOutboundProxyUrl({ proxy: "   " } as OcxProviderConfig)).toBeUndefined();
    expect(providerOutboundProxyInit({ proxy: "   " } as OcxProviderConfig)).toEqual({});
  });
});

describe("providerFetch per-provider proxy", () => {
  function providerWithFetchSeam(provider: Partial<OcxProviderConfig>, captured: Array<{ init?: RequestInit }>): OcxProviderConfig {
    const seam = async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      captured.push({ init });
      return Response.json({});
    };
    return { baseUrl: "https://example.test/v1", adapter: "openai-chat", ...provider, fetch: seam } as OcxProviderConfig;
  }

  test("injects the resolved provider proxy into every send", async () => {
    const captured: Array<{ init?: RequestInit }> = [];
    process.env.OCX_TEST_PROXY_REF = "http://per-provider:7890";
    const fetch = providerFetch(providerWithFetchSeam({ proxy: "${OCX_TEST_PROXY_REF}" }, captured));
    await fetch("https://upstream.test/v1/chat", { method: "POST", body: "x" });
    expect(captured[0]?.init?.proxy).toBe("http://per-provider:7890");
  });

  test("a provider without the field passes init through untouched", async () => {
    const captured: Array<{ init?: RequestInit }> = [];
    const fetch = providerFetch(providerWithFetchSeam({}, captured));
    await fetch("https://upstream.test/v1/chat", { method: "POST", body: "x" });
    expect(captured[0]?.init).toEqual({ method: "POST", body: "x" });
    expect("proxy" in (captured[0]?.init ?? {})).toBe(false);
  });

  test("pacing still wraps a proxied provider", async () => {
    const captured: Array<{ init?: RequestInit }> = [];
    const fetch = providerFetch(
      providerWithFetchSeam({ proxy: "http://per-provider:7890", requestPacing: { enabled: true, minIntervalMs: 1 } }, captured),
      undefined,
      { providerName: "paced" },
    );
    await fetch("https://upstream.test/v1/chat", { method: "POST" });
    expect(typeof fetch.waitForPacing).toBe("function");
    expect(captured[0]?.init?.proxy).toBe("http://per-provider:7890");
  });
});
