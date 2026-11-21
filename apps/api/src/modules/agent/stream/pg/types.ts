// Public PG run port types; kept separate to avoid dependency cycles.
import type { AgentIntent } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, RootLogger } from '../../../platform/index.ts';
import type {
  Admission,
  AdmissionLimits,
  AdmissionTicket,
  RunOutcome,
  RunReply,
  SettleResult,
} from '../admission/index.ts';
import type {
  RecoverableRunRegistry,
  RunFacts,
  RunRegistry,
  RunTexts,
  TerminalDraft,
  TerminalFrame,
} from '../run/types.ts';
import type { QuotaLimitsSource } from './limits.ts';

export type FinalizeHold = 'stored_frame_invalid' | 'facts_inconsistent';

/**
 * B3-08t · BR-AI-19 细则「运行级字段」, BR-AI-05 细则「上下文块」⑤: what the process that ran the run
 * writes with its terminal state (the F5 UPDATE, same transaction, only while final_event IS NULL).
 * A run finalized by another request (admit's stale-run path, the recovery finalizer) has none:
 * intent and input_passed are left as they are (NULL / false), model is not touched and the
 * snapshot pre-written at admission is cleared when no model was recorded (model IS NULL).
 */
export interface LiveRunFields {
  /** The server-checked intent (orchestrator storedIntentOf), null for none. */
  readonly intent: AgentIntent | null;
  /** The run passed step 1 of 「判定顺序」 (input review passed, not refused by the pre-checks). */
  readonly inputPassed: boolean;
  /**
   * true: the result used model output (model / model_snapshot are left for the trace writer);
   * false: it used none (both set NULL); null: not known yet (as for a run finalized elsewhere).
   */
  readonly modelUsed: boolean | null;
}

/** Admission of the PG ports: settle also takes the live run fields (B3-08t). */
export interface PgAdmission extends Admission {
  settle(
    ticket: AdmissionTicket,
    outcome: RunOutcome,
    limits: AdmissionLimits,
    reply?: RunReply,
    fields?: LiveRunFields,
  ): Promise<SettleResult>;
}

export type FinalizeOutcome =
  | {
      readonly kind: 'final';
      readonly frame: TerminalFrame;
      readonly refunded: boolean;
      /** quota_left inside the stored done frame; null for an error frame. */
      readonly snapshotQuotaLeft: number | null;
      /** The remaining quota now (F4 formula, this run already counted or refunded). */
      readonly quotaLeft: number;
      /** Whether this call wrote the terminal (false: it was already there). */
      readonly wrote: boolean;
    }
  | { readonly kind: 'running' }
  | { readonly kind: 'held'; readonly reason: FinalizeHold };

export interface Finalizer {
  /** Recovery finalization in its own transaction; retryable errors → AdmissionUnavailableError. */
  finalize(runId: string): Promise<FinalizeOutcome>;
}

export interface RunTimings {
  readonly runMaxMs: number;
  readonly lockGraceMs: number;
  readonly cancelPgPollMs: number;
}

export type TxStep =
  | 'admit'
  | 'lookup'
  | 'hold'
  | 'facts'
  | 'ending'
  | 'settle'
  | 'finish'
  | 'finalize'
  | 'cancel'
  | 'cancel_poll';

export type CrashPoint = 'admit' | 'facts' | 'ending' | 'settle' | 'finish' | 'finalize' | 'cancel';

export interface TxHooks {
  beforeSql?(step: TxStep, pid: number): Promise<void>;
  beforeCommit?(step: TxStep, pid: number): Promise<void>;
  afterCommit?(step: TxStep): Promise<void>;
  crash?(point: CrashPoint, phase: 'before' | 'after'): void;
}

export interface PgRunDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly timings: RunTimings;
  /** The same instance B3-03d uses for the limits it passes to admit. */
  readonly limits: QuotaLimitsSource;
  readonly texts: Pick<RunTexts, 'errorMsg'>;
  /** Redis fast path for cancel signals; may be absent or failing. */
  readonly signals?: Pick<RunRegistry, 'requestCancel' | 'cancelRequested'>;
  readonly logger?: Pick<RootLogger, 'error' | 'warn'>;
  readonly hooks?: TxHooks;
}

export interface PgRunRegistry extends RecoverableRunRegistry {
  recordEnding(runId: string, facts: RunFacts, draft: TerminalDraft): Promise<void>;
  finish(runId: string, terminal: TerminalFrame): Promise<TerminalFrame>;
}

export interface CancelQuery {
  readonly appId: string;
  readonly runId: string;
}

export interface PgRunPorts {
  readonly admission: PgAdmission;
  readonly registry: PgRunRegistry;
  readonly finalizer: Finalizer;
  cancel(query: CancelQuery): Promise<'accepted' | 'not_running'>;
}
