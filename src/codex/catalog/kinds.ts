/** Stable ownership marker for a routed combo that deliberately owns a bare native slug. */
export const CODEX_NATIVE_ALIAS_CATALOG_KIND = "combo-native-alias-v1";
/**
 * Stable ownership marker for a routed custom model (`OcxCustomModel.publicAlias`) that
 * deliberately owns a bare catalog slug. Same takeover semantics as the combo native alias:
 * the bare row replaces the native row with the same slug, and routing resolves the bare id
 * to the custom model's provider/modelId before any native interpretation.
 */
export const CODEX_CUSTOM_ALIAS_CATALOG_KIND = "custom-native-alias-v1";
