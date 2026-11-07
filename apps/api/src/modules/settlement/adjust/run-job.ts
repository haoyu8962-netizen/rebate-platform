// B2-09zb (D10-769 / D10-770): one `settle_adjust` run of (app, platform, D) on queue settle — the
// scheduled run after D's bill run is done, or finance's manual trigger (adminRunSettleAdjust).
// settle_jobs keeps one row per (app, 'settle_adjust', platform, settleBillRunAt(D)), written only
// through bill/settle-job.ts (running → done; a failed row is run again on the same row):
// - a new key: the row is claimed `running` in a transaction held open while the generator runs
//   (its orders commit one by one in their own transactions) and completed `done` in it, so a
//   worker that dies mid-run leaves no `running` row behind and a redelivery runs again;
// - a concurrent delivery of the same key waits on the unique key and then sees the done row;
// - a done row (a redelivery, or a manual trigger of a day already run): the generator runs again
//   without touching the row — it writes only for orders whose current record has no candidate of
//   the current version yet, so a redelivery writes nothing;
// - a failure: the claim rolls back and the key is recorded `failed` (failSettleJob).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import { claimSettleJob, completeSettleJob, failSettleJob } from '../bill/settle-job.ts';
import type { SettleAdjustGenerator, SettleAdjustRunResult } from './generate.ts';

const JOB = 'settle_adjust';

export interface SettleAdjustJobInput {
  readonly appId: string;
  readonly platform: string;
  /** The +08:00 bill day D (YYYY-MM-DD). */
  readonly accountingDate: string;
  /** D 00:00 +08:00, the settle_jobs run_at of the key. */
  readonly runAt: Date;
}

export interface SettleAdjustJobResult {
  /** 'claimed': the key's row went running → done; 'rerun': the row was already done. */
  readonly outcome: 'claimed' | 'rerun';
  readonly run: SettleAdjustRunResult;
}

export interface SettleAdjustJob {
  run(input: SettleAdjustJobInput): Promise<SettleAdjustJobResult>;
}

export interface SettleAdjustJobDependencies {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly generator: Pick<SettleAdjustGenerator, 'run'>;
}

export function createSettleAdjustJob(deps: SettleAdjustJobDependencies): SettleAdjustJob {
  const { db, clock, generator } = deps;
  return {
    async run(input) {
      const key = { appId: input.appId, job: JOB, platform: input.platform, runAt: input.runAt };
      const generatorInput = {
        appId: input.appId,
        platform: input.platform,
        accountingDate: input.accountingDate,
      };
      try {
        return await db.transaction().execute(async (trx): Promise<SettleAdjustJobResult> => {
          const jobId = await claimSettleJob(trx, key, clock.now());
          const run = await generator.run(generatorInput);
          if (jobId === null) return { outcome: 'rerun', run };
          await completeSettleJob(trx, jobId, clock.now(), run.orders, 0);
          return { outcome: 'claimed', run };
        });
      } catch (error: unknown) {
        await failSettleJob(db, key, clock.now());
        throw error;
      }
    },
  };
}
