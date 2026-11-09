// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  CLAWED,
  ID,
  REF,
  STATUS_NAME,
  clawbackPath,
  createServer,
  stepUpValue,
} from './fixtures.ts';
import {
  CONFIRM,
  DONE,
  FLOW_TIMEOUT,
  NOTE,
  actions,
  assertClawback,
  assertTotp,
  clawbackDialogs,
  clawbackEntries,
  click,
  confirmAndVerify,
  confirmMaybeVerify,
  drawersOf,
  fill,
  freshNotices,
  idempotencyOf,
  mount,
  openClawback,
  openDetail,
  pressConfirm,
  settle,
  settled,
  showsAmount,
  snapshotText,
  squash,
  statusCell,
  stepUp,
  stepUpDialogs,
  stepUpHeader,
  textbox,
  usable,
  verify,
} from './helpers.ts';

const NOTE_TEXT = '复核确认命中黑名单，按 R8 扣回';

/** The row (and the drawer, when open) of `ref` shows 「已调账」 and has no usable 【确认扣回】. */
async function shownAdjusted(ref: string): Promise<void> {
  await waitFor(() => expect(statusCell(ref)).toContain(STATUS_NAME.adjusted));
  for (const drawer of drawersOf(ref))
    await waitFor(() => expect(squash(drawer.textContent)).toContain(STATUS_NAME.adjusted));
  await waitFor(() => expect(clawbackEntries(ref)).toEqual([]));
}

it(
  '[AC-F1-08ec-CLAWBACK#1] 待处理的黑名单差错单【确认扣回】填备注：确认后先弹动态码，验证后才 POST blacklist-clawback（X-Step-Up-Token + Idempotency-Key + 只有 {note}，不带金额）；成功提示含服务端返回的 clawed_back_fen（后台金额格式），该行变为「已调账」、入口消失',
  async () => {
    const server = createServer();
    await mount(server);
    const modal = await openClawback(server, REF.open, ID.open);
    const before = snapshotText();
    await confirmAndVerify(server, modal, ID.open, `  ${NOTE_TEXT}  `);
    const [sent] = server.clawbacks(ID.open);
    assertClawback(server, sent!, NOTE_TEXT);
    expect(stepUpHeader(sent!)).toBe(stepUpValue(1));
    assertTotp(server);
    expect(server.verifies()).toHaveLength(1);
    expect(server.item(ID.open).status).toBe('adjusted');
    expect(server.orderOf(ID.open)).toBe('CLAWED_BACK');
    await waitFor(() => {
      const notices = freshNotices(before);
      expect(notices).toMatch(DONE);
      expect(
        showsAmount(notices, CLAWED[ID.open]!),
        `clawed_back_fen ${CLAWED[ID.open]} in 「${notices}」`,
      ).toBe(true);
    });
    await shownAdjusted(REF.open);
    expect(clawbackDialogs()).toEqual([]);
    expect(stepUpDialogs()).toEqual([]);
    expect(server.clawbacks()).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ec-CLAWBACK#2] 处理中的黑名单差错单不填备注：请求体是 {}（不带 note、金额）；服务端实扣 0 时成功提示照样给出并显示 0.00，该行变为「已调账」',
  async () => {
    const server = createServer();
    await mount(server);
    const modal = await openClawback(server, REF.busy, ID.busy);
    const before = snapshotText();
    await confirmAndVerify(server, modal, ID.busy);
    const [sent] = server.clawbacks(ID.busy);
    assertClawback(server, sent!);
    expect(sent!.body).toEqual({});
    await waitFor(() => {
      const notices = freshNotices(before);
      expect(notices).toMatch(DONE);
      expect(showsAmount(notices, 0), `clawed_back_fen 0 in 「${notices}」`).toBe(true);
    });
    await shownAdjusted(REF.busy);
    expect(server.item(ID.busy).status).toBe('adjusted');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ec-CLAWBACK#3] 连点两次确认、再连点两次【验证并继续】：只弹一个动态码对话框，只发一次 blacklist-clawback POST',
  async () => {
    const server = createServer();
    await mount(server);
    const modal = await openClawback(server, REF.open, ID.open);
    await fill(textbox(modal, NOTE), NOTE_TEXT);
    await pressConfirm(modal, true);
    const dialog = await stepUp();
    await settle();
    expect(stepUpDialogs(), 'one step-up dialog').toHaveLength(1);
    expect(server.clawbacks()).toEqual([]);
    await verify(dialog, true);
    await waitFor(() => expect(server.clawbacks(ID.open)).toHaveLength(1));
    await settled(server);
    await settle();
    await settled(server);
    expect(server.clawbacks(), 'one clawback').toHaveLength(1);
    assertClawback(server, server.clawbacks(ID.open)[0]!, NOTE_TEXT);
    await shownAdjusted(REF.open);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ec-CLAWBACK#4] 请求进行中：确认框的确认按钮不可用，再点也不发第二个请求、不再要动态码；请求返回后提示成功，全程只有一个 POST',
  async () => {
    const server = createServer();
    const release = server.hold('POST', clawbackPath(ID.open));
    await mount(server);
    const modal = await openClawback(server, REF.open, ID.open);
    const before = snapshotText();
    await pressConfirm(modal);
    await verify(await stepUp());
    await waitFor(() => expect(server.clawbacks(ID.open)).toHaveLength(1));
    await settle();
    expect(server.pending, 'the clawback is still running').toBeGreaterThan(0);
    for (const dialog of clawbackDialogs()) {
      // Disabled, or an antd loading button (which ignores clicks).
      const idle = usable(dialog, CONFIRM).filter(
        (node) =>
          !node.classList.contains('ant-btn-loading') && node.getAttribute('aria-busy') !== 'true',
      );
      expect(idle, 'no usable confirm while sending').toEqual([]);
      for (const node of actions(dialog, CONFIRM)) await click(node);
    }
    for (const node of clawbackEntries(REF.open)) await click(node);
    await settle();
    expect(server.clawbacks(), 'still one clawback').toHaveLength(1);
    expect(server.verifies(), 'no second step-up').toHaveLength(1);
    release();
    await settled(server);
    await waitFor(() => expect(freshNotices(before)).toMatch(DONE));
    await settle();
    await settled(server);
    expect(server.clawbacks()).toHaveLength(1);
    await shownAdjusted(REF.open);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ec-CLAWBACK#5] 连续确认扣回两张差错单：两次 POST 的 Idempotency-Key 不同、请求体都是 {}，两张都变为「已调账」',
  async () => {
    const server = createServer();
    await mount(server);
    const first = await openClawback(server, REF.open, ID.open);
    await confirmAndVerify(server, first, ID.open);
    await shownAdjusted(REF.open);
    await openDetail(server, REF.busy, ID.busy);
    const second = await openClawback(server, REF.busy, ID.busy);
    await confirmMaybeVerify(server, second, ID.busy);
    const [one] = server.clawbacks(ID.open);
    const [two] = server.clawbacks(ID.busy);
    assertClawback(server, one!);
    assertClawback(server, two!);
    expect(idempotencyOf(two!), 'a new Idempotency-Key').not.toBe(idempotencyOf(one!));
    await shownAdjusted(REF.busy);
    expect(server.clawbacks()).toHaveLength(2);
  },
  FLOW_TIMEOUT,
);
