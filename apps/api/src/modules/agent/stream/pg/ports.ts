import { isDeepStrictEqual } from 'node:util';
import { sql } from 'kysely';
import { AdmissionUnavailableError } from '../admission/index.ts';
import type { RunEnding } from '../admission/index.ts';
import type { RunFacts, TerminalDraft } from '../run/types.ts';
import type { CancelQuery, PgRunDeps, PgRunPorts, PgRunRegistry } from './types.ts';
import { createAdmission } from './admit.ts';
import { defaultDraft, decideEnding } from './ending.ts';
import type { EndingMemo } from './ending.ts';
import { createFinalization } from './finalize.ts';
import { fromStored, redactedStored, StoredFrameInvalid, toStored } from './frames.ts';
import { readRun } from './store.ts';
import type { RunRow } from './store.ts';
import { createTransactions, port, retryable, unavailable } from './transaction.ts';

export function buildPgRunPorts(deps: PgRunDeps): PgRunPorts {
  const transaction = createTransactions(deps);
  const finalization = createFinalization(deps, transaction);
  const admit = createAdmission(deps, transaction, finalization);
  const memo = new Map<string, EndingMemo>();
  const polled = new Map<string, { at: number; cancelled: boolean }>();

  async function recordEnding(runId: string, facts: RunFacts, draft: TerminalDraft): Promise<void> {
    if (facts.ending === null) throw new TypeError('An ending is required');
    const proposed = { facts: { ...facts }, draft: structuredClone(draft) };
    // Save before any await; S5 retains the chosen ending even if both writes fail.
    memo.set(runId, proposed);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const row = await transaction('ending', (q) => decideEnding(q, runId, proposed));
        memo.set(runId, {
          facts: {
            ending: row.end_reason as RunEnding,
            cardsDelivered: row.card_delivered ? 1 : 0,
          },
          draft:
            row.end_draft === null
              ? defaultDraft('server_error', deps.texts)
              : fromStored(row.end_draft, 'draft'),
        });
        return;
      } catch (error) {
        if (attempt === 0 && retryable(error)) continue;
        return unavailable(error);
      }
    }
  }

  async function cancel(query: CancelQuery): Promise<'accepted' | 'not_running'> {
    const answer = await transaction('cancel', async (q) => {
      // The FIRST read of this run takes its row lock. Read clock only after it resolves.
      const row = (
        await q.query(sql<RunRow>`SELECT * FROM app.agent_runs
        WHERE app_id = ${query.appId} AND id = ${query.runId} FOR UPDATE`)
      )[0];
      const now = deps.clock.now();
      if (!row) return { status: 'not_running' as const };
      const repeated =
        row.cancel_requested_at !== null &&
        (row.end_reason === null || row.end_reason === 'cancelled');
      if (!repeated) {
        if (
          row.end_reason !== null ||
          row.final_event !== null ||
          row.deadline_at === null ||
          now.getTime() >= row.deadline_at.getTime()
        )
          return { status: 'not_running' as const };
        await q.query(sql`UPDATE app.agent_runs SET cancel_requested_at = GREATEST(${now}, accepted_at)
          WHERE app_id = ${query.appId} AND id = ${query.runId}
          AND end_reason IS NULL AND final_event IS NULL AND cancel_requested_at IS NULL
          AND ${now} < deadline_at`);
      }
      const owner = (
        await q.query(sql<{ user_id: string | null; device_id: string }>`SELECT user_id, device_id
        FROM app.agent_sessions WHERE app_id = ${row.app_id} AND id = ${row.session_id}`)
      )[0];
      return {
        status: 'accepted' as const,
        ownerKey: owner
          ? owner.user_id === null
            ? `d:${owner.device_id}`
            : `u:${owner.user_id}`
          : undefined,
      };
    });
    if (answer.status === 'accepted' && answer.ownerKey !== undefined) {
      // Cancellation is already durable. A slow or failed Redis signal cannot delay its response.
      void Promise.resolve()
        .then(() => deps.signals?.requestCancel(query.runId, answer.ownerKey!))
        .catch(() => undefined);
    }
    return answer.status;
  }

  const registry: PgRunRegistry = {
    register: () => Promise.resolve(),
    recordEnding: (runId, facts, draft) => port(() => recordEnding(runId, facts, draft)),
    recordFacts: (runId, facts, draft) =>
      port(async () => {
        if (facts.ending !== null) {
          return recordEnding(
            runId,
            facts,
            draft ?? memo.get(runId)?.draft ?? defaultDraft(facts.ending, deps.texts),
          );
        }
        await transaction('facts', async (q) => {
          if (facts.cardsDelivered > 0) {
            await q.query(sql`UPDATE app.agent_runs SET card_delivered = true
            WHERE id = ${runId} AND end_reason IS NULL`);
          }
        });
      }),
    facts: (runId) =>
      port(async () =>
        transaction('facts', async (q) => {
          const row = await readRun(q, runId);
          return {
            ending: row.end_reason as RunEnding | null,
            cardsDelivered: row.card_delivered ? 1 : 0,
          };
        }),
      ),
    draft: (runId) =>
      port(async () =>
        transaction('facts', async (q) => {
          const row = await readRun(q, runId);
          return row.end_draft === null ? null : fromStored(row.end_draft, 'draft');
        }),
      ),
    final: (runId) =>
      port(async () =>
        transaction('finish', async (q) => {
          const row = await readRun(q, runId);
          return row.final_event === null ? null : fromStored(row.final_event, 'final');
        }),
      ),
    finish: (runId, terminal) =>
      port(async () => {
        const frame = await transaction('finish', async (q) => {
          const row = await readRun(q, runId);
          if (row.final_event === null) throw new AdmissionUnavailableError('rolled_back');
          try {
            return fromStored(row.final_event, 'final');
          } catch (error) {
            // B3-08zh (BR-AI-22): the session was detached while the run went on, so its terminal
            // state was stored without msg / fallback_q; the frame sent is the one this process
            // finalized, exactly when the stored form is its redaction.
            if (
              error instanceof StoredFrameInvalid &&
              isDeepStrictEqual(row.final_event, redactedStored(toStored(terminal)))
            ) {
              return terminal;
            }
            throw error;
          }
        });
        memo.delete(runId);
        polled.delete(runId);
        return frame;
      }),
    requestCancel: (runId, ownerKey) =>
      port(async () => {
        // Legacy RunManager.cancel still honors ownership; HTTP uses the app-scoped cancel port.
        const owner = await transaction(
          'cancel_poll',
          async (q) =>
            (
              await q.query(sql<{
                app_id: string;
                user_id: string | null;
                device_id: string;
              }>`SELECT r.app_id, s.user_id, s.device_id FROM app.agent_runs r
        JOIN app.agent_sessions s ON s.app_id = r.app_id AND s.id = r.session_id
        WHERE r.id = ${runId}`)
            )[0],
        );
        if (
          !owner ||
          ownerKey !== (owner.user_id === null ? `d:${owner.device_id}` : `u:${owner.user_id}`)
        )
          return 'not_found';
        return (await cancel({ appId: owner.app_id, runId })) === 'accepted' ? 'ok' : 'not_found';
      }),
    cancelRequested: (runId) =>
      port(async () => {
        try {
          if (await deps.signals?.cancelRequested(runId)) return true;
        } catch {
          /* PG is authoritative; Redis is only an accelerator. */
        }
        const now = deps.clock.now().getTime();
        const previous = polled.get(runId);
        if (previous && now >= previous.at && now - previous.at < deps.timings.cancelPgPollMs)
          return previous.cancelled;
        const cancelled = await transaction('cancel_poll', async (q) => {
          const rows = await q.query(sql<{
            cancelled: boolean;
          }>`SELECT cancel_requested_at IS NOT NULL AS cancelled
          FROM app.agent_runs WHERE id = ${runId}`);
          return rows[0]?.cancelled ?? false;
        });
        polled.set(runId, { at: now, cancelled });
        return cancelled;
      }),
  };

  return {
    registry,
    admission: {
      admit: (req, limits) => port(() => admit(req, limits)),
      settle: (ticket, outcome, _limits, reply) =>
        port(async () => {
          const proposed = memo.get(ticket.runId) ?? {
            facts: outcome,
            draft: defaultDraft(outcome.ending, deps.texts),
          };
          // B3-08zc: the reply is written in the terminal transaction itself.
          const out = await finalization.requireFinal(ticket.runId, proposed, reply);
          return { refunded: out.refunded, quotaLeft: out.quotaLeft };
        }),
    },
    finalizer: { finalize: (runId) => port(() => finalization.independent(runId)) },
    cancel: (query) => port(() => cancel(query)),
  };
}
