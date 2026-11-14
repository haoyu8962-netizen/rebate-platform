// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJUSTMENTS,
  ADJUSTMENT_ORDER,
  COLUMN,
  DOC,
  ERROR,
  LABEL,
  REF_TYPE_NAME,
  TEXT,
  UNKNOWN_DOC,
  UNKNOWN_USER,
  USER,
  conflict,
  createWriteServer,
  createdId,
  denied,
  fenOf,
  passOf,
  reasonName,
  rejected,
  stepUpRequired,
  stillRunning,
  unavailable,
  type CreateNew,
  type RequestLog,
} from './fixtures.ts';
import {
  assertWrite,
  button,
  buttons,
  click,
  createDrawer,
  dialogsTitled,
  fillForm,
  hasText,
  idemOf,
  main,
  mount,
  nonReadsSince,
  openCreate,
  pressSubmit,
  refRows,
  settle,
  settled,
  shows,
  stepUpDialogs,
  submitLocked,
  submitWithSms,
  typeInto,
  valueOf,
  verifySms,
  waitColumn,
  type NewForm,
  type WriteServer,
} from './helpers.ts';

async function ready(server: WriteServer): Promise<void> {
  await mount(server);
  await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
  await settled(server);
}

/** A valid RECON_FIX increase of ¥8.80 for `user`. */
function reconFix(user: string): NewForm {
  return {
    user,
    direction: '调增',
    amount: '8.8',
    reason: reasonName('RECON_FIX'),
    refs: [['recon_diff', DOC.reconDiff]],
    subject: '佣金收入',
  };
}
function reconFixBody(user: string): CreateNew {
  return {
    user_id: user,
    direction: 'increase',
    amount_fen: fenOf('8.8'),
    reason_code: 'RECON_FIX',
    refs: [{ ref_type: 'recon_diff', ref_id: DOC.reconDiff }],
    contra_subject: 'COMMISSION_REVENUE',
  };
}
/** The drawer is still open with what was typed. */
function kept(root: HTMLElement, user: string): void {
  expect(createDrawer()).toBe(root);
  expect(valueOf(root, LABEL.user)).toBe(user);
  expect(valueOf(root, LABEL.amount)).toBe('8.8');
  expect(refRows(root)).toEqual([[REF_TYPE_NAME.recon_diff, DOC.reconDiff]]);
}
const userDeleted = (): Response => rejected(['user_id'], 'adjust_user_deleted');

it(
  '[AC-F1-08cb-ERROR#1] 20001 data.fields=[user_id]（用户不存在）：抽屉保留、已填不丢，提示「用户不存在，请核对用户 ID」；改正 UID 再提交时重新短信验证、换新的 Idempotency-Key（20001 已确定拒绝，改过的请求体沿用原键会被契约判 20901），请求体按改正后的值，成功后提示新单号',
  { timeout: 120_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const root = await openCreate();
    await fillForm(root, reconFix(UNKNOWN_USER));
    const first = await submitWithSms(server, root);
    assertWrite(server, first, reconFixBody(UNKNOWN_USER), passOf(1));
    await waitFor(() => expect(hasText(createDrawer(), ERROR.userUnknown)).toBe(true));
    kept(root, UNKNOWN_USER);
    expect(server.writes()).toHaveLength(1);

    await typeInto(root, LABEL.user, USER.recon);
    const second = await submitWithSms(server, root);
    assertWrite(server, second, reconFixBody(USER.recon), passOf(2));
    expect(idemOf(second)).not.toBe(idemOf(first));
    await waitFor(() => expect(shows(TEXT.created(createdId(1)))).toBe(true));
    await waitColumn(COLUMN.id, [createdId(1), ...ADJUSTMENT_ORDER]);
    expect(server.writes()).toHaveLength(2);
  },
);

