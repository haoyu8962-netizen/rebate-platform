// B2-06f: the payout process's runtime (规划/08 BR-WDR-13, BR-WDR-14). PayoutModule.forPayout
// provides it under payoutRuntimeToken() on the payout entry only (null without a database or job
// queue). entry.ts resolves PAYOUT_MODE first (payout-mode.ts, the only guard), then resolves the
// token optionally (as the worker's order sync) and calls start(decision) once, before the queue
// starts: start registers the one handler of queue `payout` (jobs `transfer` and `release` →
// jobs/transfer-job.ts, job `query` → jobs/query-job.ts; the BR-WDR-13 ③ member review and the
// persisted pause are the worker's, D10-398) over the process's handle, the injected Clock and content's
// configuration reader (switches read straight from PG, no Redis), with the channels of the
// decision: dry_run → FakeChannel (never the network), live → AlipayChannel with the injected
// credentials. start trusts the decision it is given; neither it nor its logs carry a credential.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { Ledger } from '../ledger/index.ts';
import type { Clock, EventBus, QueueRuntime, ReceivedJob } from '../platform/index.ts';
import { defaultPayoutChannelConfig } from './application/judgement.ts';
import { createQueryRecovery } from './application/query-recovery.ts';
import {
  startQueryRecoveryWorker,
  type QueryRecoveryWorker,
} from './application/query-recovery-worker.ts';
import type { WithdrawApplyOptions } from './application/withdraw-apply.ts';
import type { PayoutConfigPort } from './application/withdraw-rules.ts';
import type { DecryptWithdrawalAccount } from './application/withdrawal-reads.ts';
import { AlipayChannel } from './infra/channels/alipay-channel.ts';
import { BankCardChannel } from './infra/channels/bank-card-channel.ts';
import { FakeChannel } from './infra/channels/fake-channel.ts';
import type { PayoutChannel, PayoutChannelName } from './infra/channels/payout-channel.ts';
import { WechatChannel } from './infra/channels/wechat-channel.ts';
import { createQueryJob } from './jobs/query-job.ts';
import {
  PAYOUT_QUERY_JOB,
  PAYOUT_QUEUE,
  PAYOUT_RELEASE_JOB,
  PAYOUT_TRANSFER_JOB,
  createTransferJob,
} from './jobs/transfer-job.ts';
import type { PayoutMode, PayoutModeDecision } from './payout-mode.ts';

export interface PayoutStarted {
  readonly mode: PayoutMode;
  /** The adapter of each channel the handlers can call. */
  readonly channels: Readonly<Partial<Record<PayoutChannelName, PayoutChannel>>>;
}

export interface PayoutRuntime {
  /** Registers queue `payout`; called once, before the queue starts. */
  start(decision: PayoutModeDecision): PayoutStarted;
  /**
   * B2-06i: starts the query chain's crash recovery (at once, then every hour, BR-WDR-14). Once,
   * after start and after the queue started: the rounds enqueue jobs. Any PAYOUT_MODE.
   */
  startRecovery(): QueryRecoveryWorker;
}

const PAYOUT_RUNTIME = Symbol('PAYOUT_RUNTIME');

/** The DI token of the payout process's runtime; the same symbol on every call. */
export function payoutRuntimeToken(): symbol {
  return PAYOUT_RUNTIME;
}

// The adapters' constructed lists and scene are only fallbacks: the transfer and query jobs read
// payout.definite_fail_codes / payer_side_codes / query_status_map and payout.biz_scene of the
// withdrawal's app from PG on every call and hand them to AlipayChannel (ChannelJudgement; an
// unset biz_scene keeps this scene name). FakeChannel (dry_run) judges with its constructed lists.
const TRANSFER_SCENE_NAME = '佣金报酬';

/** The process's handles and ports (PayoutModule.forPayout resolves them). */
export interface PayoutRuntimeOptions {
  /** The process handle (couli_payout): withdrawals reads and W9, payout_attempts, jobs. */
  readonly db: Kysely<DB>;
  readonly queue: QueueRuntime;
  readonly eventBus: EventBus;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly config: PayoutConfigPort;
  readonly ledger: Ledger;
  readonly lockUsersForUpdate: WithdrawApplyOptions['lockUsersForUpdate'];
  readonly decryptPayee: DecryptWithdrawalAccount;
}

function channelsOf(
  decision: PayoutModeDecision,
  clock: Clock,
  logger: Logger,
): Readonly<Partial<Record<PayoutChannelName, PayoutChannel>>> {
  const defaults = defaultPayoutChannelConfig();
  const lists = {
    definiteFailCodes: defaults.definiteFailCodes,
    payerSideCodes: defaults.payerSideCodes,
    queryStatusMap: defaults.queryStatusMap,
  };
  const alipay: PayoutChannel =
    decision.mode === 'live'
      ? new AlipayChannel({
          credentials: { ...decision.credentials },
          bizScene: TRANSFER_SCENE_NAME,
          lists,
          clock,
          logger: logger.child({ channel: 'alipay' }),
        })
      : new FakeChannel({ mode: 'dry_run', lists, script: {} });
  // bank_card and wechat stay in their closed state (BR-WDR-32 / BR-WDR-33).
  return Object.freeze({
    alipay,
    bank_card: new BankCardChannel(),
    wechat: new WechatChannel(),
  });
}

export function createPayoutRuntime(options: PayoutRuntimeOptions): PayoutRuntime {
  let started = false;
  let recoveryStarted = false;
  return {
    startRecovery() {
      if (!started) throw new Error('payout runtime: recovery before start');
      if (recoveryStarted) throw new Error('payout runtime: recovery already started');
      recoveryStarted = true;
      const { db, queue, clock, logger, config } = options;
      const recovery = createQueryRecovery({ attemptsDb: db, config, queue, logger });
      return startQueryRecoveryWorker({ recovery, db, clock, logger });
    },
    start(decision) {
      if (started) throw new Error('payout runtime: already started');
      started = true;
      const { db, queue, eventBus, clock, logger, config, ledger, lockUsersForUpdate } = options;
      const channels = channelsOf(decision, clock, logger);
      const transfer = createTransferJob({
        db,
        attemptsDb: db,
        clock,
        config,
        queue,
        eventBus,
        channels,
        decryptPayee: options.decryptPayee,
        logger,
      });
      const query = createQueryJob({
        db,
        attemptsDb: db,
        clock,
        config,
        ledger,
        lockUsersForUpdate,
        queue,
        eventBus,
        channels,
        logger,
      });
      queue.register(PAYOUT_QUEUE, async (job: ReceivedJob): Promise<void> => {
        if (job.name === PAYOUT_TRANSFER_JOB || job.name === PAYOUT_RELEASE_JOB)
          return transfer(job);
        if (job.name === PAYOUT_QUERY_JOB) return query(job);
        logger.warn({ job_id: job.id, queue: job.queue, name: job.name }, 'payout_job_unknown');
      });
      // Mode and channel names only: never a credential.
      logger.info(
        { payout_mode: decision.mode, channels: Object.keys(channels) },
        'payout_runtime_started',
      );
      return { mode: decision.mode, channels };
    },
  };
}
