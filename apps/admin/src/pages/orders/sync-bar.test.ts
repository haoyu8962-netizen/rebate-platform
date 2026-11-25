// Unit tests of the sync status bar reads (F1-07edb): only the latest read reaches the bar, each
// 【刷新】 reads exactly once more, a failed refresh shows the failed line, and 「更新于」 is the
// 24-hour Beijing time of the moment the read succeeded.
import { expect, it } from 'vitest';
import type { SyncItem, SyncPage } from './model.ts';
import { syncBarReader, syncBarUpdated, type SyncBarState } from './sync-bar.ts';

interface Pending {
  readonly resolve: (page: SyncPage) => void;
  readonly reject: (cause: unknown) => void;
}

/** A reader whose reads are answered by hand, in any order. */
function harness() {
  const reads: Pending[] = [];
  const shown: SyncBarState[] = [];
  const clock = { ms: Date.parse(READ_AT) };
  const reader = syncBarReader(
    () =>
      new Promise<SyncPage>((resolve, reject) => {
        reads.push({ resolve, reject });
      }),
    (state) => shown.push(state),
    () => clock.ms,
  );
  return { reads, shown, reader, clock };
}

const READ_AT = '2026-11-25T02:03:04.000Z';
const ready = (item: SyncItem | undefined, readAt = READ_AT): SyncBarState => ({
  status: 'ready',
  item,
  readAt,
});

const item = (platform: string, status: string, createdAt: string) =>
  ({ platform, status, created_at: createdAt }) as unknown as SyncItem;
const pageOf = (...items: SyncItem[]) => ({ items }) as unknown as SyncPage;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const QUEUED = item('pdd', 'queued', '2026-10-31T10:00:00+08:00');
const DONE = item('pdd', 'done', '2026-10-31T10:00:00+08:00');
const JD = item('jd', 'done', '2026-10-31T10:05:00+08:00');

it('[AC-F1-07edb-UNIT#3] 状态条请求带递增序号：较早发出的响应晚到（成功或失败）一律丢弃，只显示最新一次', async () => {
  const { reads, shown, reader } = harness();
  reader.load();
  reader.load();
  expect(reads).toHaveLength(2);
  // The latest read answers first; the earlier one's late answer is dropped.
  reads[1]!.resolve(pageOf(DONE));
  await flush();
  reads[0]!.resolve(pageOf(QUEUED));
  await flush();
  expect(shown).toEqual([ready(DONE)]);

  // An earlier read failing late does not replace the latest answer either.
  reader.load();
  reader.load();
  reads[3]!.resolve(pageOf(JD));
  await flush();
  reads[2]!.reject(new Error('503'));
  await flush();
  expect(shown).toEqual([ready(DONE), ready(JD)]);

  // An earlier read answering while the latest is still out does not reach the bar.
  reader.load();
  reader.load();
  reads[4]!.resolve(pageOf(QUEUED));
  await flush();
  expect(shown).toHaveLength(2);
  reads[5]!.resolve(pageOf());
  await flush();
  expect(shown.at(-1)).toEqual(ready(undefined));

  // After stop (the bar is gone) nothing reaches it.
  reader.load();
  reader.stop();
  reads[6]!.resolve(pageOf(JD));
  await flush();
  expect(shown).toHaveLength(3);
});

it('[AC-F1-07edb-UNIT#4] 首次加载读一次；每点一次【刷新】恰好再读一次，显示新应答与新的读取时刻', async () => {
  const { reads, shown, reader, clock } = harness();
  reader.load();
  expect(reads).toHaveLength(1);
  reads[0]!.resolve(pageOf(QUEUED));
  await flush();
  expect(shown).toEqual([ready(QUEUED)]);

  // One click: exactly one more read; its answer and its arrival time replace what was shown.
  reader.load();
  expect(reads).toHaveLength(2);
  clock.ms = Date.parse('2026-11-25T06:30:00Z');
  reads[1]!.resolve(pageOf(JD));
  await flush();
  expect(reads).toHaveLength(2);
  expect(shown).toEqual([ready(QUEUED), ready(JD, '2026-11-25T06:30:00.000Z')]);
});

it('[AC-F1-07edb-UNIT#6] 「更新于」是读取成功那一刻的北京时间 24 小时制：下午不回绕到 12 点以内，跨零点进到次日', async () => {
  expect(syncBarUpdated('2026-11-25T06:30:00Z')).toBe('14:30:00');
  expect(syncBarUpdated('2026-11-25T16:05:06Z')).toBe('00:05:06');
  expect(syncBarUpdated('2026-11-25T15:59:59Z')).toBe('23:59:59');
  expect(syncBarUpdated('2026-11-25T04:00:00Z')).toBe('12:00:00');

  // The time is taken when the answer arrives, not when the read was sent.
  const { reads, shown, reader, clock } = harness();
  clock.ms = Date.parse('2026-11-25T03:00:00Z');
  reader.load();
  clock.ms = Date.parse('2026-11-25T16:05:06Z');
  reads[0]!.resolve(pageOf(DONE));
  await flush();
  expect(shown).toEqual([ready(DONE, '2026-11-25T16:05:06.000Z')]);
  const last = shown[0]!;
  expect(last.status === 'ready' ? syncBarUpdated(last.readAt) : '').toBe('00:05:06');
});

it('[AC-F1-07edb-UNIT#5] 刷新失败显示「同步状态读取失败」，不保留之前读到的记录；初次读失败后刷新成功则显示新记录', async () => {
  const { reads, shown, reader } = harness();
  reader.load();
  reads[0]!.resolve(pageOf(QUEUED));
  await flush();
  reader.load();
  reads[1]!.reject(new Error('503'));
  await flush();
  expect(shown.at(-1)).toEqual({ status: 'failed' });

  const second = harness();
  second.reader.load();
  second.reads[0]!.reject(new Error('503'));
  await flush();
  expect(second.shown).toEqual([{ status: 'failed' }]);
  second.reader.load();
  second.reads[1]!.resolve(pageOf(JD));
  await flush();
  expect(second.shown.at(-1)).toEqual(ready(JD));
});
