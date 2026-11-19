// B2-07g rule test (claude-independent, SPEC_REF ba6655b1): the filters, order and pages of
// listAdminPayoutBatches (contracts/openapi.yaml GET /admin/v1/payout-batches, CT-24zzo; 04 §5 后台分页).
// Filters combine with AND: kind; held (true = held_count > 0, false = held_count = 0); created_from
// inclusive and created_to exclusive on created_at (ISO 8601 with offset). Order created_at
// descending, then batch_id descending. page from 1 (default 1), page_size 1–200 (default 20); a page
// past the last one is items=[]; total is the count of the filter set. A value outside an enum, not a
// boolean, not a date-time or out of range is 20001 naming the parameter; created_from later than
// created_to is 20001 with fields [created_from, created_to]; equal bounds or a filter set nothing
// matches is an empty page, not an error. Expected values are written by hand. Top-level it() only.
import { expect, it } from 'vitest';
import {
  ago,
  batchIds,
  fieldsError,
  fixture,
  heldOn,
  member,
  orderedIds,
  pageOf,
  plus,
  seedBatch,
  suite,
  summaryView,
  withBatches,
  withOffset,
  type BatchRow,
  type BatchesAdmin,
  type Fixture,
} from './kit.ts';

const s = suite();

interface Batches {
  readonly b1: BatchRow;
  readonly b2: BatchRow;
  readonly b3: BatchRow;
  readonly b4: BatchRow;
  readonly b5: BatchRow;
}

/**
 * b1 auto 300 minutes ago; b2 manual 200 ago; b3 manual and b4 auto both exactly 100 ago, b4 with
 * the higher id (so it comes first), b3 with a held member; b5 manual 10 ago. Each batch but b3 has
 * no member.
 */
