// B1-02zp §9 #9, #15, #16 (BR-WDR-01 细则「加验依据」; D10-149, D10-161; couli #174 r5): the failure
// count of one account, shared by both ways, per +08:00 natural day, reserved atomically before
// the comparison. kit.holdExchange parks a request between its reservation and its end, so the
// reservation, its release and what happened meanwhile can be observed from the outside.
//
// #96 and #97 only start requests together, so a read-then-write passes them whenever the first
// write lands before the second read. #104 and #105 leave that to no timing: another connection
// holds the users row (kit.holdUser) until both requests are seen waiting on it (pg_stat_activity),
// so both have read the count before either write lands, and only a conditional write or a lock
// taken before the read lets a single request through.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  BY_ID,
  BY_OAUTH,
  FAIL_LIMIT,
  ID,
  MANUAL_REQUIRED,
  MIDNIGHT,
  OTHER_ID,
  PENDING_MANUAL,
  SECOND,
  THIRD_ID,
  TODAY,
  TOMORROW,
  YESTERDAY,
  attemptOf,
  closeKit,
  envelope,
  firstOf,
  fixture,
  holdExchange,
  idNumberRequired,
  mismatch,
  oauthBody,
  openKit,
  passed,
  pending,
  statusOf,
  type Fixture,
  type Kit,
} from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

/** Flagged with both a real name and WeChat as trusted identities, so both ways are open. */
async function flagged(f: Fixture) {
  const { uid } = await f.user();
  const device = await f.device();
  const unionId = await f.bind(uid, 'wechat');
  await f.realname(uid);
  await f.flag(uid, { realname: true, providers: ['wechat'] });
  return { uid, device, unionId, c: f.client(uid, device) };
}

function codes(responses: readonly { json<T>(): T }[]): number[] {
  return responses.map((response) => response.json<{ code: number }>().code).sort((a, b) => a - b);
}

type Client = ReturnType<Fixture['client']>;
type Sent = ReturnType<Client['byId']>;
type Way = 'id_number' | 'oauth';

/** A submission that will fail its comparison; an attempt is taken now, before any row is held. */
async function failing(c: Client, way: Way): Promise<() => Sent> {
  if (way === 'id_number') return () => c.byId(OTHER_ID);
  const attempt = attemptOf(kit, await c.attempt('wechat'));
  return () => c.byOauth(oauthBody('wechat', attempt.attempt_id));
}

/**
 * Two failing submissions for the last try of the day, in this order: each is seen waiting on the
 * held users row before the next is sent, and the row is released once both wait.
 */
async function lastTryBehindBarrier(first: Way, second: Way) {
  const f = await fixture(kit);
  const { uid, c } = await flagged(f);
  await f.failures(uid, FAIL_LIMIT - 1);
  kit.exchange.mockResolvedValue({ union_id: `union-${randomUUID()}` });
  const sends = [await failing(c, first), await failing(c, second)];
  const held = await f.holdUser(uid);
  const requests: Sent[] = [];
  const waiting: number[] = [];
  let exchangedWhileHeld = 0;
  try {
    for (const send of sends) {
      requests.push(send());
      waiting.push(await f.lockWaiters(requests.length, requests));
    }
    exchangedWhileHeld = kit.exchange.mock.calls.length;
  } finally {
    await held.release();
  }
  return { f, uid, waiting, exchangedWhileHeld, responses: await Promise.all(requests) };
}

it('[AC-B1-02zp#90] 身份证与第三方合计连续 5 次，按账号不按设备：换设备不重置，第 5 次 fail_remaining=0', async () => {
  const f = await fixture(kit);
  const { uid, c } = await flagged(f);
  const other = f.client(uid, await f.device());
  const third = f.client(uid, await f.device());
  kit.exchange.mockResolvedValue({ union_id: `union-${randomUUID()}` });

  mismatch(kit, BY_ID, await c.byId(OTHER_ID), 4);
  mismatch(kit, BY_ID, await other.byId(THIRD_ID), 3);
  const first = attemptOf(kit, await third.attempt('wechat'));
  mismatch(kit, BY_OAUTH, await third.byOauth(oauthBody('wechat', first.attempt_id)), 2);
  mismatch(kit, BY_ID, await c.byId(OTHER_ID), 1);
  const second = attemptOf(kit, await other.attempt('wechat'));
  mismatch(kit, BY_OAUTH, await other.byOauth(oauthBody('wechat', second.attempt_id)), 0);

  expect(await f.state(uid)).toMatchObject({
    reverify_fail_count: FAIL_LIMIT,
    reverify_fail_day: TODAY,
  });
  expect(statusOf(kit, await c.status())).toEqual(MANUAL_REQUIRED);
});

