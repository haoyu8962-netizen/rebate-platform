// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  PLATFORM_NAME,
  RECORD,
  SYNCS,
  WINDOW_END,
  createServer,
  networkDown,
  statusName,
} from './fixtures.ts';
import {
  EMPTY,
  FAILED,
  FLOW_TIMEOUT,
  click,
  freshAll,
  mountList,
  openRecords,
  rowsWith,
  settled,
  snapshotText,
  squash,
  usable,
} from './helpers.ts';

/** The records list request carries only the contract's page parameters. */
function assertPageQuery(query: Record<string, string>): void {
  expect(Object.keys(query).filter((name) => name !== 'page' && name !== 'page_size')).toEqual([]);
  if (query['page'] !== undefined) expect(query['page']).toBe('1');
  if (query['page_size'] !== undefined) {
    const size = Number(query['page_size']);
    expect(Number.isInteger(size) && size >= 1 && size <= 200).toBe(true);
  }
}

/** Waits for the one visible row of the sample `kind` and checks what it shows. */
async function checkRow(kind: keyof typeof RECORD): Promise<void> {
  const sample = RECORD[kind];
  await waitFor(() => expect(rowsWith(sample.marker), `record row ${kind}`).toHaveLength(1));
  const text = squash(rowsWith(sample.marker)[0]!.textContent);
  expect(text, `status of ${kind}`).toContain(squash(statusName(sample.status)));
  expect(text, `platform of ${kind}`).toMatch(PLATFORM_NAME[sample.platform]);
  expect(text, `Beijing creation time of ${kind}`).toContain(squash(sample.created));
  expect(text).not.toMatch(/undefined|null|NaN|Invalid/);
}

it(
  '[AC-F1-07eb-RECORDS#1] 点【同步记录】后才另发同步记录列表请求 GET /admin/v1/order-syncs（只带 page / page_size，状态条初次加载那一次不算），列出状态中文名（字典，缺键显示编码）、平台、单号或北京时间时间窗、北京创建时间',
  async () => {
    const { server } = await mountList();
    const initialQueries = server.recordReads().map(({ query }) => query);
    expect(initialQueries).toEqual([{ page: '1', page_size: '1' }]);
    const dialogReads = () => server.recordReads().slice(1);
    await openRecords();
    await waitFor(() => expect(dialogReads()).toHaveLength(1));
    await settled(server);
    assertPageQuery(dialogReads()[0]!.query);
    expect(dialogReads()[0]!.headers.get('Authorization')).toBe('Bearer example-admin-token');
    await checkRow('queued');
    await checkRow('done');
    await checkRow('running');
    await checkRow('failed');
    // The window rows show both ends in Beijing time (each end is on a later day than its start,
    // so its date shows either way).
    expect(squash(rowsWith(RECORD.running.marker)[0]!.textContent)).toContain(
      squash(WINDOW_END.running),
    );
    expect(squash(rowsWith(RECORD.failed.marker)[0]!.textContent)).toContain(
      squash(WINDOW_END.failed),
    );
    expect(dialogReads()).toHaveLength(1);
    expect(server.posts()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07eb-RECORDS#2] 没有同步记录时显示空态',
  async () => {
    const server = createServer({ records: [] });
    await mountList(server);
    const initialQueries = server.recordReads().map(({ query }) => query);
    expect(initialQueries).toEqual([{ page: '1', page_size: '1' }]);
    const dialogReads = () => server.recordReads().slice(1);
    const before = snapshotText();
    await openRecords();
    await waitFor(() => expect(dialogReads()).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(freshAll(before)).toMatch(EMPTY));
    for (const kind of Object.keys(RECORD) as (keyof typeof RECORD)[])
      expect(rowsWith(RECORD[kind].marker)).toEqual([]);
    expect(dialogReads()).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07eb-RECORDS#3] 同步记录读取失败显示可重试的出错态，重试只多一个列表请求并列出记录',
  async () => {
    const { server } = await mountList();
    const initialQueries = server.recordReads().map(({ query }) => query);
    expect(initialQueries).toEqual([{ page: '1', page_size: '1' }]);
    const dialogReads = () => server.recordReads().slice(1);
    server.once('GET', SYNCS, () => networkDown());
    const before = snapshotText();
    await openRecords();
    await waitFor(() => expect(dialogReads()).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(freshAll(before)).toMatch(FAILED));
    expect(rowsWith(RECORD.done.marker)).toEqual([]);
    await waitFor(() =>
      expect(usable(document.body, /^重试$/).length, 'a 【重试】 on the records').toBeGreaterThan(
        0,
      ),
    );
    await click(usable(document.body, /^重试$/)[0]!);
    await waitFor(() => expect(dialogReads()).toHaveLength(2));
    await settled(server);
    assertPageQuery(dialogReads()[1]!.query);
    await checkRow('done');
    expect(dialogReads()).toHaveLength(2);
  },
  FLOW_TIMEOUT,
);