async function batches(f: Fixture, h: BatchesAdmin): Promise<Batches> {
  const [lowId, highId] = orderedIds();
  const b1 = await seedBatch(f, { kind: 'auto', created_at: ago(f, 300) });
  const b2 = await seedBatch(f, { kind: 'manual', created_at: ago(f, 200), by: h.executor.id });
  const tieAt = ago(f, 100);
  const b3 = await f.db
    .withSchema('app')
    .insertInto('payout_batches')
    .values({
      id: lowId,
      app_id: f.appId,
      kind: 'manual',
      created_by: h.executor.id,
      created_at: tieAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const b4 = await f.db
    .withSchema('app')
    .insertInto('payout_batches')
    .values({ id: highId, app_id: f.appId, kind: 'auto', created_by: null, created_at: tieAt })
    .returningAll()
    .executeTakeFirstOrThrow();
  const b5 = await seedBatch(f, { kind: 'manual', created_at: ago(f, 10), by: h.executor.id });
  const who = await member(f, h);
  await heldOn(f, h, who, b3, {
    reason: 'queue_paused',
    executedAt: tieAt,
    heldAt: plus(tieAt, 20_000),
  });
  return { b1, b2, b3, b4, b5 };
}

it('[AC-B2-07g#9] 不带参数：created_at 倒序、同刻按 batch_id 倒序，page=1、page_size=20、total 为全部；行值照契约（b3 带一个挂起成员 held_count=1）', async () => {
  const f = fixture(s);
  await withBatches(f, async (h) => {
    const x = await batches(f, h);
    const page = await pageOf(await h.list());
    expect(page.items.map((row) => row['batch_id'])).toEqual([
      x.b5.id,
      x.b4.id,
      x.b3.id,
      x.b2.id,
      x.b1.id,
    ]);
    expect({ page: page.page, page_size: page.page_size, total: page.total }).toEqual({
      page: 1,
      page_size: 20,
      total: 5,
    });
    expect(page.items[2]).toEqual(
      summaryView(x.b3, {
        executed_at: x.b3.created_at.getTime(),
        member_count: 1,
        result_counts: { paying: 1 },
        held_count: 1,
      }),
    );
    expect(page.items[0]).toEqual(
      summaryView(x.b5, {
        executed_at: null,
        member_count: 0,
        result_counts: {},
        held_count: 0,
      }),
    );
  });
});

it('[AC-B2-07g#9] kind 与 held 过滤（AND 组合）：kind=auto → [b4, b1]；kind=manual → [b5, b3, b2]；held=true → [b3]；held=false → [b5, b4, b2, b1]；kind=manual & held=false → [b5, b2]；kind=auto & held=true 无匹配 → items=[]、total=0', async () => {
  const f = fixture(s);
  await withBatches(f, async (h) => {
    const x = await batches(f, h);
    expect(await batchIds(await h.list({ kind: 'auto' }))).toEqual([x.b4.id, x.b1.id]);
    expect(await batchIds(await h.list({ kind: 'manual' }))).toEqual([x.b5.id, x.b3.id, x.b2.id]);
    expect(await batchIds(await h.list({ held: 'true' }))).toEqual([x.b3.id]);
    expect(await batchIds(await h.list({ held: 'false' }))).toEqual([
      x.b5.id,
      x.b4.id,
      x.b2.id,
      x.b1.id,
    ]);
    const both = await pageOf(await h.list({ kind: 'manual', held: 'false' }));
    expect([both.items.map((row) => row['batch_id']), both.total]).toEqual([[x.b5.id, x.b2.id], 2]);
    const none = await pageOf(await h.list({ kind: 'auto', held: 'true' }));
    expect({ items: none.items, total: none.total }).toEqual({ items: [], total: 0 });
  });
});

it('[AC-B2-07g#9] created_from 含、created_to 不含（ISO 8601 带时区）：from=恰 100 分前 → [b5, b4, b3]；to=恰 100 分前 → [b2, b1]；from=200 分前、to=100 分前 → [b2]；from 与 to 相等 → 空页不报错；同一时刻写成 +08:00 与 Z 结果相同', async () => {
  const f = fixture(s);
  await withBatches(f, async (h) => {
    const x = await batches(f, h);
    const tie = withOffset(ago(f, 100));
    expect(await batchIds(await h.list({ created_from: tie }))).toEqual([
      x.b5.id,
      x.b4.id,
      x.b3.id,
    ]);
    expect(await batchIds(await h.list({ created_to: tie }))).toEqual([x.b2.id, x.b1.id]);
    expect(
      await batchIds(await h.list({ created_from: withOffset(ago(f, 200)), created_to: tie })),
    ).toEqual([x.b2.id]);
    const equal = await pageOf(await h.list({ created_from: tie, created_to: tie }));
    expect({ items: equal.items, total: equal.total }).toEqual({ items: [], total: 0 });
    expect(await batchIds(await h.list({ created_from: ago(f, 100).toISOString() }))).toEqual([
      x.b5.id,
      x.b4.id,
      x.b3.id,
    ]);
  });
});

it('[AC-B2-07g#9] 分页：page_size=2 → 第 1 页 [b5, b4]、第 2 页 [b3, b2]、第 3 页 [b1]、第 4 页 items=[]，total 都是 5，page / page_size 原样回带；page_size=200 可用', async () => {
  const f = fixture(s);
  await withBatches(f, async (h) => {
    const x = await batches(f, h);
    const pages: unknown[] = [];
    for (const n of ['1', '2', '3', '4']) {
      const page = await pageOf(await h.list({ page: n, page_size: '2' }));
      pages.push({
        ids: page.items.map((row) => row['batch_id']),
        page: page.page,
        page_size: page.page_size,
        total: page.total,
      });
    }
    expect(pages).toEqual([
      { ids: [x.b5.id, x.b4.id], page: 1, page_size: 2, total: 5 },
      { ids: [x.b3.id, x.b2.id], page: 2, page_size: 2, total: 5 },
      { ids: [x.b1.id], page: 3, page_size: 2, total: 5 },
      { ids: [], page: 4, page_size: 2, total: 5 },
    ]);
    const wide = await pageOf(await h.list({ page_size: '200' }));
    expect([wide.items.length, wide.page_size, wide.total]).toEqual([5, 200, 5]);
    // The same filter on page 2 of 1-row pages counts the filter set, not the whole app.
    const filtered = await pageOf(await h.list({ kind: 'manual', page: '2', page_size: '1' }));
    expect([filtered.items.map((row) => row['batch_id']), filtered.total]).toEqual([[x.b3.id], 3]);
  });
});

it('[AC-B2-07g#9] 20001 各情形（data.fields 指明参数）：page_size=201 / 0、page=0、kind 不在枚举、held 不是布尔、created_from / created_to 不是日期时间；created_from 晚于 created_to → [created_from, created_to]', async () => {
  const f = fixture(s);
  await withBatches(f, async (h) => {
    await batches(f, h);
    await fieldsError(await h.list({ page_size: '201' }), ['page_size']);
    await fieldsError(await h.list({ page_size: '0' }), ['page_size']);
    await fieldsError(await h.list({ page: '0' }), ['page']);
    await fieldsError(await h.list({ kind: 'batch' }), ['kind']);
    await fieldsError(await h.list({ held: 'yes' }), ['held']);
    await fieldsError(await h.list({ created_from: 'yesterday' }), ['created_from']);
    await fieldsError(await h.list({ created_to: '2026-10-30' }), ['created_to']);
    await fieldsError(
      await h.list({
        created_from: withOffset(ago(f, 100)),
        created_to: withOffset(plus(ago(f, 100), -1)),
      }),
      ['created_from', 'created_to'],
    );
  });
});