it('[AC-B1-02zp#91] 满 5 次当天提交回 10010 manual、不再比对：正确证件号也不通过，第三方不再换取身份，计数不再涨', async () => {
  const f = await fixture(kit);
  const { uid, unionId, c } = await flagged(f);
  const attempt = attemptOf(kit, await c.attempt('wechat'));
  await f.failures(uid, FAIL_LIMIT);
  kit.exchange.mockResolvedValue({ union_id: unionId });

  pending(kit, BY_ID, await c.byId(OTHER_ID), PENDING_MANUAL);
  pending(kit, BY_ID, await c.byId(ID), PENDING_MANUAL);
  pending(kit, BY_OAUTH, await c.byOauth(oauthBody('wechat', attempt.attempt_id)), PENDING_MANUAL);

  expect(kit.exchange).not.toHaveBeenCalled();
  expect(await f.devices(uid)).toEqual([]);
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: FAIL_LIMIT });
});

it('[AC-B1-02zp#92] 次日恢复：+08:00 零点前一秒仍锁定，零点起自助恢复，从 0 重新计', async () => {
  const f = await fixture(kit);
  const { uid, c } = await flagged(f);
  await f.failures(uid, FAIL_LIMIT);
  kit.clock.set(new Date(Date.parse(MIDNIGHT) - SECOND));
  pending(kit, BY_ID, await c.byId(ID), PENDING_MANUAL);
  expect(statusOf(kit, await c.status())).toEqual(MANUAL_REQUIRED);

  kit.clock.set(MIDNIGHT);
  expect(statusOf(kit, await c.status())).toEqual(idNumberRequired(FAIL_LIMIT));
  mismatch(kit, BY_ID, await c.byId(OTHER_ID), FAIL_LIMIT - 1);
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 1, reverify_fail_day: TOMORROW });
});

it('[AC-B1-02zp#93] 日切按 +08:00 不按 UTC：同一 +08:00 自然日跨过 UTC 零点不重置', async () => {
  const f = await fixture(kit);
  const { uid, c } = await flagged(f);
  kit.clock.set('2026-10-08T23:59:59.000Z');
  await f.failures(uid, 2, TOMORROW);
  mismatch(kit, BY_ID, await c.byId(OTHER_ID), 2);
  kit.clock.set('2026-10-09T00:00:00.000Z');
  mismatch(kit, BY_ID, await c.byId(OTHER_ID), 1);
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 4, reverify_fail_day: TOMORROW });
});

it('[AC-B1-02zp#94] 昨天满 5 次的旧计数不挡今天：预占把计数换到今天', async () => {
  const f = await fixture(kit);
  const { uid, c } = await flagged(f);
  await f.failures(uid, FAIL_LIMIT, YESTERDAY);
  mismatch(kit, BY_ID, await c.byId(OTHER_ID), FAIL_LIMIT - 1);
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 1, reverify_fail_day: TODAY });
});

it('[AC-B1-02zp#95] 通过清零，「连续」从 0 重新计（§2b、契约）：换设备后又有 5 次', async () => {
  const f = await fixture(kit);
  const { uid, c } = await flagged(f);
  const other = f.client(uid, await f.device());
  await f.failures(uid, FAIL_LIMIT - 1);
  passed(kit, BY_ID, await c.byId(ID));
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 0 });
  expect(statusOf(kit, await other.status())).toEqual(idNumberRequired(FAIL_LIMIT));
  mismatch(kit, BY_ID, await other.byId(OTHER_ID), FAIL_LIMIT - 1);
});

it('[AC-B1-02zp#96] 并发时实际比对不超过剩余次数：7 个错误证件号同时提交，正好 5 个 20005，其余 10010', async () => {
  const f = await fixture(kit);
  const { uid, c } = await flagged(f);
  const responses = await Promise.all(
    Array.from({ length: 7 }, () => c.byId(OTHER_ID, { key: randomUUID() })),
  );
  expect(codes(responses)).toEqual([10010, 10010, 20005, 20005, 20005, 20005, 20005]);
  expect(await f.state(uid)).toMatchObject({
    reverify_fail_count: FAIL_LIMIT,
    reverify_fail_day: TODAY,
  });
});

