// B2-04zzl confirmation rule tests, idempotency, one order with several differences, concurrency and
// atomicity (claude-independent, SPEC_REF d5713bf4): contracts/openapi.yaml
// blacklistClawbackAdminReconDiff — `Idempotency-Key` required; same key and body → the first result;
// another body → 20901; still running → 40901; a new key on an adjusted difference → 20902; the voucher
// event id `B{recon_diff_id}` keeps a redelivery from clawing back twice; several open differences of
// one order: the first confirmation takes the order, the others are 20902 resource=order; two requests
// at once claw back once; everything in one transaction. Requests go through the real admin entry
// (kit.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  ACTION,
  CHANNEL,
  FAULT_POINTS,
  PERMISSION,
  SUFFIX,
  answer,
  app,
  audits,
  clawbackKey,
  clawbackPath,
  confirmed,
  diffConflict,
  diffNow,
  eventIdOf,
  everything,
  expectAdjusted,
  holdOrderKey,
  idempotencyRows,
  newKey,
  orderConflict,
  platformClawbackKey,
  platformDecreaseLines,
  receivable,
  seedBlacklistDiff,
  suite,
  track,
  userClawbackLines,
  waiting,
  withAdmin,
} from './kit.ts';
import { reopenOrder, replayClawbackVouchers, restoreNets } from './ledger-kit.ts';

const s = suite();

it('[AC-B2-04zzl#31] 同一 Idempotency-Key 同一请求体重放：原样返回第一次的应答（同一 clawed_back_fen），不二次扣回、不再写审计；同 key 换请求体 → 20901；不同 key 再确认同一张 → 20902 recon_diff；别的账号用同一 key 是它自己的作用域 → 20902 recon_diff', async () => {
  const a = await app(s);
  const { h } = a;
  const o = await h.credited();
  const diff = await seedBlacklistDiff(a, o);
  await withAdmin(a, async (admin) => {
    const key = newKey();
    const body = { note: '复核确认' };
    const sent = await admin.confirm(diff.id, body, { key });
    expect((await confirmed(sent)).clawed_back_fen).toBe(552);
    const after = await everything(a);

    for (let i = 0; i < 2; i += 1) {
      const again = await admin.confirm(diff.id, body, { key });
      expect(again.statusCode).toBe(sent.statusCode);
      expect(again.body).toBe(sent.body);
    }
    await answer(await admin.confirm(diff.id, { note: '换一个说明' }, { key }), 20901);
    await diffConflict(await admin.confirm(diff.id, body));
    const colleague = await admin.caller([PERMISSION]);
    await diffConflict(await admin.confirm(diff.id, body, { key, caller: colleague }));

    expect(await everything(a)).toEqual(after);
    expect(await audits(a.f, ACTION)).toHaveLength(1);
    expect(await h.balance(o.user('self'))).toBe(0n);
  });
});

it('[AC-B2-04zzl#32] Idempotency-Key 必填：不带或格式不对 → 20001，什么都不变、不留幂等记录；同一 key 的第一次还在执行时再发 → 40901，放行后第一次照常完成', async () => {
  const a = await app(s);
  const o = await a.h.credited();
  const diff = await seedBlacklistDiff(a, o);
  await withAdmin(a, async (admin) => {
    const before = await everything(a);
    await answer(await admin.confirm(diff.id, {}, { key: null }), 20001);
    await answer(await admin.confirm(diff.id, {}, { key: 'short' }), 20001);
    expect(await everything(a)).toEqual(before);
    expect(await idempotencyRows(a.f)).toEqual([]);

    const key = newKey();
    const lock = await holdOrderKey(a.f, o.orderKey);
    const first = track(admin.confirm(diff.id, {}, { key }));
    try {
      expect(await waiting(a.f, 1, [first]), '第一次请求应在订单键锁上等待').toBe(true);
      await answer(await admin.confirm(diff.id, {}, { key }), 40901);
      expect(await everything(a)).toEqual(before);
    } finally {
      await lock.release();
    }
    const sent = await first.promise;
    expect((await confirmed(sent)).clawed_back_fen).toBe(552);
    const rows = (await idempotencyRows(a.f)).filter((row) => row.key === key);
    expect(rows.map((row) => ({ path: row.path, status: row.status }))).toEqual([
      { path: clawbackPath(diff.id), status: 'completed' },
    ]);
  });
});

