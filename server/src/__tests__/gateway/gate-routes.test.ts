// Public allowlist, port roles and the everywhere-blocklist.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { call, mintAppKey, startGatewayHarness, type GatewayHarness } from './helpers.js';
import { isBlockedEverywhere, matchPublicRoute, normalisePath } from '../../gateway/gate/routes.js';

let h: GatewayHarness;
let chatKey: string;

beforeAll(async () => {
  h = await startGatewayHarness();
  chatKey = mintAppKey('chat-app');
});
afterAll(() => h.close());

describe('route matching (unit)', () => {
  it('matches only exact method + path', () => {
    expect(matchPublicRoute('POST', '/v1/chat/completions')?.endpoint).toBe('chat');
    for (const [m, u] of [
      ['GET', '/v1/chat/completions'],
      ['HEAD', '/v1/models'],
      ['POST', '/V1/chat/completions'],
      ['POST', '/v1/chat/completions/'],
      ['POST', '/v1//chat/completions'],
      ['POST', '/v1/v1/chat/completions'],
      ['POST', '/v1/chat/completions?x=1'],
      ['POST', '/v1/chat%2Fcompletions'],
      ['POST', '/v1/completions'],
      ['POST', '/v1/responses'],
      ['POST', '/v1/messages'],
    ]) {
      expect(matchPublicRoute(m, u), `${m} ${u}`).toBeNull();
    }
  });

  it('normalises like a lenient router before checking the blocklist', () => {
    expect(normalisePath('/API//Update/')).toBe('/api/update');
    expect(normalisePath('/v1/v1/t/abc')).toBe('/v1/t/abc');
    expect(normalisePath('/api/%75pdate')).toBe('/api/update');
    expect(normalisePath('/%E0%A4%A')).toBeNull();
  });

  it.each([
    '/api/update', '/api/update/apply', '/API/Update', '/api/%75pdate',
    '/api/premium/license', '/api/auth/desktop-session',
    '/v1/t/sometoken/chat/completions', '/v1/v1/t/x', '/v1beta/models', '/mcp', '/mcp/', '//mcp',
    '/api/tags', '/api/chat', '/api/generate', '/api/embed', '/api/show', '/api/version',
    '/%E0%A4%A',
    'http://gw.example.com/api/update', 'http://127.0.0.1:3002/api/ping', '*',
  ])('blocks %s everywhere', (url) => {
    expect(isBlockedEverywhere(url)).toBe(true);
  });

  it.each(['/api/embeddings', '/api/auth/login', '/api/ping', '/v1/transcriptions', '/mcpx', '/v1/tts'])(
    'does not block %s', (url) => {
      expect(isBlockedEverywhere(url)).toBe(false);
    },
  );
});

describe('public port', () => {
  it.each([
    ['GET', '/'],
    ['GET', '/api/ping'],
    ['GET', '/readyz'],
    ['GET', '/v1/docs'],
    ['GET', '/v1/providers'],
    ['POST', '/v1/completions'],
    ['POST', '/v1/responses'],
    ['POST', '/v1/messages'],
    ['POST', '/v1/moderations'],
    ['POST', '/V1/chat/completions'],
    ['POST', '/v1/chat/completions/'],
    ['POST', '/v1/v1/chat/completions'],
    ['GET', '/v1/models/'],
    ['GET', '/assets/index.js'],
  ])('%s %s → 404 even with a valid app key', async (method, path) => {
    const res = await call(h.publicUrl, method, path, { key: chatKey, body: method === 'POST' ? {} : undefined });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'Not found', type: 'not_found_error', code: 'not_found' } });
  });

  it('HEAD on an allowed GET path is 404', async () => {
    const res = await fetch(`${h.publicUrl}/v1/models`, { method: 'HEAD', headers: { Authorization: `Bearer ${chatKey}` } });
    expect(res.status).toBe(404);
  });

  it('/livez answers {status} only, no key needed', async () => {
    const res = await call(h.publicUrl, 'GET', '/livez');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('does not advertise the framework', async () => {
    const res = await call(h.publicUrl, 'GET', '/livez');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});

describe('admin port', () => {
  it('passes upstream routes through', async () => {
    expect((await call(h.adminUrl, 'GET', '/api/ping')).status).toBe(200);
    const livez = await call(h.adminUrl, 'GET', '/livez');
    expect(livez.status).toBe(200);
    expect(livez.body).toHaveProperty('uptime_s'); // upstream's full body, for the compose healthcheck
  });

  it.each(['/api/update/check', '/api/premium/status', '/api/auth/desktop-session', '/mcp', '/v1beta/models', '/api/tags', '/v1/t/x/models'])(
    'still blocks %s', async (path) => {
      expect((await call(h.adminUrl, 'GET', path)).status).toBe(404);
    },
  );
});

describe('absolute-form request targets', () => {
  it('are rejected on the admin port too (Express would route them by pathname)', async () => {
    const url = new URL(h.adminUrl);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: url.hostname, port: url.port, method: 'GET', path: `http://127.0.0.1:${url.port}/api/ping` },
        (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(404);
  });
});

describe('port role is deny-by-default', () => {
  it('a request that arrives on any port other than the admin port gets public rules', async () => {
    // The public listener is "some other port": upstream's dashboard API is not there.
    expect((await call(h.publicUrl, 'GET', '/api/auth/status')).status).toBe(404);
  });

  it('a Host header naming the admin port does not grant admin', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const url = new URL(h.publicUrl);
      const req = httpRequest({
        host: url.hostname, port: url.port, path: '/api/ping', method: 'GET',
        headers: { Host: `127.0.0.1:${h.adminPort}` },
      }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(404);
  });
});
