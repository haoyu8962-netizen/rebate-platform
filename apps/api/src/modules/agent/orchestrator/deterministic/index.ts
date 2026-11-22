// B3-05e: deterministic link path (BR-AI-01 A-level resolve_link; BR-AI-04; BR-AI-05).
// The core enters this path whenever input check found links, before any prompt or model read,
// so it also serves no-model routes and exhausted budgets (BR-AI-14 细则「无模型降级」first step).
// Links (URLs and tokens alike, B3-04g) go one by one, in order of appearance, through the same
// LinkQuoteRunner (B3-04c / B3-04f: resolve_link or the official TokenParser → get_rebate_quote →
// register_links: registration only, never a conversion). Each link's failure is handled on its
// own; the rest of the material is untrusted text and has no effect here.
import type { Candidate } from '../../../parsing/index.ts';
import type { LinkQuoteOutcome, LinkQuoteRunner } from '../../tools/quote/index.ts';
import type { ToolCallContext } from '../../tools/registry/index.ts';
import type { RunBodyResult, RunContext, UnnumberedCard } from '../../stream/run/index.ts';
import type {
  AgentRunTexts,
  DeterministicPath,
  PathInput,
  ToolTraceFragment,
} from '../core/ports.ts';

export interface DeterministicPathDeps {
  readonly quotes: LinkQuoteRunner;
  readonly texts: AgentRunTexts;
  /** B3-05u: one redacted error line per link that failed for a server reason. */
  readonly logger?: { error(obj: Record<string, unknown>, msg: string): void };
  /** The placeholder-free message of an error frame (the core's errorMsg); absent: texts.text
   * of `error.<code>`. */
  readonly errorMsg?: (appId: string, code: number) => Promise<string>;
  /** Optional receiver of each successful link's trace fragment (link_registrations), handed
   * over unchanged as DegradedPathDeps.onTrace does. Best effort: it never changes the result. */
  readonly onTrace?: (fragment: ToolTraceFragment) => void;
}

type Done = Extract<RunBodyResult, { kind: 'done' }>;

function stopped(): Done {
  return { kind: 'done', finishReason: 'stop' };
}

function toolName(): 'get_rebate_quote' {
  return 'get_rebate_quote';
}

/** BR-TEXT-14 error text keys; the code alone selects the key, never the material. */
function errorKey(code: number): string {
  return `error.${code}`;
}

/** Default for price_unavailable / no_card: dependency unavailable. No substitute card and no
 * filled-in number (BR-AI-04 required fields). */
function unavailableCode(): 50301 {
  return 50301;
}

/** BR-AI-15 细则 (B3-05u): parse_error with this code is a server reason, not the product's. */
function parseUnavailableCode(): 50301 {
  return 50301;
}

/** BR-TEXT-22: a link that failed for a server reason while the run still ends stop. */
function quoteFailedKey(): string {
  return 'agent.notice.quote_failed';
}

/** BR-PRICE-08: a pasted link whose product has no rebate gets this notice only. */
function noRebateKey(): string {
  return 'no_rebate.notice';
}

/** BR-AI-15 细则: every link failed for a server reason → error frame, never retryable. */
function serverFailureCode(): 50401 {
  return 50401;
}

/**
 * One link's result. product: the product itself (upstream answered: no rebate, unrecognized,
 * no price, no card) → its own notice, the run ends stop. server: upstream timeout / 5xx /
 * circuit open, our registration or any thrown error; cause is an enum-like label for the log.
 */
type Verdict =
  | { readonly kind: 'ok'; readonly outcome: Extract<LinkQuoteOutcome, { kind: 'ok' }> }
  | { readonly kind: 'product'; readonly key: string }
  | { readonly kind: 'server'; readonly cause: string };

function classify(outcome: LinkQuoteOutcome): Verdict {
  switch (outcome.kind) {
    case 'ok':
      return { kind: 'ok', outcome };
    case 'no_rebate':
      return { kind: 'product', key: noRebateKey() };
    case 'server_failed':
      return { kind: 'server', cause: 'server_failed' };
    case 'parse_error':
      return outcome.error_code === parseUnavailableCode()
        ? { kind: 'server', cause: `parse_error_${String(outcome.error_code)}` }
        : { kind: 'product', key: errorKey(outcome.error_code) };
    case 'price_unavailable':
    case 'no_card':
      return { kind: 'product', key: errorKey(unavailableCode()) };
  }
}

function isLabel(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(value);
}

/**
 * Error class name, or the code of a UnionError / GovernanceError; never the message. Reading an
 * oddly shaped error (constructor nulled, throwing getters, proxies) never throws: 'unknown'.
 */