it('[AC-B1-02zp#97] 只差一次名额的两个并发请求，最多一个进入比对：另一个立刻 10010，通过后清零', async () => {
  const f = await fixture(kit);
  const { uid, device, unionId, c } = await flagged(f);
  await f.failures(uid, FAIL_LIMIT - 1);
  const [a, b] = [
    attemptOf(kit, await c.attempt('wechat')),
    attemptOf(kit, await c.attempt('wechat')),
  ];
  const held = holdExchange(kit);
  const first = c.byOauth(oauthBody('wechat', a.attempt_id));
  const second = c.byOauth(oauthBody('wechat', b.attempt_id));
  // Wait until one request is parked in the exchange and the other has answered (10010). Both
  // answering ends the wait too; both parked is what the time bound of firstOf is for.
  await firstOf([
    Promise.all([held.reached, Promise.race([first, second])]),
    Promise.all([first, second]),
  ]);
  const inFlight = kit.exchange.mock.calls.length;
  held.release({ union_id: unionId });
  const responses = await Promise.all([first, second]);

  expect(inFlight).toBe(1);
  expect(kit.exchange).toHaveBeenCalledTimes(1);
  expect(codes(responses)).toEqual([0, 10010]);
  expect(await f.devices(uid)).toEqual([{ device_hash: device.hash, source: 'self' }]);
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 0 });
});

it('[AC-B1-02zp#98] 预占在比对之前：请求还停在换取身份时计数已加 1', async () => {
  const f = await fixture(kit);
  const { uid, c } = await flagged(f);
  await f.failures(uid, 2);
  const attempt = attemptOf(kit, await c.attempt('wechat'));
  const held = holdExchange(kit);
  const request = c.byOauth(oauthBody('wechat', attempt.attempt_id));
  await firstOf([held.reached, request]);
  const reserved = (await f.state(uid)).reverify_fail_count;
  held.release({ unavailable: true });
  const response = await request;

  expect(reserved).toBe(3);
  envelope(kit, BY_OAUTH, response, 50305);
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 2 });
});

it('[AC-B1-02zp#99] 退回：凭证无效 20004 与上游不可用 50305 都退回预占，只剩 1 次时不会把账号锁住', async () => {
  const f = await fixture(kit);
  const { uid, c } = await flagged(f);
  await f.failures(uid, FAIL_LIMIT - 1);

  const invalid = attemptOf(kit, await c.attempt('wechat'));
  kit.exchange.mockResolvedValue({ invalid: true });
  envelope(kit, BY_OAUTH, await c.byOauth(oauthBody('wechat', invalid.attempt_id)), 20004);
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: FAIL_LIMIT - 1 });

  const down = attemptOf(kit, await c.attempt('wechat'));
  kit.exchange.mockResolvedValue({ unavailable: true });
  envelope(kit, BY_OAUTH, await c.byOauth(oauthBody('wechat', down.attempt_id)), 50305);
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: FAIL_LIMIT - 1 });

  expect(statusOf(kit, await c.status())).toEqual(idNumberRequired(1));
  mismatch(kit, BY_ID, await c.byId(OTHER_ID), 0);
});

it('[AC-B1-02zp#100] 退回只撤销本次的预占：两个并发预占都退回后计数回到原值', async () => {
  const f = await fixture(kit);
  const { uid, c } = await flagged(f);
  await f.failures(uid, 1);
  const [a, b] = [
    attemptOf(kit, await c.attempt('wechat')),
    attemptOf(kit, await c.attempt('wechat')),
  ];
  const held = holdExchange(kit, 2);
  const first = c.byOauth(oauthBody('wechat', a.attempt_id));
  const second = c.byOauth(oauthBody('wechat', b.attempt_id));
  await firstOf([held.reached, Promise.all([first, second])]);
  const reserved = (await f.state(uid)).reverify_fail_count;
  held.release({ unavailable: true });
  const responses = await Promise.all([first, second]);

  expect(reserved).toBe(3);
  expect(codes(responses)).toEqual([50305, 50305]);
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 1 });
});

it('[AC-B1-02zp#101] 零点之后的退回不动新一天的计数（只在预占的同一自然日才 −1）', async () => {
  const f = await fixture(kit);
  const { uid, c } = await flagged(f);
  await f.failures(uid, 3);
  const attempt = attemptOf(kit, await c.attempt('wechat'));
  const held = holdExchange(kit);
  const parked = c.byOauth(oauthBody('wechat', attempt.attempt_id));
  try {
    await firstOf([held.reached, parked]);
    expect(kit.exchange).toHaveBeenCalledTimes(1);
    kit.clock.set(MIDNIGHT);
    mismatch(kit, BY_ID, await f.client(uid, await f.device()).byId(OTHER_ID), FAIL_LIMIT - 1);
  } finally {
    held.release({ unavailable: true });
  }
  envelope(kit, BY_OAUTH, await parked, 50305);
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 1, reverify_fail_day: TOMORROW });
  expect(statusOf(kit, await c.status())).toEqual(idNumberRequired(FAIL_LIMIT - 1));
});

