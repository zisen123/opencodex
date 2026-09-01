/**
 * Anthropic-flavor /v1/models entries in the official ModelInfo shape
 * (anthropic-sdk-typescript@9e46760 src/resources/models.ts — devlog 131).
 *
 * Why full ModelInfo: Claude Desktop 3P discovery is the only channel that can
 * carry per-model capabilities (effort ladder / thinking types); the static
 * inferenceModels schema has no capability fields. Claude Code CLI 2.1.207 strips
 * unknown fields, so the richer shape is backward-safe (audit 133 R1#4).
 *
 * Honesty rules (audit 133 R2#1/R2#2/R3#2/R4#1):
 *  - native ladders start from the injected catalog but advertise ONLY rungs that
 *    survive nativeEffortClamp as identity (`(clamp(r) ?? r) === r`), ultra excluded;
 *  - routed ladders use the adapter-reported CatalogModel.reasoningEfforts only —
 *    no ladder means effort.supported:false, never a guess;
 *  - created_at is a fixed constant; max_input_tokens is authoritative-or-null;
 *    max_tokens is always null (no authoritative output limit exists proxy-side).
 */
import { catalogModelEfforts, nativeEffortClamp, nativeOpenAiContextWindow, type CatalogModel } from "../codex/catalog";
import { claudeCodeAlias, claudeCodeNativeAlias } from "./alias";
import { desktop3pAlias } from "./desktop-3p";
import { AUTO_CONTEXT_OFF, type AutoContextMode } from "./context-windows";

const MODEL_INFO_CREATED_AT = "2026-01-01T00:00:00Z";
const ANTHROPIC_EFFORT_RUNGS = new Set(["low", "medium", "high", "xhigh", "max"]);
const ONE_MILLION = 1_000_000;

interface CapabilitySupport { supported: boolean }

function cap(supported: boolean): CapabilitySupport {
  return { supported };
}

function effortCapability(ladder: readonly string[]) {
  const rungs = new Set(ladder.filter(r => ANTHROPIC_EFFORT_RUNGS.has(r)));
  const supported = rungs.size > 0;
  return {
    supported,
    low: cap(rungs.has("low")),
    medium: cap(rungs.has("medium")),
    high: cap(rungs.has("high")),
    max: cap(rungs.has("max")),
    xhigh: supported ? cap(rungs.has("xhigh")) : null,
  };
}

function modelCapabilities(ladder: readonly string[], imageInput: boolean) {
  const reasons = ladder.length > 0;
  return {
    batch: cap(false),
    citations: cap(false),
    code_execution: cap(false),
    context_management: {
      supported: false,
      clear_thinking_20251015: null,
      clear_tool_uses_20250919: null,
      compact_20260112: null,
    },
    effort: effortCapability(ladder),
    image_input: cap(imageInput),
    pdf_input: cap(false),
    structured_outputs: cap(false),
    thinking: reasons
      ? { supported: true, types: { adaptive: cap(true), enabled: cap(true) } }
      : { supported: false, types: { adaptive: cap(false), enabled: cap(false) } },
  };
}

/** Native ladder: catalog rungs that the native effort clamp passes through as identity. */
export function nativeEffectiveLadder(slug: string): string[] {
  const ladder = catalogModelEfforts([slug]).get(slug) ?? [];
  return ladder.filter(r => r !== "ultra" && (nativeEffortClamp(slug, r) ?? r) === r);
}

export interface AnthropicModelInfo {
  id: string;
  display_name: string;
  type: "model";
  created_at: string;
  capabilities: ReturnType<typeof modelCapabilities>;
  max_input_tokens: number | null;
  max_tokens: null;
}

/**
 * Local display-name overrides for the sole upstream provider in this deployment.
 * The generic `${modelId} (${provider})` label is accurate upstream but noisy in
 * the Claude Code picker when every routed row would carry the same suffix.
 */
