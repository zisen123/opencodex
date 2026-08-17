/**
 * Validation for `OcxCustomModel.publicAlias` — the explicit bare public id a custom model
 * answers to in addition to its routed `<provider>/<modelId>` slug. The alias becomes the
 * Codex-facing catalog slug (the picker shows the bare id) and routes to the concrete
 * provider/modelId before any native OpenAI interpretation; the upstream wire id stays the
 * row's native `modelId`.
 *
 * The checks mirror the combo alias rules (src/combos/types.ts) with the one deliberate
 * difference: a bare alias never needs a separate native-family opt-in — configuring
 * `publicAlias` IS the explicit opt-in.
 */
import { POLICY_NAMESPACE } from "../routing/profile-namespace";
import { COMBO_NAMESPACE, resolveComboId } from "../combos";
import { hasOwnProvider } from "../config";
import type { OcxConfig } from "../types";

/** Bare public alias shape: one id-shaped segment, never a "/". */
export const CUSTOM_MODEL_PUBLIC_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface CustomModelAliasIssue {
  path: Array<string | number>;
  message: string;
}

/**
 * Cross-config alias checks shared by the CLI add path and the management API. `excludeId`
 * is the custom-model row being edited (its own stored alias must not collide with itself).
 */
export function customModelPublicAliasIssues(
  config: Pick<OcxConfig, "providers" | "combos" | "customModels">,
  alias: string,
  options: { excludeId?: string } = {},
): CustomModelAliasIssue[] {
  const issues: CustomModelAliasIssue[] = [];
  const trimmed = alias.trim();
  if (!CUSTOM_MODEL_PUBLIC_ALIAS_PATTERN.test(trimmed)) {
    issues.push({
      path: ["publicAlias"],
      message: "publicAlias must use letters, numbers, dot, underscore, or hyphen (max 64) and must not contain \"/\"",
    });
    return issues;
  }
  if (trimmed === POLICY_NAMESPACE) {
    issues.push({
      path: ["publicAlias"],
      message: `publicAlias must not use the reserved "${POLICY_NAMESPACE}" routing namespace`,
    });
  }
  if (trimmed === COMBO_NAMESPACE) {
    issues.push({
      path: ["publicAlias"],
      message: `publicAlias must not use the reserved "${COMBO_NAMESPACE}" namespace`,
    });
  }
  if (hasOwnProvider(config.providers, trimmed)) {
    issues.push({
      path: ["publicAlias"],
      message: `publicAlias "${trimmed}" collides with configured provider name "${trimmed}"`,
    });
  }
  if (resolveComboId({ combos: config.combos }, trimmed) !== null) {
    issues.push({
      path: ["publicAlias"],
      message: `publicAlias "${trimmed}" is already used by a combo alias`,
    });
  }
  for (const other of config.customModels ?? []) {
    if (other.id === options.excludeId) continue;
    const otherAlias = typeof other.publicAlias === "string" ? other.publicAlias.trim() : "";
    if (otherAlias && otherAlias === trimmed) {
      issues.push({
        path: ["publicAlias"],
        message: `publicAlias "${trimmed}" is already used by custom model "${other.id}"`,
      });
    }
  }
  return issues;
}

/** Trimmed public alias of a custom-model row, or null when the row keeps its routed slug. */
export function customModelPublicAlias(model: { publicAlias?: unknown }): string | null {
  const alias = typeof model.publicAlias === "string" ? model.publicAlias.trim() : "";
  return alias || null;
}
