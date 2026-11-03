// B2-09i rule tests of the effects (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminCreatePayoutWatermark 「Effects」 — one new row of payout_watermarks, written and never changed;
// entered_by the caller's admin_users id, entered_by_name the account's current name (display_name,
// else the username); created_at the injected Clock, measured_at as sent; no voucher, no balance, no
// withdrawal changes; audit payout_watermark_create with the watermark_id, channel, available_fen,
// measured_at and note, and no personal data. Requests go through the real admin entry (kit.ts).
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  ACTION,
  CASH_ENTRY,
  MINUTE,
  audits,
  auditText,
  books,
  enterBody,
  entered,
  fixture,
  member,
  seedSevenDays,
  seedWithdrawal,
  suite,
  viewOf,
  watermarkRows,
  withWatermarkAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-09i#23] 写入：一行 payout_watermarks，entered_by 是调用者的 admin_users id（不是登录名），created_at 是注入时钟，measured_at 是请求里的时刻，金额分毫不差；响应即这一行加 entered_by_name', async () => {
  const f = fixture(s);
  await withWatermarkAdmin(f, async (h) => {
    const who = await h.caller([CASH_ENTRY], { displayName: '合成财务' });
    const item = await entered(
      await h.enter(
        enterBody({
          channel: 'wechat',
          available_fen: 3_000_000,
          measured_at: '2026-11-03T09:30:00+08:00',
          note: '网银余额截图 09:30',
        }),
        { caller: who },
      ),
    );
    const rows = await watermarkRows(f);
    expect(rows).toEqual([
      {
        id: item['watermark_id'],
        app_id: f.appId,
        channel: 'wechat',
        available_fen: 3_000_000n,
        measured_at: new Date('2026-11-03T01:30:00.000Z'),
        entered_by: who.id,
        created_at: f.clock.now(),
      },
    ]);
    expect(item).toEqual(viewOf(rows[0]!, '合成财务'));
  });
});

it('[AC-B2-09i#24] entered_by_name 是账号当前的姓名：display_name 优先，没有时取用户名；账号改名后再录入，响应跟着变，entered_by 仍是同一个 id', async () => {
  const f = fixture(s);
  await withWatermarkAdmin(f, async (h) => {
    const plain = await entered(await h.enter(enterBody()));
    expect(plain['entered_by']).toBe(h.operator.id);
    expect(plain['entered_by_name']).toBe(h.operator.loginName);

    const who = await h.caller([CASH_ENTRY], { displayName: '合成财务甲' });
    const named = await entered(await h.enter(enterBody(), { caller: who }));
    expect(named['entered_by']).toBe(who.id);
    expect(named['entered_by_name']).toBe('合成财务甲');

    await f.db
      .updateTable('admin_users')
      .set({ display_name: '合成财务乙' })
      .where('app_id', '=', f.appId)
      .where('id', '=', who.id)
      .execute();
    const renamed = await entered(await h.enter(enterBody(), { caller: who }));
    expect(renamed['entered_by']).toBe(who.id);
    expect(renamed['entered_by_name']).toBe('合成财务乙');
  });
});

it('[AC-B2-09i#25] 只插入：再录一条多一行，旧行一个字段都不变；不带 note 的录入同样写一行', async () => {
  const f = fixture(s);
  await withWatermarkAdmin(f, async (h) => {
    await entered(
      await h.enter(
        enterBody({ available_fen: 111, measured_at: '2026-11-03T09:10:00+08:00', note: '第一条' }),
      ),
    );
    const [old] = await watermarkRows(f);
    expect(old).toBeDefined();

    f.clock.advanceMs(5 * MINUTE);
    const later = await h.relogin(h.operator);
    const item = await entered(
      await h.enter(enterBody({ available_fen: 222, measured_at: '2026-11-03T09:20:00+08:00' }), {
        caller: later,
      }),
    );
    const rows = await watermarkRows(f);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(old);
    expect(rows[1]).toMatchObject({
      id: item['watermark_id'],
      available_fen: 222n,
      created_at: f.clock.now(),
    });
    expect(await audits(f, ACTION)).toHaveLength(2);
  });
});

it('[AC-B2-09i#26] 审计：action payout_watermark_create 恰一条，操作人是调用者、时间是注入时钟；含 watermark_id、channel、available_fen、measured_at、note；不含登录名或显示名', async () => {
  const f = fixture(s);
  await withWatermarkAdmin(f, async (h) => {
    const who = await h.caller([CASH_ENTRY], { displayName: '合成财务' });
    const note = '网银余额截图 09:30';
    const item = await entered(
      await h.enter(
        enterBody({
          available_fen: 3_000_000,
          measured_at: '2026-11-03T09:30:00+08:00',
          note,
        }),
        { caller: who },
      ),
    );
    const records = await audits(f, ACTION);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.admin_id).toBe(who.id);
    expect(record.system_actor).toBeNull();
    expect(record.at).toEqual(f.clock.now());

    const text = auditText(record);
    expect(text).toContain(`"watermark_id":"${String(item['watermark_id'])}"`);
    expect(text).toContain('"channel":"alipay"');
    expect(text).toMatch(/"available_fen":"?3000000"?[,}]/);
    expect(text).toContain(`"note":${JSON.stringify(note)}`);
    const measured = /"measured_at":"([^"]+)"/.exec(text);
    expect(measured, text).not.toBeNull();
    expect(Date.parse(measured![1]!)).toBe(Date.parse('2026-11-03T09:30:00+08:00'));

    expect(text).not.toContain(who.loginName);
    expect(text).not.toContain('合成财务');
    expect(text).not.toContain('entered_by_name');
  });
});

it('[AC-B2-09i#27] 审计：不带 note 的录入，审计里同样恰一条且没有备注内容', async () => {
  const f = fixture(s);
  await withWatermarkAdmin(f, async (h) => {
    const item = await entered(await h.enter(enterBody()));
    const records = await audits(f, ACTION);
    expect(records).toHaveLength(1);
    const text = auditText(records[0]!);
    expect(text).toContain(`"watermark_id":"${String(item['watermark_id'])}"`);
    expect(text).not.toMatch(/"note":"/);
  });
});

it('[AC-B2-09i#28] 不碰账：录入前后凭证、分录、科目账户、余额、提现单、批次、批次明细、事件都不变，也不入队', async () => {
  const f = fixture(s);
  await seedSevenDays(f);
  const owner = await member(f);
  await seedWithdrawal(f, { userId: owner, net: 10_000n });
  await seedWithdrawal(f, { userId: owner, net: 20_000n, status: 'PAYING' });
  await withWatermarkAdmin(f, async (h) => {
    const before = await books(f);
    await entered(await h.enter(enterBody({ available_fen: 3_000_000 })));
    await entered(await h.enter(enterBody({ channel: 'wechat', available_fen: 0 })));
    expect(await books(f)).toEqual(before);
    expect(f.send).not.toHaveBeenCalled();
    expect(await watermarkRows(f)).toHaveLength(2);
  });
});
