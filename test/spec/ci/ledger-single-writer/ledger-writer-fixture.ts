import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, expect } from 'vitest';
import type { CheckResult } from '../../../../tools/guard/lib/cli.ts';
import { writeFiles } from '../../../../tools/guard/lib/fixture-kit.ts';
import { listTreeFiles, type TreeListing } from '../../../../tools/guard/lib/tree.ts';
import { repoRoot } from '../../../../tools/lib/paths.ts';

export const REPO = repoRoot();
export const ALLOWLIST = 'tools/guard/ledger-writers.allow.txt';
export const STORE = 'apps/api/src/modules/ledger/infra/store.ts';
export const BACKFILL = 'db/migrations/0054_ledger-user-accounts-backfill.sql';
export const BALANCES = 'account_balances';
export const ENTRIES = 'ledger_entries';
export const VOUCHERS = 'ledger_vouchers';
export const BALANCE_UPDATE = ['UPDATE', `app.${BALANCES}`, 'SET version = 1;'].join(' ');

const guardPath = join(REPO, 'tools/guard/ledger-writers.ts');
const requireFromTest = createRequire(import.meta.url);
const fixtureRoots: string[] = [];

// The verify container has no Git checkout. Use the same walk as guard static there.
export function fixture(files: Record<string, string>, allowlist = '# 无放行条目\n'): string {
  const parent = join(REPO, '.tmp');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'ledger-single-writer-'));
  fixtureRoots.push(root);
  writeFiles(root, { [ALLOWLIST]: allowlist, ...files });
  return root;
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type LedgerWritersCheck = (root: string, tree: TreeListing) => CheckResult;

export function check(root: string, tree = listTreeFiles(root)): CheckResult {
  expect(existsSync(guardPath), '任务要求交付 tools/guard/ledger-writers.ts').toBe(true);
  const guard = requireFromTest(guardPath) as { ledgerWritersCheck?: LedgerWritersCheck };
  expect(guard.ledgerWritersCheck, '守卫应导出 ledgerWritersCheck').toBeTypeOf('function');
  return guard.ledgerWritersCheck!(root, tree);
}

export function expectPass(result: CheckResult): void {
  expect(result.problems).toEqual([]);
  expect(result.status).toBe('pass');
}

export function expectWrite(
  result: CheckResult,
  file: string,
  lines: readonly number[],
  table: string,
  operation: RegExp,
): string {
  expect(result.status).toBe('fail');
  const problem = result.problems.find((text) => {
    if (!text.startsWith(`${file}:`)) return false;
    const location = text.slice(file.length + 1);
    const line = /^\d+\b/.exec(location)?.[0];
    // A dedicated field identifies the hit even when the guidance mentions other ledger tables.
    const reportedTable = /(?:^|[\s:：,，;；])表\s*[:：]\s*(\w+)\b/.exec(location)?.[1];
    return (
      lines.includes(Number(line)) &&
      reportedTable?.toLowerCase() === table &&
      operation.test(location)
    );
  });
  expect(problem, result.problems.join('\n')).toBeDefined();
  return problem!;
}
