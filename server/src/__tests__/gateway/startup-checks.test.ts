import { describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../../lib/config.js';
import { readGatewayEnv } from '../../gateway/env.js';
import { serverModeProblems, assertServerModeSafe } from '../../gateway/startup-checks.js';
import { loadGatewayRuntime } from '../../gateway/app.js';

const SAFE_ENV: NodeJS.ProcessEnv = {
  GATEWAY_SERVER_MODE: '1',
  GATEWAY_ADMIN_PORT: '3002',
  GATEWAY_CONFIG_PATH: '/srv/gateway/gateway.config.json',
  ENCRYPTION_KEY: 'ab'.repeat(32),
  FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS: 'true',
};

function safeConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig(),
    port: 3001,
    nodeEnv: 'production',
    trustProxy: 1,
    allowedHosts: ['gw.example.com', 'gateway.tailnet.ts.net'],
    ...overrides,
  };
}

function problemsFor(envOverrides: NodeJS.ProcessEnv = {}, configOverrides: Partial<Config> = {}) {
  const env = { ...SAFE_ENV, ...envOverrides };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return serverModeProblems(safeConfig(configOverrides), readGatewayEnv(env), env);
}

describe('server-mode startup checks', () => {
  it('accepts a safe configuration', () => {
    expect(problemsFor()).toEqual([]);
  });

  it.each([
    ['missing admin port', { GATEWAY_ADMIN_PORT: undefined }, {}, 'GATEWAY_ADMIN_PORT'],
    ['admin port equal to public port', { GATEWAY_ADMIN_PORT: '3001' }, {}, 'must differ from PORT'],
    ['missing config path', { GATEWAY_CONFIG_PATH: undefined }, {}, 'GATEWAY_CONFIG_PATH'],
    ['placeholder encryption key', { ENCRYPTION_KEY: 'your-64-char-hex-key-here' }, {}, 'ENCRYPTION_KEY'],
    ['all-zero encryption key', { ENCRYPTION_KEY: '0'.repeat(64) }, {}, 'ENCRYPTION_KEY'],
    ['SSRF guard off', { FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS: undefined }, {}, 'FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS'],
    ['desktop mode', { FREEAPI_DESKTOP: '1' }, {}, 'FREEAPI_DESKTOP'],
    ['context handoff on', { FREELLMAPI_CONTEXT_HANDOFF: 'on_model_switch' }, {}, 'FREELLMAPI_CONTEXT_HANDOFF'],
    ['response cache on', { RESPONSE_CACHE: 'true' }, {}, 'RESPONSE_CACHE'],
    ['not production', {}, { nodeEnv: 'development' }, 'NODE_ENV'],
    ['trust proxy off', {}, { trustProxy: false }, 'TRUST_PROXY'],
    ['trust every proxy', {}, { trustProxy: true }, 'TRUST_PROXY'],
    ['trust two hops', {}, { trustProxy: 2 }, 'TRUST_PROXY'],
    ['trust a catch-all list', {}, { trustProxy: ['0.0.0.0/0'] }, 'TRUST_PROXY'],
    ['no allowed hosts', {}, { allowedHosts: [] }, 'ALLOWED_HOSTS'],
    ['wildcard allowed hosts', {}, { allowedHosts: ['*'] }, 'ALLOWED_HOSTS'],
  ] as const)('rejects %s', (_label, env, config, expected) => {
    const problems = problemsFor(env as NodeJS.ProcessEnv, config as Partial<Config>);
    expect(problems.join('\n')).toContain(expected);
  });

  it('context handoff explicitly "off" is fine', () => {
    expect(problemsFor({ FREELLMAPI_CONTEXT_HANDOFF: 'off' })).toEqual([]);
  });

  it('throws one error listing every problem', () => {
    const env = { ...SAFE_ENV, ENCRYPTION_KEY: '', FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS: '' };
    expect(() => assertServerModeSafe(safeConfig(), readGatewayEnv(env), env))
      .toThrow(/ENCRYPTION_KEY[\s\S]*FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS/);
  });

  it('server mode off: no checks, no runtime (upstream behaviour)', () => {
    expect(loadGatewayRuntime(safeConfig({ nodeEnv: 'development' }), {})).toBeNull();
  });

  it('server mode on with an unsafe environment stops the boot', () => {
    expect(() => loadGatewayRuntime(safeConfig(), { ...SAFE_ENV, ENCRYPTION_KEY: '' })).toThrow(/unsafe/);
  });
});
