import type { Clock, RedisNamespace, RootLogger, Scheduler } from '../../../platform/index.ts';
import type {
  CardInput,
  DoneData,
  ErrorData,
  FinishReason,
  FrameValidator,
  MetaData,
  StreamSink,
  SuggestionsData,
} from '../writer/index.ts';
import type { Admission, AdmissionLimits, AdmissionTicket, RunEnding } from '../admission/index.ts';

export interface RunConfig {
  readonly maxRunMs: number;
  readonly heartbeatMs: number;
  readonly disconnectGraceMs: number;
  readonly guardPollMs: number;
  readonly signalPollMs: number;
}

export type AbortReason =
  'cancelled' | 'timeout' | 'disconnected' | 'disabled' | 'consent_withdrawn';

/** A card without card_id; embedded product cards carry no card_id either. */
export type UnnumberedCard = Omit<CardInput, 'card_id'>;

export interface NumberedCard {
  readonly card: CardInput;
  readonly used: number;
}

export interface RunContext {
  readonly runId: string;
  readonly sessionId: string;
  /** Aborted once; reason is an AbortReason. */
  readonly signal: AbortSignal;
  readonly cardsDelivered: number;
  text(delta: string): void;
  toolStatus(tool: string, phase: 'start' | 'end' | 'failed', displayText: string): void;
  /** `delivered`, when given, receives the frame's card_id once the numbered card was written
   * (B3-05i: the orchestrator fills it into the tool's modelView); never when nothing was (B3-08zc:
   * a card kept for the stored reply while the client is gone gets no receipt either). */
  card(card: UnnumberedCard, delivered?: (cardId: string) => void): Promise<void>;
  suggestions(items: SuggestionsData['items']): void;
}

export type RunBodyResult =
  | {
      readonly kind: 'done';
      readonly finishReason: Exclude<FinishReason, 'cancelled' | 'timeout'>;
      readonly ending?: 'input_review_timeout';
    }
  | { readonly kind: 'error'; readonly error: ErrorData };

export type RunBody = (ctx: RunContext) => Promise<RunBodyResult>;

export interface RunGuard {
  check(): Promise<null | { readonly code: 30501 | 10004 }>;
}

/**
 * The run a guard is taken for (B3-03i, plan G-1): the guard of one run checks that run's subject
 * (BR-AI-13: a withdrawal ends the live runs of that subject only; BR-AI-12: agent.enabled off
 * ends every run).
 */
export interface RunGuardTarget {
  readonly appId: string;
  /** u:<user_id> | d:<device_id> (BR-AI-20), as RunStart.ownerKey. */
  readonly ownerKey: string;
  readonly runId: string;
}

export interface RunTexts {
  text(key: 'agent.timeout'): string;
  errorMsg(code: number): string;
}

export interface CardSequence {
  /** Returns the first of `count` numbers reserved for the session; never reused. */
  reserve(sessionId: string, count: number): Promise<number>;
}

export type TerminalFrame =
  | { readonly event: 'done'; readonly data: DoneData }
  | { readonly event: 'error'; readonly data: ErrorData };

/** Saved before settlement; quota_left is supplied only by the admission gate afterward. */
export type TerminalDraft =
  | { readonly event: 'done'; readonly data: Omit<DoneData, 'quota_left'> }
  | { readonly event: 'error'; readonly data: ErrorData };

export interface RunRegistration {
  readonly runId: string;
  readonly sessionId: string;
  /** u:<user_id> | d:<device_id> (BR-AI-20). */
  readonly ownerKey: string;
}

/** Facts saved while the run goes (BR-AI-23 细则): ending null until the run has one. */
export interface RunFacts {
  readonly ending: RunEnding | null;
  readonly cardsDelivered: number;
}

