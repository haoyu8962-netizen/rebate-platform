// @vitest-environment jsdom
import { cleanup, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ENTRY,
  NOTICE,
  QUEUE,
  RESUME,
  SERVER_REASON,
  VERSION,
  failedWith,
  pausedOverview,
  type SwitchUpdate,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  MULTI_TIMEOUT,
  answerNormally,
  assertPut,
  changedElsewhere,
  closed,
  notice,
  openAction,
  openPanel,
  pauseNames,
  puts,
  queueShown,
  reasonInput,
  reasonMessages,
  rereadAfter,
  scriptPut,
  serverFor,
  settle,
  settled,
  squash,
  step,
  stepDialogs,
  submit,
  switchDialogs,
  tryAgain,
  typeReason,
  verifications,
  verify,
} from './helpers.ts';

// F1-08bd ③ errors of adminUpdateKillSwitch. 20902 (the version moved on: someone else changed the
// switch) says so and reads the overview again, sending nothing on its own; trying again reads the
// version again. 10003 asks for the dynamic code again and then sends the same body (the same
// expected_version). 10403 names the missing points; 20001 is placed by data.fields (reason at the
// reason field, anything else a dialog notice). 5xx and a network error say the submit failed and
// send nothing on their own; trying again reads the version again. After 10403, 20001, 5xx and a
// network error the dialog stays with what was typed.

const REASON = '财务已充值，恢复出款';
const BODY: SwitchUpdate = { value: false, expected_version: VERSION.queue, reason: REASON };
const PAUSED_ALL = [ENTRY.resume, ENTRY.channel, ENTRY.channel].sort();

/** Nothing reads as done; the dialog, without a StepUpModal, stays with the reason typed. */
function assertKept(modal: HTMLElement): void {
  expect(within(document.body).queryAllByText(RESUME.done, { exact: true })).toEqual([]);
  expect(stepDialogs(), 'no StepUpModal left open').toEqual([]);
  expect(switchDialogs(), 'the dialog stays').toEqual([modal]);
  expect(reasonInput(modal).value, 'the reason stays').toBe(REASON);
}

it(
  '[AC-F1-08bd-ERROR#1] 20902（别人刚解除了暂停，version 已变）：提示「开关状态已被他人修改，已刷新为最新状态，请核对后重试」、重新读概览，标题行随之换成【暂停队列】；不报成功、不自动重发',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor({ overview: pausedOverview() });
    scriptPut(server, (request) => {
      changedElsewhere(server, QUEUE, false);
      return answerNormally(server, request);
    });
    const panel = await openPanel(server);
    const { modal, mark } = await openAction(server, panel, RESUME);
    await typeReason(modal, REASON);
    await submit(server, modal, RESUME);
    const sent = assertPut(server, RESUME, BODY, 1, 1, mark);
    await notice(NOTICE.conflict);
    await rereadAfter(server, sent);
    const after = [ENTRY.pause, ENTRY.channel, ENTRY.channel].sort();
    await waitFor(() => expect(pauseNames(), 'the entries as refreshed').toEqual(after));
    expect(queueShown(panel)).toEqual(['运行中']);
    await settle();
    expect(puts(server), 'no automatic resend').toHaveLength(1);
    expect(verifications(server)).toHaveLength(1);
    expect(within(document.body).queryAllByText(RESUME.done, { exact: true })).toEqual([]);
  },
);

it(
  '[AC-F1-08bd-ERROR#2] 20902（别人改过又改回，仍是暂停、version 前进了 2）：提示并刷新、不自动重发，【解除暂停】仍在；再试时重新读开关列表，按新的 expected_version=9 发出，成功后标题行换成【暂停队列】',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor({ overview: pausedOverview() });
    scriptPut(server, (request) => {
      changedElsewhere(server, QUEUE, true, 2);
      return answerNormally(server, request);
    });
    const panel = await openPanel(server);
    const { modal, mark } = await openAction(server, panel, RESUME);
    await typeReason(modal, REASON);
    await submit(server, modal, RESUME);
    const first = assertPut(server, RESUME, BODY, 1, 1, mark);
    await notice(NOTICE.conflict);
    await rereadAfter(server, first);
    expect(puts(server), 'no automatic resend').toHaveLength(1);
    expect(pauseNames(), 'still paused').toEqual(PAUSED_ALL);

    await tryAgain(server, panel, RESUME);
    const since = server.log.indexOf(first) + 1;
    const body: SwitchUpdate = { ...BODY, expected_version: VERSION.queue + 2 };
    const second = assertPut(server, RESUME, body, 2, verifications(server).length, since);
    await closed();
    await notice(RESUME.done);
    await rereadAfter(server, second);
    const after = [ENTRY.pause, ENTRY.channel, ENTRY.channel].sort();
    await waitFor(() => expect(pauseNames(), 'lifted on the second try').toEqual(after));
  },
);

