import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  ALLOWLIST,
  BACKFILL,
  BALANCES,
  BALANCE_UPDATE,
  REPO,
  STORE,
  check,
  expectPass,
  expectWrite,
  fixture,
} from './ledger-writer-fixture.ts';

const FIXTURES = 'test/spec/ledger/posting/';
const AUTOCORRECT = 'apps/api/src/modules/ledger/application/auto-correct.ts';
const UNIT_TEST = 'apps/api/src/modules/orders/direct-write.test.ts';
const QUERY = `const statement = ${JSON.stringify(BALANCE_UPDATE)};\n`;

it('[CT-06zzzzzx#7] 文件和目录清单条目放行，支持注释、空行与 Tab 后的理由', () => {
  const root = fixture(
    {
      [STORE]: QUERY,
      [BACKFILL]: BALANCE_UPDATE,
      [`${FIXTURES}nested/rows.ts`]: QUERY,
    },
    `# 写入点与测试夹具\n\n${STORE}\t记账写入点\n${BACKFILL}\t历史迁移\n${FIXTURES}\t夹具\n`,
  );
  expectPass(check(root));
});

it('[CT-06zzzzzx#8] 拒绝包含通配符的放行条目', () => {
  const wildcard = 'test/spec/**/';
  // A literal directory with this name exists, so a missing-path error cannot satisfy the case.
  const root = fixture({ [`${wildcard}rows.ts`]: '// No writes here.\n' }, `${wildcard}\t测试\n`);
  const result = check(root);
  expect(result.status).toBe('fail');
  expect(result.problems.join('\n')).toContain(wildcard);
});

it('[CT-06zzzzzx#9] 同模块、新迁移、应用单测及放行目录的同名前缀目录仍受检查', () => {
  const migration = 'db/migrations/9999_balance-write.sql';
  const sibling = 'test/spec/ledger/posting-extra/rows.ts';
  const root = fixture(
    {
      [STORE]: QUERY,
      [BACKFILL]: BALANCE_UPDATE,
      [`${FIXTURES}rows.ts`]: QUERY,
      [AUTOCORRECT]: QUERY,
      [migration]: BALANCE_UPDATE,
      [UNIT_TEST]: QUERY,
      [sibling]: QUERY,
    },
    `${STORE}\t记账写入点\n${BACKFILL}\t历史迁移\n${FIXTURES}\t夹具\n`,
  );
  const result = check(root);
  const advice = expectWrite(result, AUTOCORRECT, [1], BALANCES, /\bupdate\b/i);
  expect(advice).toMatch(/ledger\b[^:\n]{0,24}(?:记账|posting|模块|module)/i);
  expect(advice).toMatch(/门禁|guard/i);
  expect(advice).toMatch(/负责人|owner/i);
  for (const file of [migration, UNIT_TEST, sibling]) {
    expectWrite(result, file, [1], BALANCES, /\bupdate\b/i);
  }
});

it('[CT-06zzzzzx#10] 放行路径已不存在时检查失败', () => {
  const missing = 'test/spec/ledger/removed-fixture/';
  const root = fixture({}, `${missing}\t曾使用的测试夹具\n`);
  const result = check(root);
  expect(result.status).toBe('fail');
  expect(result.problems.join('\n')).toContain(missing);
});

it('[CT-06zzzzzx#11] 放行路径仍在但无命中时只发一条 notice', () => {
  const root = fixture({ [STORE]: '// No writes here.\n' }, `${STORE}\t记账写入点\n`);
  const result = check(root);
  expectPass(result);
  expect(result.notices).toHaveLength(1);
  expect(result.notices[0]).toContain(STORE);
});

it('[CT-06zzzzzx#12] guard static 执行 ledger-writers 并报告未放行的写入', () => {
  const root = fixture({ [AUTOCORRECT]: QUERY });
  const run = spawnSync(
    process.execPath,
    [join(REPO, 'tools/guard/run.ts'), 'static', '--cwd', root, '--allow-missing-spec'],
    { cwd: REPO, encoding: 'utf8' },
  );
  expect(run.stdout).toMatch(/^FAIL ledger-writers\b/m);
  expect(run.stderr).toContain(`ledger-writers: ${AUTOCORRECT}:1`);
  expect(run.status).toBe(1);
});

it('[CT-06zzzzzx#13] 随仓清单逐条列出现有写入点和夹具并说明理由', () => {
  const path = join(REPO, ALLOWLIST);
  expect(existsSync(path), `任务要求交付 ${ALLOWLIST}`).toBe(true);
  const rows = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
  for (const row of rows) expect(row).toMatch(/^[^\t]+\t\s*\S/);
  expect(rows.map((row) => row.split('\t')[0]).sort()).toEqual(
    [
      STORE,
      BACKFILL,
      'apps/api/src/modules/identity/infra/registration-store.test.ts',
      'apps/api/src/modules/ledger/application/ledger-locks.test.ts',
      'tools/ci/lint-migrations.test.ts',
      'test/spec/agent/write-scope/',
      'test/spec/db/ledger/backfill/',
      'test/spec/db/ledger/core/',
      'test/spec/db/ledger/invariants-07-after-recalc/',
      'test/spec/growth/admin-invite-rewards/',
      'test/spec/growth/invite-reward/',
      'test/spec/identity/bind-phone-merge-conditions/',
      'test/spec/identity/deletion-expiry/',
      'test/spec/identity/deletion-progress-message/',
      'test/spec/identity/deletion-request/',
      'test/spec/identity/reverify-gates/',
      'test/spec/ledger/admin-fund-ledger/',
      'test/spec/ledger/admin-ledger-read/',
      'test/spec/ledger/admin-recon-balance-recalc/',
      'test/spec/ledger/daily-check/',
      FIXTURES,
      'test/spec/ledger/wallet-ledger/',
      'test/spec/ledger/wallet-summary/',
      'test/spec/payment/recon/',
      'test/spec/risk/appeal-restore/',
      'test/spec/settlement/blacklist-clawback/',
      'test/spec/settlement/union-receipts-schema/',
    ].sort(),
  );
});

it('[CT-06zzzzzx#14] 在真实仓库根目录执行守卫应通过', () => {
  const result = check(REPO);
  expect(result.name).toBe('ledger-writers');
  expectPass(result);
});
