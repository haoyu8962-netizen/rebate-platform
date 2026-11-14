// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  APPROVE,
  RESULT_TEXT,
  VERIFY,
  assertRequest,
  button,
  buttons,
  checkbox,
  click,
  confirm,
  dialogs,
  main,
  mount,
  notice,
  ok,
  open,
  pendingRows,
  rowsOf,
  select,
  serverFor,
  settled,
  stepDialogs,
  succeed,
  verify,
  writes,
  type ResultItem,
} from './helpers.ts';

it(
  '[AC-F1-08ai-ERROR#4] 网络错误后保留勾选与确认框，手动重提同批沿用原幂等标识及请求体，返回后逐单显示结果',
  { timeout: 60_000 },
  async () => {
    const items = pendingRows().slice(0, 2);
    const server = serverFor(items);
    const results: ResultItem[] = [
      { withdrawal_id: items[0]!.withdrawal_id, result: 'approved', reason: null },
      { withdrawal_id: items[1]!.withdrawal_id, result: 'skipped', reason: 'blocked' },
    ];
    server.once('POST', APPROVE, () => {
      throw new Error('simulated network disconnect');
    });
    server.once('POST', APPROVE, () => {
      succeed(server, items.slice(0, 1));
      return ok({ items: results });
    });
    await mount(server);
    await select(items);
    await confirm(server, await open());
    await verify();
    await notice('网络错误，请检查网络后重试；未确认前不会重复提交');
    await settled(server);
    assertRequest(server, items);
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
    expect(stepDialogs()).toEqual([]);
    expect(dialogs()).toHaveLength(1);
    for (const item of items) {
      expect(checkbox(item).checked).toBe(true);
      expect(rowsOf(dialogs()[0]!, item.out_biz_no)).toHaveLength(1);
    }
    const first = writes(server)[0]!;
    const reads = server.reads().length;
    await click(button(dialogs()[0]!, '确认通过'));
    // A manual replay may reuse the valid credential or request another dynamic code.
    await waitFor(() =>
      expect(writes(server).length === 2 || stepDialogs().length === 1).toBe(true),
    );
    if (stepDialogs().length === 1) await verify();
    await waitFor(() => expect(writes(server)).toHaveLength(2));
    await waitFor(() => expect(server.reads().length).toBeGreaterThan(reads));
    await settled(server);
    expect(writes(server)).toHaveLength(2);
    const second = writes(server)[1]!;
    expect(second.method).toBe('POST');
    expect(second.path).toBe(APPROVE);
    expect(second.query).toEqual({});
    expect(second.body).toEqual({ withdrawal_ids: items.map((item) => item.withdrawal_id) });
    expect(second.body).toEqual(first.body);
    expect(first.headers.get('Idempotency-Key')).toEqual(expect.stringMatching(/^\S+$/));
    expect(second.headers.get('Idempotency-Key')).toEqual(expect.stringMatching(/^\S+$/));
    expect(second.headers.get('Idempotency-Key')).toBe(first.headers.get('Idempotency-Key'));
    const verifications = server.requests('POST', VERIFY);
    expect(verifications.length === 1 || verifications.length === 2).toBe(true);
    expect(verifications.map((request) => request.body)).toEqual(
      Array.from({ length: verifications.length }, () => ({ tier: 'totp', code: '123456' })),
    );
    expect(second.headers.get('Authorization')).toBe('Bearer example-admin-token');
    expect(second.headers.get('X-Step-Up-Token')).toBe(`batch-pass-${verifications.length}`);
    for (const [index, text] of [RESULT_TEXT.approved, RESULT_TEXT.blocked].entries()) {
      expect(
        rowsOf(document.body, items[index]!.out_biz_no).filter(
          (row) => within(row).queryAllByText(text, { exact: true }).length === 1,
        ),
      ).toHaveLength(1);
    }
    expect(buttons(main(), '批量通过')).toEqual([]);
    expect(
      Array.from(main().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).filter(
        (node) => node.checked,
      ),
    ).toEqual([]);
  },
);
