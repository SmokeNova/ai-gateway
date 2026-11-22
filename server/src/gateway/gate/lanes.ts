// Lane allowlist and rewrite.
//
// Upstream has no per-key model allowlist: any key can ask for any model,
// including `fusion` (fans one request out to many models). In server mode an
// app may only name lanes its policy lists, and the gate swaps the lane ID for
// the upstream target before upstream sees the body.
import type { GatewayConfig, Lane, LaneEndpoint } from '../config.js';
import type { AuthenticatedApp } from './auth.js';

/** Endpoints an app may call, derived from the endpoints of its lanes. */
export function allowedEndpoints(app: AuthenticatedApp, config: GatewayConfig): Set<LaneEndpoint> {
  const endpoints = new Set<LaneEndpoint>();
  for (const id of app.policy.lanes) {
    const lane = config.lanes[id];
    if (lane) endpoints.add(lane.endpoint);
  }
  return endpoints;
}

export function upstreamTarget(lane: Lane): string | null {
  switch (lane.endpoint) {
    case 'chat': return `auto:${lane.chain}`;
    case 'embeddings': return lane.family;
    case 'transcriptions': return null; // STT has no chains upstream; permitted by path
  }
}

export type LaneResult =
  | { ok: true; laneId: string; upstreamModel: string }
  | { ok: false; status: number; code: string; message: string };

export function resolveLane(
  model: unknown,
  endpoint: LaneEndpoint,
  app: AuthenticatedApp,
  config: GatewayConfig,
): LaneResult {
  if (typeof model !== 'string' || model.length === 0) {
    return { ok: false, status: 400, code: 'model_required', message: 'model is required and must be a lane ID, e.g. "lane:fast"' };
  }
  const allowed = app.policy.lanes.includes(model) && Object.prototype.hasOwnProperty.call(config.lanes, model);
  const lane = allowed ? config.lanes[model] : undefined;
  if (!lane) {
    return {
      ok: false, status: 403, code: 'lane_not_allowed',
      message: `"${model.slice(0, 100)}" is not a lane this key may use. Allowed: ${app.policy.lanes.join(', ')}`,
    };
  }
  if (lane.endpoint !== endpoint) {
    return {
      ok: false, status: 400, code: 'lane_wrong_endpoint',
      message: `${model} is a ${lane.endpoint} lane and can't be used on this endpoint`,
    };
  }
  const target = upstreamTarget(lane);
  if (!target) {
    return { ok: false, status: 400, code: 'lane_wrong_endpoint', message: `${model} has no target for this endpoint` };
  }
  return { ok: true, laneId: model, upstreamModel: target };
}
