// @vitest-environment jsdom
// F1-08fa 错误与三态（任务依据摘录 第 4 条）：20001 data.fields=[user_id]（用户不存在、格式不对、
// 他 app）在 UID 旁提示「UID 不存在或格式不对」，不显示旧数据；10403 显示无权限；加载中、出错可
// 重试（流水与摘要各自的【重试】只重读失败的那一个，查询对象不变）、空列表。
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ANY_SUMMARY,
  COPY,
  ENTRIES,
  LEDGER,
  MALFORMED_UID,
  PAGE_SIZE,
  UID,
  UNKNOWN_UID,
  createServer,
  denied,
  rejected,
  rowShown,
  summaryPath,
  summaryShown,
  unavailable,
} from './fixtures.ts';
import {
  busy,
  click,
  control,
  controlsNamed,
  fieldErrors,
  main,
  mountLedger,
  queryUser,
  settle,
  settled,
  shows,
  summaryPairs,
  tableCount,
  tableRows,
  typeInto,
  uidForm,
  uidInput,
} from './helpers.ts';

it(
  '[AC-F1-08fa-STATE#1] 未知 UID（20001 data.fields=[user_id]）：UID 旁提示「UID 不存在或格式不对」，不显示摘要与表格',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mountLedger(server);
    await queryUser(server, UNKNOWN_UID);
    expect(server.summaryReads().map((read) => read.path)).toEqual([summaryPath(UNKNOWN_UID)]);
    expect(server.ledgerQueries()).toEqual([
      { user_id: UNKNOWN_UID, page: '1', page_size: PAGE_SIZE },
    ]);
    expect(fieldErrors(uidInput())).toEqual([COPY.uidUnknown]);
    expect(summaryPairs()).toEqual([]);
    expect(tableCount()).toBe(0);
  },
);

it(
  '[AC-F1-08fa-STATE#2] 格式不对的 UID 由契约校验：照样请求，服务端 20001 [user_id] 时 UID 旁同一句提示',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mountLedger(server);
    await queryUser(server, MALFORMED_UID);
    expect(server.summaryReads().map((read) => read.path)).toEqual([summaryPath(MALFORMED_UID)]);
    expect(server.ledgerQueries()).toEqual([
      { user_id: MALFORMED_UID, page: '1', page_size: PAGE_SIZE },
    ]);
    expect(fieldErrors(uidInput())).toEqual([COPY.uidUnknown]);
    expect(summaryPairs()).toEqual([]);
    expect(tableCount()).toBe(0);
  },
);

it(
  '[AC-F1-08fa-STATE#3] 先查到一个用户、再查他 app 的 UID（20001 [user_id]）：旧摘要与旧流水都不再显示，只有 UID 旁的提示',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mountLedger(server);
    await queryUser(server, UID);
    expect(summaryPairs()).toEqual(summaryShown(UID));
    expect(tableRows()).toEqual(ENTRIES.map(rowShown));
    await queryUser(server, UNKNOWN_UID);
    expect(fieldErrors(uidInput())).toEqual([COPY.uidUnknown]);
    expect(summaryPairs()).toEqual([]);
    expect(tableCount()).toBe(0);
    // A good UID afterwards clears the hint and shows that user again.
    await queryUser(server, UID);
    expect(fieldErrors(uidInput())).toEqual([]);
    expect(summaryPairs()).toEqual(summaryShown(UID));
  },
);

it(
  '[AC-F1-08fa-STATE#4] 服务端 10403（权限已撤回）：显示无权限标题与说明，不显示摘要与表格',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    server.always('GET', ANY_SUMMARY, denied);
    server.always('GET', LEDGER, denied);
    await mountLedger(server);
    await queryUser(server, UID);
    expect(shows(main(), COPY.forbiddenTitle), COPY.forbiddenTitle).toBe(true);
    expect(shows(main(), COPY.forbiddenDescription), COPY.forbiddenDescription).toBe(true);
    expect(summaryPairs()).toEqual([]);
    expect(tableCount()).toBe(0);
    expect(server.writes()).toEqual([]);
  },
);

it(
  '[AC-F1-08fa-STATE#5] 加载中：流水请求未返回时显示加载状态、没有数据行，返回后逐行列出',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mountLedger(server);
    const release = server.hold('GET', LEDGER);
    try {
      await typeInto(uidInput(), UID);
      await click(control(uidForm(), COPY.query));
      await waitFor(() => expect(server.ledgerQueries()).toHaveLength(1));
      await settle();
      await waitFor(() => expect(busy(), 'a loading state in the main area').toBe(true));
      expect(tableRows()).toEqual([]);
    } finally {
      release();
    }
    await settled(server);
    await waitFor(() => expect(tableRows()).toEqual(ENTRIES.map(rowShown)));
  },
);

it(
  '[AC-F1-08fa-STATE#6] 流水读取失败：表格位置显示「余额流水加载失败」与一个【重试】，摘要照常；重试只重读流水、查询对象不变，成功后列出',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    server.once('GET', LEDGER, unavailable);
    await mountLedger(server);
    await queryUser(server, UID);
    expect(shows(main(), COPY.ledgerFailed), COPY.ledgerFailed).toBe(true);
    expect(summaryPairs()).toEqual(summaryShown(UID));
    expect(tableRows()).toEqual([]);
    expect(controlsNamed(main(), COPY.retry)).toHaveLength(1);
    await click(control(main(), COPY.retry));
    await settled(server);
    await settle();
    const base = { user_id: UID, page: '1', page_size: PAGE_SIZE };
    expect(server.ledgerQueries()).toEqual([base, base]);
    expect(server.summaryReads()).toHaveLength(1);
    expect(shows(main(), COPY.ledgerFailed)).toBe(false);
    expect(tableRows()).toEqual(ENTRIES.map(rowShown));
  },
);

it(
  '[AC-F1-08fa-STATE#7] 摘要读取失败：显示「资金摘要加载失败」与一个【重试】，流水照常；重试只重读摘要，成功后显示摘要',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    server.once('GET', ANY_SUMMARY, unavailable);
    await mountLedger(server);
    await queryUser(server, UID);
    expect(shows(main(), COPY.summaryFailed), COPY.summaryFailed).toBe(true);
    expect(summaryPairs()).toEqual([]);
    expect(tableRows()).toEqual(ENTRIES.map(rowShown));
    expect(controlsNamed(main(), COPY.retry)).toHaveLength(1);
    await click(control(main(), COPY.retry));
    await settled(server);
    await settle();
    expect(server.summaryReads().map((read) => read.path)).toEqual([
      summaryPath(UID),
      summaryPath(UID),
    ]);
    expect(server.ledgerQueries()).toHaveLength(1);
    expect(shows(main(), COPY.summaryFailed)).toBe(false);
    expect(summaryPairs()).toEqual(summaryShown(UID));
  },
);

it(
  '[AC-F1-08fa-STATE#8] 流水请求单独回 20001 [user_id]（摘要已成功）：也按 UID 提示处理，不显示摘要与表格',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    server.once('GET', LEDGER, () => rejected(['user_id']));
    await mountLedger(server);
    await queryUser(server, UID);
    expect(fieldErrors(uidInput())).toEqual([COPY.uidUnknown]);
    expect(summaryPairs()).toEqual([]);
    expect(tableCount()).toBe(0);
  },
);
