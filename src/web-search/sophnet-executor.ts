import type { OcxProviderConfig } from "../types";
import { redactSecretString } from "../lib/redact";
import { signalWithTimeout } from "../lib/abort";
import { sidecarEnter } from "../lib/sidecar-tracker";
import type { SidecarOutcome, SidecarSettings } from "./executor";

/** Per-result content clamp so N results can't blow the tool_result budget (format-result clamps again downstream). */
const MAX_RESULT_CONTENT_CHARS = 600;
const MAX_RESULTS = 8;

interface SophnetSearchHit {
  title?: unknown;
  url?: unknown;
  content?: unknown;
}

interface SophnetSearchResponse {
  status?: unknown;
  message?: unknown;
  result?: unknown;
}

/**
 * Execute ONE web search via Sophnet's hosted search API (`/api/open-apis/moltbot/search/web`) —
 * the same endpoint the sophnet-search MCP wrapper uses. Unlike the openai/anthropic backends this
 * is a PURE SEARCH RESULTS API: there is no sidecar model synthesizing an answer, so `text` is the
 * formatted result list itself and `sources` carries every hit for citation rendering.
 *
 * Auth reuses the sophnet provider's `apiKey` (the same key its chat/responses channels use).
 * Never throws — returns `{error}` so the caller injects a graceful tool result.
 */
export async function runSophnetWebSearch(
  query: string,
  providerName: string,
  provider: OcxProviderConfig,
  settings: SidecarSettings,
  abortSignal?: AbortSignal,
): Promise<SidecarOutcome> {
  const apiKey = provider.apiKey?.trim();
  if (!apiKey) {
    return { text: "", sources: [], error: `provider "${providerName}" has no apiKey configured for the sophnet search backend` };
  }
  // Derive the search endpoint from the provider's own baseUrl so channel-path changes upstream
  // don't desync us: .../api/open-apis/<channel> -> <origin>/api/open-apis/moltbot/search/web.
  let url: string;
  try {
    url = new URL(provider.baseUrl).origin + "/api/open-apis/moltbot/search/web";
  } catch {
    return { text: "", sources: [], error: `provider "${providerName}" baseUrl is not a valid URL` };
  }

  const linkedSignal = signalWithTimeout(settings.timeoutMs, abortSignal);
  const sidecarExit = sidecarEnter("web-search-sophnet");
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
      signal: linkedSignal.signal,
      redirect: "manual",
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.warn(`[web-search] sophnet HTTP ${res.status} for query "${query.slice(0, 80)}" (${Date.now() - t0}ms)`);
      return { text: "", sources: [], error: `sophnet HTTP ${res.status}: ${redactSecretString(t.slice(0, 200))}` };
    }
    const data = (await res.json().catch(() => null)) as SophnetSearchResponse | null;
    if (!data || data.status !== 0) {
      const msg = data && typeof data.message === "string" ? redactSecretString(data.message.slice(0, 200)) : "malformed response";
      return { text: "", sources: [], error: `sophnet search failed: ${msg}` };
    }
    const hits = Array.isArray(data.result) ? (data.result as SophnetSearchHit[]).slice(0, MAX_RESULTS) : [];
    if (hits.length === 0) {
      return { text: `(no results found for: ${query})`, sources: [] };
    }
    const sources: SidecarOutcome["sources"] = [];
    const seen = new Set<string>();
    const lines: string[] = [`Web search results for: ${query}`, ""];
    let i = 0;
    for (const hit of hits) {
      const title = typeof hit?.title === "string" ? hit.title : "(no title)";
      const hitUrl = typeof hit?.url === "string" ? hit.url : "";
      const content = typeof hit?.content === "string" ? hit.content.trim() : "";
      i++;
      lines.push(`${i}. ${title}`);
      if (hitUrl) {
        lines.push(`   URL: ${hitUrl}`);
        if (!seen.has(hitUrl)) {
          seen.add(hitUrl);
          sources.push({ url: hitUrl, ...(title !== "(no title)" ? { title } : {}) });
        }
      }
      if (content) lines.push(`   ${content.slice(0, MAX_RESULT_CONTENT_CHARS)}${content.length > MAX_RESULT_CONTENT_CHARS ? "…" : ""}`);
      lines.push("");
    }
    return { text: lines.join("\n").trim(), sources };
  } catch (e) {
    const kind = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "connect_error";
    console.warn(`[web-search] sophnet ${kind} for query "${query.slice(0, 80)}" (${Date.now() - t0}ms)`);
    return { text: "", sources: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    sidecarExit();
    linkedSignal.cleanup();
  }
}
