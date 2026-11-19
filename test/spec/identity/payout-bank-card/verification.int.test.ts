import { randomUUID } from 'node:crypto';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  ALIPAY,
  BANK_CONTEXT,
  account,
  bankBody,
  block,
  card,
  change,
  close,
  config,
  deferred,
  envelope,
  fixture,
  open,
  privateDataAbsent,
  reset,
  seedAttempt,
  state,
  until,
  userLockAvailable,
  type Kit,
} from './kit.ts';

let database: TestDatabase;
let redis: TestRedis;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  redis = await acquireTestRedis();
  kit = await open(database, redis);
});
beforeEach(() => reset(kit));
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    try {
      await redis?.stop();
    } finally {
      await database?.drop();
    }
  }
});

it('[AC-B1-13f#20] 同卡并发首发只预占一次，供应商期间释放 users 锁；其余请求 40901', async () => {
  const f = await fixture(kit);
  const hold = deferred<'match' | 'mismatch'>();
  kit.verify.mockImplementation(() => hold.promise);
  const completed: Awaited<ReturnType<typeof f.submit>>[] = [];
  const pending = Array.from({ length: 4 }, () =>
    f.submit().then((response) => {
      completed.push(response);
      return response;
    }),
  );
  try {
    await until(() => kit.verify.mock.calls.length >= 1 && completed.length >= 3);
    await userLockAvailable(kit, f);
    expect(await f.attempts()).toHaveLength(1);
    expect((await f.attempts())[0]).toMatchObject({ status: 'reserved', resolved_at: null });
    expect(completed).toHaveLength(3);
    for (const response of completed) envelope(kit, response, 40901);
    expect(kit.verify).toHaveBeenCalledTimes(1);
    expect(kit.query).not.toHaveBeenCalled();
    expect(await f.attempts()).toHaveLength(1);
  } finally {
    hold.resolve('match');
    await Promise.all(pending);
  }
  const responses = await Promise.all(pending);
  const successes = responses.filter((response) => response.statusCode === 200);
  expect(successes).toHaveLength(1);
  envelope(kit, successes[0]!);
  expect((await f.attempts())[0]!.status).toBe('matched');
});

it('[AC-B1-13f#21] 不同卡并发最多用剩余额度，reserved 已提交后供应商才可见请求', async () => {
  const f = await fixture(kit);
  await seedAttempt(kit, f, { status: 'mismatched', cardNo: card(9) });
  const hold = deferred<'match' | 'mismatch'>();
  kit.verify.mockImplementation(() => hold.promise);
  const completed: Awaited<ReturnType<typeof f.submit>>[] = [];
  const pending = [1, 2, 3, 4].map((serial) =>
    f.submit(bankBody(card(serial))).then((response) => {
      completed.push(response);
      return response;
    }),
  );
  try {
    await until(() => kit.verify.mock.calls.length >= 2 && completed.length >= 2);
    const rows = await f.attempts();
    expect(rows.filter((row) => row.status === 'reserved')).toHaveLength(2);
    expect(new Set(kit.verify.mock.calls.map(([input]) => input.vendor_request_id)).size).toBe(2);
    for (const [input] of kit.verify.mock.calls) {
      expect(rows.find((row) => row.vendor_request_id === input.vendor_request_id)?.status).toBe(
        'reserved',
      );
    }
    expect(completed).toHaveLength(2);
    for (const response of completed) {
      expect(envelope(kit, response, 30303).data).toEqual({
        reason: 'payout_account_verify_limit',
      });
    }
    expect(kit.verify).toHaveBeenCalledTimes(2);
  } finally {
    hold.resolve('mismatch');
    await Promise.all(pending);
  }
  const responses = await Promise.all(pending);
  expect(
    responses.filter((response) => response.json<{ code: number }>().code === 30307),
  ).toHaveLength(2);
  expect(
    responses.filter((response) => response.json<{ code: number }>().code === 30303),
  ).toHaveLength(2);
  expect(await f.attempts()).toHaveLength(3);
});

