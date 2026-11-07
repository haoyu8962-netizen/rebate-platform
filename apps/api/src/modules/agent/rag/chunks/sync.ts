// B3-08i: syncing app.agent_rule_chunks of one app with its published help / rule articles, read
// only through the injected content reader (app.module builds it; D10-386, as B3-08k). Missing
// (article_id, version, seq) chunks of current revisions are inserted as active; every other active
// chunk of the app (older version, offline, draft, not help / rule) is retired at the Clock's now.
// Repeating the call changes nothing (at-least-once delivery); a unique-key conflict on insert
// counts as already written. Syncs of one app are serialised: one transaction takes the app's
// advisory lock first, then lists the articles and reads, inserts and retires the chunks, so no sync
// acts on an article snapshot older than another sync's writes (money review r1 S1).
// `db` is used for app.agent_rule_chunks only. Called by the agent worker's rule sync runtime
// (./worker.ts, B3-08m) for each app, one round at start and then every 300 s; app.module builds
// the content reader it reads through.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { PublishedArticlesReader } from '../../../content/index.ts';
import type { Clock } from '../../../platform/index.ts';
import { chunkArticle } from './chunk.ts';

export interface RuleChunkSyncOptions {
  /** Primary couli_app handle, for app.agent_rule_chunks only. */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  /** content's published help / rule articles reader. */
  readonly articles: PublishedArticlesReader;
}

export interface RuleChunkSyncResult {
  /** Chunk rows this call inserted. */
  readonly inserted: number;
  /** Active chunk rows this call retired. */
  readonly retired: number;
}

interface WantedChunk {
  readonly article_id: string;
  readonly published_version: number;
  readonly seq: number;
  readonly title: string;
  readonly text: string;
}

function keyOf(articleId: string, version: number, seq: number): string {
  return `${articleId}/${String(version)}/${String(seq)}`;
}

export async function syncRuleChunks(
  options: RuleChunkSyncOptions,
  appId: string,
): Promise<RuleChunkSyncResult> {
  const { db, clock, articles } = options;
  return db.transaction().execute(async (trx) => {
    // Key as content's lockInviteReward / identity's consent lock: hashtextextended of a
    // module.table:app text. Taken before the articles are listed; READ COMMITTED reads after the
    // wait see the previous sync's commit.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agent.agent_rule_chunks.sync:${appId}`}, 0))`.execute(
      trx,
    );
    return syncLocked(trx, clock, articles, appId);
  });
}

async function syncLocked(
  db: Kysely<DB>,
  clock: Clock,
  articles: PublishedArticlesReader,
  appId: string,
): Promise<RuleChunkSyncResult> {
  const wanted = new Map<string, WantedChunk>();
  for (const article of await articles.list(appId)) {
    for (const draft of chunkArticle(article)) {
      wanted.set(keyOf(article.id, article.version, draft.seq), {
        article_id: article.id,
        published_version: article.version,
        seq: draft.seq,
        title: draft.title,
        text: draft.text,
      });
    }
  }

  const stored = await db
    .withSchema('app')
    .selectFrom('agent_rule_chunks')
    .select(['chunk_id', 'article_id', 'published_version', 'seq', 'status'])
    .where('app_id', '=', appId)
    .execute();
  const present = new Set<string>();
  const stale: string[] = [];
  for (const row of stored) {
    const key = keyOf(row.article_id, row.published_version, row.seq);
    present.add(key);
    if (row.status === 'active' && !wanted.has(key)) stale.push(row.chunk_id);
  }

  let inserted = 0;
  const missing = [...wanted].filter(([key]) => !present.has(key)).map(([, row]) => row);
  if (missing.length > 0) {
    // A concurrent or earlier delivery may have written some rows since the read: the unique key
    // (article_id, published_version, seq) keeps one and the conflict counts as written.
    const rows = await db
      .withSchema('app')
      .insertInto('agent_rule_chunks')
      .values(missing.map((row) => ({ chunk_id: randomUUID(), app_id: appId, ...row })))
      .onConflict((oc) => oc.columns(['article_id', 'published_version', 'seq']).doNothing())
      .returning('chunk_id')
      .execute();
    inserted = rows.length;
  }

  let retired = 0;
  if (stale.length > 0) {
    // status = 'active' is re-checked under the row lock: a concurrent sync retires each row once.
    const result = await db
      .withSchema('app')
      .updateTable('agent_rule_chunks')
      .set({ status: 'retired', retired_at: clock.now() })
      .where('app_id', '=', appId)
      .where('chunk_id', 'in', stale)
      .where('status', '=', 'active')
      .executeTakeFirst();
    retired = Number(result.numUpdatedRows);
  }
  return { inserted, retired };
}
