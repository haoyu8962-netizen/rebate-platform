// B3-08w · BR-AI-01 细则「判定顺序」② (承接上文的订单按 order_query), BR-AI-20 (only this app's
// and this session's runs), BR-AI-19 (intent is a run-level trace field). D10-1022 ④「上一轮」.
// The rule tests in test/spec/agent/previous-intent/** import this file by path: the names, the
// signatures and the semantics written here are the contract.
//
// createPgPreviousIntentReader({db}).previousIntent({appId, sessionId, runId}) — read only:
//   "the previous run" is the one app.agent_runs row with app_id = appId, session_id = sessionId,
//   id ≠ runId and accepted_at earlier than the accepted_at of run runId, taken first by
//   accepted_at desc, id desc (run runId itself was inserted at acceptance and never counts).
//   Its intent 'order_query' or 'earnings_query' is returned as is; any other value, NULL, or no
//   previous run → null. No time window, and never a look past that one row (an earlier
//   order_query behind a later run does not count). Another session's or another app's runs never
//   count. A sessionId that is not a UUID → null without any query. A failing read rejects with
//   the database error (the stream assembly logs it and answers null).
//
// Rules for the implementation: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no NestJS, no process.env, data access only through Kysely on
// deps.db.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { isUuid } from '../index.ts';

/** The intents a following elliptical question (那返了吗) may continue. */
export type PreviousRunIntent = 'order_query' | 'earnings_query';

/** The run asking (its own ids, from the server-side run input only). */
export interface PreviousIntentQuery {
  readonly appId: string;
  readonly sessionId: string;
  readonly runId: string;
}

export interface PreviousIntentReader {
  previousIntent(query: PreviousIntentQuery): Promise<PreviousRunIntent | null>;
}

export interface PgPreviousIntentReaderDeps {
  readonly db: Kysely<DB>;
}

function previousRunIntentOf(intent: string | null | undefined): PreviousRunIntent | null {
  return intent === 'order_query' || intent === 'earnings_query' ? intent : null;
}

export function createPgPreviousIntentReader(
  deps: PgPreviousIntentReaderDeps,
): PreviousIntentReader {
  const { db } = deps;
  return {
    async previousIntent(query) {
      // Non-UUID ids never reach the uuid columns (no query, no cast error).
      if (!isUuid(query.sessionId) || !isUuid(query.runId)) return null;
      // One statement: the asking run's accepted_at comes from its own row (same app and
      // session); no such row → the comparison is NULL and no previous run is found.
      const row = await db
        .withSchema('app')
        .selectFrom('agent_runs as p')
        .select('p.intent')
        .where('p.app_id', '=', query.appId)
        .where('p.session_id', '=', query.sessionId)
        .where('p.id', '<>', query.runId)
        .where('p.accepted_at', '<', (eb) =>
          eb
            .selectFrom('agent_runs as c')
            .select('c.accepted_at')
            .where('c.app_id', '=', query.appId)
            .where('c.session_id', '=', query.sessionId)
            .where('c.id', '=', query.runId),
        )
        .orderBy('p.accepted_at', 'desc')
        .orderBy('p.id', 'desc')
        .limit(1)
        .executeTakeFirst();
      return previousRunIntentOf(row?.intent);
    },
  };
}
