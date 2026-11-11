// @vitest-environment jsdom
// F1-15b: filters of the record subpage map to the query of adminListInviteRewards — invitee_id,
// inviter_id, status (contract enum) and the +08:00 calendar days qualified_from / qualified_to
// (both inclusive); empty filters are left out; paging sends page / page_size and keeps the
// filters; a new filter starts again at page 1. A start day later than the end day is never
// listed: no request, or the 20001 field error is shown.
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  BOTH_SKIPPED,
  INVITER,
  OTHER_INVITER,
  PROCESSED,
  QUALIFIED,
  VOIDED,
  createRewardServer,
  manyRewards,
} from './fixtures.ts';
import {
  SUBPAGE,
  firstPageSize,
  lastQuery,
  listQueries,
  listed,
  mountAt,
  nextPage,
  pickStatus,
  rowsWith,
  settled,
  submitFilters,
  typeInvitee,
  typeInviter,
  typeRange,
} from './helpers.ts';

it(
  '[AC-F1-15b-FILTER#1] 按被邀请人与状态（作废）查询：请求带 invitee_id 与 status=voided、回第 1 页，只列出该条',
  { timeout: 40_000 },
  async () => {
    const server = createRewardServer();
    await mountAt(server, SUBPAGE);
    await listed(PROCESSED.invitee_phone_masked);
    const size = firstPageSize(server);
    await typeInvitee(VOIDED.invitee_id);
    await pickStatus(/作废/);
    await submitFilters();
    await waitFor(() =>
      expect(lastQuery(server)).toEqual({
        page: '1',
        page_size: size,
        invitee_id: VOIDED.invitee_id,
        status: 'voided',
      }),
    );
    await listed(VOIDED.invitee_phone_masked);
    await waitFor(() => expect(rowsWith(PROCESSED.invitee_phone_masked)).toEqual([]));
  },
);

it(
  '[AC-F1-15b-FILTER#2] 按邀请人查询：请求只带 inviter_id，列出该邀请人的记录',
  { timeout: 40_000 },
  async () => {
    const server = createRewardServer();
    await mountAt(server, SUBPAGE);
    await listed(PROCESSED.invitee_phone_masked);
    const size = firstPageSize(server);
    await typeInviter(OTHER_INVITER);
    await submitFilters();
    await waitFor(() =>
      expect(lastQuery(server)).toEqual({ page: '1', page_size: size, inviter_id: OTHER_INVITER }),
    );
    await listed(BOTH_SKIPPED.invitee_phone_masked);
    await waitFor(() => expect(rowsWith(PROCESSED.invitee_phone_masked)).toEqual([]));
  },
);

it(
  '[AC-F1-15b-FILTER#3] 按取得资格日期起止查询：发 qualified_from / qualified_to 日历日（含两端）',
  { timeout: 40_000 },
  async () => {
    const server = createRewardServer();
    await mountAt(server, SUBPAGE);
    await listed(PROCESSED.invitee_phone_masked);
    const size = firstPageSize(server);
    await typeRange('2026-10-19', '2026-10-20');
    await submitFilters();
    await waitFor(() =>
      expect(lastQuery(server)).toEqual({
        page: '1',
        page_size: size,
        qualified_from: '2026-10-19',
        qualified_to: '2026-10-20',
      }),
    );
    await listed(QUALIFIED.invitee_phone_masked);
    await listed(PROCESSED.invitee_phone_masked);
    await waitFor(() => expect(rowsWith(VOIDED.invitee_phone_masked)).toEqual([]));
    expect(rowsWith(BOTH_SKIPPED.invitee_phone_masked)).toEqual([]);
  },
);

it(
  '[AC-F1-15b-FILTER#4] 起日晚于止日：不发该请求或显示 20001 字段错误，总有提示，不自动重发',
  { timeout: 40_000 },
  async () => {
    const server = createRewardServer();
    await mountAt(server, SUBPAGE);
    await listed(PROCESSED.invitee_phone_masked);
    await typeRange('2026-10-21', '2026-10-19');
    await submitFilters();
    await settled(server);
    await waitFor(() =>
      expect(document.body.textContent ?? '').toMatch(
        /晚于|早于|不能大于|不能小于|不能晚|不能早|起止|日期范围|有误|无效|参数/,
      ),
    );
    const inverted = listQueries(server).filter(
      (query) => query['qualified_from'] === '2026-10-21',
    );
    // The server refuses such a query (20001); the page never sends it again on its own.
    expect(inverted.length).toBeLessThanOrEqual(1);
  },
);

it(
  '[AC-F1-15b-FILTER#5] 翻页带 page=2 与原筛选，改筛选后回第 1 页',
  { timeout: 60_000 },
  async () => {
    const records = manyRewards(205);
    const server = createRewardServer({ records });
    await mountAt(server, SUBPAGE);
    await listed(records[0]!.invitee_phone_masked);
    const size = firstPageSize(server);
    await pickStatus(/顺延/);
    await submitFilters();
    await waitFor(() =>
      expect(lastQuery(server)).toEqual({ page: '1', page_size: size, status: 'deferred' }),
    );
    await settled(server);
    await nextPage();
    await waitFor(() =>
      expect(lastQuery(server)).toEqual({ page: '2', page_size: size, status: 'deferred' }),
    );
    await settled(server);
    await typeInviter(INVITER);
    await submitFilters();
    await waitFor(() =>
      expect(lastQuery(server)).toEqual({
        page: '1',
        page_size: size,
        status: 'deferred',
        inviter_id: INVITER,
      }),
    );
  },
);