it('[AC-B1-13f#22] 同键 R2 在 R1 核验期间 40901，R1 不一致后原样回放，不二次收费', async () => {
  const f = await fixture(kit);
  const key = randomUUID();
  const token = await f.stepUp();
  const hold = deferred<'match' | 'mismatch'>();
  kit.verify.mockImplementation(() => hold.promise);
  const pending = f.submit(bankBody(), key, token);
  try {
    await until(() => kit.verify.mock.calls.length === 1);
    envelope(kit, await f.submit(bankBody(), key, token), 40901);
    expect(await f.idempotency(key)).toEqual([]);
  } finally {
    hold.resolve('mismatch');
    await pending;
  }
  const first = await pending;
  envelope(kit, first, 30307);
  const replay = await f.submit(bankBody(), key, '');
  envelope(kit, replay, 30307);
  expect(replay.body).toBe(first.body);
  expect(kit.verify).toHaveBeenCalledTimes(1);
  expect(await f.attempts()).toHaveLength(1);
  expect((await f.attempts())[0]!.status).toBe('mismatched');
  expect(await f.idempotency(key)).toHaveLength(1);
  // B1-02zzzb: the token binds this card; a new key verifies it again (match) and saves.
  kit.verify.mockResolvedValue('match');
  envelope(kit, await f.submit(bankBody(), randomUUID(), token));
});

it('[AC-B1-13f#23] 核验落 matched 与账号、幂等结果一起提交，等待保存锁时仍只可见 reserved', async () => {
  const f = await fixture(kit);
  const key = randomUUID();
  const vendor = deferred<'match' | 'mismatch'>();
  const unlock = deferred<void>();
  const locked = deferred<number>();
  kit.verify.mockImplementation(() => vendor.promise);
  const pending = f.submit(bankBody(), key);
  let locker: Promise<void> | undefined;
  try {
    await until(() => kit.verify.mock.calls.length === 1);
    locker = kit.db.transaction().execute(async (trx) => {
      await trx.selectFrom('users').select('id').where('id', '=', f.uid).forNoKeyUpdate().execute();
      const row = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
      locked.resolve(row.rows[0]!.pid);
      await unlock.promise;
    });
    const pid = await locked.promise;
    vendor.resolve('match');
    await until(async () => {
      const row = await sql<{ blocked: boolean }>`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
      ) AS blocked`.execute(kit.db);
      return row.rows[0]!.blocked;
    });
    expect((await f.attempts())[0]!.status).toBe('reserved');
    expect(await f.idempotency(key)).toEqual([]);
    expect((await state(kit, f)).accounts).toEqual([]);
  } finally {
    vendor.resolve('match');
    unlock.resolve();
    await locker;
    await pending;
  }
  envelope(kit, await pending);
  expect((await f.attempts())[0]!.status).toBe('matched');
  expect((await state(kit, f)).accounts).toHaveLength(1);
  expect(await f.idempotency(key)).toHaveLength(1);
});

it.each(['changes', 'blacklist', 'occupied'] as const)(
  '[AC-B1-13f#24] 供应商返回后重查 %s；保存拒绝也保留 matched，3xxxx 同事务保存幂等结果',
  async (reason) => {
    const f = await fixture(kit);
    await account(kit, f);
    const key = randomUUID();
    const token = await f.stepUp();
    const hold = deferred<'match' | 'mismatch'>();
    kit.verify.mockImplementation(() => hold.promise);
    const pending = f.submit(bankBody(), key, token);
    try {
      await until(() => kit.verify.mock.calls.length === 1);
      if (reason === 'changes') {
        await change(kit, f);
        await change(kit, f);
      }
      if (reason === 'blacklist') await block(kit, f);
      if (reason === 'occupied') {
        const other = await fixture(kit, { appId: f.appId });
        await account(kit, other, card(), { method: 'bank_card' });
      }
    } finally {
      hold.resolve('match');
      await pending;
    }
    const code = reason === 'changes' ? 30303 : reason === 'blacklist' ? 44001 : 30308;
    const body = envelope(kit, await pending, code);
    if (reason === 'changes') expect(body.data).toEqual({ reason: 'payout_account_change_limit' });
    expect((await f.attempts())[0]!.status).toBe('matched');
    expect((await state(kit, f)).accounts.filter((row) => row.is_current)[0]!.payout_method).toBe(
      'alipay',
    );
    expect(await f.idempotency(key)).toHaveLength(reason === 'blacklist' ? 0 : 1);
    if (reason === 'changes') {
      await config(kit, f, 'withdraw.payout_account_change_per_month', 3);
      envelope(kit, await f.submit(bankBody(), randomUUID(), token));
      expect(kit.verify).toHaveBeenCalledTimes(1);
      expect(await f.attempts()).toHaveLength(1);
    }
  },
);

