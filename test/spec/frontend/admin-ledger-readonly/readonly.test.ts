// @vitest-environment jsdom
// F1-08fa 只读（任务依据摘录 第 5 条）：页面上有【导出记录】入口，点击只是跳到导出记录页
// /exports（F1-10j 已有），不发写请求；不出现【导出当前筛选】（隐藏，不置灰，编排 D10-1740）及
// 任何写入口（调账、核销、冲正、充值、转账、编辑、删除等），整页只发 GET。
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { COPY, EXPORTS_ROUTE, UID, createServer } from './fixtures.ts';
import {
  breadcrumb,
  click,
  control,
  controlNames,
  isDisabled,
  main,
  mountLedger,
  queryUser,
  settled,
} from './helpers.ts';

/** Names of controls a read-only ledger page must not offer (any state, hidden not disabled). */
const WRITE_NAME =
  /调账|核销|冲正|红冲|充值|转账|扣款|补发|新增|新建|编辑|修改|删除|作废|保存|提交|确认|审批|批准|冻结余额|解冻/;

function exportNames(): string[] {
  return controlNames(main()).filter((name) => name.includes('导出'));
}

it(
  '[AC-F1-08fa-READONLY#1] 进入时与查过用户后，名字含「导出」的控件都恰好只有【导出记录】一个（没有【导出当前筛选】），且可点',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mountLedger(server);
    expect(exportNames()).toEqual([COPY.exportsEntry]);
    expect(isDisabled(control(main(), COPY.exportsEntry))).toBe(false);
    await queryUser(server, UID);
    expect(exportNames()).toEqual([COPY.exportsEntry]);
    expect(isDisabled(control(main(), COPY.exportsEntry))).toBe(false);
  },
);

it(
  '[AC-F1-08fa-READONLY#2] 点【导出记录】：地址变为 /exports、面包屑「系统 / 操作日志 / 导出记录」，不发任何非 GET 请求，也不重读流水',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mountLedger(server);
    await queryUser(server, UID);
    const reads = server.pageReads().length;
    await click(control(main(), COPY.exportsEntry));
    await waitFor(() => expect(window.location.pathname).toBe(EXPORTS_ROUTE));
    await settled(server);
    expect(breadcrumb()).toEqual(['系统', '操作日志', '导出记录']);
    expect(server.pageReads()).toHaveLength(reads);
    expect(server.writes()).toEqual([]);
  },
);

it(
  '[AC-F1-08fa-READONLY#3] 进入、查询、出数后都没有任何写入口（按钮或链接），整页只发 GET',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mountLedger(server);
    expect(controlNames(main()).filter((name) => WRITE_NAME.test(name))).toEqual([]);
    await queryUser(server, UID);
    expect(controlNames(main()).filter((name) => WRITE_NAME.test(name))).toEqual([]);
    expect(server.writes()).toEqual([]);
    expect(server.log.map((request) => request.method)).toEqual(['GET', 'GET']);
  },
);
