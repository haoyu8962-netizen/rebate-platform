import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { requireAttrPidScene } from '../../db/orders/attr-pid-scene/kit.ts';
import {
  ANSWER,
  GRANTS,
  REASON,
  accepted,
  itemPath,
  orderPath,
  seedClaim,
  setup,
} from '../admin-mounts/kit.ts';
import { prepareOrder } from './kit.ts';

const h = useHarness();

async function prepareAdminOrder(action: 'approve' | 'reassign', tradeId: string) {
  const s = await setup(h, { grants: GRANTS[action] });
  const f = await prepareOrder(h.db, tradeId, {
    appId: s.appId,
    clockStart: '2026-10-08T02:00:00.000Z',
    initialReport: {
      click_time: '2026-10-06 00:00:00',
      tk_create_time: '2026-10-06 00:15:00',
      tk_paid_time: '2026-10-06 00:30:00',
      tb_paid_time: '2026-10-06 00:30:00',
      modified_time: '2026-10-06 00:45:00',
    },
  });
  expect(f.initial).toMatchObject({
    platform_status: 'PAID',
    user_id: null,
    rebate_status: 'UNATTRIBUTED',
  });
  expect(await f.readScene()).toBe('taolijin');
  expect(await f.readSnapshot()).toEqual({ splits: [], totals: [] });
  await f.updateRegistration('share');
  await f.publishRules();
  return { s, f };
}

const TAOLIJIN_SNAPSHOT = {
  splits: [{ rebate_mode: 'none', raw_n_fen: 1000n }],
  totals: [{ user_share_total_fen: 0n }],
};

it('[AC-B1-08zzi#6] 淘礼金登记改为分享后，找回审核仍按入库场景生成快照', async () => {
  await requireAttrPidScene(h.db);
  const { s, f } = await prepareAdminOrder('approve', '4920000000000000106');
  const { claim, item } = await seedClaim(s, f.initial);
  const response = await s.post(itemPath(claim.id, item.id, 'approve'), {
    expected_row_version: item.row_version,
    reason: REASON,
  });
  await accepted(response, ANSWER.approve);

  expect(await f.readOrder()).toMatchObject({
    user_id: s.userId,
    user_basis: 'claim',
    locked: true,
    rebate_status: 'ESTIMATED',
  });
  expect(await f.readScene()).toBe('taolijin');
  expect(await f.readSnapshot()).toEqual(TAOLIJIN_SNAPSHOT);
}, 120_000);

it('[AC-B1-08zzi#7] 淘礼金登记改为分享后，指定归属仍按入库场景生成快照', async () => {
  await requireAttrPidScene(h.db);
  const { s, f } = await prepareAdminOrder('reassign', '4920000000000000107');
  const response = await s.post(
    orderPath(f.initial.order_id, 'reassign'),
    {
      user_id: s.userId,
      expected_user_id: null,
      expected_locked: false,
      reason: REASON,
    },
    { stepUp: await s.stepUp(s.admin) },
  );
  await accepted(response, ANSWER.reassign);

  expect(await f.readOrder()).toMatchObject({
    user_id: s.userId,
    user_basis: 'admin',
    locked: true,
    rebate_status: 'ESTIMATED',
  });
  expect(await f.readScene()).toBe('taolijin');
  expect(await f.readSnapshot()).toEqual(TAOLIJIN_SNAPSHOT);
}, 120_000);