const DISPLAY_NAME_OVERRIDES: ReadonlyMap<string, string> = new Map([
  ["sophnet/gpt-5.5", "GPT-5.5"],
  ["sophnet/gpt-5.4", "GPT-5.4"],
  ["sophnet-responses/gpt-5.3-codex", "GPT-5.3 Codex"],
  ["sophnet/DeepSeek-V4-Pro-0813", "DeepSeek V4 Pro"],
  ["sophnet-responses/DeepSeek-V4-Flash-Vision-Exp", "DeepSeek V4 Flash Vision"],
  ["sophnet/qwen3.8-max", "Qwen3.8 Max"],
  ["sophnet/qwen3.8-flash", "Qwen3.8 Flash"],
  ["sophnet/Kimi-K3", "Kimi K3"],
  ["sophnet/GLM-5.3", "GLM 5.3"],
  ["sophnet/glm-5.3-flash", "GLM 5.3 Flash"],
  ["sophnet-anthropic/claude-opus-4-8", "Claude Opus 4.8"],
  ["sophnet-anthropic/claude-opus-4-7", "Claude Opus 4.7"],
  ["sophnet-anthropic/anthropic.claude-opus-4-6", "Claude Opus 4.6"],
  ["sophnet-anthropic/claude-sonnet-4-6", "Claude Sonnet 4.6"],
  ["sophnet-anthropic/claude-haiku-4-5-20251001", "Claude Haiku 4.5"],
  ["openrouter/stealth/ox-alpha", "Ox Alpha"],
  ["openrouter-responses/stealth/ox-alpha", "Ox Alpha"],
]);

function modelInfo(id: string, displayName: string, ladder: readonly string[], imageInput: boolean, contextWindow?: number): AnthropicModelInfo {
  return {
    id,
    display_name: displayName,
    type: "model",
    created_at: MODEL_INFO_CREATED_AT,
    capabilities: modelCapabilities(ladder, imageInput),
    max_input_tokens: typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : null,
    max_tokens: null,
  };
}

/**
 * Which id family the discovery list carries (devlog 050): Claude Code (CLI)
 * gets readable `claude-ocx-*` ids; Claude Desktop keeps the hashed
 * `claude-opus-4-8-<code>` family its 3P config was written with. Both families
 * decode in resolveInboundModel regardless of the style served here.
 */
export type AnthropicIdStyle = "desktop3p" | "readable";

