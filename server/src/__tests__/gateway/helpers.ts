// Test harness: the server-mode app on two real ephemeral ports (public + admin),
// backed by an in-memory database, with helpers to mint app keys.
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { loadConfig } from '../../lib/config.js';
import { hashClientProfileKey, mintClientProfileKey } from '../../lib/system-prompt.js';
import { createGatewayApp } from '../../gateway/app.js';
import { parseGatewayConfig, type GatewayConfig } from '../../gateway/config.js';

export const TEST_CONFIG = {
  lanes: {
    'lane:fast': { endpoint: 'chat', chain: 'gwtest-missing', input: ['text', 'image'] },
    'lane:smart': { endpoint: 'chat', chain: 'gwtest-smart' },
    'lane:stt': { endpoint: 'transcriptions' },
    'lane:embed-test': { endpoint: 'embeddings', family: 'gwtest-family' },
  },
  apps: {
    'chat-app': { lanes: ['lane:fast', 'lane:smart'] },
    'stt-app': { lanes: ['lane:stt'] },
    'embed-app': { lanes: ['lane:embed-test'] },
  },
};

export interface GatewayHarness {
  publicUrl: string;
  adminUrl: string;
  adminPort: number;
  config: GatewayConfig;
  unifiedKey: string;
  close(): Promise<void>;
}

async function listenEphemeral(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as { port: number }).port;
}

export async function startGatewayHarness(rawConfig: unknown = TEST_CONFIG): Promise<GatewayHarness> {
  process.env.ENCRYPTION_KEY ??= '0'.repeat(64);
  initDb(':memory:');
  const config = parseGatewayConfig(rawConfig);

  // Bind both ports first so the gate can be told which one is the admin port.
  const publicServer = createServer();
  const adminServer = createServer();
  const publicPort = await listenEphemeral(publicServer);
  const adminPort = await listenEphemeral(adminServer);
  const app = createGatewayApp(loadConfig(), { adminPort, adminHost: null, config });
  publicServer.on('request', app);
  adminServer.on('request', app);

  return {
    publicUrl: `http://127.0.0.1:${publicPort}`,
    adminUrl: `http://127.0.0.1:${adminPort}`,
    adminPort,
    config,
    unifiedKey: getUnifiedApiKey(),
    async close() {
      publicServer.closeAllConnections?.();
      adminServer.closeAllConnections?.();
      await Promise.all([
        new Promise<void>(r => publicServer.close(() => r())),
        new Promise<void>(r => adminServer.close(() => r())),
      ]);
    },
  };
}

/** Create an enabled client profile (an app key) and return its plaintext key. */
export function mintAppKey(name: string, enabled = true): string {
  const key = mintClientProfileKey();
  const secret = encrypt(key);
  getDb().prepare(`INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, enabled)
    VALUES (?, ?, ?, ?, ?, ?)`).run(name, hashClientProfileKey(key), secret.encrypted, secret.iv, secret.authTag, enabled ? 1 : 0);
  return key;
}

export async function call(
  baseUrl: string,
  method: string,
  path: string,
  opts: { key?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.key ? { Authorization: `Bearer ${opts.key}` } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
  });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body, headers: res.headers };
}
