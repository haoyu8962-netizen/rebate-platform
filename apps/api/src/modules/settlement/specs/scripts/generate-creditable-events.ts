// Build-time only (BR-FUND-02 可入账事件); never imported at run time. Run from the repository root:
// node apps/api/src/modules/settlement/specs/scripts/generate-creditable-events.ts
// Writes ../creditable-events.gen.ts (CREDITABLE_EVENTS) from specs/creditable-events.yaml, keeping
// the version string, every field and the order of platforms. Rerun after changing the specification;
// the rule tests fail until the generated file matches.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@readme/openapi-parser';

export const creditableEventsSpecFile = new URL(
  '../../../../../../../specs/creditable-events.yaml',
  import.meta.url,
);
export const creditableEventsGenFile = new URL('../creditable-events.gen.ts', import.meta.url);

/** confirm_receipt = 确认收货；complete_or_verify = 订单完成或核销（08 BR-FUND-02）。 */
const EVENTS = new Set(['confirm_receipt', 'complete_or_verify']);

function fail(file: URL, message: string): never {
  throw new Error(`${fileURLToPath(file)}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/**
 * Build-time renderer: read the supplied YAML file and emit creditable-events.gen.ts source
 * exporting CREDITABLE_EVENTS. An explicit input lets rule tests use synthetic specifications.
 */
export async function creditableEventsSource(inputFile: URL): Promise<string> {
  const spec: unknown = await parse(fileURLToPath(inputFile));
  if (!isRecord(spec) || !hasExactKeys(spec, ['version', 'platforms'])) {
    fail(inputFile, 'top level must be a mapping with exactly version and platforms');
  }
  if (typeof spec['version'] !== 'string' || spec['version'] === '') {
    fail(inputFile, 'version must be a non-empty string');
  }
  const platforms = spec['platforms'];
  if (!Array.isArray(platforms)) fail(inputFile, 'platforms must be a list');
  const seen = new Set<string>();
  platforms.forEach((item: unknown, index) => {
    const at = `platforms[${String(index)}]`;
    if (!isRecord(item) || !hasExactKeys(item, ['platform', 'event'])) {
      fail(inputFile, `${at} must be exactly {platform, event}`);
    }
    const platform = item['platform'];
    const event = item['event'];
    if (typeof platform !== 'string' || platform === '') {
      fail(inputFile, `${at}.platform must be a non-empty string`);
    }
    if (typeof event !== 'string' || !EVENTS.has(event)) {
      fail(inputFile, `${at}.event must be one of ${[...EVENTS].join(', ')}`);
    }
    if (seen.has(platform)) fail(inputFile, `${at}.platform ${platform} is listed twice`);
    seen.add(platform);
  });
  return (
    '// Generated from specs/creditable-events.yaml by settlement/specs/scripts/generate-creditable-events.ts.\n' +
    '// Do not edit by hand. Regenerate after changing the specification.\n' +
    `export const CREDITABLE_EVENTS = ${JSON.stringify(spec, null, 2)} as const;\n`
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(creditableEventsGenFile, await creditableEventsSource(creditableEventsSpecFile));
}