it('[AC-B1-13f#25] 供应商异常 50401 后同键只回 40901，新键同卡只 query，成功后才核销 token', async () => {
  const f = await fixture(kit);
  const key = randomUUID();
  const token = await f.stepUp();
  kit.verify.mockRejectedValue(new Error(`vendor transport failed: ${card()} ${f.idNo}`));
  const failed = await f.submit(bankBody(), key, token);
  envelope(kit, failed, 50401);
  privateDataAbsent(kit, [failed.json()], [card(), f.idNo]);
  const rows = await f.attempts();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    status: 'unknown',
    unknown_at: kit.clock.now(),
    resolved_at: null,
  });
  expect(await f.idempotency(key)).toEqual([]);
  envelope(kit, await f.submit(bankBody(), key, token), 40901);
  expect(kit.query).not.toHaveBeenCalled();
  kit.query.mockResolvedValue('match');
  envelope(kit, await f.submit(bankBody(), randomUUID(), token));
  expect(kit.query).toHaveBeenCalledExactlyOnceWith(rows[0]!.vendor_request_id);
  expect(kit.verify).toHaveBeenCalledTimes(1);
  expect(await f.attempts()).toHaveLength(1);
  envelope(kit, await f.submit(ALIPAY, randomUUID(), token), 10003);
});

it('[AC-B1-13f#26] 挂起供应商十秒截止为 50401；迟到的一致不能自行绑定账号', async () => {
  const f = await fixture(kit);
  const hold = deferred<'match' | 'mismatch'>();
  kit.verify.mockImplementation(() => hold.promise);
  const pending = f.submit();
  try {
    // Real adapter deadline, no global fake timers that could break PG/Redis or JWT clocks.
    envelope(kit, await pending, 50401);
    expect((await f.attempts())[0]!.status).toBe('unknown');
  } finally {
    hold.resolve('match');
  }
  expect((await state(kit, f)).accounts).toEqual([]);
  expect(kit.verify).toHaveBeenCalledTimes(1);
}, 15_000);

it.each(['reserved', 'unknown', 'matched', 'mismatched', 'expired_unresolved'] as const)(
  '[AC-B1-13f#27] 同键复用 %s，不检查 matched 有效期，不查询、不新占额度',
  async (status) => {
    const f = await fixture(kit);
    const key = randomUUID();
    await seedAttempt(kit, f, {
      key,
      status,
      reservedAt: '2026-10-16T00:00:00Z',
      verifyDate: '2026-10-16',
      ...(status === 'matched' ? { resolvedAt: '2026-10-16T00:00:01Z' } : {}),
    });
    const code =
      status === 'matched'
        ? 0
        : status === 'mismatched'
          ? 30307
          : status === 'expired_unresolved'
            ? 50401
            : 40901;
    envelope(kit, await f.submit(bankBody(), key), code);
    expect(kit.verify).not.toHaveBeenCalled();
    expect(kit.query).not.toHaveBeenCalled();
    expect(await f.attempts()).toHaveLength(1);
    expect(await f.idempotency(key)).toHaveLength([0, 30307].includes(code) ? 1 : 0);
    if (status === 'reserved')
      expect((await f.attempts())[0]).toMatchObject({
        status: 'unknown',
        unknown_at: kit.clock.now(),
      });
  },
);

