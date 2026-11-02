// B1-02zy §9 #1–#3: a request already past its reads when the real deletion cleanup commits. The
// cleanup is parked in its transaction with the users row held (kit.ts heldRound), the request
// stops behind it, the cleanup commits, and only then does the request's write run. Refresh and
// byOauth go through the real HTTP entries and the real round; reserveFailure is called directly,
// because no HTTP request passes the deletion guard after the status moved and nothing can park one
// between the guard and its reservation.
//
// What the request answers is left open on purpose (§9 #3, the brief): only the data is judged.
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { REFRESH, attemptOf, firstOf, fixture, holdExchange, oauthBody } from '../reverify/kit.ts';
import {
  ROUNDS,
  account,
  closeSuite,
  enterProcessing,
  expectNoWriteBack,
  heldRound,
  memberOf,
  openSuite,
  reachedBarrier,
  resetSuite,
  write,
  type Suite,
} from './kit.ts';

let s: Suite;
beforeAll(async () => {
  s = await openSuite();
}, 180_000);
afterAll(async () => {
  await closeSuite(s);
}, 120_000);
beforeEach(async () => {
  await resetSuite(s);
});

it.each(ROUNDS)(
  '[AC-B1-02zy#1] 刷新令牌：已读到未吊销的会话、卡在写活动前，注销清理提交（账号 $status）后放行：最近活动与上次登录设备仍为空，users 不再被写',
  async ({ round, status }) => {
    const f = await fixture(s.http);
    const device = await f.device();
    const { uid, number } = await f.user();
    const login = await f.smsLogin(number, device);
    const m = memberOf(f, uid);
    await enterProcessing(s, m);
    let refreshing: Promise<unknown> = Promise.resolve();
    await heldRound(s, round, m, async () => {
      refreshing = f.post(device, REFRESH, { refresh_token: login.tokens.refresh_token });
      await reachedBarrier(f, 2, refreshing);
    });
    await refreshing;
    await expectNoWriteBack(s, m, status);
  },
);

it.each(ROUNDS)(
  '[AC-B1-02zy#2] 第三方加验：比对已通过、settlePassed 之前注销清理提交（账号 $status）：不留 reverified_devices 行，计数与日期仍为空',
  async ({ round, status }) => {
    const f = await fixture(s.http);
    const { uid, device, m } = await account(s, f);
    const unionId = await f.bind(uid, 'wechat');
    await f.flag(uid, { realname: false, providers: ['wechat'] });
    const c = f.client(uid, device);
    const attempt = attemptOf(s.http, await c.attempt('wechat'));
    // Sent while the account is normal: past the deletion guard, parked after its reservation.
    const held = holdExchange(s.http);
    const request = c.byOauth(oauthBody('wechat', attempt.attempt_id));
    try {
      await firstOf([held.reached, request]);
      expect(s.http.exchange).toHaveBeenCalledTimes(1);
      await enterProcessing(s, m);
      await heldRound(s, round, m, async () => {
        // The binding stays until the completion: the comparison passes, the write stops.
        held.release({ union_id: unionId });
        await reachedBarrier(f, 2, request);
      });
    } finally {
      held.release({ unavailable: true });
    }
    await request;
    await expectNoWriteBack(s, m, status);
  },
);

it.each(ROUNDS)(
  '[AC-B1-02zy#3] reserveFailure：占位语句排在注销清理之后，清理提交（账号 $status）后不占位、不写计数与日期',
  async ({ round, status }) => {
    const f = await fixture(s.http);
    const target = await account(s, f);
    await enterProcessing(s, target.m);
    let reserving: Promise<unknown> = Promise.resolve();
    await heldRound(s, round, target.m, async () => {
      reserving = write(s, 'reserveFailure', target);
      await reachedBarrier(f, 2, reserving);
    });
    await reserving;
    await expectNoWriteBack(s, target.m, status);
  },
);
