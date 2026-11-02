// B2-04zo：资产快照调度在生产组合根的装配（不连库，模块不真正构建）。LedgerAssetSnapshotModule.forWorker 只在
// worker 入口调用一次；ledger 自己不导入 settlement 或 content（预估来源与配置读取由 app.module 注入）；两个
// 定时常量导出；asset-snapshot.ts 的调度 TODO 删掉。骨架上模块不存在，红在 kit 的断言。
// 用例全部是顶层 it（资金测试路径，规划/11 §4.3）。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { FIRST_TICK_MS, ROOT, TICK_MS, assembledBy } from './kit.ts';

const LEDGER = 'apps/api/src/modules/ledger/';
const MODULE = `${LEDGER}asset-snapshot.module.ts`;
const RUNNER = `${LEDGER}application/asset-snapshot.ts`;

function source(path: string): string {
  return readFileSync(new URL(path, ROOT), 'utf8');
}

/** Source text without line and block comments (a mention in a comment is not a call). */
function code(path: string): string {
  return source(path)
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
}

/** The module file (when it exists) and the schedule files of application/, tests excluded. */
function scheduleFiles(): string[] {
  const application = readdirSync(new URL(`${LEDGER}application/`, ROOT))
    .filter((name) => /^asset-snapshot-schedule.*\.ts$/u.test(name) && !name.endsWith('.test.ts'))
    .map((name) => `${LEDGER}application/${name}`);
  return [...(existsSync(new URL(MODULE, ROOT)) ? [MODULE] : []), ...application];
}

it('[AC-B2-04zo#1] 装配：worker 入口的 app.module 恰调用一次 LedgerAssetSnapshotModule.forWorker；api、stream、admin、payout 入口一次都不调用', async () => {
  expect(await assembledBy('worker')).toHaveLength(1);
  for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
    expect(await assembledBy(entry), `${entry} assembles the snapshot schedule`).toEqual([]);
  }
});

it('[AC-B2-04zo#2] 装配（源码）：app.module 调 forWorker 并注入 createPendingEarningsSource；ledger 的调度文件不导入 settlement 或 content；asset-snapshot.ts 的 B2-04zb 调度 TODO 已删', () => {
  const files = scheduleFiles();
  expect(files, 'the module file of the schedule').toContain(MODULE);
  const app = code('apps/api/src/app.module.ts');
  expect(app).toMatch(/\bLedgerAssetSnapshotModule\.forWorker\s*\(/u);
  expect(app).toMatch(/\bcreatePendingEarningsSource\s*\(/u);
  for (const file of files) {
    const text = code(file);
    expect(text, file).not.toMatch(/from\s+['"][^'"]*modules\/(settlement|content)\//u);
    expect(text, file).not.toMatch(/from\s+['"]\.\.\/(\.\.\/)?(settlement|content)\//u);
  }
  expect(source(RUNNER)).not.toMatch(/blocked on B2-04zb/u);
});

it('[AC-B2-04zo#3] 定时常量导出：调度文件导出首次延迟 15 秒与间隔 60 秒', async () => {
  const files = scheduleFiles();
  expect(files, 'the module file of the schedule').toContain(MODULE);
  const exported: unknown[] = [];
  for (const file of files) {
    const loaded = (await import(new URL(file, ROOT).href)) as Record<string, unknown>;
    exported.push(...Object.values(loaded));
  }
  expect(exported).toContain(FIRST_TICK_MS);
  expect(exported).toContain(TICK_MS);
});
