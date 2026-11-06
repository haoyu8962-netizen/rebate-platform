// B2-12f：坏账核销候选生成任务在生产组合根的装配（不连库，模块不真正构建）。LedgerBadDebtWriteoffModule.forWorker
// 只在 worker 入口调用一次（编排者补充：候选生成走真实调度入口，确认 app.module 确实接了生成任务）；ledger 的核销
// 文件不直接导入 identity 或 content（注销状态与阈值配置经 app.module 注入的端口，ledger AGENTS.md 硬规则 6）。
// 骨架上 app.module 不调用 forWorker，红在断言。用例全部是顶层 it（资金测试路径，规划/11 §4.3）。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { assembledBy } from './kit.ts';

const ROOT = new URL('../../../../', import.meta.url);
const LEDGER = 'apps/api/src/modules/ledger/';
const MODULE = `${LEDGER}bad-debt-writeoff.module.ts`;

function source(path: string): string {
  return readFileSync(new URL(path, ROOT), 'utf8');
}

/** Source text without line and block comments (a mention in a comment is not a call). */
function code(path: string): string {
  return source(path)
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
}

/** The task's ledger files (module, application, store, controller), tests excluded. */
function writeoffFiles(): string[] {
  const of = (dir: string, pattern: RegExp): string[] =>
    existsSync(new URL(`${LEDGER}${dir}`, ROOT))
      ? readdirSync(new URL(`${LEDGER}${dir}`, ROOT))
          .filter((name) => pattern.test(name) && !name.endsWith('.test.ts'))
          .map((name) => `${LEDGER}${dir}${name}`)
      : [];
  return [
    ...(existsSync(new URL(MODULE, ROOT)) ? [MODULE] : []),
    ...of('application/', /^bad-debt-writeoff.*\.ts$/u),
    ...of('infra/', /^bad-debt-writeoffs-store.*\.ts$/u),
    ...of('http/admin/', /^bad-debt-writeoffs\.controller.*\.ts$/u),
  ];
}

it('[AC-B2-12f#1] 装配：worker 入口的 app.module 恰调用一次 LedgerBadDebtWriteoffModule.forWorker；api、stream、admin、payout 入口一次都不调用', async () => {
  expect(await assembledBy('worker'), 'worker 入口应恰好装配一次候选生成任务').toHaveLength(1);
  for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
    expect(await assembledBy(entry), `${entry} assembles the candidate generation`).toEqual([]);
  }
});

it('[AC-B2-12f#2] 装配（源码）：app.module 调 LedgerBadDebtWriteoffModule.forWorker；ledger 的核销文件不从 identity 或 content 模块直接导入', () => {
  const files = writeoffFiles();
  expect(files, 'the module file of the generation').toContain(MODULE);
  expect(code('apps/api/src/app.module.ts')).toMatch(
    /\bLedgerBadDebtWriteoffModule\.forWorker\s*\(/u,
  );
  for (const file of files) {
    const text = code(file);
    expect(text, file).not.toMatch(/from\s+['"][^'"]*modules\/(identity|content)\//u);
    expect(text, file).not.toMatch(/from\s+['"](\.\.\/)+(identity|content)\//u);
  }
});
