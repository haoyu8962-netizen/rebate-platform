// Unit tests of the sync status bar reads (F1-07edb): only the latest read reaches the bar, an
// accepted manual sync reads once more, and a failed refresh shows the failed line.
import { expect, it } from 'vitest';
import type { SyncItem, SyncOutcome, SyncPage } from './model.ts';
import { refreshesSyncBar, syncBarReader, type SyncBarState } from './sync-bar.ts';

interface Pending {
  readonly resolve: (page: SyncPage) => void;
  readonly reject: (cause: unknown) => void;
}

/** A reader whose reads are answered by hand, in any order. */
function harness() {
  const reads: Pending[] = [];
  const shown: SyncBarState[] = [];
  const reader = syncBarReader(
    () =>
      new Promise<SyncPage>((resolve, reject) => {
        reads.push({ resolve, reject });
      }),
    (state) => shown.push(state),
  );
  return { reads, shown, reader };
}

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
  expect(shown).toEqual([{ status: 'ready', item: DONE }]);

  // An earlier read failing late does not replace the latest answer either.
  reader.load();
  reader.load();
  reads[3]!.resolve(pageOf(JD));
  await flush();
  reads[2]!.reject(new Error('503'));
  await flush();
  expect(shown).toEqual([
    { status: 'ready', item: DONE },
    { status: 'ready', item: JD },
  ]);

  // An earlier read answering while the latest is still out does not reach the bar.
  reader.load();
  reader.load();
  reads[4]!.resolve(pageOf(QUEUED));
  await flush();
  expect(shown).toHaveLength(2);
  reads[5]!.resolve(pageOf());
  await flush();
  expect(shown.at(-1)).toEqual({ status: 'ready', item: undefined });

  // After stop (the bar is gone) nothing reaches it.
  reader.load();
  reader.stop();
  reads[6]!.resolve(pageOf(JD));
  await flush();
  expect(shown).toHaveLength(3);
});

it('[AC-F1-07edb-UNIT#4] 手动同步提交成功（新建或复用）后状态条只再读一次；其余结果不读', async () => {
  const accepted: SyncOutcome[] = [{ kind: 'created' }, { kind: 'reused' }];
  const refused: SyncOutcome[] = [
    { kind: 'paused', platform: 'pdd' },
    { kind: 'forbidden' },
    { kind: 'rateLimited' },
    { kind: 'fields', fields: ['from'] },
    { kind: 'network' },
    { kind: 'failed' },
  ];
  for (const outcome of accepted) expect(refreshesSyncBar(outcome), outcome.kind).toBe(true);
  for (const outcome of refused) expect(refreshesSyncBar(outcome), outcome.kind).toBe(false);

  // First load: one read; one accepted submit: exactly one more, whose answer is what is shown.
  const { reads, shown, reader } = harness();
  reader.load();
  reads[0]!.resolve(pageOf(QUEUED));
  await flush();
  reader.load();
  expect(reads).toHaveLength(2);
  reads[1]!.resolve(pageOf(JD));
  await flush();
  expect(shown).toEqual([
    { status: 'ready', item: QUEUED },
    { status: 'ready', item: JD },
  ]);
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
  expect(second.shown.at(-1)).toEqual({ status: 'ready', item: JD });
});
