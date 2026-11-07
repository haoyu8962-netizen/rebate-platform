// B3-08m · BR-AI-07 T6: search_rules' data source on the stream entry: the caller's app's active
// rows of app.agent_rule_chunks (agent's own table, written by ./sync.ts), read fresh on every call
// (no cache: a sync's retirement takes effect on the next question). SELECT only; the app comes
// from the server-built call context (BR-AI-03), never from model arguments.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { RuleChunkRow } from '../../tools/rules/index.ts';

/** RulesDeps.activeChunks over the primary couli_app handle (agent's own table only). */
export function createActiveRuleChunksReader(
  db: Kysely<DB>,
): (appId: string) => Promise<readonly RuleChunkRow[]> {
  return async (appId) => {
    const rows = await db
      .withSchema('app')
      .selectFrom('agent_rule_chunks')
      .select(['chunk_id', 'article_id', 'published_version', 'title', 'text'])
      .where('app_id', '=', appId)
      .where('status', '=', 'active')
      .orderBy('chunk_id')
      .execute();
    return rows.map((row) => ({
      chunk_id: row.chunk_id,
      article_id: row.article_id,
      published_version: Number(row.published_version),
      title: row.title,
      text: row.text,
    }));
  };
}
