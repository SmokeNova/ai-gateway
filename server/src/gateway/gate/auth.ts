// App authentication on the public port, before any body is read.
//
// Uses upstream's own token extraction and key resolution, so the gate accepts
// exactly what upstream's requireInferenceAuth would, then narrows it: only a
// per-app client-profile key, never the unified key (which can do everything).
import type { Request } from 'express';
import { extractApiToken } from '../../routes/proxy.js';
import { resolveAuth } from '../../lib/system-prompt.js';
import { getDb } from '../../db/index.js';
import type { AppPolicy, GatewayConfig } from '../config.js';

export interface AuthenticatedApp {
  profileId: number;
  name: string;
  policy: AppPolicy;
}

export type AppAuthResult =
  | { ok: true; app: AuthenticatedApp }
  | { ok: false; reason: 'invalid_api_key' | 'app_not_configured' | 'app_ambiguous' };

export function authenticateApp(req: Request, config: GatewayConfig): AppAuthResult {
  const auth = resolveAuth(extractApiToken(req));
  if (!auth || auth.kind !== 'profile') return { ok: false, reason: 'invalid_api_key' };
  // Own-property lookup only, so a profile named "constructor" or "__proto__"
  // can never pick up something from Object.prototype.
  const policy = Object.prototype.hasOwnProperty.call(config.apps, auth.name) ? config.apps[auth.name] : undefined;
  if (!policy) return { ok: false, reason: 'app_not_configured' };
  // Policies are keyed by profile name, which upstream doesn't keep unique.
  // Two enabled keys sharing a name would share a policy (and, from M3, its
  // limits), so fail closed until one is renamed or disabled.
  const sameName = getDb()
    .prepare('SELECT COUNT(*) AS n FROM client_profiles WHERE name = ? AND enabled = 1')
    .get(auth.name) as { n: number };
  if (sameName.n > 1) return { ok: false, reason: 'app_ambiguous' };
  return { ok: true, app: { profileId: auth.profileId, name: auth.name, policy } };
}
