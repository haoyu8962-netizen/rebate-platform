// @vitest-environment jsdom
// F1-08fa 按 UID 查询（任务依据摘录 第 2、3 条）：user_id 必填；【查询】读资金摘要
// （adminGetUserFundSummary）与流水第 1 页（adminListLedgerEntries，page_size 20 ≤ 200），请求只带
// 契约参数。摘要逐项、流水表逐列按契约字段显示：记账时间（北京时间）、会计日、流水类型与子户
// （后台字典名，缺行显示编码）、子类型（编码，空时「—」）、金额（用户视角带符号，经
// @couli/money）、变动后余额（null 显示「—」而不是 ¥0.00）、凭证号（uniq_key）、业务单号（biz_id）。
import { expect, it } from 'vitest';
import {
  CLAWED,
  COLUMNS,
  COPY,
  ENTRIES,
  FEE,
  PAGE_SIZE,
  PLAIN_UID,
  REWARDED,
  UID,
  createServer,
  rowShown,
  summaryPath,
  summaryShown,
} from './fixtures.ts';
import {
  click,
  control,
  fieldErrors,
  main,
  mountLedger,
  queryUser,
  settled,
  shows,
  summaryPairs,
  tableCount,
  tableRows,
  tableTitles,
  uidForm,
  uidInput,
} from './helpers.ts';

it(
  '[AC-F1-08fa-QUERY#1] UID 为空时【查询】：UID 旁提示「请输入用户 UID」，不发请求',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mountLedger(server);
    await click(control(uidForm(), COPY.query));
    await settled(server);
    expect(fieldErrors(uidInput())).toEqual([COPY.uidRequired]);
    expect(server.log).toEqual([]);
    expect(summaryPairs()).toEqual([]);
    expect(tableCount()).toBe(0);
  },
);

it(
  '[AC-F1-08fa-QUERY#2] 【查询】：恰好一次读资金摘要（路径带 user_id、无查询参数）与一次读流水第 1 页（查询对象只有 user_id、page=1、page_size=20），只发 GET',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mountLedger(server);
    await queryUser(server, UID);
    expect(server.summaryReads().map((read) => [read.path, read.query])).toEqual([
      [summaryPath(UID), {}],
    ]);
    expect(server.ledgerQueries()).toEqual([{ user_id: UID, page: '1', page_size: PAGE_SIZE }]);
    expect(server.writes()).toEqual([]);
    expect(fieldErrors(uidInput())).toEqual([]);
  },
);

it(
  '[AC-F1-08fa-QUERY#3] 资金摘要逐项：用户 UID、可用余额（负数照实 -¥12.00）、冻结金额、负余额起始日、已提现、提现限制（冻结种类按字典名，缺行显示编码，用「、」连接）',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mountLedger(server);
    await queryUser(server, UID);
    expect(summaryPairs()).toEqual(summaryShown(UID));
    expect(summaryShown(UID)[1]).toEqual(['可用余额', '-¥12.00']);
  },
);

it(
  '[AC-F1-08fa-QUERY#4] 无冻结、未转负的摘要：负余额起始日「—」、冻结金额与已提现 ¥0.00、提现限制「无」',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mountLedger(server);
    await queryUser(server, PLAIN_UID);
    expect(summaryPairs()).toEqual(summaryShown(PLAIN_UID));
    expect(summaryShown(PLAIN_UID)).toEqual([
      ['用户 UID', PLAIN_UID],
      ['可用余额', '¥12.00'],
      ['冻结金额', '¥0.00'],
      ['负余额起始日', '—'],
      ['已提现', '¥0.00'],
      ['提现限制', '无'],
    ]);
  },
);

it(
  '[AC-F1-08fa-QUERY#5] 流水表表头恰为九列，行按返回顺序，每格整串等于契约字段的显示值',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mountLedger(server);
    await queryUser(server, UID);
    expect(tableTitles()).toEqual(COLUMNS);
    expect(tableRows()).toEqual(ENTRIES.map(rowShown));
  },
);

it(
  '[AC-F1-08fa-QUERY#6] 金额与余额的写法：扣回 -¥1,234.56 与余额 -¥12.00 照实为负；0 元手续费金额 ¥0.00、余额 0 显示 ¥0.00；余额未记录（null）显示「—」；子类型为空显示「—」；UTC 记账时间换成北京时间',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mountLedger(server);
    await queryUser(server, UID);
    const rows = tableRows();
    const clawed = rows[ENTRIES.indexOf(CLAWED)]!;
    expect(clawed[0]).toBe('2026-11-06 09:15:30');
    expect(clawed[3]).toBe('PART_REFUND');
    expect(clawed[5]).toBe('-¥1,234.56');
    expect(clawed[6]).toBe('-¥12.00');
    const fee = rows[ENTRIES.indexOf(FEE)]!;
    expect(fee[3]).toBe(COPY.dash);
    expect(fee[5]).toBe('¥0.00');
    expect(fee[6]).toBe('¥0.00');
    const rewarded = rows[ENTRIES.indexOf(REWARDED)]!;
    expect(rewarded[5]).toBe('+¥8.00');
    expect(rewarded[6]).toBe(COPY.dash);
    expect(rows.at(-1)![0]).toBe('2026-11-01 00:30:05');
    expect(rows.at(-1)![5]).toBe('+¥0.61');
  },
);

it(
  '[AC-F1-08fa-QUERY#7] 没有流水的用户：摘要照常显示，表格位置显示「暂无余额流水」，没有数据行',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mountLedger(server);
    await queryUser(server, PLAIN_UID);
    expect(server.ledgerQueries()).toEqual([
      { user_id: PLAIN_UID, page: '1', page_size: PAGE_SIZE },
    ]);
    expect(summaryPairs()).toEqual(summaryShown(PLAIN_UID));
    expect(shows(main(), COPY.empty), COPY.empty).toBe(true);
    expect(tableRows()).toEqual([]);
  },
);