it('[AC-B2-04zzl#33] 凭证层幂等：差错单被人为改回待处理再调一次：订单已非 CREDITED → 20902 order、什么都不变；再经真实 ledger.post 重投同一批 `B{id}` 凭证（同键、同内容）：每张都答 duplicate 与原 voucher_id，不发 INSERT，提交后凭证数量与内容、分录、余额全不变（0 / 0 / 0），不重复扣回', async () => {
  const a = await app(s);
  const { h } = a;
  const o = await h.credited();
  const diff = await seedBlacklistDiff(a, o);
  await withAdmin(a, async (admin) => {
    expect((await confirmed(await admin.confirm(diff.id))).clawed_back_fen).toBe(552);
    const event = eventIdOf(diff);
    const keys = await h.clawbackKeys(o);
    expect(keys).toEqual(
      [
        clawbackKey(o, 'self', event),
        clawbackKey(o, 'direct', event),
        clawbackKey(o, 'indirect', event),
        platformClawbackKey(o, event),
      ].sort(),
    );

    await a.f.db
      .updateTable('recon_diffs')
      .set({ status: 'open', closed_at: null, handler_id: null })
      .where('app_id', '=', h.appId)
      .where('id', '=', diff.id)
      .execute();
    const before = await everything(a);
    await orderConflict(await admin.confirm(diff.id));
    expect(await everything(a)).toEqual(before);

    // The same four `B{id}` vouchers again, through the ledger's own entry.
    const stored = await Promise.all(
      [
        clawbackKey(o, 'self', event),
        clawbackKey(o, 'direct', event),
        clawbackKey(o, 'indirect', event),
        platformClawbackKey(o, event),
      ].map(async (uniqKey) => ({
        uniqKey,
        kind: 'duplicate',
        voucherId: (await h.voucher(uniqKey)).id,
      })),
    );
    const replay = await replayClawbackVouchers(a, o, event, {
      users: [
        { role: 'self', fen: 425n },
        { role: 'direct', fen: 85n },
        { role: 'indirect', fen: 42n },
      ],
      platformFen: 448n,
    });
    expect(replay.results).toEqual(stored);
    expect(replay.voucherInserts, '已存在的 uniq_key 不再尝试写凭证').toBe(0);

    expect(await everything(a)).toEqual(before);
    expect(await h.clawbackKeys(o)).toEqual(keys);
    expect(await h.voucherLines(clawbackKey(o, 'self', event))).toEqual(
      userClawbackLines(o, 'self', 425n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'direct', event))).toEqual(
      userClawbackLines(o, 'direct', 85n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'indirect', event))).toEqual(
      userClawbackLines(o, 'indirect', 42n),
    );
    expect(await h.voucherLines(platformClawbackKey(o, event))).toEqual(
      platformDecreaseLines(o, 448n),
    );
    for (const person of o.people) {
      expect(await h.balance(person.userId), person.role).toBe(0n);
    }
    expect((await h.read(o)).rebate_status).toBe('CLAWED_BACK');
  });
});