export interface RunRegistry {
  register(run: RunRegistration): Promise<void>;
  /** Saves the draft together with ending facts before resolving; live saves omit it. */
  recordFacts(runId: string, facts: RunFacts, draft?: TerminalDraft): Promise<void>;
  facts(runId: string): Promise<RunFacts | null>;
  requestCancel(runId: string, ownerKey: string): Promise<'ok' | 'not_found'>;
  cancelRequested(runId: string): Promise<boolean>;
  /**
   * Saves the terminal after settlement. B3-03g: a registry that persists the terminal returns the
   * frame actually stored (agent_runs.final_event), and the manager sends that one instead of its
   * own; returning nothing (B3-03b fakes, the Redis registry) keeps sending `terminal`.
   */
  finish(runId: string, terminal: TerminalFrame): Promise<TerminalFrame | void>;
  /**
   * B3-03g S4 (design §3.1): called by the manager inside choose(), when the ending is chosen and
   * before anything is awaited (no wait for pending card facts); the PG registry writes the ending
   * with the decision UPDATE at once. Optional: registries without it are skipped.
   */
  recordEnding?(runId: string, facts: RunFacts, draft: TerminalDraft): Promise<void>;
  final(runId: string): Promise<TerminalFrame | null>;
}

/** Recovery reads the draft separately so RunFacts retains its existing public shape. */
export interface RecoverableRunRegistry extends RunRegistry {
  draft(runId: string): Promise<TerminalDraft | null>;
}

export interface RedisRunRegistryDeps {
  /** Wiring must provide an app_id-scoped namespace; run ids alone do not isolate brands. */
  readonly redis: RedisNamespace;
  readonly clock: Clock;
  readonly ttlSeconds: number;
}

export interface RunSink extends StreamSink {
  onClose(listener: () => void): void;
}

export interface RunStart {
  readonly ticket: AdmissionTicket;
  readonly ownerKey: string;
  readonly limits: AdmissionLimits;
  readonly meta: Omit<MetaData, 'session_id' | 'run_id' | 'duplicate'>;
  readonly sink: RunSink;
  /**
   * B3-03i (only added): the app of the run; the HTTP layer passes caller.appId. Used for
   * RunManagerDeps.guardFor; absent, the run is guarded by RunManagerDeps.guard as before.
   */
  readonly appId?: string;
}

export interface RunFinal {
  readonly terminal: TerminalFrame | null;
  readonly ending: RunEnding;
  readonly cardsDelivered: number;
}

export interface RunManager {
  start(start: RunStart, body: RunBody): Promise<RunFinal>;
  cancel(runId: string, ownerKey: string): Promise<'ok' | 'not_found'>;
}

export interface RunManagerDeps {
  readonly admission: Admission;
  readonly registry: RunRegistry;
  readonly cards: CardSequence;
  readonly texts: RunTexts;
  readonly guard: RunGuard;
  /**
   * B3-03i (only added, plan G-1): the guard of one run. When given and RunStart.appId is
   * present, the manager takes that run's guard from guardFor({appId: start.appId, ownerKey:
   * start.ownerKey, runId: ticket.runId}) and polls only it for that run, exactly as `guard` is
   * polled (cadence, read timeout, a rejection or timeout retried next round, 30501 → disabled,
   * 10004 → consent_withdrawn); `guard` is then not consulted for that run. Without guardFor, or
   * without start.appId, every run is guarded by `guard` as before.
   */
  readonly guardFor?: (run: RunGuardTarget) => RunGuard;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly config: RunConfig;
  readonly validator?: FrameValidator;
  /** Inject ROOT_LOGGER (or a child) when wiring the stream entry. */
  readonly logger?: Pick<RootLogger, 'error'>;
  /**
   * B3-08zh (BR-AI-19 细则「助手回复落库」, D10-1361): told of every card kept for the reply without
   * a frame (the client is gone; no receipt), with the run id and the numbered card, in delivery
   * order and before ctx.card resolves (awaited, so whatever it records precedes the run's next
   * step, as a framed card's receipt does). A rejection or throw is ignored (the run goes on).
   */
  readonly onUnframedCard?: (runId: string, card: CardInput) => Promise<void> | void;
}

export function runConfigDefaults(): RunConfig {
  return {
    maxRunMs: 20_000,
    heartbeatMs: 15_000,
    disconnectGraceMs: 60_000,
    guardPollMs: 5_000,
    signalPollMs: 500,
  };
}
