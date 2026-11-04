// B2-09m order-of-checks rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminBatchManualPaid, D10-591 — the route schema first, also for a caller without the permission point or
// a step-up token (20001 data.fields naming the field); then payout.manual_entry (10403
// data.reason=admin_permission_denied; a super admin holds every point) → step-up totp (10003
// data.tier=totp) → the duplicate check (20001 data.fields=[items]), case-insensitive on the id. The login
// token is checked before the body is parsed (platform/http/request-checks.ts), so no login token is always
// 10001. Every refusal writes nothing. Requests go through the real admin entry (manual-paid-harness.ts).
// Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  ENTRY,
  EXECUTE,
  NET,
  REVIEW,
  VIEW,
  answer,
  approved,
  asPaidManual,
  denied,
  entryOf,
  expectItems,
  expectNothingWritten,
  fieldsError,
  fixture,
  paid,
  payee,
  rowOf,
  serial,
  skipped,
  state,
  stepUpRequired,
  suite,
  voucherOf,
  withManualAdmin,
  type ManualPaidEntry,
} from './manual-paid-harness.ts';

const s = suite();

it('[AC-B2-09m#49] 权限：只持 withdraw.review、只持 payout.execute、只持 fund.view、三个都持、没有权限点 → 10403 data.reason=admin_permission_denied，带不带 step-up 都一样，也先于重复 id 的检查；不带登录令牌 → 10001；什么都不写', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const w = await approved(f, h, await payee(f, h));
    const entry = entryOf(f, w);
    const before = await state(f);
    const outsiders = [
      h.reviewer,
      h.executor,
      h.viewer,
      await h.caller([REVIEW, EXECUTE, VIEW]),
      await h.caller([]),
    ];
    for (const caller of outsiders) {
      await denied(await h.manualPaid([entry], { caller }));
      await denied(await h.manualPaid([entry], { caller, stepUp: null }));
      await denied(await h.manualPaid([entry, entry], { caller }));
      await denied(await h.manualPaid([entry, entry], { caller, stepUp: null }));
    }
    await answer(await h.manualPaid([entry], { caller: null }), 10001);
    expect(await state(f)).toEqual(before);
    expect(await rowOf(f, w)).toEqual(w);
  });
});

it('[AC-B2-09m#50] 能补录的账号：只持 payout.manual_entry；超管没有权限点行也能，manual_entry_by 与 manual_confirm_by 是超管；超管同样要动态码档（无令牌 10003）', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const root = await h.caller([], { superAdmin: true });
    const byRoot = await approved(f, h, await payee(f, h));
    const byEntry = await approved(f, h, await payee(f, h));
    const rootEntry = entryOf(f, byRoot);
    const entryEntry = entryOf(f, byEntry);

    await stepUpRequired(await h.manualPaid([rootEntry], { caller: root, stepUp: null }));
    expect(await rowOf(f, byRoot)).toEqual(byRoot);

    await expectItems(await h.manualPaid([rootEntry], { caller: root }), [paid(byRoot.id)]);
    expect(await rowOf(f, byRoot)).toEqual(asPaidManual(f, byRoot, rootEntry, root.id));
    await expectItems(await h.manualPaid([entryEntry]), [paid(byEntry.id)]);
    expect(await rowOf(f, byEntry)).toEqual(asPaidManual(f, byEntry, entryEntry, h.entry.id));
  });
});

it('[AC-B2-09m#51] 二次验证（动态码档）：不带令牌、令牌是别的账号的、令牌是短信档的 → 10003 data.tier=totp，先于重复 id 的检查；什么都不写', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const w = await approved(f, h, await payee(f, h));
    const entry = entryOf(f, w);
    const before = await state(f);
    const colleague = await h.caller([ENTRY]);

    await stepUpRequired(await h.manualPaid([entry], { stepUp: null }));
    await stepUpRequired(await h.manualPaid([entry], { stepUp: await h.stepUp(colleague) }));
    await stepUpRequired(await h.manualPaid([entry], { stepUp: await h.stepUp(h.entry, 'sms') }));
    await stepUpRequired(await h.manualPaid([entry, entry], { stepUp: null }));

    expect(await state(f)).toEqual(before);
  });
});

it('[AC-B2-09m#52] 重复 withdrawal_id（有权限且带令牌）→ 20001 data.fields=[items]，一单都不补、什么都不写：同一个 id、大小写不同的同一个 id、重复的非 UUID 都算', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const first = await approved(f, h, await payee(f, h));
    const second = await approved(f, h, await payee(f, h));
    const before = await state(f);
    const firstEntry = entryOf(f, first);
    const stray = entryOf(f, { id: 'not-a-uuid', net_fen: NET });

    await fieldsError(await h.manualPaid([firstEntry, entryOf(f, second), firstEntry]), ['items']);
    await fieldsError(
      await h.manualPaid([
        firstEntry,
        entryOf(f, second),
        { ...firstEntry, withdrawal_id: first.id.toUpperCase(), channel_order_id: serial() },
      ]),
      ['items'],
    );
    await fieldsError(await h.manualPaid([stray, stray]), ['items']);

    expectNothingWritten(before, await state(f));
  });
});

