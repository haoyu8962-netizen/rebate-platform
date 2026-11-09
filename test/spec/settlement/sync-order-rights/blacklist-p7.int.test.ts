// B2-04zzr rule test, P7 meeting a new blacklist entry in the same sync (claude-independent, 第 3 次,
// D10-1147, Codex money r1 S2; SPEC_REF b7ff7807). BR-FUND-01 P 表 P7, BR-FUND-08 (event key
// P{row_version}), BR-ATTR-26 (blacklist → R6). One report takes a SETTLED, not credited order
// (WAITING) to PLATFORM_INVALID while its channel has just been put on the blocklist. Orders writes
// the sync update first (row_version v → v + 1), then applyOrderBlacklist voids it through
// settlement's BLACKLIST_HIT (R6, row_version v + 1 → v + 2), and only then hands the event to
// settlement. The order_rights row of the P7 carries the version the sync update wrote, P{v + 1},
// never the one after the R6. v is read before the report, not written down.
// Production worker over the real pipeline (harness.ts); the channel entry is a blocklist row of
// this union account as the B1-09n kit writes it (../../orders/rebate-wiring/kit.ts blockChannel),
// the rule BLACKLIST_HIT with no row of its own, as in AC-B1-09n#13. Expected values by hand.
// Top-level it() only.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import { ATTR_CODE } from '../../orders/rebate-wiring/kit.ts';
import { observations } from '../settle-diff-sync/kit.ts';
import {
  N,
  TIMEOUT,
  databaseFixture,
  expectWrittenSucceeded,
  invalidAfterSettle,
  rightsBrief,
  settled,
  withWorker,
} from './harness.ts';
import type { StatusMapModule } from './status-codes.ts';

vi.mock('../../../../apps/api/src/modules/orders/domain/status-map.ts', async (importOriginal) =>
  (await import('./status-codes.ts')).withSyntheticCodes(await importOriginal<StatusMapModule>()),
);

const p = databaseFixture(createTestDatabase);

/** The order's channel (relation_id), put on the blocklist after the order is stored. */
const CHANNEL = 'channel-b2-04zzr-19';
/** The entry's start: before the order's attr_at (paid 2026-10-20 10:00 +08:00). */
const LISTED_SINCE = new Date('2026-10-01T00:00:00.000Z');

it(
  '[AC-B2-04zzr#19] 同一次同步里 P7（SETTLED 收到 PLATFORM_INVALID）同时命中新加入的订单黑名单：orders 先写同步更新（row_version v → v+1），再经 applyOrderBlacklist 走 R6 作废（→ v+2），之后才到 settlement；order_rights 恰好一行 (INVALID_AFTER_SETTLE, SUCCEEDED, P{v+1})，是同步更新写入的版本而不是 R6 之后的 v+2；订单照旧被黑名单作废为 VOID（原因码 BLACKLIST、platform_status 仍 SETTLED）、没有扣回凭证、rights_pending 仍 false',
  async () => {
    await withWorker(p.db, async (w) => {
      const app = await w.app();
      const o = w.order(app, {
        est_commission_fen: N,
        commission_fen: N,
        attr_params: {
          relation_id: CHANNEL,
          sub_union_id: null,
          custom_parameters: JSON.stringify({ app: 'n', uid: ATTR_CODE }),
        },
      });
      const read = observations(p.db, app, o);
      await o.sync(settled(N));
      expect(await o.row(), 'the waiting order, attributed, on the channel').toMatchObject({
        user_id: app.userId,
        relation_id: CHANNEL,
        rebate_status: 'WAITING',
        platform_status: 'SETTLED',
        rights_pending: false,
      });

      await p.db
        .insertInto('blocklist')
        .values({
          id: randomUUID(),
          app_id: app.appId,
          dimension: 'channel',
          value: CHANNEL,
          value_hmac: null,
          platform: 'pdd',
          union_account_id: app.accountId,
          start_at: LISTED_SINCE,
          end_at: null,
          expire_at: null,
          status: 'active',
          violation_type: 'other',
          created_by: 'fixture-admin',
          created_at: LISTED_SINCE,
          updated_at: LISTED_SINCE,
        })
        .execute();

      const v = (await o.row()).row_version;
      await o.sync(invalidAfterSettle(1));

      const after = await o.row();
      expect(after, 'voided by the blacklist (R6) in the same sync').toMatchObject({
        rebate_status: 'VOID',
        reason: 'BLACKLIST',
        platform_status: 'SETTLED',
        rights_pending: false,
      });
      expect(after.row_version, 'the sync update (v + 1), then the R6 (v + 2)').toBe(v + 2);
      const hits = await p.db
        .selectFrom('risk_hits')
        .select(['rule_id', 'risk_action', 'dimension', 'ref_type', 'ref_id'])
        .where('app_id', '=', app.appId)
        .execute();
      expect(hits).toEqual([
        {
          rule_id: 'BLACKLIST_HIT',
          risk_action: 'void_commission',
          dimension: 'channel',
          ref_type: 'order',
          ref_id: after.order_id,
        },
      ]);
      expect(await read.vouchers(), 'no clawback, no voucher at all').toEqual([]);

      expect(await rightsBrief(p.db, app, o)).toEqual([
        {
          type: 'INVALID_AFTER_SETTLE',
          status: 'SUCCEEDED',
          platform_rights_no: `P${String(v + 1)}`,
        },
      ]);
      await expectWrittenSucceeded(p.db, app, o);
    });
  },
  TIMEOUT,
);
