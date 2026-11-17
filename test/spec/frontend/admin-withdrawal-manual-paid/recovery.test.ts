// @vitest-environment jsdom
import { cleanup, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  MANUAL,
  REASONS,
  VERIFY,
  approvedRows,
  assertReplay,
  assertRequest,
  button,
  click,
  confirm,
  dialogs,
  disabled,
  failure,
  field,
  fill,
  fillRows,
  inputs,
  main,
  mount,
  notice,
  ok,
  open,
  paid,
  reply,
  retry,
  rowOf,
  select,
  serverFor,
  settled,
  stepDialogs,
  unknown,
  verify,
  writes,
} from './helpers.ts';

it(
  '[AC-F1-08al-UNKNOWN#1] 首次已生效但网络断开，原始输入锁定；重验后原键原字节请求重放确定结果',
  { timeout: 60_000 },
  async () => {
    const rows = approvedRows(2);
    const server = serverFor(rows);
    const results = paid(rows);
    server.once('POST', MANUAL, () => {
      reply(server, results);
      throw new Error('response lost');
    });
    server.once('POST', MANUAL, () => ok({ items: results }));
    await mount(server);
    await select(rows);
    const modal = await open();
    const body = await fillRows(modal, rows);
    const original = inputs(modal).map((input) => input.value);
    await confirm(server, modal);
    await verify();
    await settled(server);
    await unknown(modal);
    assertRequest(server, body);
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
    expect(inputs(modal).map((input) => input.value)).toEqual(original);
    const reads = server.reads().length;
    await retry(server, modal);
    assertReplay(server, body, 2);
    await notice('已录入 2 张，跳过 0 张', modal);
    expect(within(modal).queryAllByText('上次提交结果未知', { exact: true })).toEqual([]);
    await waitFor(() => expect(server.reads().length).toBeGreaterThan(reads));
    await settled(server);
    expect(disabled(button(modal, '关闭'))).toBe(false);
  },
);