it('[AC-B2-09m#53] 大写 id 能补录，回的是发送时的写法；状态、凭证键（小写）都落在同一张单上，只有一张凭证', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const w = await approved(f, h, await payee(f, h));
    const upper = w.id.toUpperCase();
    const entry = entryOf(f, w, { withdrawal_id: upper });

    await expectItems(await h.manualPaid([entry]), [paid(upper)]);

    expect(await rowOf(f, w)).toEqual(asPaidManual(f, w, entry, h.entry.id));
    expect(await voucherOf(f.db, f.appId, `wd:${w.id}:PAID`)).toHaveLength(1);
    const keys = (await state(f)).vouchers.map((row) => row.uniq_key);
    expect(keys.filter((key) => key.endsWith(':PAID'))).toEqual([`wd:${w.id}:PAID`]);
  });
});

it('[AC-B2-09m#54] 校验顺序（D10-591）：不合格请求体（缺字段、空数组、201 项、多余字段、流水号空、含空白或超 64 字符、paid_fen 小数或字符串、paid_at 非时间、id 超长）在无权限、不带 step-up 时也是 20001 且 data.fields 恰为该字段；有权限的也一样；什么都不写', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const before = await state(f);
    const good: ManualPaidEntry = entryOf(f, { id: randomUUID(), net_fen: NET });
    const one = (patch: Record<string, unknown>): unknown => ({ items: [{ ...good, ...patch }] });
    const without = (field: keyof ManualPaidEntry): unknown => {
      const copy: Record<string, unknown> = { ...good };
      delete copy[field];
      return { items: [copy] };
    };
    const cases: readonly (readonly [unknown, string])[] = [
      [{}, 'items'],
      [{ items: [] }, 'items'],
      [{ items: good }, 'items'],
      [
        { items: Array.from({ length: 201 }, () => ({ ...good, withdrawal_id: randomUUID() })) },
        'items',
      ],
      [{ items: [good], operator: randomUUID() }, 'operator'],
      [one({ note: '多余字段' }), 'items.0.note'],
      [without('withdrawal_id'), 'items.0.withdrawal_id'],
      [without('channel_order_id'), 'items.0.channel_order_id'],
      [without('paid_at'), 'items.0.paid_at'],
      [without('paid_fen'), 'items.0.paid_fen'],
      [one({ channel_order_id: '' }), 'items.0.channel_order_id'],
      [one({ channel_order_id: '2026 1103' }), 'items.0.channel_order_id'],
      [one({ channel_order_id: ' 20261103' }), 'items.0.channel_order_id'],
      [one({ channel_order_id: '20261103\t' }), 'items.0.channel_order_id'],
      [one({ channel_order_id: '2026\n1103' }), 'items.0.channel_order_id'],
      [one({ channel_order_id: '2026　1103' }), 'items.0.channel_order_id'],
      [one({ channel_order_id: 'x'.repeat(65) }), 'items.0.channel_order_id'],
      [one({ channel_order_id: 20261103 }), 'items.0.channel_order_id'],
      [one({ paid_fen: 12_347.5 }), 'items.0.paid_fen'],
      [one({ paid_fen: '12347' }), 'items.0.paid_fen'],
      [one({ paid_fen: null }), 'items.0.paid_fen'],
      [one({ paid_at: 'yesterday' }), 'items.0.paid_at'],
      [one({ paid_at: '2026-11-03' }), 'items.0.paid_at'],
      [one({ paid_at: 1_793_000_000 }), 'items.0.paid_at'],
      [one({ withdrawal_id: 'x'.repeat(65) }), 'items.0.withdrawal_id'],
      [one({ withdrawal_id: '' }), 'items.0.withdrawal_id'],
      [one({ withdrawal_id: 1 }), 'items.0.withdrawal_id'],
    ];
    const nobody = await h.caller([]);
    for (const [body, field] of cases) {
      await fieldsError(await h.manualPaidBody(body, { caller: nobody, stepUp: null }), [field]);
      await fieldsError(await h.manualPaidBody(body, { caller: h.viewer }), [field]);
      await fieldsError(await h.manualPaidBody(body, { stepUp: null }), [field]);
      await fieldsError(await h.manualPaidBody(body), [field]);
    }
    expect(await state(f)).toEqual(before);
  });
});

it('[AC-B2-09m#55] 恰好 200 项通过 schema（未知 id 和非 UUID 填满），每项都有结果；一张可补的照常 paid', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const w = await approved(f, h, await payee(f, h));
    const unknown = Array.from({ length: 100 }, () => randomUUID());
    const strays = Array.from({ length: 99 }, (_, index) => `stray-${index}`);
    const rest = [...unknown, ...strays];

    await expectItems(
      await h.manualPaid([entryOf(f, w), ...rest.map((id) => entryOf(f, { id, net_fen: NET }))]),
      [paid(w.id), ...rest.map((id) => skipped(id, 'not_found'))],
    );

    expect(await rowOf(f, w)).toMatchObject({ status: 'PAID_MANUAL' });
  });
});

it('[AC-B2-09m#56] 一个动态码档令牌覆盖整个请求：同一令牌一次补 3 单；令牌成功后被消费，再用 → 10003，单不动', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const rows = [
      await approved(f, h, await payee(f, h)),
      await approved(f, h, await payee(f, h)),
      await approved(f, h, await payee(f, h)),
    ];
    const stepUp = await h.stepUp(h.entry);

    const items = rows.map((row) => entryOf(f, row));

    await expectItems(
      await h.manualPaid(items, { stepUp }),
      rows.map((row) => paid(row.id)),
    );

    const next = await approved(f, h, await payee(f, h));
    await stepUpRequired(await h.manualPaid([entryOf(f, next)], { stepUp }));
    expect(await rowOf(f, next)).toEqual(next);
  });
});
