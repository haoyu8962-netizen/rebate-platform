// B2-02t rule tests: app.module's assembly of the check's worker (no database).
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const ROOT = new URL('../../../../', import.meta.url);

/** Source text without line and block comments (a mention in a comment is not a call). */
function code(path: string): string {
  return readFileSync(new URL(path, ROOT), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
}

it('[AC-B2-02t#15] 装配（源码）：app.module 注册 LedgerCreditPostcheckModule.forWorker；ledger 自己不导入 payout、commission', () => {
  expect(code('apps/api/src/app.module.ts')).toMatch(
    /\bLedgerCreditPostcheckModule\.forWorker\s*\(/u,
  );
  for (const path of [
    'apps/api/src/modules/ledger/credit-postcheck.module.ts',
    'apps/api/src/modules/ledger/application/credit-postcheck.ts',
  ]) {
    const text = code(path);
    expect(text).not.toMatch(/from\s+['"][^'"]*modules\/(payout|commission)\//u);
    expect(text).not.toMatch(/from\s+['"]\.\.\/(\.\.\/)?(payout|commission)\//u);
  }
});
