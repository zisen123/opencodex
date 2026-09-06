import { resolveEnvValue } from "../config";
import type { OcxProviderConfig } from "../types";

/**
 * Effective outbound proxy URL for one provider (`providers.<name>.proxy`), resolved with the
 * same "${HTTPS_PROXY}"-style env-reference semantics as the global `proxy` field.
 *
 * `undefined` means "no provider-level override": the request keeps the existing process-wide
 * resolution — HTTP(S)_PROXY env, which `applyProxyEnv` mirrors `config.proxy` into — so a
 * provider without the field is byte-identical to before. A resolved URL is passed as Bun's
 * per-request fetch `proxy` option, which overrides the environment variables for that request
 * (but still yields to a matching NO_PROXY host entry, same as the env-driven path).
 */
export function providerOutboundProxyUrl(provider: Pick<OcxProviderConfig, "proxy">): string | undefined {
  const url = resolveEnvValue(provider.proxy)?.trim();
  return url ? url : undefined;
}

/** Spread into a fetch init to route it through the provider's proxy. Empty when unset. */
export function providerOutboundProxyInit(
  provider: Pick<OcxProviderConfig, "proxy">,
): { proxy?: string } {
  const url = providerOutboundProxyUrl(provider);
  return url ? { proxy: url } : {};
}
