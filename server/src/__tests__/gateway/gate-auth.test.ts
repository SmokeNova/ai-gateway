// App keys on the public port: checked before the body is read, profile keys only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { call, mintAppKey, startGatewayHarness, type GatewayHarness } from './helpers.js';

let h: GatewayHarness;
let chatKey: string;
let sttKey: string;
let unconfiguredKey: string;
let disabledKey: string;

beforeAll(async () => {
  h = await startGatewayHarness();
  chatKey = mintAppKey('chat-app');
  sttKey = mintAppKey('stt-app');
  unconfiguredKey = mintAppKey('not-in-config');
  disabledKey = mintAppKey('chat-app', false);
});
afterAll(() => h.close());

/**
 * Send headers announcing a big body, write only a few bytes, and wait for the
 * response. If the gate answered without waiting for the body, the response
 * arrives while the body is still incomplete.
 */
function answerWithoutBody(path: string, contentLength: number, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const url = new URL(h.publicUrl);
    const req = httpRequest({
      host: url.hostname, port: url.port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(contentLength), ...headers },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { req.destroy(); resolve({ status: res.statusCode ?? 0, body }); });
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') reject(err);
    });
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('gate waited for the body')); });
    req.write('{"model":"lane:fast"');
  });
}

describe('key check before body', () => {
  it('an anonymous 20 MB upload is rejected (401) without the body being sent', async () => {
    const res = await answerWithoutBody('/v1/audio/transcriptions', 20 * 1024 * 1024);
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe('invalid_api_key');
  });

  it('a body over the endpoint limit is rejected (413) from Content-Length alone', async () => {
    const res = await answerWithoutBody('/v1/chat/completions', 9 * 1024 * 1024, { Authorization: `Bearer ${chatKey}` });
    expect(res.status).toBe(413);
  });

  it('a wrong-endpoint key is rejected (403) before the body is sent', async () => {
    const res = await answerWithoutBody('/v1/audio/transcriptions', 5 * 1024 * 1024, { Authorization: `Bearer ${chatKey}` });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('endpoint_not_allowed');
  });
});

describe('which keys are accepted publicly', () => {
  const chat = { model: 'lane:fast', messages: [{ role: 'user', content: 'hi' }] };

  it('no key → 401', async () => {
    const res = await call(h.publicUrl, 'POST', '/v1/chat/completions', { body: chat });
    expect(res.status).toBe(401);
  });

  it('the unified key (full access) → 401 on the public port', async () => {
    const res = await call(h.publicUrl, 'POST', '/v1/chat/completions', { key: h.unifiedKey, body: chat });
    expect(res.status).toBe(401);
    const models = await call(h.publicUrl, 'GET', '/v1/models', { key: h.unifiedKey });
    expect(models.status).toBe(401);
  });

  it('the unified key still works on the admin port', async () => {
    const res = await call(h.adminUrl, 'GET', '/v1/models', { key: h.unifiedKey });
    expect(res.status).toBe(200);
  });

  it('a disabled app key → 401', async () => {
    const res = await call(h.publicUrl, 'POST', '/v1/chat/completions', { key: disabledKey, body: chat });
    expect(res.status).toBe(401);
  });

  it('a valid key with no gateway policy → 403 app_not_configured', async () => {
    const res = await call(h.publicUrl, 'POST', '/v1/chat/completions', { key: unconfiguredKey, body: chat });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('app_not_configured');
  });

  it('x-api-key works like upstream (same extraction order)', async () => {
    const res = await call(h.publicUrl, 'GET', '/v1/models', { headers: { 'x-api-key': chatKey } });
    expect(res.status).toBe(200);
  });

  it('a configured app key reaches upstream', async () => {
    const res = await call(h.publicUrl, 'POST', '/v1/chat/completions', { key: chatKey, body: chat });
    // Upstream answered (the test chain does not exist), so the gate let it through.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('gwtest-missing');
  });

  it('two enabled keys sharing an app name → 403 app_ambiguous (fail closed)', async () => {
    const first = mintAppKey('embed-app');
    const second = mintAppKey('embed-app');
    for (const key of [first, second]) {
      const res = await call(h.publicUrl, 'GET', '/v1/models', { key });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('app_ambiguous');
    }
  });

  it('a compressed body → 415 (it would inflate past the size check)', async () => {
    const res = await call(h.publicUrl, 'POST', '/v1/chat/completions', {
      key: chatKey, body: chat, headers: { 'Content-Encoding': 'gzip' },
    });
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('unsupported_encoding');
  });

  it('a chunked body over the limit → 413 from the parser', async () => {
    const big = JSON.stringify({ ...chat, pad: 'x'.repeat(9 * 1024 * 1024) });
    const res = await fetch(`${h.publicUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${chatKey}` },
      // A stream body has no Content-Length, so it goes out chunked.
      body: new Blob([big]).stream(),
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
  });

  it('an STT-only key cannot use chat', async () => {
    const res = await call(h.publicUrl, 'POST', '/v1/chat/completions', { key: sttKey, body: chat });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('endpoint_not_allowed');
  });
});