it('[AC-B1-02zp#102] 预占期间已被通过清零：退回不再 −1，计数不低于 0', async () => {
  const f = await fixture(kit);
  const { uid, c } = await flagged(f);
  await f.failures(uid, 2);
  const attempt = attemptOf(kit, await c.attempt('wechat'));
  const held = holdExchange(kit);
  const parked = c.byOauth(oauthBody('wechat', attempt.attempt_id));
  try {
    await firstOf([held.reached, parked]);
    expect(kit.exchange).toHaveBeenCalledTimes(1);
    kit.clock.advanceMs(SECOND);
    passed(kit, BY_ID, await f.client(uid, await f.device()).byId(ID));
    expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 0 });
  } finally {
    held.release({ unavailable: true });
  }
  envelope(kit, BY_OAUTH, await parked, 50305);
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 0 });
});

it('[AC-B1-02zp#103] 预占期间清零后又有新失败：退回不吃掉这次新失败', async () => {
  const f = await fixture(kit);
  const { uid, c } = await flagged(f);
  await f.failures(uid, 2);
  const attempt = attemptOf(kit, await c.attempt('wechat'));
  const held = holdExchange(kit);
  const parked = c.byOauth(oauthBody('wechat', attempt.attempt_id));
  try {
    await firstOf([held.reached, parked]);
    expect(kit.exchange).toHaveBeenCalledTimes(1);
    kit.clock.advanceMs(SECOND);
    passed(kit, BY_ID, await f.client(uid, await f.device()).byId(ID));
    kit.clock.advanceMs(SECOND);
    mismatch(kit, BY_ID, await f.client(uid, await f.device()).byId(OTHER_ID), FAIL_LIMIT - 1);
  } finally {
    held.release({ unavailable: true });
  }
  envelope(kit, BY_OAUTH, await parked, 50305);
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 1 });
});

it.each([
  { way: 'oauth', comparisons: 1 },
  { way: 'id_number', comparisons: 0 },
] as const)(
  '[AC-B1-02zp#104] 屏障：只剩 1 次时两个 $way 请求都等在 users 行上，放行后只有一个进入比对，一个 20005 一个 10010，计数正好到 5（不靠时序，D10-161）',
  async ({ way, comparisons }) => {
    const { f, uid, waiting, exchangedWhileHeld, responses } = await lastTryBehindBarrier(way, way);
    expect(waiting).toEqual([1, 2]);
    expect(exchangedWhileHeld).toBe(0);
    expect(kit.exchange).toHaveBeenCalledTimes(comparisons);
    expect(codes(responses)).toEqual([10010, 20005]);
    expect(await f.state(uid)).toMatchObject({
      reverify_fail_count: FAIL_LIMIT,
      reverify_fail_day: TODAY,
    });
  },
);

it.each([
  { first: 'oauth', second: 'id_number' },
  { first: 'id_number', second: 'oauth' },
] as const)(
  '[AC-B1-02zp#105] 屏障：身份证与第三方共用最后一次名额（先 $first 后 $second），放行后只有一个进入比对，计数正好到 5',
  async ({ first, second }) => {
    const { f, uid, waiting, exchangedWhileHeld, responses } = await lastTryBehindBarrier(
      first,
      second,
    );
    expect(waiting).toEqual([1, 2]);
    expect(exchangedWhileHeld).toBe(0);
    // Which of the two takes the try is the lock queue's; that only one compares is the rule.
    expect(kit.exchange.mock.calls.length).toBeLessThanOrEqual(1);
    expect(codes(responses)).toEqual([10010, 20005]);
    expect(await f.state(uid)).toMatchObject({
      reverify_fail_count: FAIL_LIMIT,
      reverify_fail_day: TODAY,
    });
  },
);

