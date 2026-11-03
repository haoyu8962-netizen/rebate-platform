// B2-09i refusal rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminCreatePayoutWatermark, order of checks (D10-591). Pinned with bodies the route schema accepts:
// fund.cash_entry (10403 data.reason=admin_permission_denied; a super admin holds every point) →
// step-up totp (10003 data.tier=totp) → the checks on the body (20001 data.fields). A body the route
// schema refuses is only asserted for a caller with the permission point and a token. The request
// body (D10-592): channel alipay or wechat, available_fen an integer from 0 to 2^53 − 1, measured_at a
// date-time, note 1–500 characters and not blank, no other field. Every refusal writes nothing.
// Requests go through the real admin entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  CASH_ENTRY,
  answer,
  chars,
  denied,
  enterBody,
  entered,
  everything,
  executeAuto,
  fieldsError,
  fixture,
  member,
  newKey,
  refusableBodies,
  refusedFor,
  seedWithdrawal,
  stepUpRequired,
  suite,
  watermarkRows,
  withWatermarkAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-09i#11] 权限：只持 fund.view、没有权限点、只有别的权限点 → 10403 data.reason=admin_permission_denied，带不带令牌都一样，也先于空白 note 与取数时间的检查；不带登录令牌 → 10001；什么都不写', async () => {
  const f = fixture(s);
  await withWatermarkAdmin(f, async (h) => {
    const before = await everything(f);
    const outsiders = [
      h.viewer,
      await h.caller([]),
      await h.caller(['fund.recon', 'payout.execute']),
    ];
    for (const caller of outsiders) {
      await denied(await h.enter(enterBody(), { caller }));
      await denied(await h.enter(enterBody(), { caller, stepUp: null }));
      for (const body of refusableBodies()) {
        await denied(await h.enter(body, { caller }));
        await denied(await h.enter(body, { caller, stepUp: null }));
      }
    }
    await answer(await h.enter(enterBody(), { caller: null }), 10001);
    expect(await everything(f)).toEqual(before);
  });
});

it('[AC-B2-09i#12] 二次验证（动态码档）：不带 X-Step-Up-Token、令牌是别的账号的、令牌是短信档的 → 10003 data.tier=totp，先于空白 note 与取数时间的检查；什么都不写；令牌不进请求体哈希，拿到令牌后用同一 Idempotency-Key 重放即成功且只有一行', async () => {
  const f = fixture(s);
  await withWatermarkAdmin(f, async (h) => {
    const before = await everything(f);
    const key = newKey();
    const colleague = await h.caller([CASH_ENTRY]);
    await stepUpRequired(await h.enter(enterBody(), { key, stepUp: null }));
    await stepUpRequired(await h.enter(enterBody(), { key, stepUp: await h.stepUp(colleague) }));
    await stepUpRequired(
      await h.enter(enterBody(), { key, stepUp: await h.stepUp(h.operator, 'sms') }),
    );
    for (const body of refusableBodies()) {
      await stepUpRequired(await h.enter(body, { stepUp: null }));
    }
    expect(await everything(f)).toEqual(before);

    const item = await entered(await h.enter(enterBody(), { key }));
    const rows = await watermarkRows(f);
    expect(rows.map((row) => row.id)).toEqual([item['watermark_id']]);
    expect(rows[0]?.entered_by).toBe(h.operator.id);
  });
});

it('[AC-B2-09i#13] 超管没有权限点行也能录入，entered_by 是超管；超管同样要动态码档（无令牌 10003）', async () => {
  const f = fixture(s);
  await withWatermarkAdmin(f, async (h) => {
    const root = await h.caller([], { superAdmin: true });
    await stepUpRequired(await h.enter(enterBody(), { caller: root, stepUp: null }));
    expect(await watermarkRows(f)).toEqual([]);

    await entered(await h.enter(enterBody(), { caller: root }));
    expect((await watermarkRows(f)).map((row) => row.entered_by)).toEqual([root.id]);
  });
});

