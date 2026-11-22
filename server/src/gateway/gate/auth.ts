// App authentication on the public port, before any body is read.
//
// Uses upstream's own token extraction and key resolution, so the gate accepts
// exactly what upstream's requireInferenceAuth would, then narrows it: only a
// per-app client-profile key, never the unified key (which can do everything).
import type { Request } from 'express';
import { extractApiToken } from '../../routes/proxy.js';
import { resolveAuth } from '../../lib/system-prompt.js';
import type { AppPolicy, GatewayConfig } from '../config.js';

export interface AuthenticatedApp {
  profileId: number;
  name: string;
  policy: AppPolicy;
}

export type AppAuthResult =
  | { ok: true; app: AuthenticatedApp }
  | { ok: false; reason: 'invalid_api_key' | 'app_not_configured' };

export function authenticateApp(req: Request, config: GatewayConfig): AppAuthResult {
  const auth = resolveAuth(extractApiToken(req));
  if (!auth || auth.kind !== 'profile') return { ok: false, reason: 'invalid_api_key' };
  // Own-property lookup only, so a profile named "constructor" or "__proto__"
  // can never pick up something from Object.prototype.
  const policy = Object.prototype.hasOwnProperty.call(config.apps, auth.name) ? config.apps[auth.name] : undefined;
  if (!policy) return { ok: false, reason: 'app_not_configured' };
  return { ok: true, app: { profileId: auth.profileId, name: auth.name, policy } };
}
