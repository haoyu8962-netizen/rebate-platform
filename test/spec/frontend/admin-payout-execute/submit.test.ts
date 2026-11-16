// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { CANCEL, CID, CNO, ENTRY, QID, QNO, SUBMIT, executed } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  assertPost,
  button,
  buttons,
  checkbox,
  click,
  confirm,
  dialogs,
  disabled,
  holdWith,
  open,
  openQueue,
  posts,
  select,
  serverFor,
  settled,
  step,
  stepDialogs,
  verifications,
  verify,
} from './helpers.ts';

// F1-08bb ③: 【确认执行】 → StepUpModal (totp) → exactly one POST /admin/v1/payout-batches whose
// body is only `withdrawal_ids` (the ticked ids, list order, no duplicate), with X-Step-Up-Token and
// Idempotency-Key. Double clicks and clicks while it is in flight send nothing more; while it is in
// flight the dialog stays, 【执行所选】 and 【确认执行】 are disabled. Cancelling the dynamic code
// sends nothing; after closing the dialog the focus returns to 【执行所选】.

it(
  '[AC-F1-08bb-SUBMIT#1] 一次动态码覆盖整批：倒序勾选、取消再勾不改变请求体顺序；连点【确认执行】与【验证并继续】、在途时再点入口与提交都只发一次 POST /admin/v1/payout-batches（请求体只有 withdrawal_ids，列表顺序，带 X-Step-Up-Token 与 Idempotency-Key），在途时对话框保留、两处按钮禁用',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const release = holdWith(server, executed([QID.approvedA, CID], []));
    const panel = await openQueue(server);
    try {
      await select(panel, [CNO, QNO.approvedA]);
      await click(checkbox(panel, CNO));
      expect(checkbox(panel, CNO).checked).toBe(false);
      await select(panel, [CNO]);
      const entry = button(panel, ENTRY);
      const modal = await open(server, panel);
      const submit = button(modal, SUBMIT);
      await confirm(server, modal, true);
      await verify(true);
      await waitFor(() => expect(posts(server)).toHaveLength(1));
      expect(disabled(entry), `${ENTRY} disabled in flight`).toBe(true);
      expect(disabled(submit), `${SUBMIT} disabled in flight`).toBe(true);
      expect(
        dialogs().filter((node) => node === modal),
        'the dialog stays',
      ).toHaveLength(1);
      await click(entry, true);
      await click(submit, true);
      assertPost(server, [QID.approvedA, CID], 1, 1);
      expect(verifications(server)).toHaveLength(1);
      expect(server.pending).toBe(1);
    } finally {
      release();
    }
    await settled(server);
    assertPost(server, [QID.approvedA, CID], 1, 1);
    expect(verifications(server)).toHaveLength(1);
    expect(server.writes()).toHaveLength(2);
  },
);

it(
  '[AC-F1-08bb-SUBMIT#2] 取消动态码不提交；关闭执行确认对话框后焦点回【执行所选】、勾选保留；再次执行仍须动态码，期间不发验证以外的写请求',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openQueue(server);
    await select(panel, [QNO.approvedA, CNO]);
    const entry = button(panel, ENTRY);
    const modal = await open(server, panel);
    await confirm(server, modal);
    await click(button(await step(), CANCEL));
    await waitFor(() => expect(stepDialogs()).toEqual([]));
    expect(server.writes()).toEqual([]);
    for (const remaining of dialogs()) await click(button(remaining, CANCEL));
    await waitFor(() => expect(dialogs()).toEqual([]));
    await waitFor(() => expect(document.activeElement).toBe(entry));
    expect(checkbox(panel, QNO.approvedA).checked).toBe(true);
    expect(checkbox(panel, CNO).checked).toBe(true);
    expect(buttons(panel, ENTRY)).toHaveLength(1);
    const reopened = await open(server, panel);
    await confirm(server, reopened);
    expect(verifications(server)).toEqual([]);
    expect(posts(server)).toEqual([]);
  },
);