it('[AC-B1-02zp#110] 同一设备两个第三方加验都已预占：A 通过清零、另一设备又失败 1 次后，慢的 B 比对通过而设备行已在，B 回 passed 且照样清零（§2b「加验通过时也清零」）', async () => {
  const f = await fixture(kit);
  const { uid, device, unionId, c } = await flagged(f);
  const other = f.client(uid, await f.device());
  const [a, b] = [
    attemptOf(kit, await c.attempt('wechat')),
    attemptOf(kit, await c.attempt('wechat')),
  ];
  // One hold per request: a parked exchange keeps its own answer, so A can end while B waits.
  const heldB = holdExchange(kit);
  const slow = c.byOauth(oauthBody('wechat', b.attempt_id));
  await firstOf([heldB.reached, slow]);
  const heldA = holdExchange(kit);
  const fast = c.byOauth(oauthBody('wechat', a.attempt_id));
  try {
    await firstOf([heldA.reached, fast]);
    expect(kit.exchange).toHaveBeenCalledTimes(2);
    expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 2, reverify_fail_day: TODAY });

    kit.clock.advanceMs(SECOND);
    heldA.release({ union_id: unionId });
    passed(kit, BY_OAUTH, await fast);
    expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 0, reverify_fail_day: null });

    kit.clock.advanceMs(SECOND);
    mismatch(kit, BY_ID, await other.byId(OTHER_ID), FAIL_LIMIT - 1);
    expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 1, reverify_fail_day: TODAY });
  } finally {
    heldA.release({ unavailable: true });
    heldB.release({ union_id: unionId });
  }

  passed(kit, BY_OAUTH, await slow);
  expect(await f.devices(uid)).toEqual([{ device_hash: device.hash, source: 'self' }]);
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 0, reverify_fail_day: null });
});

it('[AC-B1-02zp#111] 设备行冲突的通过也算清零：C 预占后 B 通过清零（不新增设备行）、另一设备又失败 1 次，C 的 50305 退回不吃掉这次新失败，再失败 4 次转 10010（共 5 次，不多一次，§2c）', async () => {
  const f = await fixture(kit);
  const { uid, device, unionId, c } = await flagged(f);
  const other = f.client(uid, await f.device());
  const third = f.client(uid, await f.device());
  const [a, b, onOther] = [
    attemptOf(kit, await c.attempt('wechat')),
    attemptOf(kit, await c.attempt('wechat')),
    attemptOf(kit, await other.attempt('wechat')),
  ];
  // One hold per request: a parked exchange keeps its own answer, so each can end on its own.
  const heldB = holdExchange(kit);
  const requestB = c.byOauth(oauthBody('wechat', b.attempt_id));
  await firstOf([heldB.reached, requestB]);
  const heldA = holdExchange(kit);
  const requestA = c.byOauth(oauthBody('wechat', a.attempt_id));
  await firstOf([heldA.reached, requestA]);
  const heldC = holdExchange(kit);
  try {
    expect(kit.exchange).toHaveBeenCalledTimes(2);
    expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 2, reverify_fail_day: TODAY });

    // A passes: a new device row and a clear.
    kit.clock.advanceMs(SECOND);
    heldA.release({ union_id: unionId });
    passed(kit, BY_OAUTH, await requestA);
    expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 0, reverify_fail_day: null });

    // C reserves on a device not re-verified, after that device row exists.
    kit.clock.advanceMs(SECOND);
    const requestC = other.byOauth(oauthBody('wechat', onOther.attempt_id));
    await firstOf([heldC.reached, requestC]);
    expect(kit.exchange).toHaveBeenCalledTimes(3);
    expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 1, reverify_fail_day: TODAY });

    // B passes: its device row is already there, so only the count shows the clear.
    kit.clock.advanceMs(SECOND);
    heldB.release({ union_id: unionId });
    passed(kit, BY_OAUTH, await requestB);
    expect(await f.devices(uid)).toEqual([{ device_hash: device.hash, source: 'self' }]);
    expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 0, reverify_fail_day: null });

    // A new failure, after the clear that wiped C's reservation.
    kit.clock.advanceMs(SECOND);
    mismatch(kit, BY_ID, await third.byId(OTHER_ID), FAIL_LIMIT - 1);
    expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 1, reverify_fail_day: TODAY });

    heldC.release({ unavailable: true });
    envelope(kit, BY_OAUTH, await requestC, 50305);
    expect(await f.state(uid)).toMatchObject({ reverify_fail_count: 1, reverify_fail_day: TODAY });
  } finally {
    heldA.release({ unavailable: true });
    heldB.release({ unavailable: true });
    heldC.release({ unavailable: true });
  }

  for (const remaining of [3, 2, 1, 0]) {
    mismatch(kit, BY_ID, await third.byId(OTHER_ID), remaining);
  }
  expect(await f.state(uid)).toMatchObject({
    reverify_fail_count: FAIL_LIMIT,
    reverify_fail_day: TODAY,
  });
  pending(kit, BY_ID, await third.byId(ID), PENDING_MANUAL);
  expect(statusOf(kit, await third.status())).toEqual(MANUAL_REQUIRED);
  expect(await f.devices(uid)).toEqual([{ device_hash: device.hash, source: 'self' }]);
  expect(await f.state(uid)).toMatchObject({ reverify_fail_count: FAIL_LIMIT });
});