it(
  '[AC-F1-08bd-ERROR#3] 10003：重新弹出动态码并提示「动态码凭证已失效，请重新输入动态码」，验证前不重发；验证后以新凭证原样重发（整个请求体相同、expected_version 仍为 7），成功后关闭',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor({ overview: pausedOverview() });
    scriptPut(server, () => failedWith(10003, { tier: 'totp' }));
    const panel = await openPanel(server);
    const { modal, mark } = await openAction(server, panel, RESUME);
    await typeReason(modal, REASON);
    await submit(server, modal, RESUME);
    await step();
    await notice(NOTICE.again);
    await settled(server);
    assertPut(server, RESUME, BODY, 1, 1, mark);
    expect(puts(server), 'not resent before the new code').toHaveLength(1);
    expect(switchDialogs(), 'the dialog stays').toEqual([modal]);
    await verify();
    await waitFor(() => expect(puts(server)).toHaveLength(2));
    await settled(server);
    assertPut(server, RESUME, BODY, 2, 2, mark);
    expect(verifications(server)).toHaveLength(2);
    await closed();
    await notice(RESUME.done);
  },
);

interface Placement {
  readonly reply: () => Response;
  /** A notice of the page; null: none, the message is at the reason field. */
  readonly notice: string | null;
  /** The messages at the reason field. */
  readonly field: readonly string[];
}

it(
  '[AC-F1-08bd-ERROR#4] 10403 提示「无权限执行此操作（需要 switch.payout 或 switch.all 权限点）」；20001 data.fields=[reason] 提示落在原因输入框，data.fields 为 [value]、[key] 或空时在对话框提示「提交内容有误，请检查后重试」、不落字段；都不报成功、不自动重新验证或重发，对话框与已填原因保留',
  { timeout: 2 * MULTI_TIMEOUT },
  async () => {
    const placements: readonly Placement[] = [
      {
        reply: () => failedWith(10403, { reason: 'admin_permission_denied' }),
        notice: NOTICE.forbidden,
        field: [],
      },
      {
        reply: () => failedWith(20001, { fields: ['reason'] }),
        notice: null,
        field: [squash(SERVER_REASON)],
      },
      { reply: () => failedWith(20001, { fields: ['value'] }), notice: NOTICE.invalid, field: [] },
      { reply: () => failedWith(20001, { fields: ['key'] }), notice: NOTICE.invalid, field: [] },
      { reply: () => failedWith(20001, { fields: [] }), notice: NOTICE.invalid, field: [] },
    ];
    for (const placement of placements) {
      const server = serverFor({ overview: pausedOverview() });
      scriptPut(server, placement.reply);
      const panel = await openPanel(server);
      const { modal, mark } = await openAction(server, panel, RESUME);
      await typeReason(modal, REASON);
      await submit(server, modal, RESUME);
      assertPut(server, RESUME, BODY, 1, 1, mark);
      if (placement.notice !== null) await notice(placement.notice);
      await waitFor(() => expect(reasonMessages(modal)).toEqual(placement.field));
      await settled(server);
      assertKept(modal);
      expect(puts(server), 'no automatic resend').toHaveLength(1);
      expect(verifications(server), 'no new verification').toHaveLength(1);
      expect(pauseNames(), 'the entries stay').toEqual(PAUSED_ALL);
      cleanup();
    }
  },
);

interface Failure {
  readonly fail: () => Response;
  readonly notice: string;
}

it(
  '[AC-F1-08bd-ERROR#5] 5xx 提示「提交失败，请稍后重试」，网络错误提示「网络错误，请检查网络后重试；未确认前不会重复提交」；不报成功、不自动重发，对话框与已填原因保留；其间开关 version 又前进了 1，再试时重新读开关列表，按 expected_version=8 发出，成功后关闭',
  { timeout: MULTI_TIMEOUT },
  async () => {
    const failures: readonly Failure[] = [
      { fail: () => failedWith(50001), notice: NOTICE.failed },
      {
        fail: () => {
          throw new Error('simulated network disconnect');
        },
        notice: NOTICE.network,
      },
    ];
    for (const failure of failures) {
      const server = serverFor({ overview: pausedOverview() });
      scriptPut(server, () => {
        changedElsewhere(server, QUEUE, true);
        return failure.fail();
      });
      const panel = await openPanel(server);
      const { modal, mark } = await openAction(server, panel, RESUME);
      await typeReason(modal, REASON);
      await submit(server, modal, RESUME);
      const first = assertPut(server, RESUME, BODY, 1, 1, mark);
      await notice(failure.notice);
      await settled(server);
      assertKept(modal);
      expect(puts(server), 'no automatic resend').toHaveLength(1);
      expect(verifications(server), 'no new verification').toHaveLength(1);

      await tryAgain(server, panel, RESUME);
      const since = server.log.indexOf(first) + 1;
      const body: SwitchUpdate = { ...BODY, expected_version: VERSION.queue + 1 };
      assertPut(server, RESUME, body, 2, verifications(server).length, since);
      await closed();
      await notice(RESUME.done);
      cleanup();
    }
  },
);