it(
  '[AC-F1-08cb-ERROR#2] 20001 按 data.reason 提示在抽屉里：关联单据 adjust_ref_invalid → 「关联单据不存在、不属于该用户或不能用于调账，请核对」；adjust_user_deleted → 「该用户已注销或正在注销，不能调账」；抽屉保留、不自动重发',
  { timeout: 120_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const root = await openCreate();
    await fillForm(root, { ...reconFix(USER.recon), refs: [['recon_diff', UNKNOWN_DOC]] });
    const first = await submitWithSms(server, root);
    expect(first.body).toEqual({
      ...reconFixBody(USER.recon),
      refs: [{ ref_type: 'recon_diff', ref_id: UNKNOWN_DOC }],
    });
    await waitFor(() => expect(hasText(createDrawer(), ERROR.refInvalid)).toBe(true));
    expect(createDrawer()).toBe(root);
    expect(refRows(root)).toEqual([[REF_TYPE_NAME.recon_diff, UNKNOWN_DOC]]);
    await settled(server);
    expect(server.writes()).toHaveLength(1);

    server.once('POST', ADJUSTMENTS, userDeleted);
    await submitWithSms(server, root);
    await waitFor(() => expect(hasText(createDrawer(), ERROR.userDeleted)).toBe(true));
    expect(createDrawer()).toBe(root);
    expect(valueOf(root, LABEL.user)).toBe(USER.recon);
    await settled(server);
    expect(server.writes()).toHaveLength(2);
  },
);

it(
  '[AC-F1-08cb-ERROR#3] 10403（本地有 fund.adjust、服务端不认）：提示「无权限执行调账」，抽屉保留、已填不丢，不自动重发',
  { timeout: 90_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const root = await openCreate();
    await fillForm(root, reconFix(USER.recon));
    server.once('POST', ADJUSTMENTS, denied);
    await submitWithSms(server, root);
    await waitFor(() => expect(shows(ERROR.forbidden)).toBe(true));
    kept(root, USER.recon);
    await settled(server);
    expect(server.writes()).toHaveLength(1);
    expect(server.codeSends()).toHaveLength(1);
  },
);

it(
  '[AC-F1-08cb-ERROR#4] 结果未定的失败（50001、40901）：每次提示「提交失败，请稍后重试」、抽屉保留、不自动重发；再次提交重新短信验证并沿用同一个 Idempotency-Key 与同一请求体，最终成功只生效一张',
  { timeout: 180_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const root = await openCreate();
    await fillForm(root, reconFix(USER.recon));
    const body = reconFixBody(USER.recon);
    const sent: RequestLog[] = [];
    for (const reply of [unavailable, stillRunning]) {
      server.once('POST', ADJUSTMENTS, reply);
      sent.push(await submitWithSms(server, root));
      await waitFor(() => expect(shows(ERROR.failed)).toBe(true));
      kept(root, USER.recon);
      await settled(server);
      expect(server.writes()).toHaveLength(sent.length);
    }
    const last = await submitWithSms(server, root);
    sent.push(last);
    sent.forEach((request, index) => assertWrite(server, request, body, passOf(index + 1)));
    expect(sent.map(idemOf)).toEqual(Array.from({ length: 3 }, () => idemOf(sent[0]!)));
    await waitFor(() => expect(shows(TEXT.created(createdId(1)))).toBe(true));
    await waitFor(() => expect(dialogsTitled(TEXT.createTitle)).toEqual([]));
    await waitColumn(COLUMN.id, [createdId(1), ...ADJUSTMENT_ORDER]);
    expect(server.writes()).toHaveLength(3);
  },
);

it(
  '[AC-F1-08cb-ERROR#5] 20901（同键不同请求体）：提示「提交失败，请稍后重试」、不自动重发；用户再次提交时换新的 Idempotency-Key（error-codes 20901：生成新幂等键后由用户重新提交）',
  { timeout: 120_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const root = await openCreate();
    await fillForm(root, reconFix(USER.recon));
    server.once('POST', ADJUSTMENTS, conflict);
    const first = await submitWithSms(server, root);
    await waitFor(() => expect(shows(ERROR.failed)).toBe(true));
    kept(root, USER.recon);
    await settled(server);
    expect(server.writes()).toHaveLength(1);

    const second = await submitWithSms(server, root);
    assertWrite(server, second, reconFixBody(USER.recon), passOf(2));
    expect(idemOf(second)).not.toBe(idemOf(first));
    await waitFor(() => expect(shows(TEXT.created(createdId(1)))).toBe(true));
    expect(server.writes()).toHaveLength(2);
  },
);