it(
  '[AC-F1-08al-UNKNOWN#2] 无法解析的响应也按未知锁定；去列表核对关闭并刷新，不再发写请求',
  { timeout: 90_000 },
  async () => {
    for (const response of [
      () =>
        new Response('{invalid json', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      () => Response.json({ items: [] }),
    ]) {
      const rows = approvedRows(1);
      const server = serverFor(rows);
      server.once('POST', MANUAL, response);
      await mount(server);
      await select(rows);
      const modal = await open();
      const body = await fillRows(modal, rows);
      await confirm(server, modal);
      await verify();
      await settled(server);
      await unknown(modal);
      assertRequest(server, body);
      const reads = server.reads().length;
      await click(button(modal, '去列表核对'));
      await waitFor(() => expect(dialogs()).toEqual([]));
      await waitFor(() => expect(server.reads().length).toBeGreaterThan(reads));
      await settled(server);
      assertRequest(server, body);
      expect(
        within(main())
          .queryAllByRole('checkbox')
          .filter((node) => (node as HTMLInputElement).checked),
      ).toEqual([]);
      cleanup();
    }
  },
);

it(
  '[AC-F1-08al-UNKNOWN#3] 网络未知后收到带外壳 40901 或 5xx 仍锁定；再试原键原体，已录入项返回 not_approved 如实展示',
  { timeout: 120_000 },
  async () => {
    for (const code of [40901, 50001]) {
      const rows = approvedRows(2);
      const server = serverFor(rows);
      server.once('POST', MANUAL, () => {
        reply(server, paid([rows[0]!]));
        throw new Error('partial response lost');
      });
      server.once('POST', MANUAL, () => failure(code, {}));
      server.once('POST', MANUAL, () =>
        reply(server, [
          { withdrawal_id: rows[0]!.withdrawal_id, result: 'skipped', reason: 'not_approved' },
          ...paid([rows[1]!]),
        ]),
      );
      await mount(server);
      await select(rows);
      const modal = await open();
      const body = await fillRows(modal, rows);
      const original = inputs(modal).map((input) => input.value);
      await confirm(server, modal);
      await verify();
      await settled(server);
      await unknown(modal);
      await retry(server, modal);
      await unknown(modal);
      assertReplay(server, body, 2);
      expect(inputs(modal).map((input) => input.value)).toEqual(original);
      expect(server.requests('POST', VERIFY)).toHaveLength(2);
      await retry(server, modal);
      assertReplay(server, body, 3);
      await notice('已录入 1 张，跳过 1 张', modal);
      await notice(REASONS.not_approved, rowOf(modal, rows[0]!.out_biz_no));
      await notice('已录入', rowOf(modal, rows[1]!.out_biz_no));
      expect(within(modal).queryAllByText('上次提交结果未知', { exact: true })).toEqual([]);
      cleanup();
    }
  },
);

it(
  '[AC-F1-08al-UNKNOWN#4] 首次即带外壳的在途 40901 或部分失败 5xx 也不能解锁改写或自动重发',
  { timeout: 90_000 },
  async () => {
    for (const code of [40901, 50001]) {
      const rows = approvedRows(1);
      const server = serverFor(rows);
      server.once('POST', MANUAL, () => failure(code, {}));
      server.once('POST', MANUAL, () => reply(server, paid(rows)));
      await mount(server);
      await select(rows);
      const modal = await open();
      const body = await fillRows(modal, rows);
      await confirm(server, modal);
      await verify();
      await settled(server);
      await unknown(modal);
      assertRequest(server, body);
      await retry(server, modal);
      assertReplay(server, body, 2);
      await notice('已录入 1 张，跳过 0 张', modal);
      cleanup();
    }
  },
);

it(
  '[AC-F1-08al-REAUTH#1] 10003 重新动态码且验证前不重发；直接拒绝或未知后重验均沿用原键原体',
  { timeout: 90_000 },
  async () => {
    for (const loseFirst of [false, true]) {
      const rows = approvedRows(2);
      const server = serverFor(rows);
      if (loseFirst)
        server.once('POST', MANUAL, () => {
          throw new Error('response lost');
        });
      server.once('POST', MANUAL, () => failure(10003, { tier: 'totp' }));
      server.once('POST', MANUAL, () => reply(server, paid(rows)));
      await mount(server);
      await select(rows);
      const modal = await open();
      const body = await fillRows(modal, rows);
      await confirm(server, modal);
      await verify();
      await settled(server);
      if (loseFirst) {
        await unknown(modal);
        await retry(server, modal);
      }
      await waitFor(() => expect(stepDialogs()).toHaveLength(1));
      await notice('动态码凭证已失效，请重新输入动态码');
      const before = loseFirst ? 2 : 1;
      assertReplay(server, body, before);
      expect(inputs(modal).map((input) => disabled(input))).toEqual(inputs(modal).map(() => true));
      await verify();
      await settled(server);
      assertReplay(server, body, before + 1);
      await notice('已录入 2 张，跳过 0 张', modal);
      cleanup();
    }
  },
);

it(
  '[AC-F1-08al-ERROR#1] 确定的 10403 与 20001 展示全文、解锁且不自动重发；新提交换键',
  { timeout: 180_000 },
  async () => {
    for (const loseFirst of [false, true])
      for (const scenario of [
        {
          code: 10403,
          data: { reason: 'admin_permission_denied' },
          text: '无权限执行此操作（需要 payout.manual_entry 权限点）',
        },
        { code: 20001, data: { fields: ['items'] }, text: '提交内容有误，请检查后重试' },
        {
          code: 20001,
          data: { fields: ['items[0].paid_fen'] },
          text: '提交内容有误，请检查后重试',
        },
      ]) {
        const rows = approvedRows(1);
        const server = serverFor(rows);
        if (loseFirst)
          server.once('POST', MANUAL, () => {
            throw new Error('response lost');
          });
        server.once('POST', MANUAL, () => failure(scenario.code, scenario.data));
        server.once('POST', MANUAL, () => reply(server, paid(rows)));
        await mount(server);
        await select(rows);
        const modal = await open();
        const body = await fillRows(modal, rows);
        await confirm(server, modal);
        await verify();
        await settled(server);
        if (loseFirst) {
          await unknown(modal);
          await retry(server, modal);
        }
        const before = loseFirst ? 2 : 1;
        await notice(scenario.text);
        await settled(server);
        assertReplay(server, body, before);
        expect(within(modal).queryAllByText('上次提交结果未知', { exact: true })).toEqual([]);
        expect(inputs(modal).map((input) => disabled(input))).toEqual([false, false, false]);
        expect(disabled(button(modal, '确认录入'))).toBe(false);
        expect(within(document.body).queryAllByText('已录入', { exact: true })).toEqual([]);
        expect(document.querySelectorAll('.ant-message-success')).toHaveLength(0);
        await fill(field(rowOf(modal, rows[0]!.out_biz_no), '通道流水号'), 'Corrected-Serial');
        body.items[0]!.channel_order_id = 'Corrected-Serial';
        await confirm(server, modal);
        await verify();
        await notice('已录入 1 张，跳过 0 张', modal);
        await settled(server);
        assertRequest(server, body, before + 1);
        expect(writes(server).at(-1)!.headers.get('Idempotency-Key')).not.toBe(
          writes(server)[0]!.headers.get('Idempotency-Key'),
        );
        cleanup();
      }
  },
);
