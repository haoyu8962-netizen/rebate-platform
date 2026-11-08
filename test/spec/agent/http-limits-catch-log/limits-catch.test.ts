// B3-08x rule tests (brief §9.2, §9.3): when limits.current() fails in sendMessage the answer stays
// the trunk's JSON 50401 and admit is not called, and the catch writes one agent_http_failed error
// line (op send_message, stage limits, error_name) with nothing of the failure's text. Each test
// checks the logged run first, so it is red on the trunk, whose catch logs nothing; the runs with
// no logger and with a throwing logger then check that the answer does not depend on the logger.
import { expect, it } from 'vitest';

import {
  APP,
  DETAIL,
  RecordingLogger,
  USER_TEXT,
  call,
  expectJsonError,
  failure,
  identifiersOf,
  messageBody,
  type FakeReply,
  type Fault,
} from '../http-catch-log/kit.ts';
import { ThrowingLogger, expectLimitsLine, limitsRig, type LimitsRig } from './kit.ts';

const LIMITS_FAILURE = 'SyntheticLimitsFailure';

function expectRefused(reply: FakeReply, r: LimitsRig): void {
  expectJsonError(reply, r.caller, 50401);
  expect(r.limitReads, 'limits read once, for the caller app').toStrictEqual([APP]);
  expect(r.admission.admits, 'admit not called').toEqual([]);
  expect(r.runs.starts, 'no run started').toEqual([]);
}

const CASES: readonly { id: string; title: string; fault: () => Fault; errorName: string }[] = [
  {
    id: '1',
    title: '抛 Error，错误信息里带合成用户文本与令牌样式串',
    fault: () => failure(LIMITS_FAILURE),
    errorName: LIMITS_FAILURE,
  },
  {
    id: '2.1',
    title: '抛字符串（内容即错误原文）',
    fault: () => DETAIL,
    errorName: 'unknown',
  },
  {
    id: '2.2',
    title: '抛带 name / message 的普通对象',
    fault: () => ({ name: `Named ${USER_TEXT}`, message: DETAIL }),
    errorName: 'unknown',
  },
];

for (const c of CASES) {
  it(`[B3-08x#${c.id}] limits.current() ${c.title}：回 JSON 50401 且不受理；logger 恰一行 error（send_message、limits、${c.errorName}），不含错误原文与标识；未注入或抛错的 logger 下回包一致`, async () => {
    const log = new RecordingLogger();
    const logged = limitsRig(c.fault(), log);
    const body = messageBody();
    const reply = await call(logged, 'send_message', body);
    expectRefused(reply, logged);
    expectLimitsLine(log, {
      errorName: c.errorName,
      forbidden: identifiersOf(logged.caller, body.client_msg_id),
    });

    const bare = limitsRig(c.fault(), null);
    const bareReply = await call(bare, 'send_message', messageBody());
    expectRefused(bareReply, bare);
    expect(bareReply.record(), '未注入 logger 时回包一致').toStrictEqual(reply.record());

    const thrower = new ThrowingLogger();
    const broken = limitsRig(c.fault(), thrower);
    const brokenReply = await call(broken, 'send_message', messageBody());
    expectRefused(brokenReply, broken);
    expect(thrower.calls, 'the failure reached the logger once').toBe(1);
    expect(brokenReply.record(), 'logger 抛错时回包一致').toStrictEqual(reply.record());
  });
}