it(
  '[AC-F1-08cb-ERROR#6] POST 返回 10003 data.tier=sms（验证已失效）：重新发验证码、再弹短信验证，验证后用新的验证重放同一请求体与同一个 Idempotency-Key（契约：重放沿用原键），成功只生效一张',
  { timeout: 120_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const root = await openCreate();
    await fillForm(root, reconFix(USER.recon));
    server.once('POST', ADJUSTMENTS, stepUpRequired);
    await pressSubmit(root);
    await verifySms(server);
    await waitFor(() => expect(server.writes()).toHaveLength(1));
    await waitFor(() => expect(server.codeSends()).toHaveLength(2));
    await verifySms(server);
    await waitFor(() => expect(server.writes()).toHaveLength(2));
    await settled(server);
    await waitFor(() => expect(stepUpDialogs()).toEqual([]));

    const [first, second] = server.writes();
    const body = reconFixBody(USER.recon);
    assertWrite(server, first!, body, passOf(1));
    assertWrite(server, second!, body, passOf(2));
    expect(idemOf(second!)).toBe(idemOf(first!));
    await waitFor(() => expect(shows(TEXT.created(createdId(1)))).toBe(true));
    expect(server.writes()).toHaveLength(2);
    expect(server.verifications()).toHaveLength(2);
  },
);

it(
  '[AC-F1-08cb-ERROR#7] 未登记验证手机号（发码返回 10003 data.reason=verify_phone_missing）：提示「这项操作需要短信验证，请先登记验证手机号」，不弹验证、不发 POST，抽屉保留；再按提交也不再发码、不弹验证',
  { timeout: 90_000 },
  async () => {
    const server = createWriteServer({ verifyPhone: false });
    await ready(server);
    const root = await openCreate();
    await fillForm(root, reconFix(USER.recon));
    await pressSubmit(root);
    await waitFor(() => expect(server.codeSends()).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(shows(ERROR.verifyPhoneMissing)).toBe(true));
    expect(stepUpDialogs()).toEqual([]);
    expect(server.verifications()).toEqual([]);
    expect(server.writes()).toEqual([]);
    kept(root, USER.recon);

    for (const node of buttons(root, TEXT.submit)) await click(node);
    await settled(server);
    expect(stepUpDialogs()).toEqual([]);
    expect(server.codeSends()).toHaveLength(1);
    expect(server.verifications()).toEqual([]);
    expect(server.writes()).toEqual([]);
    expect(shows(ERROR.verifyPhoneMissing)).toBe(true);
  },
);

it(
  '[AC-F1-08cb-ERROR#8] 提交中：【提交并短信验证】不可用，再点不发第二次；返回成功后只有一次 POST',
  { timeout: 90_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const root = await openCreate();
    await fillForm(root, reconFix(USER.recon));
    const release = server.hold('POST', ADJUSTMENTS);
    await pressSubmit(root);
    await verifySms(server);
    await waitFor(() => expect(server.writes()).toHaveLength(1));
    await waitFor(() => expect(submitLocked(root)).toBe(true));
    for (const node of buttons(root, TEXT.submit)) await click(node);
    await settle();
    expect(server.writes()).toHaveLength(1);
    expect(server.codeSends()).toHaveLength(1);
    expect(stepUpDialogs()).toEqual([]);

    release();
    await settled(server);
    await waitFor(() => expect(shows(TEXT.created(createdId(1)))).toBe(true));
    expect(server.writes()).toHaveLength(1);
    expect(server.verifications()).toHaveLength(1);
  },
);

it(
  '[AC-F1-08cb-ERROR#9] 新建抽屉【取消】：抽屉关闭、焦点回到【新建调账】，不发任何请求',
  { timeout: 60_000 },
  async () => {
    const server = createWriteServer();
    await ready(server);
    const since = server.log.length;
    const entry = button(main(), TEXT.createEntry);
    const root = await openCreate();
    await fillForm(root, { user: USER.recon, amount: '1' });
    await click(button(root, TEXT.cancel));
    await waitFor(() => expect(dialogsTitled(TEXT.createTitle)).toEqual([]));
    await waitFor(() => expect(document.activeElement).toBe(entry));
    await settled(server);
    expect(nonReadsSince(server, since)).toEqual([]);
  },
);
