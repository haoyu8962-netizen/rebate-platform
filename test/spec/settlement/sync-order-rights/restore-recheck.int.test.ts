// B2-04zzr rule tests, the re-check at handling time (claude-independent, SPEC_REF b1410c4f):
// 08 BR-FUND-22 细则「处理时再核」with 编排 D10-1126 ③ / D10-1134. A successful INVALID_AFTER_SETTLE
// record whose success instant (order_rights.updated_at; a row written as SUCCEEDED has updated_at =
// created_at) is not earlier than the platform_restore difference's registration
// (recon_diffs.created_at) — the same instant included — means the platform invalidated the order
// again: POST /admin/v1/recon-diffs/{recon_diff_id}/restore refuses it like a current platform_status
// INVALID (20001 [recon_diff_id] reason restore_platform_invalid, R12 and R13 alike): rebate_status,
// vouchers, history, audit and the difference stay as they were. A record that succeeded before the
// registration (the clock moved on before the difference was seeded) does not stop the restore, nor
// does a record still PROCESSING. Requests go through the real admin entry (../platform-restore/kit.ts,
// read only); the order_rights rows are fixtures of what the sync writes. Top-level it() only.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  diffNow,
  fixture,
  orderRow,
  platformRestored,
  refusedWith,
  seedBareOrder,
  seedClawedBack,
  seedPlatformDiff,
  suite,
  withRestoreAdmin,
  world,
  type PlatformDiffTarget,
  type RestoreFixture,
} from '../platform-restore/kit.ts';

const s = suite();

const MINUTE = 60_000;
const RECEIVED_AT = new Date('2026-09-15T00:00:00.000Z');

/** One order_rights(INVALID_AFTER_SETTLE) row of the order, created and updated at the given instants. */
async function invalidRecord(
  f: RestoreFixture,
  target: PlatformDiffTarget,
  spec: {
    readonly status?: 'SUCCEEDED' | 'PROCESSING';
    readonly createdAt?: Date;
    readonly updatedAt?: Date;
  } = {},
): Promise<void> {
  const createdAt = spec.createdAt ?? f.clock.now();
  await f.db
    .insertInto('order_rights')
    .values({
      id: randomUUID(),
      app_id: f.appId,
      order_id: target.orderId,
      source: 'API',
      type: 'INVALID_AFTER_SETTLE',
      status: spec.status ?? 'SUCCEEDED',
      amount_fen: null,
      deduction_commission_fen: null,
      occurred_at: createdAt,
      platform_rights_no: `P${randomUUID()}`,
      created_at: createdAt,
      updated_at: spec.updatedAt ?? createdAt,
    })
    .execute();
}

it('[AC-B2-04zzr#10] 处理时再核（R12，VOID、SETTLED）：差错单登记之后（同一时刻、晚一分钟各一例）出现成功的 INVALID_AFTER_SETTLE → restore_platform_invalid：返利状态不变、不写恢复凭证与历史、审计不写、差错单不关；对照：登记之前就成功的那条（时钟已推进）与登记之后仍 PROCESSING 的那条不挡恢复，照常 VOID → WAITING', async () => {
  const f = await fixture(s);
  const bare = () => seedBareOrder(f, { platformStatus: 'SETTLED', receivedAt: RECEIVED_AT });

  const earlier = await bare();
  await invalidRecord(f, earlier);
  f.clock.advanceMs(MINUTE);
  const earlierDiff = await seedPlatformDiff(f, earlier);

  const same = await bare();
  const sameDiff = await seedPlatformDiff(f, same);
  await invalidRecord(f, same);

  const later = await bare();
  const laterDiff = await seedPlatformDiff(f, later);
  const processing = await bare();
  const processingDiff = await seedPlatformDiff(f, processing);
  f.clock.advanceMs(MINUTE);
  await invalidRecord(f, later);
  await invalidRecord(f, processing, { status: 'PROCESSING' });
  f.clock.advanceMs(MINUTE);

  await withRestoreAdmin(f, async (h) => {
    const before = await world(f);
    for (const diff of [sameDiff, laterDiff]) {
      await refusedWith(await h.restore(diff.id), 'restore_platform_invalid');
      expect(await diffNow(f, diff.id)).toEqual(diff);
    }
    expect(await world(f)).toEqual(before);
    for (const order of [same, later]) {
      expect((await orderRow(f, order.orderId)).rebate_status).toBe('VOID');
    }

    for (const [order, diff] of [
      [earlier, earlierDiff],
      [processing, processingDiff],
    ] as const) {
      const data = await platformRestored(await h.restore(diff.id));
      expect(data.rebate_status_after).toBe('WAITING');
      expect((await orderRow(f, order.orderId)).rebate_status).toBe('WAITING');
    }
  });
});

it('[AC-B2-04zzr#11] 处理时再核（R13，CLAWED_BACK、SETTLED）：登记之后（同一时刻、晚一分钟、先为 WAIT_COMMISSION 登记后才变成功各一例）有成功的 INVALID_AFTER_SETTLE → restore_platform_invalid、什么都不写、差错单保持 open；对照：登记前已成功的那条不挡，照常恢复为 CREDITED', async () => {
  const f = await fixture(s);
  const clawed = () => seedClawedBack(f, { reason: 'REFUND' });

  const earlier = await clawed();
  await invalidRecord(f, earlier);
  f.clock.advanceMs(MINUTE);
  const earlierDiff = await seedPlatformDiff(f, earlier);

  const same = await clawed();
  const sameDiff = await seedPlatformDiff(f, same);
  await invalidRecord(f, same);

  const later = await clawed();
  const laterDiff = await seedPlatformDiff(f, later);
  // Created before the registration while still waiting, succeeded after it: the success instant
  // is updated_at, not created_at.
  const turned = await clawed();
  const turnedCreated = new Date(f.clock.now().getTime() - MINUTE);
  const turnedDiff = await seedPlatformDiff(f, turned);
  f.clock.advanceMs(MINUTE);
  await invalidRecord(f, later);
  await invalidRecord(f, turned, { createdAt: turnedCreated, updatedAt: f.clock.now() });
  f.clock.advanceMs(MINUTE);

  await withRestoreAdmin(f, async (h) => {
    const before = await world(f);
    for (const diff of [sameDiff, laterDiff, turnedDiff]) {
      await refusedWith(await h.restore(diff.id), 'restore_platform_invalid');
      expect(await diffNow(f, diff.id)).toEqual(diff);
    }
    expect(await world(f)).toEqual(before);
    for (const order of [same, later, turned]) {
      expect((await orderRow(f, order.orderId)).rebate_status).toBe('CLAWED_BACK');
    }

    const data = await platformRestored(await h.restore(earlierDiff.id));
    expect(data.rebate_status_after).toBe('CREDITED');
    expect((await orderRow(f, earlier.orderId)).rebate_status).toBe('CREDITED');
  });
});
