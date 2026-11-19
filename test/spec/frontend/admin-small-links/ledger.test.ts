// @vitest-environment jsdom
// F1-08fe ① 用户摘要卡【查看用户详情】跳用户详情；② 余额流水页从地址 /ledger?user_id=…&ref=… 预填「用户 UID」
// 与「业务单号」并照常查询（只改读取查询参数的部分）。只加导航：不发写请求。
import { expect, it } from 'vitest';
import {
  FEE,
  FREED,
  FROZE,
  FUND_VIEW,
  PAGE_SIZE,
  SUPER,
  UID,
  createServer,
  rowShown,
  summaryPath,
} from '../admin-ledger-readonly/fixtures.ts';
import { COPY, userPath } from './fixtures.ts';
import {
  click,
  control,
  filterField,
  landedOn,
  mountLedger,
  nonGets,
  queryUser,
  settle,
  settled,
  summaryCard,
  tableRows,
  uidInput,
  waitGet,
} from './ledger-helpers.ts';

const FLOW = { timeout: 90_000 };

it(
  '[AC-F1-08fe-USER#1] 资金摘要卡里有【查看用户详情】：点开进 /users 并读该用户详情（GET /admin/v1/users/{user_id}），不发写请求',
  FLOW,
  async () => {
    const server = createServer();
    await mountLedger(server, SUPER);
    await queryUser(server, UID);
    await click(control(summaryCard(), COPY.viewUser));
    await settle();
    await landedOn('/users');
    await waitGet(server, userPath(UID));
    expect(nonGets(server)).toEqual([]);
  },
);

it(
  '[AC-F1-08fe-PREFILL#1] 直达 /ledger?user_id=…&ref=…：「用户 UID」与「业务单号」预填，进页就读一次资金摘要与一次流水（user_id + ref，第 1 页），只列该业务单号的分录',
  FLOW,
  async () => {
    const server = createServer();
    const ref = FROZE.voucher.biz_id;
    await mountLedger(server, FUND_VIEW, `/ledger?user_id=${UID}&ref=${ref}`);
    await settled(server);
    await settle();
    expect(server.ledgerQueries()).toEqual([
      { user_id: UID, ref, page: '1', page_size: PAGE_SIZE },
    ]);
    expect(server.summaryReads().map((request) => request.path)).toEqual([summaryPath(UID)]);
    expect(uidInput().value).toBe(UID);
    expect(filterField('业务单号').value).toBe(ref);
    expect(tableRows()).toEqual([FROZE, FREED, FEE].map(rowShown));
    expect(nonGets(server)).toEqual([]);
  },
);

it(
  '[AC-F1-08fe-PREFILL#2] 直达 /ledger?user_id=…（不带 ref）：只预填「用户 UID」，流水按该用户第 1 页读、不带 ref，「业务单号」为空',
  FLOW,
  async () => {
    const server = createServer();
    await mountLedger(server, FUND_VIEW, `/ledger?user_id=${UID}`);
    await settled(server);
    await settle();
    expect(server.ledgerQueries()).toEqual([{ user_id: UID, page: '1', page_size: PAGE_SIZE }]);
    expect(server.summaryReads().map((request) => request.path)).toEqual([summaryPath(UID)]);
    expect(uidInput().value).toBe(UID);
    expect(filterField('业务单号').value).toBe('');
  },
);
