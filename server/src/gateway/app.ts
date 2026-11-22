// Server-mode app: the gateway gate in front of upstream's whole app.
//
// Wrapping createApp() instead of editing app.ts keeps upstream's busiest
// wiring file untouched. Upstream's JSON parsers skip a body the gate already
// parsed (body-parser sees the request stream already finished), so the gate's
// lane rewrite is what upstream's routes see.
import express from 'express';
import { createApp } from '../app.js';
import type { Config } from '../lib/config.js';
import { loadGatewayConfig, type GatewayConfig } from './config.js';
import { readGatewayEnv, type GatewayEnv } from './env.js';
import { createGate } from './gate/index.js';
import { assertServerModeSafe } from './startup-checks.js';

export interface GatewayRuntime {
  adminPort: number;
  /** Bind address for the admin port; null = same as the public HOST. */
  adminHost: string | null;
  config: GatewayConfig;
}

export function createGatewayApp(config: Config, runtime: GatewayRuntime) {
  const outer = express();
  outer.disable('x-powered-by');
  outer.use(createGate({ adminPort: runtime.adminPort, config: runtime.config }));
  outer.use(createApp(config));
  return outer;
}

/**
 * Boot-time entry point for index.ts. Returns null when server mode is off
 * (the process then runs exactly as upstream). Throws, and so stops the boot,
 * when server mode is on but the environment or gateway config is unsafe.
 */
export function loadGatewayRuntime(config: Config, env: NodeJS.ProcessEnv = process.env): GatewayRuntime | null {
  const gw: GatewayEnv = readGatewayEnv(env);
  if (!gw.serverMode) return null;
  assertServerModeSafe(config, gw, env);
  const gatewayConfig = loadGatewayConfig(gw.configPath!);
  warnAboutChains(gatewayConfig);
  return { adminPort: gw.adminPort!, adminHost: gw.adminHost, config: gatewayConfig };
}

/**
 * Chains are created in the dashboard after the first boot, so a missing one
 * can't stop the boot. Say which ones a lane needs, so a 400 "Profile not
 * found" later isn't a surprise.
 */
function warnAboutChains(config: GatewayConfig): void {
  const chains = Object.entries(config.lanes)
    .flatMap(([id, lane]) => (lane.endpoint === 'chat' ? [`${id} → ${lane.chain}`] : []));
  if (chains.length > 0) {
    console.log(`[gateway] chat lanes need these fallback chains in the dashboard: ${chains.join(', ')}`);
  }
}
