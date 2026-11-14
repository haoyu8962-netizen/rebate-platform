// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  NAME,
  QUERY,
  RESOLVE,
  STATUS_SHOWN,
  TEXT,
  VERIFY,
  WID,
  absent,
  assertEntries,
  assertNoEntries,
  assertNoOtherActions,
  assertStillPaying,
  assertWrite,
  button,
  click,
  confirm,
  dialogs,
  disabled,
  endedElsewhere,
  failure,
  fillPaid,
  idemOf,
  main,
  mount,
  notice,
  openResolve,
  queries,
  querySubmitted,
  refreshed,
  resolvedPaid,
  resolves,
  serverFor,
  settled,
  shown,
  startQuery,
  step,
  stepDialogs,
  verify,
  writes,
} from './helpers.ts';

it(
  '[AC-F1-08aj-QUERY#1] 【立即查询】先弹动态码，验证后只发一次 POST …/query（请求体 {}、X-Step-Up-Token、Idempotency-Key），提示已提交查询并重新读取详情；即使通道已答成功，页面仍是打款中、不报成功，入口仍在',
  { timeout: 60_000 },
  async () => {
    const server = serverFor();
    server.once('POST', QUERY, () => {
      // The job may already have run: its answer is only one more attempt, never a status.
      server.state[0]!.payout_attempts.push({
        attempt_id: 'a2000008-0000-4000-8000-000000000003',
        kind: 'query',
        result: 'success',
        resp_code: '10000',
        resp_sub_code: null,
        at: '2026-11-14T10:00:01+08:00',
      });
      return querySubmitted();
    });
    await mount(server);
    const before = server.detailReads(WID).length;
    await startQuery(server);
    await verify();
    await waitFor(() => expect(queries(server)).toHaveLength(1));
    await notice(TEXT.querySubmitted);
    await refreshed(server, before);
    expect(writes(server)).toHaveLength(1);
    assertWrite(server, queries(server)[0]!, QUERY, {});
    expect(server.log.indexOf(server.detailReads(WID).at(-1)!)).toBeGreaterThan(
      server.log.indexOf(queries(server)[0]!),
    );
    expect(stepDialogs()).toEqual([]);
    assertStillPaying();
    assertEntries();
    assertNoOtherActions();
  },
);

it(
  '[AC-F1-08aj-QUERY#2] 连点【立即查询】与验证只发一次；在途时入口禁用、再点不发；结束后再点是新的查询：重新要动态码、换新的 Idempotency-Key',
  { timeout: 60_000 },
  async () => {
    const server = serverFor();
    const release = server.hold('POST', QUERY, () => querySubmitted());
    server.once('POST', QUERY, () => querySubmitted());
    await mount(server);
    try {
      await startQuery(server, true);
      await verify(true);
      await waitFor(() => expect(queries(server)).toHaveLength(1));
      await waitFor(() => expect(disabled(button(main(), NAME.query))).toBe(true));
      await click(button(main(), NAME.query), true);
      expect(stepDialogs()).toEqual([]);
      expect(queries(server)).toHaveLength(1);
      expect(server.requests('POST', VERIFY)).toHaveLength(1);
    } finally {
      release();
    }
    await settled(server);
    await notice(TEXT.querySubmitted);
    await waitFor(() => expect(disabled(button(main(), NAME.query))).toBe(false));
    await startQuery(server);
    await verify();
    await waitFor(() => expect(queries(server)).toHaveLength(2));
    await settled(server);
    const [first, second] = queries(server);
    assertWrite(server, first!, QUERY, {});
    assertWrite(server, second!, QUERY, {});
    expect(first!.headers.get('X-Step-Up-Token')).toBe('unknown-pass-1');
    expect(second!.headers.get('X-Step-Up-Token')).toBe('unknown-pass-2');
    expect(idemOf(second!)).not.toBe(idemOf(first!));
    expect(server.requests('POST', VERIFY)).toHaveLength(2);
    assertStillPaying();
  },
);

it(
  '[AC-F1-08aj-QUERY#3] 查询被拒或未确认：10403 无权限、20001 无此单、20901 / 40901 提交失败、网络错误未确认；只发一次、不自动重发，不提示已提交，仍是打款中',
  { timeout: 120_000 },
  async () => {
    const cases = [
      { code: 10403, data: { reason: 'admin_permission_denied' }, text: TEXT.forbidden },
      { code: 20001, data: { fields: ['withdrawal_id'] }, text: TEXT.missing },
      { code: 20901, data: {}, text: TEXT.failed },
      { code: 40901, data: {}, text: TEXT.failed },
      { code: null, data: {}, text: TEXT.network },
    ];
    for (const one of cases) {
      const server = serverFor();
      server.once('POST', QUERY, () => {
        if (one.code === null) throw new Error('simulated network disconnect');
        return failure(one.code, one.data);
      });
      await mount(server);
      await startQuery(server);
      await verify();
      await notice(one.text);
      await settled(server);
      expect(queries(server)).toHaveLength(1);
      expect(writes(server)).toHaveLength(1);
      expect(server.requests('POST', VERIFY)).toHaveLength(1);
      assertWrite(server, queries(server)[0]!, QUERY, {});
      absent(TEXT.querySubmitted);
      assertStillPaying();
      cleanup();
    }
  },
);

