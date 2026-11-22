// Which paths exist on which port.
//
// Public port: an exact allowlist. Matching is done here on the raw URL, not by
// Express, because Express routing is case-insensitive and ignores trailing
// slashes — `/V1/Chat/Completions/` would otherwise reach the same handler.
//
// Every port: a blocklist of upstream routes that must never be reachable in
// server mode (self-update, licensing, local-trust shortcuts, alternative entry
// points that bypass per-app keys). Matched case-insensitively on a normalised
// path, because there Express's own loose matching is what we defend against.
import type { LaneEndpoint } from '../config.js';

export type PublicEndpoint = LaneEndpoint | 'models' | 'livez';

export interface PublicRoute {
  method: 'GET' | 'POST';
  path: string;
  endpoint: PublicEndpoint;
  /** Max request body in bytes (0 = no body expected). */
  bodyLimitBytes: number;
  /** Body is JSON and is parsed by the gate (lane rules need body.model). */
  json: boolean;
}

const MB = 1024 * 1024;

export const PUBLIC_ROUTES: readonly PublicRoute[] = [
  { method: 'POST', path: '/v1/chat/completions', endpoint: 'chat', bodyLimitBytes: 8 * MB, json: true },
  { method: 'POST', path: '/v1/audio/transcriptions', endpoint: 'transcriptions', bodyLimitBytes: 25 * MB, json: false },
  { method: 'POST', path: '/v1/embeddings', endpoint: 'embeddings', bodyLimitBytes: 1 * MB, json: true },
  { method: 'GET', path: '/v1/models', endpoint: 'models', bodyLimitBytes: 0, json: false },
  { method: 'GET', path: '/livez', endpoint: 'livez', bodyLimitBytes: 0, json: false },
];

/** Exact match: same method, same path, no query string, no trailing slash, case-sensitive. */
export function matchPublicRoute(method: string, rawUrl: string): PublicRoute | null {
  if (rawUrl.includes('?') || rawUrl.includes('#')) return null;
  return PUBLIC_ROUTES.find(r => r.method === method && r.path === rawUrl) ?? null;
}

/** Path prefixes blocked on every port (segment-aware: `/mcp` blocks `/mcp` and `/mcp/x`, not `/mcpx`). */
export const BLOCKED_PREFIXES: readonly string[] = [
  '/api/update', // self-update (can trigger an image update)
  '/api/premium', // licence + payment service
  '/api/auth/desktop-session', // desktop local-trust login
  '/v1/t', // URL-token route: injects the unified (all-powerful) key
  '/v1beta', // Gemini-native surface with its own key handling (?key=)
  '/mcp', // MCP server with state-changing tools, before admin auth
];

/** Exact paths blocked on every port: Ollama emulation (its own auth scheme). */
export const BLOCKED_EXACT: readonly string[] = [
  '/api/tags',
  '/api/version',
  '/api/show',
  '/api/chat',
  '/api/generate',
  '/api/embed',
];

/**
 * Normalise a URL path the way a lenient router might see it: decoded,
 * lower-case, repeated slashes collapsed, trailing slash dropped, a doubled
 * `/v1/v1` prefix collapsed (upstream forgives that, #1956). Returns null when
 * the path can't be decoded (such requests are rejected outright).
 */
export function normalisePath(rawUrl: string): string | null {
  const pathOnly = rawUrl.split(/[?#]/, 1)[0] ?? '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    return null;
  }
  let p = decoded.toLowerCase().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  while (p.startsWith('/v1/v1/') || p === '/v1/v1') p = p.slice(3);
  if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '');
  return p || '/';
}

export function isBlockedEverywhere(rawUrl: string): boolean {
  // Only origin-form targets ("/path"). Absolute-form ("http://host/api/update")
  // and asterisk-form ("*") targets are still routed by Express on their
  // pathname, so they would slip past the checks below; nothing legitimate
  // sends them to an origin server.
  if (!rawUrl.startsWith('/')) return true;
  const p = normalisePath(rawUrl);
  if (p === null) return true;
  if (BLOCKED_EXACT.includes(p)) return true;
  return BLOCKED_PREFIXES.some(prefix => p === prefix || p.startsWith(prefix + '/'));
}