it('[AC-B1-13f#28] 同键记录先于同指纹最新记录和已满额度，旧不一致不得被新 matched 覆盖', async () => {
  const f = await fixture(kit);
  const key = randomUUID();
  await seedAttempt(kit, f, { key, status: 'mismatched', reservedAt: '2026-10-18T03:00:00Z' });
  await seedAttempt(kit, f, { status: 'matched' });
  await seedAttempt(kit, f, { status: 'mismatched', cardNo: card(2) });
  envelope(kit, await f.submit(bankBody(), key), 30307);
  expect((await state(kit, f)).accounts).toEqual([]);
  expect(kit.verify).not.toHaveBeenCalled();
  expect(kit.query).not.toHaveBeenCalled();
});

it.each(['match', 'mismatch', 'unknown', 'not_found'] as const)(
  '[AC-B1-13f#29] 新键同卡 unknown 按原请求标识查询 %s，锁外查询且不重发旧核验',
  async (outcome) => {
    const f = await fixture(kit);
    const row = await seedAttempt(kit, f, { status: 'unknown' });
    const hold = deferred<'match' | 'mismatch' | 'unknown' | 'not_found'>();
    kit.query.mockImplementation(() => hold.promise);
    const pending = f.submit();
    try {
      await until(() => kit.query.mock.calls.length === 1);
      await userLockAvailable(kit, f);
      expect(kit.verify).not.toHaveBeenCalled();
    } finally {
      hold.resolve(outcome);
      await pending;
    }
    envelope(
      kit,
      await pending,
      outcome === 'mismatch' ? 30307 : outcome === 'unknown' ? 40901 : 0,
    );
    expect(kit.query).toHaveBeenCalledExactlyOnceWith(row.vendor_request_id);
    expect(kit.verify).toHaveBeenCalledTimes(outcome === 'not_found' ? 1 : 0);
    const attempts = await f.attempts();
    expect(attempts.find((attempt) => attempt.id === row.id)!.status).toBe(
      outcome === 'match'
        ? 'matched'
        : outcome === 'mismatch'
          ? 'mismatched'
          : outcome === 'not_found'
            ? 'expired_unresolved'
            : 'unknown',
    );
    if (outcome === 'not_found') {
      expect(attempts).toHaveLength(2);
      expect(kit.verify.mock.calls[0]![0].vendor_request_id).not.toBe(row.vendor_request_id);
    }
  },
);

it.each([59, 61])(
  '[AC-B1-13f#30] reserved 租约 %i 秒：未过期 40901；过期接管后按原标识查询',
  async (seconds) => {
    const f = await fixture(kit);
    const row = await seedAttempt(kit, f);
    kit.clock.set(new Date(kit.clock.now().getTime() + seconds * 1000));
    kit.query.mockResolvedValue('match');
    envelope(kit, await f.submit(), seconds === 59 ? 40901 : 0);
    expect(kit.verify).not.toHaveBeenCalled();
    expect(kit.query).toHaveBeenCalledTimes(seconds === 59 ? 0 : 1);
    if (seconds === 61) expect(kit.query).toHaveBeenCalledWith(row.vendor_request_id);
  },
);

it.each([23, 25])(
  '[AC-B1-13f#31] matched 距今 %i 小时，新键按复用期限判断；复用优先于额度',
  async (hours) => {
    const f = await fixture(kit);
    await config(kit, f, 'withdraw.payout_account_verify_per_day', 1);
    await seedAttempt(kit, f, {
      status: 'matched',
      resolvedAt: new Date(kit.clock.now().getTime() - hours * 3600_000).toISOString(),
    });
    envelope(kit, await f.submit(), hours === 23 ? 0 : 30303);
    expect(kit.verify).not.toHaveBeenCalled();
    expect(kit.query).not.toHaveBeenCalled();
    expect(await f.attempts()).toHaveLength(1);
  },
);

it.each(['mismatched', 'expired_unresolved', 'released', 'matched'] as const)(
  '[AC-B1-13f#32] 新键遇 %s（matched 已超期）新预占，使用新供应商请求标识',
  async (status) => {
    const f = await fixture(kit);
    const old = await seedAttempt(kit, f, { status, resolvedAt: '2026-10-16T00:00:00Z' });
    envelope(kit, await f.submit());
    expect(kit.verify).toHaveBeenCalledTimes(1);
    expect(kit.verify.mock.calls[0]![0].vendor_request_id).not.toBe(old.vendor_request_id);
    expect(await f.attempts()).toHaveLength(2);
  },
);

