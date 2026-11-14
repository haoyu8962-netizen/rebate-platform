// @vitest-environment jsdom
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  APPROVE,
  CONSEQUENCE,
  RESULT_TEXT,
  assertRequest,
  buttons,
  checkbox,
  click,
  confirm,
  dialogs,
  main,
  mount,
  ok,
  open,
  pendingRows,
  rowOf,
  rowsOf,
  select,
  serverFor,
  settled,
  succeed,
  verify,
  writes,
  type ResultItem,
} from './helpers.ts';

// Results may remain in a Modal or appear on the page. Dismiss any completed Modal
// with its standard keyboard interaction before starting another batch on this page.
async function dismissResults(): Promise<void> {
  for (const modal of dialogs()) {
    await act(async () => {
      fireEvent.keyDown(modal, { key: 'Escape', code: 'Escape', keyCode: 27 });
    });
  }
  await waitFor(() => expect(dialogs()).toEqual([]));
}

it(
  '[AC-F1-08ai-SUBMIT#2] 同页完成 A、B 后勾选 C 是新一批，两次请求的幂等标识均非空且不同',
  { timeout: 60_000 },
  async () => {
    const items = pendingRows().slice(0, 3);
    const firstBatch = items.slice(0, 2);
    const nextBatch = items.slice(2);
    const server = serverFor(items);
    server.once('POST', APPROVE, () => succeed(server, firstBatch));
    server.once('POST', APPROVE, () => succeed(server, nextBatch));
    await mount(server);
    await select(firstBatch);
    const before = server.reads().length;
    await confirm(server, await open());
    await verify();
    await waitFor(() => expect(server.reads().length).toBeGreaterThan(before));
    await settled(server);
    assertRequest(server, firstBatch);
    for (const item of firstBatch) {
      const results = rowsOf(document.body, item.out_biz_no).filter(
        (row) => within(row).queryAllByText(RESULT_TEXT.approved, { exact: true }).length === 1,
      );
      expect(results).toHaveLength(1);
    }
    expect(buttons(main(), '批量通过')).toEqual([]);
    expect(
      Array.from(main().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).filter(
        (node) => node.checked,
      ),
    ).toEqual([]);
    const first = writes(server)[0]!;
    await dismissResults();
    await select(nextBatch);
    await confirm(server, await open());
    await verify();
    await waitFor(() => expect(writes(server)).toHaveLength(2));
    await settled(server);
    assertRequest(server, nextBatch, 2);
    const second = writes(server)[1]!;
    expect(first.headers.get('Idempotency-Key')).toEqual(expect.stringMatching(/^\S+$/));
    expect(second.headers.get('Idempotency-Key')).toEqual(expect.stringMatching(/^\S+$/));
    expect(second.headers.get('Idempotency-Key')).not.toBe(first.headers.get('Idempotency-Key'));
  },
);

it(
  '[AC-F1-08ai-SUBMIT#3] 同一张单被跳过后重新勾选提交是新操作，即使请求体相同也必须更换幂等标识',
  { timeout: 60_000 },
  async () => {
    const items = pendingRows().slice(0, 1);
    const server = serverFor(items);
    const results: ResultItem[] = [
      { withdrawal_id: items[0]!.withdrawal_id, result: 'skipped', reason: 'negative_balance' },
    ];
    server.once('POST', APPROVE, () => ok({ items: results }));
    // A later operation can succeed after the server-side balance has recovered.
    server.once('POST', APPROVE, () => succeed(server, items));
    await mount(server);
    await select(items);
    const before = server.reads().length;
    await confirm(server, await open());
    await verify();
    await waitFor(() => expect(server.reads().length).toBeGreaterThan(before));
    await settled(server);
    assertRequest(server, items);
    expect(
      rowsOf(document.body, items[0]!.out_biz_no).filter(
        (row) =>
          within(row).queryAllByText(RESULT_TEXT.negative_balance, { exact: true }).length === 1,
      ),
    ).toHaveLength(1);
    expect(buttons(main(), '批量通过')).toEqual([]);
    const first = writes(server)[0]!;
    await dismissResults();
    // An inline result may repeat this number; reselect the actual list row.
    const listRows = rowsOf(main(), items[0]!.out_biz_no).filter(
      (row) => buttons(row, '详情').length === 1,
    );
    expect(listRows).toHaveLength(1);
    const choices = within(listRows[0]!).queryAllByRole('checkbox');
    expect(choices).toHaveLength(1);
    expect(choices[0]).toBeInstanceOf(HTMLInputElement);
    const choice = choices[0] as HTMLInputElement;
    expect(choice.disabled).toBe(false);
    expect(choice.checked).toBe(false);
    await click(choice);
    expect(choice.checked).toBe(true);
    await confirm(server, await open());
    await verify();
    await waitFor(() => expect(writes(server)).toHaveLength(2));
    await settled(server);
    assertRequest(server, items, 2);
    const second = writes(server)[1]!;
    expect(second.body).toEqual(first.body);
    expect(first.headers.get('Idempotency-Key')).toEqual(expect.stringMatching(/^\S+$/));
    expect(second.headers.get('Idempotency-Key')).toEqual(expect.stringMatching(/^\S+$/));
    expect(second.headers.get('Idempotency-Key')).not.toBe(first.headers.get('Idempotency-Key'));
    expect(
      rowsOf(document.body, items[0]!.out_biz_no).filter(
        (row) => within(row).queryAllByText(RESULT_TEXT.approved, { exact: true }).length === 1,
      ),
    ).toHaveLength(1);
  },
);

