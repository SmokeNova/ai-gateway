// The gateway gate: the first middleware every request meets in server mode.
//
// It runs before anything upstream does (host guard, helmet, CORS, body
// parsers, rate limiters, routers), so on the public port a request without a
// valid app key is rejected before its body is read. See
// docs/gateway/milestones/M1.md for the full flow.
import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { GatewayConfig } from '../config.js';
import { authenticateApp } from './auth.js';
import { sendGatewayError, sendNotFound } from './errors.js';
import { neutraliseRequestHeaders, stripInternalResponseHeaders } from './headers.js';
import { allowedEndpoints, resolveLane } from './lanes.js';
import { isBlockedEverywhere, matchPublicRoute, type PublicRoute } from './routes.js';

export interface GateOptions {
  adminPort: number;
  config: GatewayConfig;
}

export type PortRole = 'admin' | 'public';

/** Deny-by-default: only the configured admin port gets the admin role. */
export function portRole(req: Request, adminPort: number): PortRole {
  return req.socket.localPort === adminPort ? 'admin' : 'public';
}

export function createGate(options: GateOptions): RequestHandler {
  const { adminPort, config } = options;
  const jsonParsers = new Map<number, RequestHandler>();
  const jsonParser = (limit: number): RequestHandler => {
    let parser = jsonParsers.get(limit);
    if (!parser) {
      parser = express.json({ limit });
      jsonParsers.set(limit, parser);
    }
    return parser;
  };

  return function gatewayGate(req: Request, res: Response, next: NextFunction) {
    const url = req.originalUrl ?? req.url;
    if (isBlockedEverywhere(url)) return sendNotFound(res);
    if (portRole(req, adminPort) === 'admin') return next();
    handlePublic(req, res, next, url, config, jsonParser);
  };
}

function handlePublic(
  req: Request,
  res: Response,
  next: NextFunction,
  url: string,
  config: GatewayConfig,
  jsonParser: (limit: number) => RequestHandler,
): void {
  const route = matchPublicRoute(req.method, url);
  if (!route) return sendNotFound(res);

  stripInternalResponseHeaders(res);

  if (route.endpoint === 'livez') {
    res.status(200).json({ status: 'ok' });
    return;
  }

  if (!bodyWithinLimit(req, route)) {
    return sendGatewayError(res, 413, 'request_too_large', 'body_too_large',
      `Request body exceeds the ${Math.round(route.bodyLimitBytes / (1024 * 1024))} MB limit for ${route.path}`);
  }

  // Compressed request bodies are not supported: they'd be inflated past the
  // Content-Length check above.
  const encoding = String(req.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
  if (route.method === 'POST' && encoding !== 'identity') {
    return sendGatewayError(res, 415, 'invalid_request_error', 'unsupported_encoding',
      'Compressed request bodies are not supported (send without Content-Encoding)');
  }

  const auth = authenticateApp(req, config);
  if (!auth.ok) {
    if (auth.reason === 'app_not_configured') {
      return sendGatewayError(res, 403, 'permission_error', 'app_not_configured',
        'This key is valid but has no gateway policy. Add the app to gateway.config.json.');
    }
    if (auth.reason === 'app_ambiguous') {
      return sendGatewayError(res, 403, 'permission_error', 'app_ambiguous',
        'More than one enabled app key has this name; gateway policies need unique names.');
    }
    return sendGatewayError(res, 401, 'authentication_error', 'invalid_api_key', 'Invalid API key');
  }
  const app = auth.app;

  if (route.endpoint === 'models') {
    res.status(200).json({
      object: 'list',
      data: app.policy.lanes.map(id => ({ id, object: 'model', created: 0, owned_by: 'gateway' })),
    });
    return;
  }

  const endpoint = route.endpoint;
  if (!allowedEndpoints(app, config).has(endpoint)) {
    return sendGatewayError(res, 403, 'permission_error', 'endpoint_not_allowed',
      `This key has no lane for ${route.path}`);
  }

  neutraliseRequestHeaders(req);

  if (!route.json) return next(); // multipart STT: permitted by path, upstream parses it

  jsonParser(route.bodyLimitBytes)(req, res, (err?: unknown) => {
    if (err) return sendParseError(res, err);
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return sendGatewayError(res, 400, 'invalid_request_error', 'invalid_body',
        'Request body must be a JSON object (Content-Type: application/json)');
    }
    const lane = resolveLane(body.model, endpoint, app, config);
    if (!lane.ok) {
      const type = lane.status === 403 ? 'permission_error' : 'invalid_request_error';
      return sendGatewayError(res, lane.status, type, lane.code, lane.message);
    }
    body.model = lane.upstreamModel;
    res.locals.gateway = { app: app.name, profileId: app.profileId, lane: lane.laneId };
    next();
  });
}

function bodyWithinLimit(req: Request, route: PublicRoute): boolean {
  const raw = req.headers['content-length'];
  if (raw === undefined) return true; // chunked: bounded by Caddy and by the parser's limit
  const length = Number(raw);
  if (!Number.isFinite(length) || length < 0) return false;
  return length <= route.bodyLimitBytes;
}

function sendParseError(res: Response, err: unknown): void {
  const e = err as { type?: string; status?: number };
  if (e?.type === 'entity.too.large' || e?.status === 413) {
    return sendGatewayError(res, 413, 'request_too_large', 'body_too_large', 'Request body too large');
  }
  return sendGatewayError(res, 400, 'invalid_request_error', 'invalid_json', 'Request body is not valid JSON');
}