/** Build the full anthropic-flavor discovery list (ids are Desktop 3P aliases). */
export function buildAnthropicModelInfos(
  nativeSlugs: readonly string[],
  routedModels: readonly CatalogModel[],
  auto: AutoContextMode = AUTO_CONTEXT_OFF,
  idStyle: AnthropicIdStyle = "desktop3p",
  aliasForRoute: (provider: string, modelId: string) => string = desktop3pAlias,
): AnthropicModelInfo[] {
  const out: AnthropicModelInfo[] = [];
  const seen = new Set<string>();
  // Providers hidden from the Claude discovery list entirely. These carry models
  // that are ALSO exposed through another provider on the same upstream (e.g.
  // openrouter-responses mirrors openrouter for Codex/DSH responses-wire clients);
  // listing both mints duplicate picker rows for the same underlying model.
  const CLAUDE_DISCOVERY_HIDDEN_PROVIDERS: ReadonlySet<string> = new Set(["openrouter-responses"]);
  // Operator opt-in (2026-08-27): models whose AUTHORITATIVE window is < 1M but the
  // operator explicitly wants the [1m] picker row anyway, accepting that Claude Code
  // will then account 1M and the HUMAN compacts manually before the real limit
  // (gpt-5.3-codex 400K / gpt-5.4 320K upstream). Rationale: the alternative for
  // unrecognized ids is CC's conservative 200K window enforcement (startup warning
  // + premature compaction), which halves the usable window. Every id listed here
  // must have a real window >= 320K so the over-fill risk is bounded.
  const MANUAL_1M_ROWS: ReadonlySet<string> = new Set([
    "sophnet-responses/gpt-5.3-codex",
    "sophnet/gpt-5.4",
  ]);
  // Local UI-cleaning rule: for sophnet routes with an authoritative >=1M window,
  // emit ONLY the [1m] row. The ordinary row would otherwise appear twice in the
  // Claude Code picker (same model, 200k vs 1M accounting), which is noise here.
  // Other providers and native slugs keep the upstream paired-row behavior.
  // MANUAL_1M_ROWS entries follow the same only-the-[1m]-row shape.
  const oneMillionOnly = (provider: string, contextWindow: number | undefined, modelId: string): boolean =>
    ((provider === "sophnet" || provider === "sophnet-anthropic" || provider === "sophnet-responses"
      || provider === "openrouter" || provider === "openrouter-responses")
      && typeof contextWindow === "number" && contextWindow >= ONE_MILLION)
    || (typeof contextWindow === "number" && MANUAL_1M_ROWS.has(`${provider}/${modelId}`));
  // [1m] picker variant (devlog 260712 B1): Claude Code accounts exactly 1M for ids
  // carrying the marker (2.1.207 binary: /\[1m\]/i → 1e6, compaction preserved), so
  // ONLY models with an authoritative >=1M window get a second selectable row —
  // the auto-context widening that let a 372K route carry the marker (and be
  // over-filled) is the #854 defect and does not come back. Guards (audit R1#11):
  // same dedupe set, never double-suffix.
  const push1mVariant = (base: AnthropicModelInfo, contextWindow: number | undefined, manualKey?: string) => {
    // The [1m] marker makes Claude Code account 1e6 tokens for the row, so it
    // may only name models whose AUTHORITATIVE effective window is >= 1M —
    // never the auto-context widening, which would mark a 372K route and have
    // Claude Code over-fill it (the #854 defect). MANUAL_1M_ROWS entries are
    // the operator-opt-in exception: real window < 1M but >= 320K, human does
    // the compaction (see MANUAL_1M_ROWS above).
    const manual1m = manualKey !== undefined && MANUAL_1M_ROWS.has(manualKey);
    if (!manual1m && (contextWindow === undefined || contextWindow < ONE_MILLION)) return;
    if (base.id.includes("[1m]")) return;
    const id = `${base.id}[1m]`;
    if (seen.has(id)) return;
    seen.add(id);
    const window = contextWindow as number;
    out.push({ ...base, id, display_name: base.display_name, max_input_tokens: ONE_MILLION });
  };
  for (const slug of nativeSlugs) {
    const id = idStyle === "readable" ? claudeCodeNativeAlias(slug) : aliasForRoute("native", slug);
    if (seen.has(id)) continue;
    seen.add(id);
    const info = modelInfo(id, `${slug} (native)`, nativeEffectiveLadder(slug), true, nativeOpenAiContextWindow(slug));
    out.push(info);
    push1mVariant(info, nativeOpenAiContextWindow(slug));
  }
  for (const m of routedModels) {
    if (CLAUDE_DISCOVERY_HIDDEN_PROVIDERS.has(m.provider)) continue;
    const id = idStyle === "readable" ? claudeCodeAlias(m.provider, m.id) : aliasForRoute(m.provider, m.id);
    if (seen.has(id)) continue;
    const ladder = Array.isArray(m.reasoningEfforts) ? m.reasoningEfforts : [];
    const imageInput = Array.isArray(m.inputModalities) ? m.inputModalities.includes("image") : false;
    const displayName = DISPLAY_NAME_OVERRIDES.get(`${m.provider}/${m.id}`) ?? `${m.id} (${m.provider})`;
    const info = modelInfo(id, displayName, ladder, imageInput, m.contextWindow);
    // Anthropic passthrough guard (audit 021 #3): never auto-widen canonical claude
    // routes - only a genuine >=1M window earns the variant row there.
    if (oneMillionOnly(m.provider, m.contextWindow, m.id)) {
      push1mVariant(info, m.contextWindow, `${m.provider}/${m.id}`);
    } else {
      seen.add(id);
      out.push(info);
      push1mVariant(info, m.contextWindow, `${m.provider}/${m.id}`);
    }
  }
  return out;
}