it('[AC-B1-13f#33] 相同卡号但实名记录指纹不同不得复用；跨用户、跨 App 核验也隔离', async () => {
  const f = await fixture(kit);
  const other = await fixture(kit, { appId: f.appId });
  const foreign = await fixture(kit);
  await seedAttempt(kit, other, { status: 'matched' });
  await seedAttempt(kit, foreign, { status: 'matched' });
  await seedAttempt(kit, f, {
    status: 'matched',
    fingerprint: `${randomUUID()}:${kit.crypto.blindIndex(card(), BANK_CONTEXT)}`,
  });
  envelope(kit, await f.submit());
  expect(kit.verify).toHaveBeenCalledTimes(1);
  expect(await f.attempts()).toHaveLength(2);
  expect((await other.attempts())[0]!.status).toBe('matched');
});

it('[AC-B1-13f#34] 新键遇超过复核终点的 unknown 终结旧记录并重新预占，不永久返回 40901', async () => {
  const f = await fixture(kit);
  const old = await seedAttempt(kit, f, { status: 'unknown', unknownAt: '2026-10-18T03:30:00Z' });
  envelope(kit, await f.submit());
  const rows = await f.attempts();
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.id === old.id)!.status).toBe('expired_unresolved');
  expect(kit.verify).toHaveBeenCalledTimes(1);
  expect(kit.verify.mock.calls[0]![0].vendor_request_id).not.toBe(old.vendor_request_id);
});

it.each([1, 0, '1'])(
  '[AC-B1-13f#35] 复用小时配置 %j：正整数生效，无效值回退 24 小时',
  async (value) => {
    const f = await fixture(kit);
    await config(kit, f, 'withdraw.payout_account_verify_reuse_hours', value);
    await seedAttempt(kit, f, { status: 'matched', resolvedAt: '2026-10-18T02:00:00Z' });
    envelope(kit, await f.submit());
    expect(kit.verify).toHaveBeenCalledTimes(value === 1 ? 1 : 0);
    expect(await f.attempts()).toHaveLength(value === 1 ? 2 : 1);
    if (value !== 1) {
      const warnings = kit.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: 40,
            config_key: 'withdraw.payout_account_verify_reuse_hours',
          }),
        ]),
      );
    }
  },
);

it('[AC-B1-13f#36] query 网络错误保留 unknown 和额度，不重发收费请求；原键仍未决', async () => {
  const f = await fixture(kit);
  const row = await seedAttempt(kit, f, { status: 'unknown' });
  const key = randomUUID();
  kit.query.mockRejectedValue(new Error(`query transport failed ${card()} ${f.idNo}`));
  const response = await f.submit(bankBody(), key);
  envelope(kit, response, 40901);
  expect((await f.attempts())[0]!.status).toBe('unknown');
  expect(await f.attempts()).toHaveLength(1);
  expect(kit.query).toHaveBeenCalledExactlyOnceWith(row.vendor_request_id);
  expect(kit.verify).not.toHaveBeenCalled();
  expect(await f.idempotency(key)).toEqual([]);
  privateDataAbsent(kit, [response.json()], [card(), f.idNo]);
});

it('[AC-B1-13f#37] 完成的幂等键原样返回；同键改卡号 20901，不新收费或核销新的 step-up', async () => {
  const f = await fixture(kit);
  const key = randomUUID();
  kit.verify.mockResolvedValue('mismatch');
  const original = await f.submit(bankBody(), key);
  envelope(kit, original, 30307);
  // B1-02zzzb: the token is for the Alipay save that succeeds (20901 is the key's own answer).
  const token = await f.stepUp('payout_account_change', ALIPAY);
  envelope(kit, await f.submit(bankBody(card(2)), key, token), 20901);
  expect(kit.verify).toHaveBeenCalledTimes(1);
  expect(await f.attempts()).toHaveLength(1);
  envelope(kit, await f.submit(ALIPAY, randomUUID(), token));
});
