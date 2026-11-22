// Gateway-specific environment. Everything this fork adds is read here, so the
// rest of server/src/gateway/ never touches process.env directly.

export interface GatewayEnv {
  /** GATEWAY_SERVER_MODE: run as a public server-to-server gateway. */
  serverMode: boolean;
  /** GATEWAY_ADMIN_PORT: the only port that gets admin (dashboard) access. */
  adminPort: number | null;
  /** GATEWAY_CONFIG_PATH: lanes and per-app policies (gateway.config.json). */
  configPath: string | null;
}

const TRUTHY = /^(1|true|yes|on)$/i;

export function readGatewayEnv(env: NodeJS.ProcessEnv = process.env): GatewayEnv {
  const rawPort = env.GATEWAY_ADMIN_PORT?.trim();
  const port = rawPort ? Number(rawPort) : NaN;
  return {
    serverMode: TRUTHY.test(env.GATEWAY_SERVER_MODE?.trim() ?? ''),
    adminPort: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
    configPath: env.GATEWAY_CONFIG_PATH?.trim() || null,
  };
}
