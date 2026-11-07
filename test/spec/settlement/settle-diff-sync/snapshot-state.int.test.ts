// BR-FUND-09 / BR-CALC-02: R10 retains forfeiture and the order's reserved-rate snapshot.
import { createTestDatabase } from '@couli/db/testing';
import { addFen } from '@couli/money';
import { expect, it } from 'vitest';
import { seedVersion, version } from '../../commission/snapshot/fixtures.ts';
import { BILL_AT } from '../settlement-records/kit.ts';
import {
  MEMBER_ROLE,
  TIMEOUT,
  credited,
  databaseFixture,
  observations,
  risk,
  settled,
  touched,
  withSync,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04zi#35] R5已没收500后解除封禁，结算1000→800只扣平台200，不恢复受益人份额',
  async () => {
    await withSync(p.db, async (w) => {
      const app = await w.app();
      await w.setConfig(app, 'credit.enabled.pdd', true);
      const o = w.order(app, { est_commission_fen: 1000n, commission_fen: 1000n });
      await o.sync(settled(1000n));
      const read = observations(p.db, app, o);
      w.clock.set(BILL_AT);
      await w.bill(app);
      // Ban after attribution and bill selection, before R5 executes the beneficiary gate.
      await risk(p.db, w, app, 'banned');
      await w.confirmAndExecute(app);

      expect(await o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 1000n,
        booked_n_fen: 1000n,
      });
      expect((await read.events()).filter((e) => e.status === 'forfeited')).toMatchObject([
        { user_id: app.userId, role: MEMBER_ROLE, status: 'forfeited', reason: 'banned' },
      ]);
      const beforeLines = await read.lines();
      expect(
        beforeLines
          .filter((l) => l.owner_id === app.userId && l.subject === 'USER_BALANCE')
          .reduce((sum, l) => addFen(sum, l.amount_fen), 0n),
      ).toBe(0n);
      expect(
        beforeLines
          .filter((l) => l.subject === 'COMMISSION_REVENUE')
          .reduce((sum, l) => addFen(sum, l.amount_fen), 0n),
      ).toBe(-1000n);
      expect((await read.vouchers()).filter((v) => v.voucher_kind === 'FORFEIT')).toMatchObject([
        { uniq_key: `${read.orderRef}:PLATFORM:FORFEIT:${app.userId}:${MEMBER_ROLE}` },
      ]);
      expect(
        beforeLines
          .filter(
            (l) => l.uniq_key === `${read.orderRef}:PLATFORM:FORFEIT:${app.userId}:${MEMBER_ROLE}`,
          )
          .map((l) => [l.subject, l.amount_fen])
          .sort(),
      ).toEqual([
        ['COMMISSION_REVENUE', -500n],
        ['UNION_RECEIVABLE:pdd', 500n],
      ]);
      const balanceBefore = await read.balance();
      expect(balanceBefore).toEqual({ available_fen: 0n, frozen_fen: 0n });

      await risk(p.db, w, app, 'normal');
      await o.sync(settled(800n, touched(1)));
      // Exact entries: only PLATFORM:ADJ:2 debits revenue 200 and credits receivable 200.
      await read.adjustment(2, 0n, 200n);
      expect(
        (await read.vouchers()).filter((v) => v.voucher_kind === 'SETTLE_ADJUST'),
      ).toMatchObject([{ uniq_key: `${read.orderRef}:PLATFORM:ADJ:2` }]);
      expect(
        (await read.lines()).filter(
          (l) => l.ledger_type === 'SETTLE_ADJUST' && l.owner_id === app.userId,
        ),
      ).toEqual([]);
      expect(await read.obligations()).toEqual([]);
      expect(await read.candidates()).toEqual([]);
      expect(await o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 800n,
        booked_n_fen: 800n,
      });
      expect(await read.balance()).toEqual(balanceBefore);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zi#36] 入账后新规则预留5000生效，R10仍按快照预留0将用户与平台各扣100',
  async () => {
    await withSync(p.db, async (w) => {
      const { app, o, read } = await credited(p.db, w, { reserveBp: 0 });
      const row = await o.row();
      const snapshots = () =>
        p.db
          .selectFrom('commission_splits')
          .select(['rule_version_id', 'reserve_bp'])
          .where('app_id', '=', app.appId)
          .where('order_id', '=', row.order_id)
          .execute();
      const before = await snapshots();
      expect(before).toEqual([
        {
          rule_version_id: expect.any(String),
          reserve_bp: 0,
        },
      ]);
      expect(row).toMatchObject({ booked_base_fen: 1000n, booked_n_fen: 1000n });
      expect(await w.available(app)).toBe(500n);
      expect(
        (await read.lines())
          .filter((l) => l.subject === 'COMMISSION_REVENUE')
          .reduce((sum, l) => addFen(sum, l.amount_fen), 0n),
      ).toBe(-500n);

      // Published versions are append-only. This version becomes effective after R5.
      const later = version({
        effective_from: new Date('2026-11-25T00:00:00+08:00'),
        reserves: [
          { platform: 'taobao', reserve_bp: 0 },
          { platform: 'jd', reserve_bp: 0 },
          { platform: 'pdd', reserve_bp: 5000 },
        ],
      });
      await seedVersion(p.db, app.appId, later);
      w.clock.set('2026-11-26T02:00:00.000Z');
      expect(w.clock.now().getTime()).toBeGreaterThan(later.effective_from.getTime());
      expect(
        await p.db
          .selectFrom('commission_rule_reserves')
          .select('reserve_bp')
          .where('app_id', '=', app.appId)
          .where('rule_version_id', '=', later.rule_version_id)
          .where('platform', '=', 'pdd')
          .executeTakeFirstOrThrow(),
      ).toEqual({ reserve_bp: 5000 });

      await o.sync(settled(800n, touched(1)));
      await read.adjustment(2, 100n, 100n);
      expect(await o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 800n,
        booked_n_fen: 800n,
      });
      expect(await w.available(app)).toBe(400n);
      expect(await snapshots()).toEqual(before);
    });
  },
  TIMEOUT,
);
