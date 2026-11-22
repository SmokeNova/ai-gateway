// Route inventory: a tripwire for upstream changes.
//
// 1. Every mount path in upstream's app.ts has a recorded decision. A new mount
//    fails this test, so the weekly upstream-sync PR forces a look at it.
// 2. Every route path literal in upstream's routers is tried on the public port
//    (bare, under /v1 and under /api) with a valid app key: anything outside the
//    public allowlist must be a 404. This one needs no maintenance: new upstream
//    routes are swept automatically.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PUBLIC_ROUTES } from '../../gateway/gate/routes.js';
import { call, mintAppKey, startGatewayHarness, type GatewayHarness } from './helpers.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

type Decision = 'admin' | 'blocked' | 'public-allowlisted-subpaths';

/** Decision per app.ts mount path. Public access is ONLY via PUBLIC_ROUTES. */
const MOUNT_DECISIONS: Record<string, Decision> = {
  '/api': 'admin',
  '/api/analytics': 'admin',
  '/api/auth': 'admin', // except /api/auth/desktop-session: blocked
  '/api/backups': 'admin',
  '/api/cache': 'admin',
  '/api/chat': 'blocked', // Ollama emulation
  '/api/client-profiles': 'admin',
  '/api/compression': 'admin',
  '/api/conversations': 'admin',
  '/api/decisions': 'admin',
  '/api/embed': 'blocked', // Ollama emulation
  '/api/embeddings': 'admin', // dashboard route (and Ollama legacy, governed by its off-by-default mode)
  '/api/fallback': 'admin',
  '/api/free-tier': 'admin',
  '/api/generate': 'blocked', // Ollama emulation
  '/api/health': 'admin',
  '/api/keys': 'admin',
  '/api/keys/export': 'admin',
  '/api/logs': 'admin',
  '/api/media': 'admin',
  '/api/models': 'admin',
  '/api/ping': 'admin',
  '/api/premium': 'blocked',
  '/api/profiles': 'admin',
  '/api/search': 'admin',
  '/api/settings': 'admin',
  '/api/show': 'blocked', // Ollama emulation
  '/api/tags': 'blocked', // Ollama emulation
  '/api/update': 'blocked',
  '/api/version': 'blocked', // Ollama emulation
  '/mcp': 'blocked',
  '/v1': 'public-allowlisted-subpaths',
  '/v1/t/:token': 'blocked',
  '/v1beta': 'blocked',
};

function appMountPaths(): string[] {
  const text = readFileSync(join(SRC, 'app.ts'), 'utf8');
  const paths = new Set<string>();
  const re = /app\.(?:use|get|post|put|patch|delete|all)\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/g;
  for (const m of text.matchAll(re)) {
    for (const p of m[1].matchAll(/['"]([^'"]+)['"]/g)) paths.add(p[1]);
  }
  return [...paths].sort();
}

function routerPathLiterals(): string[] {
  const paths = new Set<string>();
  const re = /\.(?:get|post|put|patch|delete|all)\(\s*['"](\/[^'"]*)['"]/g;
  for (const file of readdirSync(join(SRC, 'routes'))) {
    if (!file.endsWith('.ts')) continue;
    const text = readFileSync(join(SRC, 'routes', file), 'utf8');
    for (const m of text.matchAll(re)) paths.add(m[1].replace(/:[A-Za-z_]+\??/g, 'x').replace(/\*.*$/, 'x'));
  }
  return [...paths].sort();
}

describe('upstream mount points', () => {
  it('every app.ts mount path has a gateway decision', () => {
    const undecided = appMountPaths().filter(p => !(p in MOUNT_DECISIONS));
    expect(undecided, 'new upstream mount(s): add a decision to MOUNT_DECISIONS and, if blocked, to gate/routes.ts').toEqual([]);
  });

  it('decisions for mounts upstream no longer has are removed', () => {
    const present = new Set(appMountPaths());
    expect(Object.keys(MOUNT_DECISIONS).filter(p => !present.has(p))).toEqual([]);
  });
});

describe('public port sweep over every upstream route path', () => {
  let h: GatewayHarness;
  let key: string;
  beforeAll(async () => {
    h = await startGatewayHarness();
    key = mintAppKey('chat-app');
  });
  afterAll(() => h.close());

  it('only allowlisted method+path pairs are anything but 404', async () => {
    const allow = new Set(PUBLIC_ROUTES.map(r => `${r.method} ${r.path}`));
    const candidates = new Set<string>();
    for (const p of routerPathLiterals()) {
      for (const prefix of ['', '/v1', '/api']) candidates.add(`${prefix}${p === '/' ? '' : p}` || '/');
    }
    const leaks: string[] = [];
    for (const path of candidates) {
      for (const method of ['GET', 'POST']) {
        if (allow.has(`${method} ${path}`)) continue;
        const res = await call(h.publicUrl, method, path, { key, body: method === 'POST' ? {} : undefined });
        if (res.status !== 404) leaks.push(`${method} ${path} → ${res.status}`);
      }
    }
    expect(candidates.size).toBeGreaterThan(50); // the scan really found upstream's routes
    expect(leaks).toEqual([]);
  }, 120_000);
});
