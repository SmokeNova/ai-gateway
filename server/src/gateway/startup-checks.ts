// Server mode refuses to start on settings that are unsafe for a public
// deployment. Each check names the variable and the expected value, so a
// failed boot says exactly what to fix.
import type { Config } from '../lib/config.js';
import type { GatewayEnv } from './env.js';

const TRUTHY = /^(1|true|yes)$/i;

export function serverModeProblems(config: Config, gw: GatewayEnv, env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];

  if (gw.adminPort === null) {
    problems.push('GATEWAY_ADMIN_PORT must be set to a valid port (e.g. 3002)');
  } else if (gw.adminPort === Number(config.port)) {
    problems.push(`GATEWAY_ADMIN_PORT (${gw.adminPort}) must differ from PORT (${config.port})`);
  }
  if (!gw.configPath) problems.push('GATEWAY_CONFIG_PATH must point at gateway.config.json');

  if (config.nodeEnv !== 'production') {
    problems.push('NODE_ENV must be "production" (otherwise 5xx error details are returned to clients)');
  }

  const key = env.ENCRYPTION_KEY?.trim() ?? '';
  if (!/^[0-9a-f]{64}$/i.test(key) || /^0+$/.test(key)) {
    problems.push('ENCRYPTION_KEY must be a real 64-char hex key (not empty, not a placeholder)');
  }

  const tp = config.trustProxy;
  const trustsSpecificProxies = (typeof tp === 'number' && tp >= 1) || (Array.isArray(tp) && tp.length > 0);
  if (!trustsSpecificProxies) {
    problems.push('TRUST_PROXY must be 1 (one proxy hop) or a list of proxy addresses, never unset or "true"');
  }

  if (config.allowedHosts.length === 0 || config.allowedHosts.includes('*')) {
    problems.push('ALLOWED_HOSTS must list the public and admin hostnames (no "*")');
  }

  if (!TRUTHY.test(env.FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS ?? '')) {
    problems.push('FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS must be "true" (blocks server-side fetches to private addresses)');
  }
  if (env.FREEAPI_DESKTOP?.trim()) {
    problems.push('FREEAPI_DESKTOP must be unset (desktop mode trusts local requests)');
  }
  const handoff = env.FREELLMAPI_CONTEXT_HANDOFF?.trim().toLowerCase();
  if (handoff && handoff !== 'off') {
    problems.push('FREELLMAPI_CONTEXT_HANDOFF must be unset or "off" (it carries context between requests)');
  }
  if (TRUTHY.test(env.RESPONSE_CACHE ?? '')) {
    problems.push('RESPONSE_CACHE must be off (cached answers could be served across end users)');
  }

  return problems;
}

export function assertServerModeSafe(config: Config, gw: GatewayEnv, env: NodeJS.ProcessEnv = process.env): void {
  const problems = serverModeProblems(config, gw, env);
  if (problems.length > 0) {
    throw new Error(`GATEWAY_SERVER_MODE is on but the configuration is unsafe:\n  - ${problems.join('\n  - ')}`);
  }
}