it(
  '[AC-F1-08aj-QUERY#4] 查询返回 10003：重新要动态码，验证前不重发；验证后用新凭证、原 Idempotency-Key 与原请求体再发一次',
  { timeout: 60_000 },
  async () => {
    const server = serverFor();
    server.once('POST', QUERY, () => failure(10003, { tier: 'totp' }));
    server.once('POST', QUERY, () => querySubmitted());
    await mount(server);
    await startQuery(server);
    await verify();
    await waitFor(() => expect(queries(server)).toHaveLength(1));
    await step();
    await notice(TEXT.stepAgain);
    await settled(server);
    expect(queries(server)).toHaveLength(1);
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
    await verify();
    await waitFor(() => expect(queries(server)).toHaveLength(2));
    await notice(TEXT.querySubmitted);
    await settled(server);
    const [first, second] = queries(server);
    assertWrite(server, first!, QUERY, {});
    assertWrite(server, second!, QUERY, {});
    expect(first!.headers.get('X-Step-Up-Token')).toBe('unknown-pass-1');
    expect(second!.headers.get('X-Step-Up-Token')).toBe('unknown-pass-2');
    expect(idemOf(second!)).toBe(idemOf(first!));
    assertStillPaying();
  },
);

it(
  '[AC-F1-08aj-QUERY#5] 查询返回 20902：提示状态已变化并重新读取详情，不重发；刷新为接口打款成功后入口消失',
  { timeout: 60_000 },
  async () => {
    const server = serverFor();
    server.once('POST', QUERY, () => {
      endedElsewhere(server);
      return failure(20902, { resource: 'withdrawal' });
    });
    await mount(server);
    const before = server.detailReads(WID).length;
    await startQuery(server);
    await verify();
    await notice(TEXT.changed);
    await refreshed(server, before);
    await waitFor(() => expect(shown(main(), STATUS_SHOWN.PAID_API)).toBeGreaterThan(0));
    assertNoEntries('after 20902');
    expect(queries(server)).toHaveLength(1);
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
    absent(TEXT.querySubmitted);
  },
);

it(
  '[AC-F1-08aj-QUERY#6] 取消动态码不发查询，焦点回【立即查询】；再按仍须重新验证',
  { timeout: 60_000 },
  async () => {
    const server = serverFor();
    await mount(server);
    const entry = await startQuery(server);
    await click(button(await step(), NAME.cancel));
    await waitFor(() => expect(stepDialogs()).toEqual([]));
    await waitFor(() => expect(document.activeElement).toBe(entry));
    expect(server.writes()).toEqual([]);
    await startQuery(server);
    expect(server.requests('POST', VERIFY)).toEqual([]);
    expect(server.writes()).toEqual([]);
  },
);

it(
  '[AC-F1-08aj-QUERY#7] 查询成功后再做人工处置是新操作：重新要动态码，处置请求用新的 Idempotency-Key，不沿用查询的凭证',
  { timeout: 60_000 },
  async () => {
    const server = serverFor();
    server.once('POST', QUERY, () => querySubmitted());
    server.once('POST', RESOLVE, (request) => resolvedPaid(server, request));
    await mount(server);
    await startQuery(server);
    await verify();
    await notice(TEXT.querySubmitted);
    await settled(server);
    await waitFor(() => expect(dialogs()).toEqual([]));
    const dialog = await openResolve();
    await fillPaid(dialog);
    await confirm(server, dialog);
    expect(resolves(server)).toEqual([]);
    await verify();
    await waitFor(() => expect(resolves(server)).toHaveLength(1));
    await settled(server);
    const query = queries(server)[0]!;
    const resolve = resolves(server)[0]!;
    expect(query.headers.get('X-Step-Up-Token')).toBe('unknown-pass-1');
    expect(resolve.headers.get('X-Step-Up-Token')).toBe('unknown-pass-2');
    expect(idemOf(resolve)).toEqual(expect.stringMatching(/^\S+$/));
    expect(idemOf(resolve)).not.toBe(idemOf(query));
    expect(server.requests('POST', VERIFY)).toHaveLength(2);
  },
);
