// B3-08v rule tests (brief §9.2 「logger 未注入时不记、不抛」, §9.3 2): without a logger the same
// failure neither throws nor rejects and the client gets exactly what it gets with a logger (the
// trunk's answer); with a logger the same failure is one error line.
import { expect, it } from 'vitest';

import { call, expectOneErrorLine, identifiersOf, messageBody, rig } from './kit.ts';
import { SCENARIOS, defaultFault, expectAnswer } from './scenarios.ts';

for (const [i, s] of SCENARIOS.entries()) {
  it(`[B3-08v#4.${i + 1}] ${s.title}：未注入 logger 时同样的失败不抛、回包与注入 logger 时一致；注入时恰一行 error`, async () => {
    const bare = rig({ logger: false });
    expect(bare.log).toBeNull();
    s.arrange(bare, defaultFault(s).fault);
    const bareReply = await call(bare, s.op, messageBody());
    expectAnswer(s, bareReply, bare);

    const logged = rig();
    const { fault, errorName } = defaultFault(s);
    s.arrange(logged, fault);
    const body = messageBody();
    const loggedReply = await call(logged, s.op, body);
    expectAnswer(s, loggedReply, logged);

    expect(bareReply.record()).toStrictEqual(loggedReply.record());
    expectOneErrorLine(logged.log!, {
      op: s.op,
      errorName,
      forbidden: identifiersOf(
        logged.caller,
        s.op === 'send_message' ? body.client_msg_id : undefined,
      ),
    });
  });
}
