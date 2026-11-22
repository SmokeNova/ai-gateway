// Header hygiene for public requests.
//
// Requests: an ALLOWLIST. Upstream reads a growing set of headers that change
// behaviour (response cache, idempotency replay, session keys for reasoning
// memory, routing strategy, compression, task type…). A denylist would miss the
// next one upstream adds; an allowlist drops it by default.
//
// Responses: internal routing details (which provider, model, key or fallback
// trail served the request) are removed before they reach an app.
import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import type { Request, Response } from 'express';

const ALLOWED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-type',
  'content-length',
  'transfer-encoding',
  'accept',
  'accept-encoding',
  'user-agent',
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  // Set by Caddy (TRUST_PROXY=1 trusts exactly one hop).
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
]);

export function neutraliseRequestHeaders(req: Request): void {
  const headers = req.headers as IncomingHttpHeaders;
  for (const name of Object.keys(headers)) {
    if (!ALLOWED_REQUEST_HEADERS.has(name.toLowerCase())) delete headers[name];
  }
  // Turns upstream's response cache off for this request even if it was
  // enabled in the dashboard (services/cache.ts parseCacheDirective).
  headers['cache-control'] = 'no-store';
  // Reasoning memory is always on upstream and keyed by x-session-id (else by
  // a hash of the first user message). A fresh id per request means nothing
  // one end user sent can be restored into another end user's request.
  headers['x-session-id'] = `gw-${randomUUID()}`;
  // Keep rawHeaders consistent with the cleaned object for anything that
  // reads them (multer/busboy read the parsed object; this is belt and braces).
  const raw: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) raw.push(name, String(v));
  }
  (req as { rawHeaders: string[] }).rawHeaders = raw;
}

const INTERNAL_RESPONSE_HEADER = /^x-(routed-via|provider|model|fallback-|freellm-|ratelimit-)/i;

export function isInternalResponseHeader(name: string): boolean {
  return INTERNAL_RESPONSE_HEADER.test(name);
}

/** Remove internal headers right before the response head is written. */
export function stripInternalResponseHeaders(res: Response): void {
  const originalWriteHead = res.writeHead;
  res.writeHead = function patchedWriteHead(this: Response, statusCode: number, ...rest: unknown[]) {
    for (const name of this.getHeaderNames()) {
      if (isInternalResponseHeader(name)) this.removeHeader(name);
    }
    // writeHead(status, headers) or writeHead(status, reason, headers)
    const idx = typeof rest[0] === 'string' ? 1 : 0;
    const extra = rest[idx];
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
      const filtered: OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(extra as OutgoingHttpHeaders)) {
        if (!isInternalResponseHeader(k)) filtered[k] = v;
      }
      rest[idx] = filtered;
    }
    return (originalWriteHead as (...args: unknown[]) => Response).call(this, statusCode, ...rest);
  } as Response['writeHead'];
}
