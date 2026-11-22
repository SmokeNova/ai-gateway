// Lane allowlist, rewrite and the per-key model list.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, mintAppKey, startGatewayHarness, type GatewayHarness } from './helpers.js';

let h: GatewayHarness;
let chatKey: string;
let embedKey: string;

beforeAll(async () => {
  h = await startGatewayHarness();
  chatKey = mintAppKey('chat-app');
  embedKey = mintAppKey('embed-app');
});
afterAll(() => h.close());

const chat = (model: unknown) => ({ model, messages: [{ role: 'user', content: 'hi' }] });

describe('lane allowlist', () => {
  it.each([
    ['a raw upstream model id', 'llama-3.3-70b-versatile'],
    ['plain auto', 'auto'],
    ['an upstream alias', 'auto:fast'],
    ['an upstream profile name', 'auto:gwtest-smart'],
    ['fusion (fans out to many models)', 'fusion'],
    ['a lane this app does not have', 'lane:embed-test'],
    ['an undefined lane', 'lane:nope'],
    ['a prototype key', 'constructor'],
  ])('rejects %s with 403 lane_not_allowed', async (_label, model) => {
    const res = await call(h.publicUrl, 'POST', '/v1/chat/completions', { key: chatKey, body: chat(model) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('lane_not_allowed');
  });

  it('missing model → 400', async () => {
    const res = await call(h.publicUrl, 'POST', '/v1/chat/completions', { key: chatKey, body: { messages: [] } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('model_required');
  });

  it('non-JSON body → 400', async () => {
    const res = await call(h.publicUrl, 'POST', '/v1/chat/completions', { key: chatKey, body: '{oops' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_json');
  });

  it('JSON array body → 400', async () => {
    const res = await call(h.publicUrl, 'POST', '/v1/chat/completions', { key: chatKey, body: [1, 2] });
    expect(res.status).toBe(400);
  });

  it('wrong Content-Type → 400 (never parsed by upstream either)', async () => {
    const res = await call(h.publicUrl, 'POST', '/v1/chat/completions', {
      key: chatKey, body: JSON.stringify(chat('lane:fast')), headers: { 'Content-Type': 'text/plain' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_body');
  });

  it('rewrites a chat lane to its upstream chain', async () => {
    const res = await call(h.publicUrl, 'POST', '/v1/chat/completions', { key: chatKey, body: chat('lane:smart') });
    expect(JSON.stringify(res.body)).toContain("Profile 'gwtest-smart' not found");
  });

  it('rewrites an embeddings lane to its upstream family', async () => {
    const res = await call(h.publicUrl, 'POST', '/v1/embeddings', { key: embedKey, body: { model: 'lane:embed-test', input: 'hi' } });
    // Upstream rejects the unknown test family by name, proving it saw the rewrite.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toContain('gwtest-family');
    expect(JSON.stringify(res.body)).not.toContain('lane:embed-test');
  });

  it("another app's chat lane on the embeddings endpoint → 403", async () => {
    const res = await call(h.publicUrl, 'POST', '/v1/embeddings', { key: embedKey, body: { model: 'lane:fast', input: 'x' } });
    expect(res.status).toBe(403);
  });
});

describe('/v1/models', () => {
  it('lists exactly the lanes this app may use', async () => {
    const res = await call(h.publicUrl, 'GET', '/v1/models', { key: chatKey });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      object: 'list',
      data: [
        { id: 'lane:fast', object: 'model', created: 0, owned_by: 'gateway' },
        { id: 'lane:smart', object: 'model', created: 0, owned_by: 'gateway' },
      ],
    });
  });

  it('needs a key', async () => {
    expect((await call(h.publicUrl, 'GET', '/v1/models')).status).toBe(401);
  });
});
