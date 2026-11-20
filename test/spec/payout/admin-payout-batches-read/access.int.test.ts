// B2-07g rule test (claude-independent, SPEC_REF ba6655b1): isolation and permissions of
// listAdminPayoutBatches / getAdminPayoutBatch (contracts/openapi.yaml CT-24zzo; 04 §11.1, §11.2).
// Only the batches of the console's app are listed; a batch of another app, an unknown id and an id
// that is not UUID-shaped are 20001 with data.fields=[batch_id] (no 404, no probing). Either
// payout.execute or fund.view is enough; lacking both is 10403 data.reason=admin_permission_denied; a
// super admin holds every point; without a token 10001. Reading writes no audit record and no row.
// Expected values are written by hand. Top-level it() only.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  REVIEW,
  ago,
  answer,
  batchIds,
  denied,
  detailOf,
  fieldsError,
  fixture,
  heldOn,
  member,
  pageOf,
  plus,
  seedBatch,
  seedMember,
  suite,
  summaryPart,
  withBatches,
  world,
} from './kit.ts';

const s = suite();

it('[AC-B2-07g#10] 只列本 app 的批次：别的 app 同时刻的批次不出现在列表、total 不计；别的 app 的批次 id、未知的 UUID、不是 UUID 的 id 取详情一律 20001 data.fields=[batch_id]（不是 404）', async () => {
  const f = fixture(s);
  const g = fixture(s);
  await withBatches(f, async (h) => {
    const mine = await seedBatch(f, { kind: 'manual', created_at: ago(f, 30), by: h.executor.id });
    const theirs = await seedBatch(g, { kind: 'manual', created_at: ago(f, 20), by: randomUUID() });
    const stranger = await seedMember(g, h);
    await heldOn(g, h, stranger, theirs, {
      reason: 'queue_paused',
      executedAt: ago(f, 20),
      heldAt: plus(ago(f, 20), 1000),
    });
    const page = await pageOf(await h.list());
    expect([page.items.map((row) => row['batch_id']), page.total]).toEqual([[mine.id], 1]);
    expect(await batchIds(await h.list({ held: 'true' }))).toEqual([]);

    await fieldsError(await h.detail(theirs.id), ['batch_id']);
    await fieldsError(await h.detail(randomUUID()), ['batch_id']);
    await fieldsError(await h.detail('not-a-batch-id'), ['batch_id']);
    expect((await detailOf(await h.detail(mine.id)))['batch_id']).toBe(mine.id);
  });
});

it('[AC-B2-07g#10] 权限：只有 payout.execute、只有 fund.view、没有任何点的超管都可读（结果相同）；只有 withdraw.review 的账号 → 10403 data.reason=admin_permission_denied；不带令牌 → 10001', async () => {
  const f = fixture(s);
  await withBatches(f, async (h) => {
    const who = await member(f, h);
    const at = ago(f, 30);
    const batch = await seedBatch(f, { kind: 'manual', created_at: at, by: h.executor.id });
    await heldOn(f, h, who, batch, {
      reason: 'queue_paused',
      executedAt: at,
      heldAt: plus(at, 1000),
    });
    const superAdmin = await h.caller([], { superAdmin: true });
    const reviewer = await h.caller([REVIEW]);

    const views: { detail: Record<string, unknown>; page: Awaited<ReturnType<typeof pageOf>> }[] =
      [];
    for (const reader of [h.executor, h.viewer, superAdmin]) {
      const detail = await detailOf(await h.detail(batch.id, reader));
      const page = await pageOf(await h.list({}, reader));
      views.push({ detail, page });
    }
    expect(views[1]).toEqual(views[0]);
    expect(views[2]).toEqual(views[0]);
    expect(views[0]!.page.items).toEqual([summaryPart(views[0]!.detail)]);

    await denied(await h.list({}, reviewer));
    await denied(await h.detail(batch.id, reviewer));
    await answer(await h.list({}, null), 10001);
    await answer(await h.detail(batch.id, null), 10001);
  });
});

it('[AC-B2-07g#10] 读取不写审计、不写任何表：成功的列表 / 详情、20001、10403 之后，本 app 的提现单、批次、批次明细、转账尝试、冻结记录、审计与配置都与读之前相同', async () => {
  const f = fixture(s);
  await withBatches(f, async (h) => {
    const who = await member(f, h);
    const at = ago(f, 30);
    const batch = await seedBatch(f, { kind: 'manual', created_at: at, by: h.executor.id });
    await heldOn(f, h, who, batch, {
      reason: 'queue_paused',
      executedAt: at,
      heldAt: plus(at, 1000),
    });
    const reviewer = await h.caller([REVIEW]);
    const before = await world(f);

    await pageOf(await h.list({ held: 'true' }));
    await detailOf(await h.detail(batch.id));
    await detailOf(await h.detail(batch.id, h.viewer));
    await fieldsError(await h.detail(randomUUID()), ['batch_id']);
    await denied(await h.detail(batch.id, reviewer));

    expect(await world(f)).toEqual(before);
  });
});