it('[AC-B2-09i#14] 有权限且带令牌时才走到请求体检查：去空白后为空的 note → 20001 data.fields=[note]，超前或过旧的 measured_at → 20001 data.fields=[measured_at]；什么都不写', async () => {
  const f = fixture(s);
  await withWatermarkAdmin(f, async (h) => {
    const before = await everything(f);
    for (const note of ['   ', ' \t\n ']) {
      await fieldsError(await h.enter(enterBody({ note })), ['note']);
    }
    await fieldsError(await h.enter(enterBody({ measured_at: '2026-11-03T10:05:00.001+08:00' })), [
      'measured_at',
    ]);
    await fieldsError(await h.enter(enterBody({ measured_at: '2026-11-03T07:59:59.999+08:00' })), [
      'measured_at',
    ]);
    expect(await everything(f)).toEqual(before);
  });
});

it('[AC-B2-09i#15] 请求体 schema（有权限且带令牌）：缺字段、channel 为 bank_card 或未知值、available_fen 为负数/小数/字符串/超过 9,007,199,254,740,991、measured_at 不是日期时间、note 为空串或超过 500 字或不是字符串、多带键（entered_by、watermark_id）→ 20001 data.fields 恰为该字段；什么都不写', async () => {
  const f = fixture(s);
  await withWatermarkAdmin(f, async (h) => {
    const before = await everything(f);
    const without = (name: string) =>
      Object.fromEntries(Object.entries(enterBody()).filter(([key]) => key !== name));
    const cases: readonly (readonly [unknown, string])[] = [
      [without('channel'), 'channel'],
      [without('available_fen'), 'available_fen'],
      [without('measured_at'), 'measured_at'],
      [enterBody({ channel: 'bank_card' }), 'channel'],
      [enterBody({ channel: 'nope' }), 'channel'],
      [enterBody({ available_fen: -1 }), 'available_fen'],
      [enterBody({ available_fen: 1.5 }), 'available_fen'],
      [enterBody({ available_fen: '100' }), 'available_fen'],
      [enterBody({ available_fen: 9_007_199_254_740_992 }), 'available_fen'],
      [enterBody({ measured_at: 'yesterday' }), 'measured_at'],
      [enterBody({ measured_at: '2026-11-03' }), 'measured_at'],
      [enterBody({ measured_at: 1_762_135_200_000 }), 'measured_at'],
      [enterBody({ note: '' }), 'note'],
      [enterBody({ note: chars(501) }), 'note'],
      [enterBody({ note: 1 }), 'note'],
      [enterBody({ entered_by: h.operator.id }), 'entered_by'],
      [enterBody({ watermark_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4fb201' }), 'watermark_id'],
    ];
    for (const [body, field] of cases) {
      await fieldsError(await h.enter(body), [field]);
    }
    expect(await everything(f)).toEqual(before);
  });
});

it('[AC-B2-09i#16] available_fen 的边界：0 可以，且 W=0 是一条有效读数（判定 watermark_usable_exceeded，不是 watermark_stale）；9,007,199,254,740,991 可以且分毫不差；note 恰好 500 字可以，不带 note 也可以', async () => {
  const f = fixture(s);
  const id = await seedWithdrawal(f, { userId: await member(f), net: 100n });
  await withWatermarkAdmin(f, async (h) => {
    const zero = await entered(await h.enter(enterBody({ available_fen: 0 })));
    expect(zero['available_fen']).toBe(0);
    expect((await watermarkRows(f)).map((row) => row.available_fen)).toEqual([0n]);
    expect(await executeAuto(f, [id])).toEqual(refusedFor('watermark_usable_exceeded'));

    const most = await entered(
      await h.enter(enterBody({ available_fen: 9_007_199_254_740_991, note: chars(500) })),
    );
    expect(most['available_fen']).toBe(9_007_199_254_740_991);
    expect((await watermarkRows(f)).map((row) => row.available_fen).sort()).toEqual([
      0n,
      9_007_199_254_740_991n,
    ]);
  });
});
