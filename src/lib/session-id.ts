/**
 * Deterministic session-id shaping for prompt-cache affinity.
 *
 * Upstreams that key prompt caching on a `session_id` header expect a uuid-shaped value. The
 * proxy derives its per-session cache keys as 32-hex SHA-256 digests, so this helper formats one
 * into a stable uuid shape (version nibble forced to 4, variant nibble forced to 8-b) — the same
 * value every time for a given key, so repeated turns of one conversation pin to one session id
 * without persisting any state.
 */
export function uuidFromHex(hex32: string): string {
  const h = (hex32 + "0".repeat(32)).slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
