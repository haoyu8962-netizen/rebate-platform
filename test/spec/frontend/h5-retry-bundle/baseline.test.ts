// DSX-47a (FU-H5-RETRY-BUNDLE): with retry-page.tsx on the base Button, couli-style
// `no-raw-pressable` has nothing left to grandfather: lint/style/baseline.json carries no allowance
// for the rule (the key is absent or empty), and the rule reports nothing anywhere in apps/h5/src.
//
// The rule runs on its own, as in h5-base-migration/lint-rule.test.ts: lint/style/index.js is
// loaded directly and only this rule runs (typescript-eslint parser, no eslint.config.js).
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Linter, type ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { expect, it } from 'vitest';
import {
  BASELINE,
  H5_SRC,
  RAW_PRESSABLE_RULE,
  REPO,
  RETRY_PAGE,
  readRepo,
  sourceFiles,
} from './support.ts';

const STYLE_MODULE = resolve(REPO, 'lint/style/index.js');
const TIMEOUT = 120_000;

/** Loads lint/style/index.js and asserts the rule exists before anything uses it. */
async function loadPlugin(): Promise<ESLint.Plugin> {
  const loaded: unknown = await import(/* @vite-ignore */ pathToFileURL(STYLE_MODULE).href);
  const style = (loaded ?? {}) as { stylePlugin?: { rules?: Record<string, unknown> } };
  expect(
    Object.keys(style.stylePlugin?.rules ?? {}),
    'lint/style/index.js stylePlugin.rules has no-raw-pressable',
  ).toContain('no-raw-pressable');
  return style.stylePlugin as unknown as ESLint.Plugin;
}

const linter = new Linter({ cwd: REPO });

/** Lines the rule reports for the committed file at the repo-relative `path`. */
function reportedLines(plugin: ESLint.Plugin, path: string): number[] {
  const config = [
    {
      files: ['**/*.ts', '**/*.tsx'],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      linterOptions: { reportUnusedDisableDirectives: 'off' },
      plugins: { 'couli-style': plugin },
      rules: { [RAW_PRESSABLE_RULE]: 'error' },
    },
  ] as unknown as Linter.Config[];
  const messages = linter.verify(readRepo(path), config, resolve(REPO, path));
  const broken = messages.filter(
    (message) => message.fatal === true || /No matching configuration/.test(message.message),
  );
  expect(
    broken.map((message) => message.message),
    `${path}: parse / config errors`,
  ).toEqual([]);
  return messages
    .filter((message) => message.ruleId === RAW_PRESSABLE_RULE)
    .map((message) => message.line);
}

it('[AC-DSX-47a-BASELINE#1] lint/style/baseline.json 不再给 couli-style/no-raw-pressable 留任何额度（无此键或为空），retry-page 条目已删除', () => {
  const baseline = JSON.parse(readRepo(BASELINE)) as Record<
    string,
    Record<string, unknown> | undefined
  >;
  const allowances = baseline[RAW_PRESSABLE_RULE] ?? {};
  expect(Object.keys(allowances), `${BASELINE} allowance of ${RETRY_PAGE}`).not.toContain(
    RETRY_PAGE,
  );
  expect(allowances, `${BASELINE} allowances of ${RAW_PRESSABLE_RULE}`).toEqual({});
});

it(
  '[AC-DSX-47a-BASELINE#2] 对 apps/h5/src 下全部源码运行 couli-style/no-raw-pressable 共 0 处',
  async () => {
    const plugin = await loadPlugin();
    const left: string[] = [];
    for (const file of sourceFiles(H5_SRC)) {
      for (const line of reportedLines(plugin, file)) left.push(`${file}:${line}`);
    }
    expect(left, `${RAW_PRESSABLE_RULE} reports in ${H5_SRC}`).toEqual([]);
  },
  TIMEOUT,
);
