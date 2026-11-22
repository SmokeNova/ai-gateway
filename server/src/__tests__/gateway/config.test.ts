import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { GatewayConfigError, loadGatewayConfig, parseGatewayConfig, RESERVED_CHAIN_NAMES } from '../../gateway/config.js';
import { TEST_CONFIG } from './helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'gw-config-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('gateway config', () => {
  it('parses the example shape and defaults chat input to text', () => {
    const config = parseGatewayConfig(TEST_CONFIG);
    expect(config.lanes['lane:smart']).toEqual({ endpoint: 'chat', chain: 'gwtest-smart', input: ['text'] });
    expect(config.apps['chat-app'].lanes).toEqual(['lane:fast', 'lane:smart']);
  });

  it('rejects an app that references an undefined lane', () => {
    expect(() => parseGatewayConfig({ lanes: {}, apps: { a: { lanes: ['lane:nope'] } } }))
      .toThrow(/apps\.a\.lanes: "lane:nope" is not defined/);
  });

  it.each([
    ['bad lane id', { lanes: { fast: { endpoint: 'transcriptions' } }, apps: {} }],
    ['unknown endpoint', { lanes: { 'lane:x': { endpoint: 'images' } }, apps: {} }],
    ['chat lane without chain', { lanes: { 'lane:x': { endpoint: 'chat' } }, apps: {} }],
    ['chain name too long', { lanes: { 'lane:x': { endpoint: 'chat', chain: 'a'.repeat(21) } }, apps: {} }],
    ['embeddings lane without family', { lanes: { 'lane:x': { endpoint: 'embeddings' } }, apps: {} }],
    ['unknown top-level key', { lanes: {}, apps: {}, extra: true }],
    ['unknown app field', { lanes: { 'lane:x': { endpoint: 'transcriptions' } }, apps: { a: { lanes: ['lane:x'], maxRpm: 5 } } }],
    ['app with no lanes', { lanes: {}, apps: { a: { lanes: [] } } }],
    ['non-positive limit', { lanes: { 'lane:x': { endpoint: 'transcriptions' } }, apps: { a: { lanes: ['lane:x'], max_rpm: 0 } } }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseGatewayConfig(raw)).toThrow(GatewayConfigError);
  });

  it.each(['fast', 'Smart', 'cheapest', 'balanced', 'auto', 'default'])(
    'rejects chain name %s (an upstream alias that routes to every model)', (chain) => {
      expect(() => parseGatewayConfig({ lanes: { 'lane:x': { endpoint: 'chat', chain } }, apps: {} }))
        .toThrow(/reserved upstream/);
    },
  );

  it('the reserved list covers every alias and reserved name in upstream source', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const router = readFileSync(join(src, 'services', 'router.ts'), 'utf8');
    const profiles = readFileSync(join(src, 'routes', 'profiles.ts'), 'utf8');
    const aliasBlock = router.match(/GLOBAL_SORT_ALIASES[^=]*=\s*\{([\s\S]*?)\};/)?.[1] ?? '';
    const reservedBlock = profiles.match(/RESERVED_PROFILE_NAMES\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? '';
    const upstream = [
      ...[...aliasBlock.matchAll(/([a-z]+)\s*:/g)].map(m => m[1]),
      ...[...reservedBlock.matchAll(/'([^']+)'/g)].map(m => m[1]),
    ];
    expect(upstream.length).toBeGreaterThan(10); // the source scan really found them
    expect(upstream.filter(n => !RESERVED_CHAIN_NAMES.includes(n))).toEqual([]);
  });

  it('loads from a file and reports unreadable or invalid JSON clearly', () => {
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify(TEST_CONFIG));
    expect(loadGatewayConfig(good).apps['stt-app'].lanes).toEqual(['lane:stt']);

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not json');
    expect(() => loadGatewayConfig(bad)).toThrow(/not valid JSON/);
    expect(() => loadGatewayConfig(join(dir, 'missing.json'))).toThrow(/cannot read gateway config/);
  });
});
