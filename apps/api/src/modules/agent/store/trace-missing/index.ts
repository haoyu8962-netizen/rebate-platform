// B3-08z · BR-AI-19 (a lost trace is never dropped silently), BR-AI-22 (sessions erased on account
// deletion); D10-1060 / D10-1087. The read-only query behind the worker's gauge
// couli_agent_trace_missing_runs{app_id} (platform/metrics/agent-trace-missing.ts declares the port
// shape; entry.ts injects this one, platform never imports agent). The rule tests in
// test/spec/platform/agent-trace-missing/** import this file by path: the names, the signatures and
// the semantics written here are the contract.
//
// createPgAgentTraceMissingPort({db}).countMissing(now) — read only, every app_id at once:
//   A run counts when all of these hold:
//   - it ended more than 24 hours before `now`: ended_at IS NOT NULL and ended_at < now − 24 h
//     (exactly 24 h is not yet counted; a run that never ended never counts);
//   - it emitted cards: agent_runs.card_delivered is true;
//   - it has no card row: no app.agent_cards row with the run's app_id and run_id (rows of other
//     runs of the same session never stand in for it);
//   - its session is not detached from its user (BR-AI-22): a session whose user_id IS NULL and
//     user_hash IS NOT NULL never counts, whether its card rows were purged to '{}' or never
//     written (the trace writer skips detached sessions, B3-08y). Guest sessions (user_id NULL,
//     user_hash NULL) and member sessions count.
//   Result: one element per app_id with at least one counted run, { app_id, runs } where runs is a
//   JS number ≥ 1; an app_id with none is absent (no 0 element); order unspecified. `now` is the
//   caller's (the injected Clock's) instant, never the database's now() / CURRENT_TIMESTAMP.
//   Only SELECT statements reading app.agent_runs, app.agent_cards and app.agent_sessions; no
//   writes, no row locks (FOR UPDATE / FOR SHARE), so it runs in a READ ONLY transaction. A failing
//   read rejects with the database error (no empty result, no 0 in its place).
//
// Rules for the implementation: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no NestJS, no process.env, data access only through Kysely on
// deps.db.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

/** One app_id's runs missing their card trace (structurally platform's AgentTraceMissingCount). */
export interface AgentTraceMissingRow {
  readonly app_id: string;
  readonly runs: number;
}

/** The read-only port (structurally platform's AgentTraceMissingPort). */
export interface AgentTraceMissingReadPort {
  countMissing(now: Date): Promise<readonly AgentTraceMissingRow[]>;
}

export interface PgAgentTraceMissingPortDeps {
  readonly db: Kysely<DB>;
}

export function createPgAgentTraceMissingPort(
  deps: PgAgentTraceMissingPortDeps,
): AgentTraceMissingReadPort {
  return {
    async countMissing(now: Date): Promise<readonly AgentTraceMissingRow[]> {
      const rows = await deps.db
        .transaction()
        .setAccessMode('read only')
        .execute((trx) =>
          trx
            .withSchema('app')
            .selectFrom('agent_runs as r')
            .innerJoin('agent_sessions as s', (join) =>
              join.onRef('s.app_id', '=', 'r.app_id').onRef('s.id', '=', 'r.session_id'),
            )
            .select(['r.app_id', sql<string>`count(*)`.as('runs')])
            .where('r.ended_at', 'is not', null)
            // The edge comes from the caller's instant only; exactly 24 h before it is not counted.
            .where(sql<boolean>`r.ended_at < ${now}::timestamptz - interval '24 hours'`)
            .where('r.card_delivered', '=', true)
            // BR-AI-22: a session detached from its user (user_id gone, user_hash left) never counts.
            .where((eb) => eb.or([eb('s.user_id', 'is not', null), eb('s.user_hash', 'is', null)]))
            .where(({ not, exists, selectFrom }) =>
              not(
                exists(
                  selectFrom('agent_cards as c')
                    .select(sql<number>`1`.as('one'))
                    .whereRef('c.app_id', '=', 'r.app_id')
                    .whereRef('c.run_id', '=', 'r.id'),
                ),
              ),
            )
            .groupBy('r.app_id')
            .execute(),
        );
      return rows.map((row) => ({ app_id: row.app_id, runs: Number(row.runs) }));
    },
  };
}
