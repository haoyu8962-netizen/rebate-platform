// Unit tests of the rescan position gauge's rendering (B1-01zzr): no database, a fake collect.
import { describe, expect, it } from 'vitest';
import type { WorkerCollection, WorkerMetricsSnapshot } from './collect.ts';
import { createMetricsRegistry } from './registry.ts';
import { NON_SYNC_QUERY_KINDS } from './rescan-position.ts';

const BARE: WorkerMetricsSnapshot = {
  queueFailed: {},
  deadLetters: {},
  backlog: {},
  oldestDueEvtAgeSeconds: {},
  syncWatermarkLagSeconds: { taobao: 250 },
};

const NAME = 'couli_sync_rescan_position_seconds';

function sampleLines(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith(`${NAME}{`) || line.startsWith(`${NAME} `));
}

describe('couli_sync_rescan_position_seconds', () => {
  it('[AC-B1-01zzr#3] worker 渲染每组回扫位置，标签为 app_id / platform / query_kind', async () => {
    const collection: WorkerCollection = {
      ...BARE,
      rescanPositionSeconds: [
        { appId: 'couli', platform: 'jd', queryKind: 'rescan', seconds: 50_000 },
        { appId: 'couli-other', platform: 'taobao', queryKind: 'rescan', seconds: 0 },
      ],
    };
    const text = await createMetricsRegistry({
      entry: 'worker',
      collect: () => Promise.resolve(collection),
    }).render();
    expect(text).toContain(`# TYPE ${NAME} gauge\n`);
    expect(sampleLines(text)).toEqual([
      `${NAME}{app_id="couli",platform="jd",query_kind="rescan"} 50000`,
      `${NAME}{app_id="couli-other",platform="taobao",query_kind="rescan"} 0`,
    ]);
    expect(text).toContain('couli_sync_watermark_lag_seconds{platform="taobao"} 250\n');
  });

  it('[AC-B1-01zzr#4] 不带回扫位置的快照或空列表没有回扫序列', async () => {
    for (const snapshot of [BARE, { ...BARE, rescanPositionSeconds: [] }]) {
      const text = await createMetricsRegistry({
        entry: 'worker',
        collect: () => Promise.resolve(snapshot),
      }).render();
      expect(sampleLines(text)).toEqual([]);
    }
  });

  it('[AC-B1-01zzr#5] 非 worker 入口不出回扫位置 gauge', async () => {
    for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
      const text = await createMetricsRegistry({
        entry,
        collect: () =>
          Promise.resolve({
            ...BARE,
            rescanPositionSeconds: [
              { appId: 'couli', platform: 'jd', queryKind: 'rescan', seconds: 1 },
            ],
          }),
      }).render();
      expect(text, entry).not.toContain(NAME);
    }
  });

  it('[AC-B1-01zzr#2] 排除表是 rescan / rights / manual', () => {
    expect([...NON_SYNC_QUERY_KINDS].sort()).toEqual(['manual', 'rescan', 'rights']);
  });
});