it(
  '[AC-F1-08ai-PREVIEW#2] 确认框说明全文只有既定后果说明，不追加冻结或封禁会员不能审核通过等说明',
  { timeout: 60_000 },
  async () => {
    const items = pendingRows().slice(0, 2);
    const server = serverFor(items);
    await mount(server);
    await select(items);
    const modal = await open();
    // Read all explanatory text, including separate sibling paragraphs. Remove only
    // the modal title, preview table and controls, never select just the expected sentence.
    const copy = modal.cloneNode(true) as HTMLElement;
    const titles = (modal.getAttribute('aria-labelledby') ?? '').split(/\s+/);
    for (const node of copy.querySelectorAll<HTMLElement>('[id]')) {
      if (titles.includes(node.id)) node.remove();
    }
    for (const node of copy.querySelectorAll('table, [role="table"], button, [role="button"]'))
      node.remove();
    expect(copy.textContent?.trim()).toBe(CONSEQUENCE);
    expect(server.writes()).toEqual([]);
  },
);

it(
  '[AC-F1-08ai-PREVIEW#3] 受阻待审单可与正常待审单同时勾选，预览分别写明阻断跳过与将通过，提交仍携带全部编号',
  { timeout: 60_000 },
  async () => {
    const items = pendingRows().slice(0, 2);
    items[0]!.blocked_reason = 'NEGATIVE_BALANCE';
    const server = serverFor(items);
    const results: ResultItem[] = [
      { withdrawal_id: items[0]!.withdrawal_id, result: 'skipped', reason: 'blocked' },
      { withdrawal_id: items[1]!.withdrawal_id, result: 'approved', reason: null },
    ];
    server.once('POST', APPROVE, () => {
      server.state[1]!.status = 'APPROVED';
      return ok({ items: results });
    });
    await mount(server);
    expect(checkbox(items[0]!).checked).toBe(false);
    await select([...items].reverse());
    const modal = await open();
    const blocked = rowOf(modal, items[0]!.out_biz_no);
    const normal = rowOf(modal, items[1]!.out_biz_no);
    const blockedCells = within(blocked).queryAllByRole('cell');
    const normalCells = within(normal).queryAllByRole('cell');
    expect(blockedCells).toHaveLength(4);
    expect(normalCells).toHaveLength(4);
    expect(blockedCells[3]!.textContent).toBe(RESULT_TEXT.blocked);
    expect(within(blocked).queryAllByText('将通过', { exact: true })).toEqual([]);
    expect(normalCells[3]!.textContent).toBe('将通过');
    expect(server.writes()).toEqual([]);
    await confirm(server, modal);
    await verify();
    await waitFor(() => expect(writes(server)).toHaveLength(1));
    await settled(server);
    assertRequest(server, items);
    for (const [index, text] of [RESULT_TEXT.blocked, RESULT_TEXT.approved].entries()) {
      expect(
        rowsOf(document.body, items[index]!.out_biz_no).filter(
          (row) => within(row).queryAllByText(text, { exact: true }).length === 1,
        ),
      ).toHaveLength(1);
    }
  },
);
