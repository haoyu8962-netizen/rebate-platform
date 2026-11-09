// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  CLAWED,
  CLAW_GRANTS,
  ID,
  RECON_GRANTS,
  REF,
  STATUS_NAME,
  clawbackPath,
  createServer,
  detailPath,
  notSupported,
  snapshot,
  stepUpRequired,
  stepUpValue,
  type Server,
} from './fixtures.ts';
import {
  CONFLICT,
  DONE,
  FLOW_TIMEOUT,
  FORBIDDEN,
  SWITCH_OFF,
  assertClawback,
  clawbackDialog,
  clawbackDialogs,
  clawbackEntries,
  confirmAndVerify,
  drawersOf,
  freshNotices,
  freshText,
  idempotencyOf,
  mount,
  openClawback,
  pressConfirm,
  readAgain,
  rowsOf,
  scope,
  settle,
  settled,
  showsAmount,
  snapshotText,
  squash,
  statusCell,
  stepUp,
  stepUpDialogs,
  stepUpHeader,
  stillListed,
  verify,
} from './helpers.ts';

const NOTE_TEXT = '复核确认命中黑名单';
/** Two full flows (the slow first antd render included) in one test. */
const PAIR_TIMEOUT = 120_000;

/**
 * 20902 resource=order: the notice says the order is no longer 已入账 (CREDITED)… (stricter than
 * the word itself, which the type's name may hold).
 */
