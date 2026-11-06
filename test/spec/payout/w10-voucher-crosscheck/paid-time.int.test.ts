// BR-WDR-15 / D10-703: time differences only warn; precisely five minutes is allowed silently.
import { expect, it } from 'vitest';
import {
  ACCOUNT,
  candidate,
  expectNoSecrets,
  query,
  secretsOf,
  serial,
  state,
  success,
  suite,
  textOf,
  warnings,
  withLoggedUnknownAdmin,
} from './crosscheck-harness.ts';

const s = suite(true);

it('[AC-B2-09x#13] 到账时间差正负恰5分钟不告警，多1毫秒仍成功且仅一条warn和审计标记', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  const logs: string[] = [];
  await withLoggedUnknownAdmin(a, logs, async (h) => {
    for (const delta of [300_000, -300_000, 300_001, -300_001]) {
      const c = await candidate(a, h);
      // Keep both times inside [T, Clock]: this is not the future-time validation guard.
      c.body.paid_at = new Date(a.clock.now().getTime() - 3_600_000).toISOString();
      await query(a, c, c.body.channel_order_id, {
        paidAt: new Date(Date.parse(c.body.paid_at) + delta).toISOString(),
      });
      const start = logs.length;
      const differs = Math.abs(delta) > 300_000;
      await success(f, a, h, c, { differs });
      const emitted = warnings(logs.slice(start));
      if (differs) {
        expect(emitted).toHaveLength(1);
        expect(emitted[0]).toMatchObject({ withdrawal_id: c.w.id });
      } else {
        expect(emitted).toEqual([]);
      }
      const records = (await state(a)).audits.filter((r) => r.target === c.w.id);
      expect(records.map((r) => r.action)).toEqual(['withdrawal_resolve']);
      expectNoSecrets(textOf([logs.slice(start), records]), [
        ...secretsOf(c.w, ACCOUNT.alipay, c.who),
        c.body.proof_text,
      ]);
    }
  });
}, 120_000);

it('[AC-B2-09x#14] 时间仅用最新成功查询：早期相差很大不告警，最新相差超限才告警', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  const logs: string[] = [];
  await withLoggedUnknownAdmin(a, logs, async (h) => {
    for (const differs of [false, true]) {
      const c = await candidate(a, h);
      c.body.paid_at = new Date(a.clock.now().getTime() - 3_600_000).toISOString();
      const distant = new Date(Date.parse(c.body.paid_at) - 300_001).toISOString();
      await query(a, c, serial(), {
        at: new Date(a.clock.now().getTime() - 120_000),
        paidAt: differs ? c.body.paid_at : distant,
      });
      await query(a, c, c.body.channel_order_id, {
        at: new Date(a.clock.now().getTime() - 60_000),
        paidAt: differs ? distant : c.body.paid_at,
      });
      // A later unsuccessful query must neither replace the successful time nor its serial.
      await query(a, c, serial(), {
        result: 'unknown',
        paidAt: differs ? c.body.paid_at : distant,
      });
      const start = logs.length;
      await success(f, a, h, c, { differs });
      expect(warnings(logs.slice(start))).toEqual(
        differs ? [expect.objectContaining({ withdrawal_id: c.w.id })] : [],
      );
    }
  });
}, 120_000);
