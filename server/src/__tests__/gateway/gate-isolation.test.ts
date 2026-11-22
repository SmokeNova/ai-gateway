// Header hygiene and cross-request isolation, with the gate in front of a fake
// "upstream" that echoes what it received and sets internal response headers.
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGate } from '../../gateway/gate/index.js';
import { parseGatewayConfig } from '../../gateway/config.js';
import { assessProviderUrl } from '../../lib/url-guard.js';
import { initDb } from '../../db/index.js';
import { call, mintAppKey, TEST_CONFIG } from './helpers.js';

let server: Server;
let baseUrl: string;
let key: string;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY ??= '0'.repeat(64);
  initDb(':memory:');
  key = mintAppKey('chat-app');
  const app = express();
  // adminPort 1: never the port these requests arrive on, so everything is public.
  app.use(createGate({ adminPort: 1, config: parseGatewayConfig(TEST_CONFIG) }));
  app.use(express.json());
  app.post('/v1/chat/completions', (req, res) => {
    res.setHeader('X-Routed-Via', 'groq/key-3');
    res.setHeader('X-Provider', 'groq');
    res.setHeader('X-Model', 'llama');
    res.setHeader('X-Fallback-Trail', 'a,b');
    res.setHeader('X-FreeLLM-Cache', 'MISS');
    res.setHeader('X-Request-ID', 'kept');
    res.writeHead(200, { 'X-Ratelimit-Remaining': '5', 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ headers: req.headers, body: req.body }));
  });
  server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

const firstMessage = { model: 'lane:fast', messages: [{ role: 'user', content: 'Hello, same opener for everyone' }] };

describe('request headers', () => {
  it('drops behaviour-changing headers and forces cache off', async () => {
    const res = await call(baseUrl, 'POST', '/v1/chat/completions', {
      key, body: firstMessage,
      headers: {
        'X-FreeLLM-Cache': 'force',
        'X-FreeLLM-Routing-Strategy': 'fastest',
        'X-FreeLLM-Compress': 'on',
        'X-FreeLLM-Task-Type': 'code',
        'Idempotency-Key': 'replay-me',
        'Anthropic-Version': '2023-06-01',
        'X-Request-ID': 'client-chosen',
        'Cache-Control': 'max-age=60',
        'X-Some-Future-Header': '1',
        'User-Agent': 'my-app/1.0',
      },
    });
    expect(res.status).toBe(200);
    const seen = res.body.headers as Record<string, string>;
    for (const name of ['x-freellm-cache', 'x-freellm-routing-strategy', 'x-freellm-compress', 'x-freellm-task-type',
      'idempotency-key', 'anthropic-version', 'x-request-id', 'x-some-future-header']) {
      expect(seen, name).not.toHaveProperty(name);
    }
    expect(seen['cache-control']).toBe('no-store');
    expect(seen['user-agent']).toBe('my-app/1.0');
    expect(seen.authorization).toBe(`Bearer ${key}`);
    expect(res.body.body.model).toBe('auto:gwtest-missing');
  });

  it('two requests with the same opener and the same client session id get different session ids', async () => {
    const opts = { key, body: firstMessage, headers: { 'X-Session-Id': 'shared-by-two-users' } };
    const a = await call(baseUrl, 'POST', '/v1/chat/completions', opts);
    const b = await call(baseUrl, 'POST', '/v1/chat/completions', opts);
    const sa = a.body.headers['x-session-id'];
    const sb = b.body.headers['x-session-id'];
    expect(sa).toMatch(/^gw-[0-9a-f-]{36}$/);
    expect(sb).toMatch(/^gw-[0-9a-f-]{36}$/);
    expect(sa).not.toBe(sb);
  });
});

describe('response headers', () => {
  it('removes internal routing details, keeps the rest', async () => {
    const res = await call(baseUrl, 'POST', '/v1/chat/completions', { key, body: firstMessage });
    for (const name of ['x-routed-via', 'x-provider', 'x-model', 'x-fallback-trail', 'x-freellm-cache', 'x-ratelimit-remaining']) {
      expect(res.headers.get(name), name).toBeNull();
    }
    expect(res.headers.get('x-request-id')).toBe('kept');
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

describe('SSRF guard (upstream, required on by the startup checks)', () => {
  it('refuses image URLs pointing at loopback, the admin port, private and Tailscale ranges', async () => {
    const previous = process.env.FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS;
    process.env.FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS = 'true';
    try {
      for (const url of [
        'http://127.0.0.1:3002/api/keys',
        'http://localhost:3002/',
        'http://10.0.0.5/',
        'http://192.168.1.10/',
        'http://169.254.169.254/latest/meta-data/',
        'http://100.101.102.103/', // Tailscale CGNAT range
      ]) {
        expect((await assessProviderUrl(url)).allowed, url).toBe(false);
      }
    } finally {
      if (previous === undefined) delete process.env.FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS;
      else process.env.FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS = previous;
    }
  });
});
