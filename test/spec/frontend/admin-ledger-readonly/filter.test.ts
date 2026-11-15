// @vitest-environment jsdom
// F1-08fa 筛选与分页（任务依据摘录 第 3 条）：查过一个用户后出现筛选表单——流水类型、子类型、
// 子户、会计日起止、业务单号（契约 ref，凭证 biz_id 精确）——及其【查询】【重置】；请求只用契约
// 参数，查询对象整个比对。会计日起晚于止：本地提示「会计日起不能晚于会计日止」且不发请求（依据：
// 契约对此只回 20001 data.fields=[accounting_date_from, accounting_date_to]，页面先拦，选本地
// 提示一支）。分页：第 2 页带同样的筛选与 page=2，page_size 不变。
import { expect, it } from 'vitest';
import {
  CLAWED,
  COPY,
  ENTRIES,
  FEE,
  FILTER_LABEL,
  FREED,
  FROZE,
  MANY_TOTAL,
  MANY_UID,
  PAGE_SIZE,
  UID,
  createServer,
  manyEntries,
  rowShown,
  subAccountName,
  typeName,
} from './fixtures.ts';
import {
  applyFilters,
  choose,
  fieldErrors,
  fillDay,
  filterField,
  filterForm,
  mountLedger,
  nextPage,
  queryUser,
  resetFilters,
  tableRows,
  typeInto,
} from './helpers.ts';

const BASE = { user_id: UID, page: '1', page_size: PAGE_SIZE } as const;

it(
  '[AC-F1-08fa-FILTER#1] 六个筛选都填后【查询】：只读流水（不重读摘要），查询对象恰为 user_id、ledger_type、sub_type、sub_account、会计日起止、ref、page=1、page_size=20，表格只列命中的那条',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mountLedger(server);
    await queryUser(server, UID);
    const form = filterForm();
    await choose(form, FILTER_LABEL.ledgerType, typeName('CLAWBACK'));
    await typeInto(filterField(FILTER_LABEL.subType), 'PART_REFUND');
    await choose(form, FILTER_LABEL.subAccount, subAccountName('available'));
    await fillDay(filterField(FILTER_LABEL.dateFrom), '2026-11-01');
    await fillDay(filterField(FILTER_LABEL.dateTo), '2026-11-06');
    await typeInto(filterField(FILTER_LABEL.ref), CLAWED.voucher.biz_id);
    await applyFilters(server);
    expect(server.summaryReads()).toHaveLength(1);
    expect(server.ledgerQueries()).toEqual([
      BASE,
      {
        user_id: UID,
        ledger_type: 'CLAWBACK',
        sub_type: 'PART_REFUND',
        sub_account: 'available',
        accounting_date_from: '2026-11-01',
        accounting_date_to: '2026-11-06',
        ref: CLAWED.voucher.biz_id,
        page: '1',
        page_size: PAGE_SIZE,
      },
    ]);
    expect(tableRows()).toEqual([rowShown(CLAWED)]);
    expect(server.writes()).toEqual([]);
  },
);

it(
  '[AC-F1-08fa-FILTER#2] 只按子户「冻结」筛：查询对象只多 sub_account=frozen，空着的筛选不带参数',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mountLedger(server);
    await queryUser(server, UID);
    await choose(filterForm(), FILTER_LABEL.subAccount, subAccountName('frozen'));
    await applyFilters(server);
    expect(server.ledgerQueries()).toEqual([BASE, { ...BASE, sub_account: 'frozen' }]);
    expect(ENTRIES.filter((entry) => entry.sub_account === 'frozen')).toEqual([FROZE, FEE]);
    expect(tableRows()).toEqual([rowShown(FROZE), rowShown(FEE)]);
  },
);

it(
  '[AC-F1-08fa-FILTER#3] 【重置】清空全部筛选并重读第 1 页（查询对象回到只有 user_id、page、page_size），再【查询】也不带旧筛选',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mountLedger(server);
    await queryUser(server, UID);
    await choose(filterForm(), FILTER_LABEL.ledgerType, typeName('WITHDRAW_FREEZE'));
    await typeInto(filterField(FILTER_LABEL.ref), FROZE.voucher.biz_id);
    await applyFilters(server);
    expect(server.ledgerQueries().at(-1)).toEqual({
      ...BASE,
      ledger_type: 'WITHDRAW_FREEZE',
      ref: FROZE.voucher.biz_id,
    });
    expect(tableRows()).toEqual([rowShown(FROZE), rowShown(FREED)]);
    await resetFilters(server);
    expect(server.ledgerQueries().at(-1)).toEqual(BASE);
    expect(filterField(FILTER_LABEL.ref).value).toBe('');
    expect(filterField(FILTER_LABEL.subType).value).toBe('');
    expect(tableRows()).toEqual(ENTRIES.map(rowShown));
    await applyFilters(server);
    expect(server.ledgerQueries()).toHaveLength(4);
    expect(server.ledgerQueries().at(-1)).toEqual(BASE);
  },
);

it(
  '[AC-F1-08fa-FILTER#4] 会计日起晚于止：【查询】时在会计日字段旁提示「会计日起不能晚于会计日止」，不发请求，表格保持原样',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mountLedger(server);
    await queryUser(server, UID);
    await fillDay(filterField(FILTER_LABEL.dateFrom), '2026-11-06');
    await fillDay(filterField(FILTER_LABEL.dateTo), '2026-11-01');
    await applyFilters(server);
    expect(server.ledgerQueries()).toEqual([BASE]);
    expect([
      ...fieldErrors(filterField(FILTER_LABEL.dateFrom)),
      ...fieldErrors(filterField(FILTER_LABEL.dateTo)),
    ]).toEqual([COPY.dateRange]);
    expect(tableRows()).toEqual(ENTRIES.map(rowShown));
  },
);

it(
  '[AC-F1-08fa-FILTER#5] 分页：25 条时第 1 页列 20 条；点「下一页」读 page=2（page_size 不变），列剩下 5 条',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mountLedger(server);
    await queryUser(server, MANY_UID);
    const all = manyEntries(MANY_TOTAL);
    expect(tableRows()).toEqual(all.slice(0, 20).map(rowShown));
    await nextPage(server);
    expect(server.ledgerQueries()).toEqual([
      { user_id: MANY_UID, page: '1', page_size: PAGE_SIZE },
      { user_id: MANY_UID, page: '2', page_size: PAGE_SIZE },
    ]);
    expect(tableRows()).toEqual(all.slice(20).map(rowShown));
  },
);

it(
  '[AC-F1-08fa-FILTER#6] 带筛选翻页：第 2 页沿用已查询的筛选；改筛选再【查询】回到第 1 页',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mountLedger(server);
    await queryUser(server, MANY_UID);
    await choose(filterForm(), FILTER_LABEL.ledgerType, typeName('REBATE_CREDIT'));
    await applyFilters(server);
    await nextPage(server);
    const filtered = { user_id: MANY_UID, ledger_type: 'REBATE_CREDIT', page_size: PAGE_SIZE };
    expect(server.ledgerQueries()).toEqual([
      { user_id: MANY_UID, page: '1', page_size: PAGE_SIZE },
      { ...filtered, page: '1' },
      { ...filtered, page: '2' },
    ]);
    await choose(filterForm(), FILTER_LABEL.subAccount, subAccountName('available'));
    await applyFilters(server);
    expect(server.ledgerQueries().at(-1)).toEqual({
      ...filtered,
      sub_account: 'available',
      page: '1',
    });
    expect(tableRows()).toEqual(manyEntries(MANY_TOTAL).slice(0, 20).map(rowShown));
  },
);
