/**
 * Focused regressions for `OcxCustomModel.publicAlias` — the explicit bare public id a custom
 * model answers to in addition to its routed `<provider>/<modelId>` slug (see
 * src/codex/custom-model-public-alias.ts). The alias becomes the Codex-facing catalog slug and
 * routes to the concrete provider/modelId BEFORE any native OpenAI interpretation; the upstream
 * wire id stays the row's native `modelId`.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { routeModel } from "../src/router";
import {
  CUSTOM_MODEL_PUBLIC_ALIAS_PATTERN,
  customModelPublicAlias,
  customModelPublicAliasIssues,
} from "../src/codex/custom-model-public-alias";
import { CODEX_CUSTOM_ALIAS_CATALOG_KIND } from "../src/codex/catalog/kinds";
import { buildCatalogEntries } from "../src/codex/catalog/sync";
import {
  configuredNativeAliasSlugs,
  desktopAllowlistSuppressedNativeSlugs,
  isCustomAliasCatalogEntry,
} from "../src/codex/catalog/metadata";
import { applyMultiAgentMode, catalogEntryIsNativeChatGpt, type RawEntry } from "../src/codex/catalog/parsing";
import type { OcxConfig, OcxCustomModel } from "../src/types";
import { INTERNAL_DEADLINE_MS } from "./helpers/test-budget";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");

function baseConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "sophnet",
    providers: {
      sophnet: {
        adapter: "openai-responses",
        baseUrl: "https://sophnet.example/v1",
        apiKey: "k-sophnet",
        models: ["gpt-5.5-internal"],
      },
    },
    ...overrides,
  };
}

function customModel(publicAlias?: string): OcxCustomModel {
  return {
    id: "cm-gpt55",
    provider: "sophnet",
    modelId: "gpt-5.5-internal",
    ...(publicAlias ? { publicAlias } : {}),
  };
}

describe("custom-model publicAlias validation", () => {
  test("accepts bare id shapes and rejects slashes, blanks, and oversized aliases", () => {
    expect(CUSTOM_MODEL_PUBLIC_ALIAS_PATTERN.test("gpt-5.5")).toBe(true);
    expect(CUSTOM_MODEL_PUBLIC_ALIAS_PATTERN.test("my-model_v2.1")).toBe(true);
    expect(CUSTOM_MODEL_PUBLIC_ALIAS_PATTERN.test("vendor/model")).toBe(false);
    expect(CUSTOM_MODEL_PUBLIC_ALIAS_PATTERN.test("")).toBe(false);
    expect(CUSTOM_MODEL_PUBLIC_ALIAS_PATTERN.test("x".repeat(65))).toBe(false);

    const config = baseConfig();
    expect(customModelPublicAliasIssues(config, "gpt-5.5")).toEqual([]);
    expect(customModelPublicAliasIssues(config, "vendor/model")[0]!.message).toContain("must not contain \"/\"");
  });

  test("rejects reserved routing namespaces", () => {
    const config = baseConfig();
    expect(customModelPublicAliasIssues(config, "policy")[0]!.message).toContain("policy");
    expect(customModelPublicAliasIssues(config, "combo")[0]!.message).toContain("combo");
  });

  test("rejects collisions with provider names, combo aliases, and sibling custom models", () => {
    const config = baseConfig({
      combos: {
        fast: { alias: "quick-turn", targets: [{ provider: "sophnet", model: "gpt-5.5-internal" }] },
      },
      customModels: [{ id: "other", provider: "sophnet", modelId: "other-model", publicAlias: "taken" }],
    });
    expect(customModelPublicAliasIssues(config, "sophnet")[0]!.message).toContain("provider name");
    expect(customModelPublicAliasIssues(config, "quick-turn")[0]!.message).toContain("combo alias");
    expect(customModelPublicAliasIssues(config, "taken")[0]!.message).toContain("other");
    // The row being edited may keep its own stored alias.
    expect(customModelPublicAliasIssues(config, "taken", { excludeId: "other" })).toEqual([]);
  });

  test("customModelPublicAlias trims and normalizes empty values to null", () => {
    expect(customModelPublicAlias({ publicAlias: " gpt-5.5 " })).toBe("gpt-5.5");
    expect(customModelPublicAlias({ publicAlias: "   " })).toBeNull();
    expect(customModelPublicAlias({})).toBeNull();
    expect(customModelPublicAlias({ publicAlias: 42 })).toBeNull();
  });
});

describe("custom-model publicAlias routing", () => {
  test("a bare publicAlias resolves before canonical OpenAI routing", () => {
    const config = baseConfig({
      providers: {
        ...baseConfig().providers,
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          codexAccountMode: "direct",
        },
      },
      customModels: [customModel("gpt-5.5")],
    });
    const routed = routeModel(config, "gpt-5.5");
    expect(routed).toMatchObject({
      providerName: "sophnet",
      modelId: "gpt-5.5-internal",
      routeKind: "explicit-provider",
      routeReason: "custom-model-public-alias",
    });
  });

  test("without a publicAlias the bare gpt-* id still routes to the native OpenAI surface", () => {
    const config = baseConfig({
      providers: {
        ...baseConfig().providers,
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          codexAccountMode: "direct",
        },
      },
      customModels: [customModel()],
    });
    expect(routeModel(config, "gpt-5.5")).toMatchObject({
      providerName: "openai",
      modelId: "gpt-5.5",
      routeReason: "native-family",
    });
  });

  test("the routed <provider>/<modelId> slug keeps working next to the alias", () => {
    const config = baseConfig({ customModels: [customModel("gpt-5.5")] });
    expect(routeModel(config, "sophnet/gpt-5.5-internal")).toMatchObject({
      providerName: "sophnet",
      modelId: "gpt-5.5-internal",
      routeReason: "explicit-provider-namespace",
    });
  });

  test("a disabled owning provider fails closed instead of falling through", () => {
    const config = baseConfig({ customModels: [customModel("gpt-5.5")] });
    config.providers.sophnet!.disabled = true;
    expect(() => routeModel(config, "gpt-5.5")).toThrow("Provider is disabled: sophnet");
  });
});

describe("custom-model publicAlias catalog takeover", () => {
  const aliasModel = {
    id: "gpt-5.5-internal",
    provider: "sophnet",
    alias: "gpt-5.5",
    customAlias: true,
  };

  test("configuredNativeAliasSlugs treats a supported native slug alias as a takeover", () => {
    expect(configuredNativeAliasSlugs({ customModels: [customModel("gpt-5.5")] })).toEqual(new Set(["gpt-5.5"]));
    // Non-native aliases configure nothing to suppress — they never shadow a native row.
    expect(configuredNativeAliasSlugs({ customModels: [customModel("my-bare-model")] })).toEqual(new Set());
    expect(desktopAllowlistSuppressedNativeSlugs({ customModels: [customModel("gpt-5.5")] }))
      .toEqual(new Set(["gpt-5.5"]));
  });

  test("buildCatalogEntries suppresses the bare native row and stamps the custom-alias kind", () => {
    const suppressed = desktopAllowlistSuppressedNativeSlugs({ customModels: [customModel("gpt-5.5")] });
    const rows = buildCatalogEntries(
      { slug: "gpt-5.4", display_name: "gpt-5.4" },
      ["gpt-5.5"],
      [aliasModel],
      undefined,
      false,
      "default",
      new Set(),
      [],
      suppressed,
    );
    const bare = rows.filter(entry => entry.slug === "gpt-5.5");
    expect(bare).toHaveLength(1);
    expect(bare[0]!.opencodex_catalog_kind).toBe(CODEX_CUSTOM_ALIAS_CATALOG_KIND);
    expect(isCustomAliasCatalogEntry(bare[0]!)).toBe(true);
    expect(String(bare[0]!.description)).toContain("Routed via opencodex");
  });

  test("a custom-alias row is never classified as ChatGPT-native and keeps routed v2 stamps", () => {
    const entry: RawEntry = {
      slug: "gpt-5.5",
      opencodex_catalog_kind: CODEX_CUSTOM_ALIAS_CATALOG_KIND,
    };
    expect(catalogEntryIsNativeChatGpt(entry)).toBe(false);

    const v2Rows: RawEntry[] = [
      { slug: "gpt-5.5", opencodex_catalog_kind: CODEX_CUSTOM_ALIAS_CATALOG_KIND },
      { slug: "gpt-5.6-sol" },
    ];
    applyMultiAgentMode(v2Rows, "v2", false, { keepNativeChatGptOnV1: true });
    expect(v2Rows[0]!.multi_agent_version).toBe("v2");
    expect(v2Rows[1]!.multi_agent_version).toBe("v1");

    // Default mode must not pin the shadowed native multi_agent_version onto the routed row.
    const defaultRows: RawEntry[] = [
      { slug: "gpt-5.5", opencodex_catalog_kind: CODEX_CUSTOM_ALIAS_CATALOG_KIND, multi_agent_version: "v1" },
    ];
    applyMultiAgentMode(defaultRows, "default", false);
    expect(defaultRows[0]).not.toHaveProperty("multi_agent_version");
  });
});

describe("ocx models add --public-alias", () => {
  function freshConfigHome() {
    const dir = mkdtempSync(join(tmpdir(), "ocx-public-alias-"));
    const config = {
      port: 10100,
      providers: {
        sophnet: {
          adapter: "openai-chat",
          baseUrl: "http://localhost:8080/v1",
          allowPrivateNetwork: true,
          models: ["gpt-5.5-internal"],
        },
      },
      defaultProvider: "sophnet",
    };
    writeFileSync(join(dir, "config.json"), JSON.stringify(config), "utf8");
    return dir;
  }

  function runCli(args: string[], env: Record<string, string> = {}) {
    return spawnSync(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: INTERNAL_DEADLINE_MS,
      killSignal: "SIGKILL",
    });
  }

  test("stores publicAlias and rejects a slash alias", () => {
    const dir = freshConfigHome();
    try {
      const ok = runCli(
        ["models", "add", "sophnet", "gpt-5.5-internal", "--public-alias", "gpt-5.5"],
        { OPENCODEX_HOME: dir },
      );
      expect(ok.status).toBe(0);
      const saved = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
      expect(saved.customModels[0].publicAlias).toBe("gpt-5.5");

      const bad = runCli(
        ["models", "add", "sophnet", "another-model", "--public-alias", "vendor/model"],
        { OPENCODEX_HOME: dir },
      );
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain("must not contain \"/\"");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("management API custom-model publicAlias", () => {
  let persistCalls = 0;
  const fixtureConfig = {
    providers: { sophnet: { adapter: "openai-chat", baseUrl: "https://example.invalid/v1" } },
    customModels: [] as Array<{ id: string; provider: string; modelId: string; publicAlias?: string }>,
  } as unknown as OcxConfig;

  beforeEach(() => {
    fixtureConfig.customModels = [
      { id: "existing-uuid", provider: "sophnet", modelId: "other-model", publicAlias: "taken" },
    ];
  });

  async function callCustomModels(
    method: "POST" | "PUT",
    body: unknown,
    pathname = "/api/custom-models",
  ): Promise<Response | null> {
    const { handleModelRoutes } = await import("../src/server/management/model-routes");
    const url = new URL(`http://127.0.0.1:10199${pathname}`);
    const req = new Request(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return handleModelRoutes({
      req,
      url,
      config: fixtureConfig,
      deps: {
        saveConfigPreservingClaudeCode: () => { persistCalls++; },
      } as Parameters<typeof handleModelRoutes>[0]["deps"],
      convergeCodexCatalog: async () => ({
        status: "committed",
        changed: false,
        degraded: false,
        notices: [],
      }),
      syncClaudeAgentDefsBestEffort: async () => {},
    });
  }

  test("POST stores a valid publicAlias and refuses collisions with 409", async () => {
    persistCalls = 0;
    const ok = await callCustomModels("POST", {
      provider: "sophnet",
      modelId: "gpt-5.5-internal",
      publicAlias: "gpt-5.5",
    });
    expect(ok?.status).toBe(201);
    const payload = await ok!.json() as { publicAlias?: string };
    expect(payload.publicAlias).toBe("gpt-5.5");
    expect(persistCalls).toBe(1);

    const clash = await callCustomModels("POST", {
      provider: "sophnet",
      modelId: "yet-another",
      publicAlias: "taken",
    });
    expect(clash?.status).toBe(409);
    expect(persistCalls).toBe(1);
  });

  test("PUT sets and clears publicAlias without self-collision", async () => {
    persistCalls = 0;
    const set = await callCustomModels("PUT", { publicAlias: "taken" }, "/api/custom-models/existing-uuid");
    expect(set?.status).toBe(200);
    expect(fixtureConfig.customModels[0]!.publicAlias).toBe("taken");

    const clear = await callCustomModels("PUT", { publicAlias: "" }, "/api/custom-models/existing-uuid");
    expect(clear?.status).toBe(200);
    expect(fixtureConfig.customModels[0]!.publicAlias).toBeUndefined();
  });
});