it('[AC-B2-04zzl#47] 恢复后新一轮整单扣回（BR-FUND-08 净额）：首次确认 `B{旧 id}` 扣 425 / 85 / 42、平台 448；R13 恢复净额、订单回到 CREDITED（booked 850 / 1000）后，用新的差错单（新 id、维度 channel,order_no_suffix）确认：再扣 425 / 85 / 42、平台冲回 448，凭证事件号是 `B{新 id}`，响应 552；净额、应收、booked 归零，CLAWED_BACK；旧 `B{旧 id}` 凭证与旧差错单不变', async () => {
  const a = await app(s);
  const { h } = a;
  const o = await h.credited();
  const first = await seedBlacklistDiff(a, o, { dimensions: [CHANNEL] });
  await withAdmin(a, async (admin) => {
    expect((await confirmed(await admin.confirm(first.id))).clawed_back_fen).toBe(552);
    const oldEvent = eventIdOf(first);
    const isOld = (uniqKey: string) => uniqKey.endsWith(`:CLAWBACK:${oldEvent}`);
    const oldRows = async () => {
      const state = await h.state();
      return {
        vouchers: state.vouchers.filter((voucher) => isOld(voucher.uniq_key)),
        lines: state.lines.filter((line) => isOld(line.uniq_key)),
      };
    };
    const oldBefore = await oldRows();
    expect(oldBefore.vouchers).toHaveLength(4);
    const firstClosed = await diffNow(a.f, first.id);

    // R13's vouchers and the order column the restore moves back to CREDITED.
    await restoreNets(
      a,
      o,
      [
        { role: 'self', fen: 425n },
        { role: 'direct', fen: 85n },
        { role: 'indirect', fen: 42n },
      ],
      448n,
    );
    await reopenOrder(a, o, 850n, 1000n);
    expect(await h.netOf(o, 'self')).toBe(425n);
    expect((await h.nets(o)).platform_net_fen).toBe(448n);
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(1000n);

    const second = await seedBlacklistDiff(a, o, { dimensions: [CHANNEL, SUFFIX] });
    const data = await confirmed(await admin.confirm(second.id));
    expect(data.clawed_back_fen).toBe(552);
    expect(data.rebate_status_after).toBe('CLAWED_BACK');

    const newEvent = eventIdOf(second);
    const fourKeys = (event: string) => [
      clawbackKey(o, 'self', event),
      clawbackKey(o, 'direct', event),
      clawbackKey(o, 'indirect', event),
      platformClawbackKey(o, event),
    ];
    expect(await h.clawbackKeys(o)).toEqual([...fourKeys(oldEvent), ...fourKeys(newEvent)].sort());
    for (const event of [oldEvent, newEvent]) {
      expect(await h.voucherLines(clawbackKey(o, 'self', event)), event).toEqual(
        userClawbackLines(o, 'self', 425n),
      );
      expect(await h.voucherLines(clawbackKey(o, 'direct', event)), event).toEqual(
        userClawbackLines(o, 'direct', 85n),
      );
      expect(await h.voucherLines(clawbackKey(o, 'indirect', event)), event).toEqual(
        userClawbackLines(o, 'indirect', 42n),
      );
      expect(await h.voucherLines(platformClawbackKey(o, event)), event).toEqual(
        platformDecreaseLines(o, 448n),
      );
    }
    for (const uniqKey of fourKeys(newEvent)) {
      expect(await h.voucherTypes(uniqKey), uniqKey).toEqual(['CLAWBACK|FULL']);
    }
    expect(await oldRows()).toEqual(oldBefore);

    for (const person of o.people) {
      expect(await h.balance(person.userId), person.role).toBe(0n);
      expect(await h.netOf(o, person.role), person.role).toBe(0n);
    }
    expect((await h.nets(o)).platform_net_fen).toBe(0n);
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(0n);
    expect(await h.orderSubjectNet(o, 'COMMISSION_REVENUE')).toBe(0n);
    expect(await h.rebateColumns(o)).toMatchObject({
      rebate_status: 'CLAWED_BACK',
      booked_base_fen: 0n,
      booked_n_fen: 0n,
      reason: 'BLACKLIST',
    });
    await expectAdjusted(a, second, { adminId: admin.operator.id, clawedBackFen: 552 });
    expect(await diffNow(a.f, first.id)).toEqual(firstClosed);
  });
});

