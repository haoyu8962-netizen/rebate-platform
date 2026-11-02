// B1-02zy §9 #3–#5: the three writes called directly, the real implementation on the real database
// (the orchestrator allows it for recordRefreshActivity and settlePassed, and §9 #3 asks it of
// reserveFailure). What a call answers stays open: a skipped write may return anything, so only
// the users row and reverified_devices are judged, and the answers are listed in the task's output.
//
// red-check holds every test of a new file to red, and the implementation exists already. So the
// controls (#7) and the late release (#8), which are green today on their own, end on a case the
// status condition decides. Each control is asserted before that case and runs on today's code too.
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  releaseFailure,
  reserveFailure,
  type FailureReservation,
} from '../../../../apps/api/src/modules/identity/infra/reverify-store.ts';
import { seedRequest, userRow } from '../deletion-processing/kit.ts';
import { flag, reverifyState, seededState } from '../reverify-deletion/kit.ts';
import { SECOND, TODAY, fixture } from '../reverify/kit.ts';
import {
  ROUNDS,
  WRITES_BY_STATUS,
  WRITE_NAMES,
  account,
  closeSuite,
  direct,
  enterProcessing,
  expectUntouched,
  openSuite,
  resetSuite,
  statusMovesUnderWrite,
  subjectOf,
  throughRound,
  write,
  written,
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

it.each(WRITES_BY_STATUS)(
  '[AC-B1-02zy#4] 账号已是 $status：真实 $write 不写，users 整行不变，不留 reverified_devices 行',
  async ({ write: name, round, status }) => {
    const f = await fixture(s.http);
    const target = await account(s, f);
    await throughRound(s, target.m, round);
    const before = await userRow(s.workers.db, target.m);
    expect(before.status).toBe(status);
    await write(s, name, target);
    await expectUntouched(s, target.m, before);
  },
);

it.each(WRITE_NAMES)(
  '[AC-B1-02zy#5] 账号已进入 processing、清理还没跑（六列还在）：%s 同样不写，整行不变',
  async (name) => {
    const f = await fixture(s.http);
    const target = await account(s, f);
    await flag(s.workers.db, target.m, target.device.hash);
    await enterProcessing(s, target.m);
    const before = await userRow(s.workers.db, target.m);
    await write(s, name, target);
    await expectUntouched(s, target.m, before);
  },
);

it.each(WRITE_NAMES)(
  '[AC-B1-02zy#6] 不靠先读后写：%s 已读到 normal、等在 users 行上时状态变 deleting，放行后不写',
  async (name) => {
    const f = await fixture(s.http);
    const target = await account(s, f);
    await flag(s.workers.db, target.m, target.device.hash);
    const before = await userRow(s.workers.db, target.m);
    await statusMovesUnderWrite(s, f, target.m, () => write(s, name, target));
    expect(await reverifyState(s.workers.db, target.m)).toEqual(seededState(target.device.hash));
    await expectUntouched(s, target.m, { ...before, status: 'deleting' });
  },
);

it.each(WRITE_NAMES)(
  '[AC-B1-02zy#7] 对照：正常、封禁、冷静期账号 %s 照旧写入，同一轮 deleting 账号不写（条件不写反、不写宽）',
  async (name) => {
    const f = await fixture(s.http);
    for (const kind of ['normal', 'banned', 'cooling'] as const) {
      const target = await account(s, f);
      await f.failures(target.uid, 2);
      if (kind === 'banned') await f.ban(target.uid);
      if (kind === 'cooling') await seedRequest(s.workers.db, target.m, { status: 'cooling' });
      await write(s, name, target);
      const expected = written(name, target);
      expect(await f.state(target.uid), kind).toMatchObject(expected.state);
      expect(await f.devices(target.uid), kind).toEqual(expected.devices);
    }
    const doomed = await account(s, f);
    await f.failures(doomed.uid, 2);
    await enterProcessing(s, doomed.m);
    const before = await userRow(s.workers.db, doomed.m);
    await write(s, name, doomed);
    await expectUntouched(s, doomed.m, before);
  },
);

it.each(ROUNDS)(
  '[AC-B1-02zy#8] 迟到的 releaseFailure 不受影响：清理已清日期（账号 $status），退回匹配不到、整行不变；之后再占位也不写',
  async ({ round }) => {
    const f = await fixture(s.http);
    const target = await account(s, f);
    const db = direct(s);
    const subject = subjectOf(target.m);
    const reservation = await reserveFailure(db, subject, TODAY, target.now);
    expect(reservation).toMatchObject({ day: TODAY, count: 1 });
    await throughRound(s, target.m, round);
    const before = await userRow(s.workers.db, target.m);
    const later = new Date(target.now.getTime() + SECOND);

    await releaseFailure(db, subject, reservation as FailureReservation, later);
    await expectUntouched(s, target.m, before);

    await reserveFailure(db, subject, TODAY, later);
    await expectUntouched(s, target.m, before);
  },
);
