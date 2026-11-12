// The SQL pieces every writer of agent_result_deliveries shares (B3-03n / B3-03q receipts in
// ./index.ts, and B3-08zc's terminal transaction in ../../stream/pg/deliveries.ts): the advisory
// lock key of a result set's deliveries, the quoted set id derived from the run id, and the quoted
// set's conditions marker. A leaf (kysely only), so both sides import it without a cycle.
import type { RawBuilder } from 'kysely';
import { sql } from 'kysely';

/** The advisory lock (transaction scope) of an advisory key: a JSON array of strings. */
export function advisoryLockSql(key: readonly string[]): RawBuilder<unknown> {
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(key)}, 0))`;
}

/** Key of the lock under which positions of a result set's deliveries are appended. */
export function deliveriesLockKey(appId: string, resultSetId: string): readonly string[] {
  return ['agent.result.deliveries', appId, resultSetId];
}

/**
 * B3-03q: the id of a run's quoted result set, computed by PG from the run id (an existing column
 * expression or a parameter). Product_list result sets get random v4 ids, so they never match.
 */
export function quotedSetId(runId: RawBuilder<unknown>): RawBuilder<string> {
  return sql<string>`md5(${'agent.result.quoted:'}::text || (${runId})::uuid::text)::uuid`;
}

/** The conditions of a quoted result set: a marker only, never a search (BR-AI-05). */
export const QUOTED_CONDITIONS = JSON.stringify({ receipt: 'rebate_quote' });
