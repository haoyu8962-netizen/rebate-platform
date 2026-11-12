// B2-10a rule-test kit (BR-FUND-02 可入账事件). The YAML oracle is tools/lib/yaml-lite.ts, never the
// generator's own parsing or validation code.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect } from 'vitest';
import { creditableEventsSource } from '../../../../apps/api/src/modules/settlement/specs/scripts/generate-creditable-events.ts';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';

export const SPEC_FILE = new URL('../../../../specs/creditable-events.yaml', import.meta.url);
export const GEN_FILE = new URL(
  '../../../../apps/api/src/modules/settlement/specs/creditable-events.gen.ts',
  import.meta.url,
);
export const RULES_FILE = new URL(
  '../../../../apps/api/src/modules/settlement/rebate/domain/rules.ts',
  import.meta.url,
);
export const SETTLEMENT_SPECS_DIR = new URL(
  '../../../../apps/api/src/modules/settlement/specs/',
  import.meta.url,
);

/** 08 BR-FUND-02：四个已登记平台的可入账事件。 */
export const EXPECTED_EVENTS: Readonly<Record<string, string>> = {
  taobao: 'confirm_receipt',
  jd: 'confirm_receipt',
  pdd: 'confirm_receipt',
  meituan: 'complete_or_verify',
};

/** 08 BR-FUND-02：P1 平台在 09 实测确认前不写入规格。 */
export const P1_PLATFORMS = ['vip', 'douyin', 'eleme'] as const;

export interface Entry {
  readonly platform: string;
  readonly event: string;
}

export async function readSpecText(): Promise<string> {
  // A missing specification must fail an assertion, not ENOENT.
  expect(existsSync(SPEC_FILE), 'specs/creditable-events.yaml must be checked in').toBe(true);
  return readFile(SPEC_FILE, 'utf8');
}

export async function readSpec(): Promise<unknown> {
  return parseYamlLite(await readSpecText());
}

export async function readGenerated(): Promise<string> {
  expect(existsSync(GEN_FILE), 'creditable-events.gen.ts must be checked in').toBe(true);
  return readFile(GEN_FILE, 'utf8');
}

/** Evaluate only the generated module, with no require, filesystem or application. */
export function generatedExports(source: string): Record<string, unknown> {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  expect(compiled.diagnostics ?? []).toEqual([]);
  const exports: Record<string, unknown> = {};
  runInNewContext(compiled.outputText, { exports }, { timeout: 1000 });
  // Remove VM realm prototypes while retaining value types, order and undefined fields.
  return structuredClone(exports);
}

export function generatedValue(source: string): unknown {
  const exports = generatedExports(source);
  expect(Object.hasOwn(exports, 'CREDITABLE_EVENTS'), 'missing export CREDITABLE_EVENTS').toBe(
    true,
  );
  return exports['CREDITABLE_EVENTS'];
}

/** Shape check: exactly {version, platforms}, each item exactly {platform, event}, all strings. */
export function platformsOf(value: unknown): Entry[] {
  expect(value).toStrictEqual({ version: expect.any(String), platforms: expect.any(Array) });
  const spec = value as { version: string; platforms: unknown[] };
  expect(spec.version).not.toBe('');
  return spec.platforms.map((item, index) => {
    expect(item, `platforms[${String(index)}]`).toStrictEqual({
      platform: expect.any(String),
      event: expect.any(String),
    });
    return item as Entry;
  });
}

export async function renderFixture(yaml: string): Promise<string> {
  const root = fileURLToPath(new URL('../../../../.tmp/B2-10a/', import.meta.url));
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'spec-'));
  try {
    const input = join(dir, 'creditable-events.yaml');
    await writeFile(input, yaml);
    return await creditableEventsSource(pathToFileURL(input));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The rendering error for a fixture, or undefined when it rendered. */
export async function renderError(yaml: string): Promise<unknown> {
  try {
    await renderFixture(yaml);
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Every module specifier in a source text (static, type-only, re-export, dynamic and require). */
export function moduleSpecifiers(text: string): string[] {
  return ts.preProcessFile(text, true, true).importedFiles.map((file) => file.fileName);
}
