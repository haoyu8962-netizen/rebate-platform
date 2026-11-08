// B3-08v rule tests (brief §9.2, §9.3 1): every fallback catch of agent/http/index.ts (:263
// createSession, :278 currentSession, :300 cancelRun, :377 sendMessage admit, :470 sendMessage
// rest) writes exactly one error line to the injected logger, carrying the operation name and
// the error's name ('unknown' for a thrown value that is not an Error) and nothing of the error
// message, the user text, the bearer-style string or the caller's identifiers; the answer is the
// trunk's (code, msg, JSON or not; no JSON once SSE has started). The five sites can be told
// apart from their lines. BR-AI-23 values and codes are unchanged (brief §9.0).
import { expect, it } from 'vitest';

import {
  DETAIL,
  USER_TEXT,
  call,
  expectOneErrorLine,
  identifiersOf,
  messageBody,
  rig,
  serialize,
  type Fault,
  type Rig,
} from './kit.ts';
import { SCENARIOS, defaultFault, expectAnswer, onePerSite, type Scenario } from './scenarios.ts';

async function failOnce(s: Scenario, fault: Fault): Promise<{ r: Rig; forbidden: string[] }> {
  const r = rig();
  s.arrange(r, fault);
  const body = messageBody();
  const reply = await call(r, s.op, body);
  expectAnswer(s, reply, r);
  return {
    r,
    forbidden: identifiersOf(r.caller, s.op === 'send_message' ? body.client_msg_id : undefined),
  };
}

for (const [i, s] of SCENARIOS.entries()) {
  it(`[B3-08v#1.${i + 1}] ${s.title}：回包同主干；logger 恰一行 error，带操作名 ${s.op} 与错误名，不含错误原文、用户文本、令牌样式串与调用方标识`, async () => {
    const { fault, errorName } = defaultFault(s);
    const { r, forbidden } = await failOnce(s, fault);
    expectOneErrorLine(r.log!, { op: s.op, errorName, forbidden });
  });
}

const NOT_ERRORS: readonly { title: string; fault: () => Fault }[] = [
  { title: '抛出字符串（内容即错误原文）', fault: () => DETAIL },
  {
    title: '抛出带 name / message 的普通对象',
    fault: () => ({ name: `Named ${USER_TEXT}`, message: DETAIL }),
  },
];

for (const [i, s] of SCENARIOS.filter((x) => x.fixed === undefined).entries()) {
  for (const [j, thrown] of NOT_ERRORS.entries()) {
    it(`[B3-08v#2.${i + 1}.${j + 1}] ${s.title}，${thrown.title}：回包同主干；一行 error，错误名记 'unknown'，不含抛出值的内容`, async () => {
      const { r, forbidden } = await failOnce(s, thrown.fault());
      const entry = expectOneErrorLine(r.log!, { op: s.op, errorName: 'unknown', forbidden });
      expect(serialize(entry)).not.toContain('Named ');
    });
  }
}

it('[B3-08v#3] 五处兜底 catch（create / current / cancel / admit / outer）同一错误名时各自的日志行互不相同，能区分是哪一处', async () => {
  const lines: string[] = [];
  for (const s of onePerSite()) {
    const { fault, errorName } = defaultFault(s);
    const { r, forbidden } = await failOnce(s, fault);
    const entry = expectOneErrorLine(r.log!, { op: s.op, errorName, forbidden });
    lines.push(serialize(entry));
  }
  expect(new Set(lines).size, lines.join('\n')).toBe(5);
});

it('[B3-08v#3] sendMessage 的 admit 处（:377）与其余兜底处（:470）日志行不同；同一处换一个失败端口（同错误名）仍可归到同一操作', async () => {
  const admit = SCENARIOS.filter((s) => s.site === 'admit' && s.fixed === undefined);
  const outer = SCENARIOS.filter((s) => s.site === 'outer' && 'json' in s.answer);
  expect(admit.length).toBeGreaterThan(0);
  expect(outer.length).toBeGreaterThan(1);
  const lineOf = async (s: Scenario): Promise<string> => {
    const { fault, errorName } = defaultFault(s);
    const { r, forbidden } = await failOnce(s, fault);
    return serialize(expectOneErrorLine(r.log!, { op: 'send_message', errorName, forbidden }));
  };
  const admitLines = new Set<string>();
  for (const s of admit) admitLines.add(await lineOf(s));
  const outerLines = new Set<string>();
  for (const s of outer) outerLines.add(await lineOf(s));
  for (const line of outerLines) {
    expect(admitLines.has(line), `outer line differs from the admit line: ${line}`).toBe(false);
  }
});
