// Spike for the M1 design: the gate wraps upstream's createApp() (no app.ts
// edit), the two listeners get different roles, and upstream sees the body the
// gate parsed and rewrote (its own parsers skip an already-parsed body).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, mintAppKey, startGatewayHarness, type GatewayHarness } from './helpers.js';

let h: GatewayHarness;
let chatKey: string;

beforeAll(async () => {
  h = await startGatewayHarness();
  chatKey = mintAppKey('chat-app');
});
afterAll(() => h.close());

describe('outer app around upstream createApp()', () => {
  it('serves upstream routes on the admin port', async () => {
    const res = await call(h.adminUrl, 'GET', '/api/ping');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('hides the same upstream routes on the public port', async () => {
    const res = await call(h.publicUrl, 'GET', '/api/ping');
    expect(res.status).toBe(404);
  });

  it('upstream routes the lane rewritten by the gate, not what the client sent', async () => {
    // lane:fast → auto:gwtest-missing, a profile that doesn't exist, so
    // upstream's router answers with an error naming the rewritten profile.
    const res = await call(h.publicUrl, 'POST', '/v1/chat/completions', {
      key: chatKey,
      body: { model: 'lane:fast', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("Profile 'gwtest-missing' not found");
    expect(JSON.stringify(res.body)).not.toContain('lane:fast');
  });
});
