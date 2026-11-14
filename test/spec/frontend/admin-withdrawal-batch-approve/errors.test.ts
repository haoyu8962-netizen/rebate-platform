// @vitest-environment jsdom
import { cleanup, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  APPROVE,
  VERIFY,
  assertRequest,
  buttons,
  confirm,
  failure,
  main,
  mount,
  notice,
  open,
  pendingRows,
  select,
  serverFor,
  settled,
  step,
  succeed,
  verify,
  writes,
} from './helpers.ts';

it(
  '[AC-F1-08ai-ERROR#1] 10003 重新索要动态码，验证前不重发；验证后更新凭据且沿用原幂等标识与整批请求体',
  { timeout: 60_000 },
  async () => {
    const items = pendingRows().slice(0, 2);
    const server = serverFor(items);
    server.once('POST', APPROVE, () => failure(10003, { tier: 'totp' }));
    server.once('POST', APPROVE, () => succeed(server, items));
    await mount(server);
    await select(items);
    const modal = await open();
    await confirm(server, modal);
    await verify();
    await waitFor(() => expect(writes(server)).toHaveLength(1));
    await step();
    await notice('动态码凭证已失效，请重新输入动态码');
    await settled(server);
    assertRequest(server, items);
    const first = writes(server)[0]!;
    const reads = server.reads().length;
    await verify();
    await waitFor(() => expect(writes(server)).toHaveLength(2));
    await waitFor(() => expect(server.reads().length).toBeGreaterThan(reads));
    await settled(server);
    assertRequest(server, items, 2);
    expect(writes(server)[1]!.headers.get('Idempotency-Key')).toBe(
      first.headers.get('Idempotency-Key'),
    );
    expect(first.headers.get('X-Step-Up-Token')).toBe('batch-pass-1');
    expect(writes(server)[1]!.body).toEqual(first.body);
    expect(buttons(main(), '批量通过')).toEqual([]);
  },
);

it(
  '[AC-F1-08ai-ERROR#2] 10403 完整提示缺审核权限，20001 按 data.fields 区分编号错误和普通输入错误；不报成功、不重发',
  { timeout: 90_000 },
  async () => {
    for (const scenario of [
      {
        code: 10403,
        data: { reason: 'admin_permission_denied' },
        message: '无权限执行此操作（需要 withdraw.review 权限点）',
      },
      {
        code: 20001,
        data: { fields: ['withdrawal_ids'] },
        message: '提现单编号有误，请刷新页面后重试',
      },
      {
        code: 20001,
        data: { fields: [] },
        message: '提交内容有误，请检查后重试',
      },
    ]) {
      const items = pendingRows().slice(0, 2);
      const server = serverFor(items);
      server.once('POST', APPROVE, () => failure(scenario.code, scenario.data));
      await mount(server);
      await select(items);
      const modal = await open();
      await confirm(server, modal);
      await verify();
      await notice(scenario.message);
      await settled(server);
      assertRequest(server, items);
      expect(server.requests('POST', VERIFY)).toHaveLength(1);
      // No successful row message or success toast may be inferred from an HTTP error.
      expect(within(document.body).queryAllByText('已通过', { exact: true })).toEqual([]);
      expect(
        within(document.body).queryAllByText('已审核通过，待执行打款', { exact: true }),
      ).toEqual([]);
      cleanup();
    }
  },
);

it(
  '[AC-F1-08ai-ERROR#3] 20901 与 40901 提示提交失败，网络错误明确提示未确认不重复提交，均不自动重新验证或重发整批',
  { timeout: 90_000 },
  async () => {
    for (const scenario of [
      { code: 20901, message: '提交失败，请稍后重试' },
      { code: 40901, message: '提交失败，请稍后重试' },
      { code: null, message: '网络错误，请检查网络后重试；未确认前不会重复提交' },
    ]) {
      const items = pendingRows().slice(0, 2);
      const server = serverFor(items);
      server.once('POST', APPROVE, () => {
        if (scenario.code === null) throw new Error('simulated network disconnect');
        return failure(scenario.code, {});
      });
      await mount(server);
      await select(items);
      const modal = await open();
      await confirm(server, modal);
      await verify();
      await notice(scenario.message);
      await settled(server);
      assertRequest(server, items);
      expect(server.requests('POST', VERIFY)).toHaveLength(1);
      cleanup();
    }
  },
);
