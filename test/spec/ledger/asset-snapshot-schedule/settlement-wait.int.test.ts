// B2-04zo：写完后 getAssetSnapshotStatus 为 complete，结算批次的等待解除（BR-FUND-18、BR-FUND-04 ⑦）。全走真实 worker
// 入口：批次由入口注册在 settle 队列上的处理器执行，端口是 app.module 接的真实 snapshotStatus，测试不注入状态。
// 用例全部是顶层 it（资金测试路径，规划/11 §4.3）。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { getAssetSnapshotStatus } from '../../../../apps/api/src/modules/ledger/index.ts';
import { existingSnapshot } from '../asset-snapshot/kit.ts';
import { batchRow, receivedJob, seedBatch } from '../../settlement/worker/kit.ts';
import {
  APP,
  TIMEOUT,
  afterMidnight,
  comparable,
  inWorkerTime,
  ledgerApp,
  runAt,
  setConfig,
  snapshotRows,
} from './kit.ts';

const YESTERDAY = '2032-07-23';
const SNAPSHOT_DAY = '2032-07-24';

it(
  '[AC-B2-04zo#24] 到点前批次等快照（snapshot_pending，状态 pending）；tick 写完后状态 complete，同一批次经真实端口执行到 DONE',
  async () => {
    await inWorkerTime(createTestDatabase, async ({ db, withWorker }) => {
      await ledgerApp(db, APP);
      await existingSnapshot(db, APP, YESTERDAY);
      await setConfig(db, APP, 'credit.enabled.taobao', true);
      const batchId = await seedBatch(db, APP, { status: 'CONFIRMED' });

      await withWorker({ now: afterMidnight(SNAPSHOT_DAY, '00:30') }, async (worker) => {
        const settle = worker.queue.registered.find((item) => item.queue === 'settle');
        expect(settle, 'the worker entry registered no settle handler').toBeDefined();
        const execute = () =>
          settle!.handler(receivedJob('batch_execute', { app_id: APP, batch_id: batchId }));
        const status = () =>
          getAssetSnapshotStatus(db, { appId: APP, accountingDate: SNAPSHOT_DAY }, worker.clock);

        await worker.quiet();
        expect(await status()).toEqual({
          state: 'pending',
          snapshotId: null,
          waitingComparable: null,
        });
        await execute();
        expect((await batchRow(db, batchId)).status).toBe('CONFIRMED');

        worker.clock.set(runAt(SNAPSHOT_DAY));
        expect(
          await worker.tickUntil(() => comparable(db, APP, SNAPSHOT_DAY)),
          'the day the batch waits for was not written',
        ).toBe(true);
        const row = (await snapshotRows(db, APP)).at(-1);
        expect(await status()).toEqual({
          state: 'complete',
          snapshotId: row?.id,
          waitingComparable: true,
        });
        await execute();
        expect((await batchRow(db, batchId)).status).toBe('DONE');
      });
    });
  },
  TIMEOUT,
);