const ORDER_GONE =
  /(?:不是|不再是|已非|并非|不再处于|不处于)[「"【]?已入账|已入账.{0,6}(?:已变化|已变更|已改变)|CREDITED/;
/** …and points to ending the difference by closing it (【关单】 / 【已关闭（不处理）】). */
const CLOSE_HINT =
  /关单|[【「]已关闭[（(]不处理[)）][】」]|(?:关闭|结案)(?:该|此|本)?差错单|(?:用|走|改用|通过|点).{0,4}关闭/;

/** After a failure in the dialog: a new step-up when the page asks for one, then the resend. */
async function resend(server: Server, id: string): Promise<void> {
  const sent = server.clawbacks(id).length;
  if (stepUpDialogs().length === 0) await pressConfirm(await clawbackDialog());
  const dialog = stepUpDialogs()[0];
  if (dialog !== undefined) await verify(dialog);
  await waitFor(() => expect(server.clawbacks(id)).toHaveLength(sent + 1));
  await settled(server);
}

it(
  '[AC-F1-08ec-ERR#1] 10003（动态码令牌失效）：不自动重发，重新弹动态码；再次验证后重放，Idempotency-Key 与第一次相同、动态码令牌是新的，成功提示含 clawed_back_fen',
  async () => {
    const server = createServer();
    server.once('POST', clawbackPath(ID.open), stepUpRequired);
    await mount(server);
    const modal = await openClawback(server, REF.open, ID.open);
    await confirmAndVerify(server, modal, ID.open, NOTE_TEXT);
    await settle();
    await settled(server);
    expect(server.clawbacks(ID.open), 'no automatic resend').toHaveLength(1);
    // The step-up dialog comes back by itself, or after pressing confirm again in the dialog.
    if (stepUpDialogs().length === 0) await pressConfirm(await clawbackDialog());
    const again = await stepUp();
    expect(server.clawbacks(ID.open)).toHaveLength(1);
    const before = snapshotText();
    await verify(again);
    await waitFor(() => expect(server.clawbacks(ID.open)).toHaveLength(2));
    await settled(server);
    const [first, second] = server.clawbacks(ID.open);
    assertClawback(server, second!, NOTE_TEXT);
    expect(idempotencyOf(second!), 'the replay keeps its Idempotency-Key').toBe(
      idempotencyOf(first!),
    );
    expect(second!.body).toEqual(first!.body);
    expect(stepUpHeader(first!)).toBe(stepUpValue(1));
    expect(stepUpHeader(second!), 'a new step-up value').toBe(stepUpValue(2));
    expect(server.item(ID.open).status).toBe('adjusted');
    await waitFor(() => {
      const notices = freshNotices(before);
      expect(notices).toMatch(DONE);
      expect(showsAmount(notices, CLAWED[ID.open]!), `clawed_back_fen in 「${notices}」`).toBe(
        true,
      );
    });
    await waitFor(() => expect(statusCell(REF.open)).toContain(STATUS_NAME.adjusted));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ec-ERR#2] 网络失败后在同一确认框重试：两次 POST 的 Idempotency-Key 相同、请求体相同，重试成功后该行变为「已调账」',
  async () => {
    const server = createServer();
    server.once('POST', clawbackPath(ID.open), () => {
      throw new TypeError('Failed to fetch');
    });
    await mount(server);
    const modal = await openClawback(server, REF.open, ID.open);
    await confirmAndVerify(server, modal, ID.open, NOTE_TEXT);
    expect(server.item(ID.open).status).toBe('open');
    expect(clawbackDialogs(), 'the dialog stays open').toHaveLength(1);
    await resend(server, ID.open);
    const [first, second] = server.clawbacks(ID.open);
    assertClawback(server, first!, NOTE_TEXT);
    assertClawback(server, second!, NOTE_TEXT);
    expect(idempotencyOf(second!), 'the retry reuses the Idempotency-Key').toBe(
      idempotencyOf(first!),
    );
    expect(second!.body).toEqual(first!.body);
    expect(server.item(ID.open).status).toBe('adjusted');
    await waitFor(() => expect(statusCell(REF.open)).toContain(STATUS_NAME.adjusted));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ec-ERR#3] 开关 order.blacklist_clawback.enabled 关闭（20001 reason=blacklist_clawback_disabled）：显示开关未开启的后台文案，不显示成功、不重发；差错单照常列出、仍待处理，订单仍已入账',
  async () => {
    const server = createServer(undefined, { enabled: false });
    await mount(server);
    const modal = await openClawback(server, REF.open, ID.open);
    const before = snapshotText();
    await confirmAndVerify(server, modal, ID.open);
    await waitFor(() => expect(freshText(before)).toMatch(SWITCH_OFF));
    await settle();
    await settled(server);
    expect(freshText(before), 'a console text, not the reason code').not.toContain(
      'blacklist_clawback',
    );
    expect(freshNotices(before)).not.toMatch(DONE);
    expect(server.clawbacks(), 'no resend').toHaveLength(1);
    expect(server.item(ID.open).status).toBe('open');
    expect(server.orderOf(ID.open)).toBe('CREDITED');
    await stillListed(REF.open, STATUS_NAME.open);
    await stillListed(REF.busy, STATUS_NAME.processing);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ec-ERR#4] 20001 reason=blacklist_clawback_not_supported 与 blacklist_clawback_disabled：各给后台文案、彼此不同（不支持的不说成开关未开），都不显示原因码、不显示成功、不重发，差错单照常列出、仍待处理',
  async () => {
    const told = new Map<string, string>();
    for (const reason of ['blacklist_clawback_not_supported', 'blacklist_clawback_disabled']) {
      const off = reason === 'blacklist_clawback_disabled';
      const server = createServer(undefined, { enabled: !off });
      if (!off) server.once('POST', clawbackPath(ID.open), notSupported);
      await mount(server);
      const modal = await openClawback(server, REF.open, ID.open);
      const before = snapshotText();
      await confirmAndVerify(server, modal, ID.open);
      await waitFor(() => expect(freshText(before), `a notice for ${reason}`).not.toBe(''));
      await settle();
      await settled(server);
      const fresh = freshText(before);
      expect(fresh, `${reason}: a console text, not the code`).not.toContain('blacklist_clawback');
      expect(freshNotices(before), `${reason}: no success`).not.toMatch(DONE);
      expect(server.clawbacks(), `${reason}: no resend`).toHaveLength(1);
      expect(server.item(ID.open).status).toBe('open');
      await stillListed(REF.open, STATUS_NAME.open);
      told.set(reason, fresh);
      cleanup();
    }
    const unsupported = told.get('blacklist_clawback_not_supported') ?? '';
    const disabled = told.get('blacklist_clawback_disabled') ?? '';
    expect(disabled).toMatch(SWITCH_OFF);
    expect(unsupported, 'not supported is not told as the switch being off').not.toMatch(
      SWITCH_OFF,
    );
    expect(unsupported, `two different texts: 「${unsupported}」 「${disabled}」`).not.toBe(
      disabled,
    );
  },
  PAIR_TIMEOUT,
);

it(
  '[AC-F1-08ec-ERR#5] 20902 resource=order（订单已不是已入账）：提示订单已不是已入账、请用关单结案；不显示成功、不重发，差错单照常列出、仍待处理',
  async () => {
    const server = createServer();
    await mount(server);
    const modal = await openClawback(server, REF.open, ID.open);
    server.setOrder(ID.open, 'CLAWED_BACK');
    const before = snapshotText();
    await confirmAndVerify(server, modal, ID.open);
    await waitFor(() => {
      const fresh = freshText(before);
      expect(fresh, 'the order is no longer 已入账').toMatch(ORDER_GONE);
      expect(fresh, 'end it by closing the difference').toMatch(CLOSE_HINT);
    });
    await settle();
    await settled(server);
    expect(freshNotices(before)).not.toMatch(DONE);
    expect(server.clawbacks(), 'no resend').toHaveLength(1);
    expect(server.item(ID.open).status).toBe('open');
    await stillListed(REF.open, STATUS_NAME.open);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ec-ERR#6] 20902 resource=recon_diff（差错单已被他人关闭）：提示已变化并重新读取详情，显示「已关闭（不处理）」，【确认扣回】消失，差错单仍在列表里，不显示成功、不重发',
  async () => {
    const server = createServer();
    await mount(server);
    const modal = await openClawback(server, REF.open, ID.open);
    server.setStatus(ID.open, 'closed');
    const reads = server.requests('GET', detailPath(ID.open)).length;
    const before = snapshotText();
    await confirmAndVerify(server, modal, ID.open);
    await waitFor(() => expect(freshText(before)).toMatch(CONFLICT));
    await readAgain(server, ID.open, reads);
    await settled(server);
    await waitFor(() => {
      const drawers = drawersOf(REF.open).map((node) => squash(node.textContent));
      const shown = [statusCell(REF.open), ...drawers];
      expect(
        shown.some((text) => text.includes(STATUS_NAME.closed)),
        'the row or the drawer shows the new status',
      ).toBe(true);
    });
    await waitFor(() => expect(clawbackEntries(REF.open)).toEqual([]));
    expect(rowsOf(scope(), [REF.open]), 'still listed').toHaveLength(1);
    expect(freshNotices(before)).not.toMatch(DONE);
    expect(server.clawbacks()).toHaveLength(1);
    expect(server.item(ID.open).status).toBe('closed');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ec-ERR#7] 10403（服务端判定无 order.blacklist_clawback）：提示无权限，不显示成功、不重发，差错单照常列出、仍待处理',
  async () => {
    const server = createServer(undefined, { permissions: RECON_GRANTS });
    await mount(server, { snapshot: snapshot(CLAW_GRANTS) });
    const modal = await openClawback(server, REF.open, ID.open);
    const before = snapshotText();
    await confirmAndVerify(server, modal, ID.open);
    await waitFor(() => expect(freshText(before)).toMatch(FORBIDDEN));
    await settle();
    await settled(server);
    expect(freshNotices(before)).not.toMatch(DONE);
    expect(server.clawbacks(), 'no resend').toHaveLength(1);
    expect(server.item(ID.open).status).toBe('open');
    await stillListed(REF.open, STATUS_NAME.open);
  },
  FLOW_TIMEOUT,
);
