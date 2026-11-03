// B2-09i idempotency rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminCreatePayoutWatermark — `Idempotency-Key` required: same key and body → the first result,
// whatever X-Step-Up-Token carries and whatever the measured_at checks would say by now; same key
// with another body → 20901; same key while still running → 40901; there is no business key, so two
// keys with the same body are two rows as long as measured_at still passes. A running entry is held
// right after its INSERT in the entry's database handle (kit.ts). Requests go through the real admin
// entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  ACTION,
  HOUR,
  MINUTE,
  PATH,
  answer,
  audits,
  enterBody,
  entered,
  everything,
  fieldsError,
  fixture,
  idempotencyRows,
  newKey,
  suite,
  track,
  watermarkRows,
  withWatermarkAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-09i#17] 同键同体：重放原样返回第一次的应答（每次的 step-up 令牌不同也一样），只有一行、一条审计', async () => {
  const f = fixture(s);
  await withWatermarkAdmin(f, async (h) => {
    const key = newKey();
    const body = enterBody({ note: '网银余额截图 09:30' });
    const sent = await h.enter(body, { key });
    const item = await entered(sent);
    const after = await everything(f);

    for (let i = 0; i < 2; i += 1) {
      const again = await h.enter(body, { key });
      expect(again.statusCode).toBe(sent.statusCode);
      expect(again.body).toBe(sent.body);
    }

    expect(await everything(f)).toEqual(after);
    expect((await watermarkRows(f)).map((row) => row.id)).toEqual([item['watermark_id']]);
    expect(await audits(f, ACTION)).toHaveLength(1);
  });
});

it('[AC-B2-09i#18] 同键同体的重放不再判取数时间：已有更新的一条、时钟走到它早已过旧之后，仍返回第一次的应答，不写新行', async () => {
  const f = fixture(s);
  await withWatermarkAdmin(f, async (h) => {
    const key = newKey();
    const body = enterBody({ measured_at: '2026-11-03T09:30:00+08:00' });
    const sent = await h.enter(body, { key });
    await entered(sent);
    await entered(await h.enter(enterBody({ measured_at: '2026-11-03T09:50:00+08:00' })));
    const after = await everything(f);

    expect((await h.enter(body, { key })).body).toBe(sent.body);

    f.clock.advanceMs(3 * HOUR);
    const caller = await h.relogin(h.operator);
    const late = await h.enter(body, { key, caller });
    expect(late.statusCode).toBe(sent.statusCode);
    expect(late.body).toBe(sent.body);
    expect(await everything(f)).toEqual(after);
  });
});

it('[AC-B2-09i#19] 同键异体（通道、金额、取数时间、备注任一不同）→ 20901，不新增任何东西', async () => {
  const f = fixture(s);
  await withWatermarkAdmin(f, async (h) => {
    const key = newKey();
    await entered(await h.enter(enterBody(), { key }));
    const after = await everything(f);
    for (const patch of [
      { channel: 'wechat' },
      { available_fen: 3_000_001 },
      { measured_at: '2026-11-03T09:31:00+08:00' },
      { note: '换一个备注' },
    ]) {
      await answer(await h.enter(enterBody(patch), { key }), 20901);
    }
    expect(await everything(f)).toEqual(after);
  });
});

it('[AC-B2-09i#20] 同一 key 的第一次还在执行时再发（同体或异体）→ 40901；放行后第一次照常完成，之后重放得到它的应答，一行一条审计', async () => {
  const f = fixture(s);
  await withWatermarkAdmin(f, async (h) => {
    const key = newKey();
    const hold = h.holdNextInsert();
    const first = track(h.enter(enterBody(), { key }));
    try {
      expect(await hold.reachedBy(first), '第一次录入应走到写入水位表这一步').toBe(true);
      await answer(await h.enter(enterBody(), { key }), 40901);
      await answer(await h.enter(enterBody({ available_fen: 1 }), { key }), 40901);
      expect(await watermarkRows(f)).toEqual([]);
    } finally {
      hold.open();
    }
    const sent = await first.promise;
    await entered(sent);
    const replay = await h.enter(enterBody(), { key });
    expect(replay.body).toBe(sent.body);
    expect(await watermarkRows(f)).toHaveLength(1);
    expect(await audits(f, ACTION)).toHaveLength(1);
    const rows = (await idempotencyRows(f)).filter((row) => row.key === key);
    expect(rows.map((row) => ({ path: row.path, status: row.status }))).toEqual([
      { path: PATH, status: 'completed' },
    ]);
  });
});

it('[AC-B2-09i#21] Idempotency-Key 必填：不带或格式不对 → 20001，什么都不写、不留幂等记录', async () => {
  const f = fixture(s);
  await withWatermarkAdmin(f, async (h) => {
    const before = await everything(f);
    for (const key of [null, 'short', 'bad key with spaces']) {
      await answer(await h.enter(enterBody(), { key }), 20001);
    }
    expect(await everything(f)).toEqual(before);
    expect(await idempotencyRows(f)).toEqual([]);
  });
});

it('[AC-B2-09i#22] 没有业务键：异键同体在取数时间校验通过时是两行、两条审计、不同 watermark_id；时钟走到它过旧后，新键同体 → 20001 data.fields=[measured_at]，不写第三行', async () => {
  const f = fixture(s);
  await withWatermarkAdmin(f, async (h) => {
    const body = enterBody({ measured_at: '2026-11-03T09:30:00+08:00' });
    const first = await entered(await h.enter(body));
    const second = await entered(await h.enter(body));
    expect(second['watermark_id']).not.toBe(first['watermark_id']);
    expect((await watermarkRows(f)).map((row) => row.id).sort()).toEqual(
      [first['watermark_id'], second['watermark_id']].sort(),
    );
    expect(await audits(f, ACTION)).toHaveLength(2);

    // 11:31 距 09:30 超过 2 小时。
    f.clock.advanceMs(121 * MINUTE - 30 * MINUTE);
    const caller = await h.relogin(h.operator);
    const after = await everything(f);
    await fieldsError(await h.enter(body, { caller }), ['measured_at']);
    expect(await everything(f)).toEqual(after);
  });
});