function causeOf(error: unknown): string {
  try {
    if (!(error instanceof Error)) return 'unknown';
    const name: unknown = error.name;
    if (name === 'UnionError' || name === 'GovernanceError') {
      const code: unknown = (error as { readonly code?: unknown }).code;
      if (isLabel(code)) return code;
    }
    const ctor: unknown = (error as { readonly constructor?: unknown }).constructor;
    if (typeof ctor !== 'function') return 'unknown';
    const ctorName: unknown = (ctor as { readonly name?: unknown }).name;
    return isLabel(ctorName) ? ctorName : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Identity only from the authenticated caller; never from the message text or context. */
function toolContext(request: PathInput, ctx: RunContext): ToolCallContext {
  const input = request.input;
  return {
    appId: input.caller.appId,
    userId: input.caller.userId,
    deviceId: input.caller.deviceId,
    phoneBound: input.caller.phoneBound,
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    signal: ctx.signal,
    placeholders: request.proceed.placeholders,
    ...(input.context === undefined ? {} : { context: input.context }),
  };
}

function reportTrace(deps: DeterministicPathDeps, fragment: ToolTraceFragment): void {
  if (deps.onTrace === undefined) return;
  try {
    deps.onTrace(fragment);
  } catch {
    // Trace is best effort; it never changes the run's result.
  }
}

/** One redacted line per link that failed for a server reason; logging never fails the run. */
function reportServerFailure(deps: DeterministicPathDeps, linkIndex: number, cause: string): void {
  if (deps.logger === undefined) return;
  try {
    deps.logger.error(
      { code: 'AGENT_LINK_QUOTE_FAILED', link_index: linkIndex, cause },
      'agent_link_quote_failed',
    );
  } catch {
    // Best effort.
  }
}

/**
 * Per link, in proceed.links order (already deduplicated and capped by the input check):
 * url and tpwd alike: tool.status start → runner → end + its cards, or failed + one notice. The
 * candidate object is handed over unchanged (a token is never rewritten as a URL).
 * Notice keys: no_rebate → no_rebate.notice; parse_error uses its own error code (30131 / 30132 /
 * 30141); price_unavailable and no_card use error.50301; a server reason (server_failed,
 * parse_error 50301, any thrown error) uses agent.notice.quote_failed. A thrown error's message
 * never reaches a frame or the log. proceed.notices are emitted by the core only and never
 * repeated here. No text.delta is written (no model, no fixed explanation text).
 * B3-05u (BR-AI-15 细则): if every link failed for a server reason, no per-link notice goes out
 * and the run ends with error 50401 (retryable false), so the core refunds the message. As soon
 * as one link delivered a card or failed for the product's own reason the run ends done stop;
 * the server-reason notices held back until then go out first, in link order. Abort is checked
 * after every await and suppresses all later output.
 */
export function createDeterministicPath(deps: DeterministicPathDeps): DeterministicPath {
  async function notice(appId: string, key: string, ctx: RunContext): Promise<boolean> {
    const text = await deps.texts.text(appId, key);
    if (ctx.signal.aborted) return false;
    const card: UnnumberedCard = {
      type: 'notice',
      schema_version: 1,
      data: { level: 'warn', text_key: key, actions: [] },
      fallback_text: text,
    };
    await ctx.card(card);
    return !ctx.signal.aborted;
  }

  async function status(
    appId: string,
    phase: 'start' | 'end' | 'failed',
    ctx: RunContext,
  ): Promise<boolean> {
    const display = await deps.texts.toolDisplay(appId, toolName(), phase);
    if (ctx.signal.aborted) return false;
    ctx.toolStatus(toolName(), phase, display);
    return true;
  }

  async function quote(request: PathInput, link: Candidate, ctx: RunContext): Promise<Verdict> {
    try {
      return classify(await deps.quotes.run(link, toolContext(request, ctx)));
    } catch (error) {
      // Only this link fails; the error never bubbles up as a run error.
      return { kind: 'server', cause: causeOf(error) };
    }
  }

  async function serverFailure(appId: string, ctx: RunContext): Promise<RunBodyResult> {
    const msg =
      deps.errorMsg === undefined
        ? await deps.texts.text(appId, errorKey(serverFailureCode()))
        : await deps.errorMsg(appId, serverFailureCode());
    if (ctx.signal.aborted) return stopped();
    return {
      kind: 'error',
      error: { code: serverFailureCode(), msg, retryable: false, fallback: null, fallback_q: null },
    };
  }

  return {
    async run(request, ctx) {
      const appId = request.input.caller.appId;
      const links = request.proceed.links;
      // settled: a card went out or a link failed for the product's own reason, so the run ends
      // stop. Until then server-reason notices are held back (all quote_failed: a count).
      let settled = false;
      let held = 0;
      for (const [linkIndex, link] of links.entries()) {
        if (ctx.signal.aborted) return stopped();
        if (!(await status(appId, 'start', ctx))) return stopped();
        const verdict = await quote(request, link, ctx);
        if (ctx.signal.aborted) return stopped();

        if (verdict.kind === 'server') {
          reportServerFailure(deps, linkIndex, verdict.cause);
          if (!(await status(appId, 'failed', ctx))) return stopped();
          if (!settled) {
            held += 1;
            continue;
          }
          if (!(await notice(appId, quoteFailedKey(), ctx))) return stopped();
          continue;
        }

        if (!(await status(appId, verdict.kind === 'ok' ? 'end' : 'failed', ctx))) {
          return stopped();
        }
        if (!settled) {
          settled = true;
          for (; held > 0; held -= 1) {
            if (!(await notice(appId, quoteFailedKey(), ctx))) return stopped();
          }
        }
        if (verdict.kind === 'product') {
          if (!(await notice(appId, verdict.key, ctx))) return stopped();
          continue;
        }
        const outcome = verdict.outcome;
        if (outcome.trace !== undefined) reportTrace(deps, outcome.trace);
        for (const card of outcome.cards) {
          await ctx.card(card);
          if (ctx.signal.aborted) return stopped();
        }
      }
      if (settled || links.length === 0) return stopped();
      return serverFailure(appId, ctx);
    },
  };
}