it('[AC-B2-04zzl#34] 一单多张未结差错单：第一张扣回后，第二张确认 → 20902 data.resource=order，第二张状态不变、不多扣回', async () => {
  const a = await app(s);
  const { h } = a;
  const o = await h.credited();
  const first = await seedBlacklistDiff(a, o, { dimensions: [CHANNEL] });
  const second = await seedBlacklistDiff(a, o, { dimensions: [SUFFIX] });
  await withAdmin(a, async (admin) => {
    expect((await confirmed(await admin.confirm(first.id))).clawed_back_fen).toBe(552);
    const keys = await h.clawbackKeys(o);
    const after = await everything(a);

    await orderConflict(await admin.confirm(second.id));

    expect(await diffNow(a.f, second.id)).toEqual(second);
    expect(await h.clawbackKeys(o)).toEqual(keys);
    expect(await everything(a)).toEqual(after);
  });
});

it('[AC-B2-04zzl#35] 并发（真 PG）：同一差错单两个请求（不同 Idempotency-Key）在订单键锁上同时等待，放行后只扣回一次：一个 200，另一个 20902；凭证一份，余额只扣一次，审计一条', async () => {
  const a = await app(s);
  const { h } = a;
  const o = await h.credited();
  const diff = await seedBlacklistDiff(a, o);
  await withAdmin(a, async (admin) => {
    const lock = await holdOrderKey(a.f, o.orderKey);
    const first = track(admin.confirm(diff.id));
    const second = track(admin.confirm(diff.id));
    try {
      expect(await waiting(a.f, 2, [first, second]), '两个请求都应在锁上等待').toBe(true);
    } finally {
      await lock.release();
    }
    const results = await Promise.all([first.promise, second.promise]);
    const codes = results.map((sent) => sent.json().code).sort((x, y) => x - y);
    const bodies = results.map((sent) => sent.body).join(' ');
    expect(codes, bodies).toEqual([0, 20902]);

    const event = eventIdOf(diff);
    expect(await h.clawbackKeys(o)).toEqual(
      [
        clawbackKey(o, 'self', event),
        clawbackKey(o, 'direct', event),
        clawbackKey(o, 'indirect', event),
        platformClawbackKey(o, event),
      ].sort(),
    );
    for (const person of o.people) {
      expect(await h.balance(person.userId), person.role).toBe(0n);
    }
    expect(await audits(a.f, ACTION)).toHaveLength(1);
    expect((await h.read(o)).rebate_status).toBe('CLAWED_BACK');
  });
});

it('[AC-B2-04zzl#36] 一个事务：写凭证、改订单、改差错单、写审计任一步失败 → 50001，整笔回滚——订单仍 CREDITED、无凭证、余额与差错单不变、不留幂等记录；同一 key 重发即成功且只扣回一次', async () => {
  const a = await app(s);
  const { h } = a;
  await withAdmin(a, async (admin) => {
    for (const point of FAULT_POINTS) {
      const o = await h.credited();
      const diff = await seedBlacklistDiff(a, o);
      const before = await everything(a);
      const key = newKey();
      const tripped = admin.fault.tripped;
      admin.fault.point = point;
      const sent = await admin.confirm(diff.id, {}, { key });
      expect(admin.fault.tripped, `${point} 必须在处理事务里执行`).toBe(tripped + 1);
      await answer(sent, 50001);
      expect(await everything(a), point).toEqual(before);
      expect(
        (await idempotencyRows(a.f)).filter((row) => row.key === key),
        point,
      ).toEqual([]);

      const data = await confirmed(await admin.confirm(diff.id, {}, { key }));
      expect(data.clawed_back_fen, point).toBe(552);
      expect((await h.read(o)).rebate_status, point).toBe('CLAWED_BACK');
      expect(await h.balance(o.user('self')), point).toBe(0n);
    }
  });
});
