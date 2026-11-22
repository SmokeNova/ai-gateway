// gateway.config.json: lane definitions and per-app policies.
//
// A lane is the public name an app asks for (`lane:fast`); it maps to an
// upstream target the app never sees. An app is an upstream client profile
// (sk-cp-… key), matched by its profile name.
import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const LANE_ID_RE = /^lane:[a-z0-9][a-z0-9-]{0,40}$/;
const laneId = z.string().regex(LANE_ID_RE, 'lane IDs look like "lane:fast" (lowercase letters, digits, dashes)');
const positiveInt = z.number().int().positive();

export const INPUT_MODALITIES = ['text', 'image', 'audio'] as const;

/**
 * Names upstream resolves BEFORE looking up a profile: `auto:<alias>` sorts the
 * whole catalog instead of using a chain (services/router.ts
 * GLOBAL_SORT_ALIASES), plus names upstream refuses for profiles
 * (routes/profiles.ts RESERVED_PROFILE_NAMES). A lane pointing at one of these
 * would silently route to every enabled model. Kept in sync by
 * __tests__/gateway/config.test.ts, which reads upstream's source.
 */
export const RESERVED_CHAIN_NAMES: readonly string[] = [
  'auto', 'default', 'active',
  'smart', 'smartest', 'intelligence',
  'fast', 'fastest', 'speed',
  'cheap', 'cheapest', 'price', 'budget',
  'reliable', 'reliability',
  'balanced',
];

const chatLane = z.object({
  endpoint: z.literal('chat'),
  /** Upstream named chain (profile). The request's model becomes `auto:<chain>`. */
  chain: z.string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,19}$/i, 'chain must be an upstream profile name (max 20 chars)')
    .refine(name => !RESERVED_CHAIN_NAMES.includes(name.toLowerCase()),
      'chain name is reserved upstream (auto:<name> would route to every model); use e.g. "gw-fast"'),
  /** Input modalities this lane accepts. Enforced in M4. */
  input: z.array(z.enum(INPUT_MODALITIES)).min(1).default(['text']),
}).strict();

const transcriptionsLane = z.object({
  endpoint: z.literal('transcriptions'),
}).strict();

const embeddingsLane = z.object({
  endpoint: z.literal('embeddings'),
  /** Upstream embedding family name. The request's model becomes this. */
  family: z.string().min(1).max(100),
}).strict();

const laneSchema = z.discriminatedUnion('endpoint', [chatLane, transcriptionsLane, embeddingsLane]);

const appSchema = z.object({
  lanes: z.array(laneId).min(1),
  // Accepted and validated now; enforced in M3.
  max_concurrent: positiveInt.optional(),
  max_rpm: positiveInt.optional(),
  max_rpd: positiveInt.optional(),
  max_tpd: positiveInt.optional(),
}).strict();

const configSchema = z.object({
  lanes: z.record(laneId, laneSchema),
  apps: z.record(z.string().trim().min(1), appSchema),
}).strict();

export type LaneEndpoint = z.infer<typeof laneSchema>['endpoint'];
export type Lane = z.infer<typeof laneSchema>;
export type AppPolicy = z.infer<typeof appSchema>;
export type GatewayConfig = z.infer<typeof configSchema>;

export class GatewayConfigError extends Error {}

/** Validate a parsed config object. Throws GatewayConfigError with every problem listed. */
export function parseGatewayConfig(raw: unknown): GatewayConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new GatewayConfigError(`invalid gateway config:\n  - ${problems.join('\n  - ')}`);
  }
  const config = result.data;
  const problems: string[] = [];
  for (const [appName, app] of Object.entries(config.apps)) {
    for (const lane of app.lanes) {
      if (!config.lanes[lane]) problems.push(`apps.${appName}.lanes: "${lane}" is not defined in lanes`);
    }
  }
  if (problems.length > 0) {
    throw new GatewayConfigError(`invalid gateway config:\n  - ${problems.join('\n  - ')}`);
  }
  return config;
}

export function loadGatewayConfig(path: string): GatewayConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new GatewayConfigError(`cannot read gateway config at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new GatewayConfigError(`gateway config at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseGatewayConfig(raw);
}
