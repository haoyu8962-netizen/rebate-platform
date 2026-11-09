// B1-10p rule test (claude-independent, SPEC_REF d5713bf4; FU-ADMIN-WRITE-READBACK-BLANK, D10-1048
// ②): the order detail adminHoldOrder, adminUnholdOrder, adminReassignOrder and
// adminSetOrderReasonSub answer with blanks last_hold_note, commission_rate_bp and
// commission_split.reserve_bp for an account without order.view; who is let in does not change.
// Top-level it() only (规划/11 §4.3).
//
// Red on the code before this task: the write answers the real values, so the comparison with the
// blanked detail fails in every case; the entitled accounts and the refusals come after it in the
// same case.
import { expect, it } from 'vitest';
import { useHarness } from '../auth/kit.ts';
import { refused, STEP_UP_REQUIRED } from '../../orders/admin-mounts/kit.ts';
import {
  ACTIONS,
  ORDER_VIEW,
  OTHER_POINTS,
  SLOW,
  WRITE_POINT,
  act,
  answered,
  arrange,
  blankOrder,
  expectEntitled,
  expectRefused,
  expectWritten,
  orderScene,
  realAfter,
  send,
  type Action,
} from './kit.ts';

const h = useHarness();

/** Write-only account blanked and the write effective; entitled accounts real; 10403 unchanged. */
async function blankedOnlyWithoutOrderView(action: Action): Promise<void> {
  const c = await orderScene(h);
  const writer = await c.s.caller([WRITE_POINT[action]]);
  const order = await arrange(c, action);
  const data = await answered(await act(c, action, order, writer));
  const real = await realAfter(c, action, order);
  expect(data).toEqual(blankOrder(real));
  await expectWritten(c, action, order, writer);

  await expectEntitled(c, action, await c.s.caller([WRITE_POINT[action], ORDER_VIEW]));
  await expectEntitled(c, action, c.superAdmin);
  await expectRefused(c, action, [ORDER_VIEW]);
}

it(
  '[AC-B1-10p#1] adminHoldOrder 只持 order.hold：响应的 last_hold_note、commission_rate_bp、commission_split.reserve_bp 为 null，金额、状态、hold_reason 照常，库里 hold 生效、审计照写；对照：加持 order.view、超管拿到真实值；只持 order.view 仍 10403',
  () => blankedOnlyWithoutOrderView('hold'),
  SLOW,
);

it(
  '[AC-B1-10p#2] adminUnholdOrder 只持 order.hold：响应三个内部字段为 null，其余照常，库里解除暂停、审计照写；对照：加持 order.view、超管拿到真实值；只持 order.view 仍 10403',
  () => blankedOnlyWithoutOrderView('unhold'),
  SLOW,
);

it(
  '[AC-B1-10p#3] adminReassignOrder 只持 order.assign（带动态码）：响应三个内部字段为 null，归属、orders.reason 照常，库里指派生效、审计照写；对照：加持 order.view、超管拿到真实值；只持 order.view 仍 10403',
  () => blankedOnlyWithoutOrderView('assign'),
  SLOW,
);

it(
  '[AC-B1-10p#4] adminSetOrderReasonSub 只持 order.claim：响应三个内部字段为 null，reason、reason_sub 照常，库里子原因生效、审计照写；对照：加持 order.view、超管拿到真实值；只持 order.view 仍 10403',
  () => blankedOnlyWithoutOrderView('reasonSub'),
  SLOW,
);

it(
  '[AC-B1-10p#5] 只有 order.view 算数：四个写接口加持 user.lookup、order.claim、risk.*、fund.view 仍置空',
  async () => {
    const c = await orderScene(h);
    for (const action of ACTIONS) {
      const caller = await c.s.caller([...new Set([WRITE_POINT[action], ...OTHER_POINTS])]);
      const order = await arrange(c, action);
      const data = await answered(await act(c, action, order, caller));
      expect(data, action).toEqual(blankOrder(await realAfter(c, action, order)));
    }
  },
  SLOW,
);

it(
  '[AC-B1-10p#6] 置空不改写操作的动态码：adminReassignOrder 不带 X-Step-Up-Token 仍 10003、什么都不写；带有效 token 成功且响应置空；同一 token 已消耗，再用仍 10003',
  async () => {
    const c = await orderScene(h);
    const writer = await c.s.caller([WRITE_POINT.assign]);
    const first = await arrange(c, 'assign');
    const untouched = await c.s.state();
    await refused(await send(c, 'assign', first, { caller: writer }), 10003, STEP_UP_REQUIRED);
    expect(await c.s.state()).toEqual(untouched);

    const stepUp = await c.s.stepUp(writer);
    const data = await answered(await send(c, 'assign', first, { caller: writer, stepUp }));
    expect(data).toEqual(blankOrder(await realAfter(c, 'assign', first)));

    const second = await arrange(c, 'assign');
    const before = await c.s.state();
    const replay = await send(c, 'assign', second, { caller: writer, stepUp });
    await refused(replay, 10003, STEP_UP_REQUIRED);
    expect(await c.s.state()).toEqual(before);
  },
  SLOW,
);
