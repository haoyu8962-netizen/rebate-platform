// B2-08f / FU-B208B-W11-LOGGER / D10-710, SPEC_REF 18f0015e:
// BR-WDR-20 through the real admin entry. Each case asserts the missing positive warning,
// rollback, then repair + retry + replay together: no independently green negative-only test.
import { expect, it } from 'vitest';
import {
  BODY,
  PAYEE_NAME,
  answer,
  billLineJson,
  entries,
  everything,
  fixture,
  idempotencyRows,
  newKey,
  paidEntries,
  returnedResolution,
  seedHold,
  seedReturnedDiff,
  suite,
  withdrawalRow,
  writtenOff,
  type WriteOffFixture,
} from '../../ledger/admin-recon-write-off/kit.ts';
import { newMember } from '../proven-success/kit.ts';
import { expected, randomHmac, seedRealname, taxRows, totals } from '../tax-ytd/kit.ts';
import { withLoggedAdmin } from './admin-kit.ts';
import { seedReturnedAt } from './seed-kit.ts';

const s = suite();
const ALERT = 'tax_ytd_identity_missing';

function warnings(lines: string[]): Record<string, unknown>[] {
  return lines
    .join('')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line['msg'] === ALERT);
}

async function snapshot(f: WriteOffFixture) {
  return {
    ...(await everything(f)),
    tax: await taxRows(f.db, f.appId),
    idempotency: await idempotencyRows(f),
    // Full voucher and entry rows: checking only the voucher identifiers misses mutations.
    vouchers: await f.db
      .selectFrom('ledger_vouchers')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    entries: await f.db
      .selectFrom('ledger_entries')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
  };
}

it.each([
  {
    label: '申请在上一年，到账与核销在以后年度',
    createdAt: '2026-12-31T15:30:00.000Z',
    year: 2026,
  },
  { label: '申请 UTC 仍为上年，+08:00 已跨年', createdAt: '2026-12-31T16:30:00.000Z', year: 2027 },
])(
  '[AC-B2-08f#1] $label：未实名 W11 恰一条 payout warn、整笔回滚；补实名同请求重试及重放只累计一次',
  async ({ createdAt, year }) => {
    const f = fixture(s, '2027-01-03T02:00:00.000Z');
    const userId = await newMember(f.db, f.ledger, f.appId);
    const w = await seedReturnedAt(f, { userId, createdAt: new Date(createdAt) });
    const billDate = '2027-01-02';
    const diff = await seedReturnedDiff(f, w, {
      period: billDate,
      dedupe_key: `R2:alipay:${billDate}:wd:${w.id}`,
      resolution: {
        ...returnedResolution(w, {
          ...billLineJson(w),
          bill_date: billDate,
          booked_at: '2027-01-02T15:02:11+08:00',
        }),
        bill_date: billDate,
      },
    });
    await seedHold(f, {
      user_id: userId,
      reason: 'recon_diff',
      source_ref: `recon_diff:${diff.id}`,
      created_by: 'system:payout-recon',
    });
    const lines: string[] = [];
    const hmac = randomHmac();
    const withdrawal = await withdrawalRow(f.db, f.appId, w.id);

    await withLoggedAdmin(f, lines, async (admin) => {
      const requestId = newKey();
      const before = await snapshot(f);
      const failed = await admin.writeOff(diff.id, BODY, { key: requestId });
      await answer(failed, 50001);
      expect(await snapshot(f), '缺实名仍须抛错并回滚整个核销事务').toEqual(before);

      const alerts = warnings(lines);
      expect(alerts, '实际 admin 装配必须把告警写到根 logger').toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        level: 40,
        msg: ALERT,
        module: 'payout',
        entry: 'admin',
      });
      const metadata = new Set(['level', 'time', 'pid', 'entry', 'env', 'module', 'msg']);
      expect(
        Object.fromEntries(Object.entries(alerts[0]!).filter(([name]) => !metadata.has(name))),
      ).toEqual({ app_id: f.appId, withdrawal_id: w.id, user_id: userId, year });

      await seedRealname(f.db, f.appId, userId, { status: 'verified', hmac });
      const succeeded = await admin.writeOff(diff.id, BODY, { key: requestId });
      const result = await writtenOff(succeeded);
      expect(result.withdrawal).toMatchObject({ status: 'PAID_API' });
      expect(result.recon_diff).toMatchObject({ status: 'written_off' });
      expect(result.released_hold_count).toBe(1);
      expect(await entries(f.db, f.appId, `wd:${w.id}:PAID`)).toEqual(paidEntries(w));
      expect((await taxRows(f.db, f.appId)).map(totals)).toEqual([
        expected(f.appId, userId, year, hmac, 10_300n, 2_000n),
      ]);
      expect(warnings(lines)).toEqual(alerts);

      const committed = await snapshot(f);
      const replay = await admin.writeOff(diff.id, BODY, { key: requestId });
      expect(replay.statusCode).toBe(succeeded.statusCode);
      expect(replay.body).toBe(succeeded.body);
      expect(await snapshot(f), '重放不再累计 tax_ytd 或产生分录').toEqual(committed);
      expect(warnings(lines)).toEqual(alerts);
    });

    // Includes startup, failed request, successful retry, replay and shutdown, not just the warn.
    const text = lines.join('');
    for (const value of [
      PAYEE_NAME,
      'synthetic-name',
      'synthetic-id-no',
      'synthetic-birth-date',
      'synthetic-encrypted-account',
      hmac,
      withdrawal.payee_hmac,
      Buffer.from('synthetic-name').toString('hex'),
      Buffer.from('synthetic-id-no').toString('hex'),
      Buffer.from('synthetic-name').toString('base64'),
      Buffer.from('synthetic-id-no').toString('base64'),
    ]) {
      expect(text, '日志不得泄露姓名、证件或摘要').not.toContain(value);
    }
  },
  120_000,
);
