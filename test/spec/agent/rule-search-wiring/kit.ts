// B3-08l rule-test kit (BR-AI-02 ①, BR-AI-07 T6; ledger B3-08l 同步 / 检索): real-PG rows of
// app.articles and app.agent_rule_chunks written as couli_app, the production stream assembly of
// [AC-B3-08g] (../stream-assembly-orders/kit.ts ordersFixture, the same entry, not a second one), a
// manual repeating schedule for the worker's rule sync, and the expected-tool set after B3-08l.
// Everything under test is built inside the tests (never in hooks): NotImplemented and missing
// wiring redden the test body itself. The integration tests pass the database in.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import type {
  RuleSyncSchedule,
  RuleSyncTimer,
} from '../../../../apps/api/src/modules/agent/index.ts';
import type { ToolOutcome } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import { PUBLISHED_AT, bodyOf } from '../rag-chunks/kit.ts';

export { NOW, PUBLISHED_AT, bodyOf } from '../rag-chunks/kit.ts';

/** BR-AI-02 正文：MVP 注册表 = allowlist（get_my_earnings 随 B3-16，不在本段）。 */
export const TOOLS = [
  'search_products',
  'get_rebate_quote',
  'list_my_orders',
  'explain_order',
  'prefill_claim',
  'search_rules',
  'handoff_to_human',
] as const;

/** What guests and unbound users are offered (audience all). */
export const ALL_AUDIENCE_TOOLS = [
  'search_products',
  'get_rebate_quote',
  'handoff_to_human',
  'search_rules',
] as const;

export const SEARCH_RULES_SWITCH = 'agent.tools.search_rules.enabled';
export const MIN_SCORE = 'agent.rag.min_score';
/** The B3-08l ledger: the B3-08i default period of 300 s, a code constant. */
export const SYNC_INTERVAL_MS = 300_000;

/** An app id made up for one test, sorting by `tag` first (ascending app id order is checkable). */
export function appIdOf(tag: string): string {
  return `synthetic-b3-08l-${tag}-${randomUUID()}`;
}

// ---- articles and chunks ----------------------------------------------------------------------

export type Category = 'help' | 'rule' | 'notice' | 'agreement';

export interface ArticleInput {
  readonly appId: string;
  readonly id?: string;
  readonly category?: Category;
  readonly title?: string;
  /** One paragraph per text (one chunk each when short). */
  readonly texts?: readonly string[];
  readonly version?: number;
  readonly status?: 'draft' | 'published' | 'offline';
  readonly publishedAt?: Date | null;
}

export interface Article {
  readonly id: string;
  readonly appId: string;
  readonly version: number;
  readonly title: string;
  readonly texts: readonly string[];
}

/** One version row of an article, as the CMS stores it (couli_app). */
export async function insertArticle(db: Kysely<DB>, input: ArticleInput): Promise<Article> {
  const status = input.status ?? 'published';
  const publishedAt =
    input.publishedAt !== undefined ? input.publishedAt : status === 'draft' ? null : PUBLISHED_AT;
  const article: Article = {
    id: input.id ?? randomUUID(),
    appId: input.appId,
    version: input.version ?? 1,
    title: input.title ?? '合成帮助文章',
    texts: input.texts ?? ['确认收货后返利进入待结算。'],
  };
  await sql`INSERT INTO app.articles
      (id, app_id, category, title, body, version, status, published_at, notice_closable)
    VALUES (${article.id}, ${article.appId}, ${input.category ?? 'help'}, ${article.title},
      ${bodyOf(...article.texts)}, ${article.version}, ${status}, ${publishedAt}, false)`.execute(
    db,
  );
  return article;
}

/** Every version row of the article gets the status (the CMS offline of a fixture). */
export async function setArticleStatus(
  db: Kysely<DB>,
  id: string,
  status: 'draft' | 'published' | 'offline',
): Promise<void> {
  await sql`UPDATE app.articles SET status = ${status} WHERE id = ${id}`.execute(db);
}

export interface ChunkRow {
  readonly chunk_id: string;
  readonly app_id: string;
  readonly article_id: string;
  readonly published_version: number;
  readonly title: string;
  readonly text: string;
}

/**
 * One chunk row written directly (as an earlier sync did), over its own published help article
 * (agent_rule_chunks_article_fkey). Retired rows carry retired_at.
 */
export async function insertChunk(
  db: Kysely<DB>,
  input: {
    readonly appId: string;
    readonly title: string;
    readonly text: string;
    readonly status?: 'active' | 'retired';
  },
): Promise<ChunkRow> {
  const article = await insertArticle(db, {
    appId: input.appId,
    title: input.title,
    texts: [input.text],
  });
  const row: ChunkRow = {
    chunk_id: randomUUID(),
    app_id: input.appId,
    article_id: article.id,
    published_version: article.version,
    title: input.title,
    text: input.text,
  };
  const status = input.status ?? 'active';
  await sql`INSERT INTO app.agent_rule_chunks
      (chunk_id, app_id, article_id, published_version, seq, title, text, status, retired_at)
    VALUES (${row.chunk_id}, ${row.app_id}, ${row.article_id}, ${row.published_version}, 0,
      ${row.title}, ${row.text}, ${status},
      ${status === 'retired' ? PUBLISHED_AT : null})`.execute(db);
  return row;
}

export interface ChunkView {
  readonly article_id: string;
  readonly published_version: number;
  readonly seq: number;
  readonly title: string;
  readonly text: string;
}

function byKey(a: ChunkView, b: ChunkView): number {
  if (a.article_id !== b.article_id) return a.article_id < b.article_id ? -1 : 1;
  if (a.published_version !== b.published_version) {
    return a.published_version - b.published_version;
  }
  return a.seq - b.seq;
}

/** The app's chunk rows of one status, as (article, version, seq, title, text), sorted. */
export async function chunkView(
  db: Kysely<DB>,
  appId: string,
  status: 'active' | 'retired' = 'active',
): Promise<ChunkView[]> {
  const result = await sql<ChunkView>`SELECT article_id::text AS article_id, published_version,
      seq, title, text
    FROM app.agent_rule_chunks WHERE app_id = ${appId} AND status = ${status}`.execute(db);
  return result.rows
    .map((row) => ({
      article_id: row.article_id,
      published_version: Number(row.published_version),
      seq: Number(row.seq),
      title: row.title,
      text: row.text,
    }))
    .sort(byKey);
}

/** Expected active chunks: one per paragraph text of each article (short texts), sorted. */
export function expectedChunks(articles: readonly Article[]): ChunkView[] {
  return articles
    .flatMap((article) =>
      article.texts.map((text, seq) => ({
        article_id: article.id,
        published_version: article.version,
        seq,
        title: article.title,
        text,
      })),
    )
    .sort(byKey);
}

// ---- tool outcomes ----------------------------------------------------------------------------

/** contracts card_rule_ref data of a chunk row (BR-AI-07 细则「T6 与其他」). */
export function ruleRefData(row: ChunkRow): Record<string, unknown> {
  return {
    chunk_id: row.chunk_id,
    title: row.title,
    excerpt: row.text,
    published_version: String(row.published_version),
    action: { route: 'Help', params: { article_id: row.article_id } },
  };
}

/** The rule_ref cards of chunk rows, in order, as cardsIn shows them. */
export function ruleRefCards(rows: readonly ChunkRow[]) {
  return rows.map((row) => ({ type: 'rule_ref', data: ruleRefData(row) }));
}

/** The cards of an ok outcome as (type, data) (an assertion failure otherwise). */
export function cardsIn(
  outcome: ToolOutcome,
): { type: string; data: Readonly<Record<string, unknown>> }[] {
  expect(outcome.kind, JSON.stringify(outcome)).toBe('ok');
  if (outcome.kind !== 'ok') return [];
  return outcome.cards.map((card) => ({ type: card.type, data: card.data }));
}

// ---- the worker's schedule --------------------------------------------------------------------

export interface ArmedRuleTimer {
  readonly tick: () => Promise<void>;
  readonly intervalMs: number;
  stopped: boolean;
}

/** A RuleSyncSchedule the test fires by hand; records every timer armed and whether it stopped. */
export class ManualRuleSchedule {
  readonly timers: ArmedRuleTimer[] = [];
  readonly schedule: RuleSyncSchedule = (tick, intervalMs): RuleSyncTimer => {
    const timer: ArmedRuleTimer = { tick, intervalMs, stopped: false };
    this.timers.push(timer);
    return {
      stop: () => {
        timer.stopped = true;
      },
    };
  };
  /** The one timer armed (an assertion failure otherwise). */
  sole(): ArmedRuleTimer {
    expect(this.timers, 'exactly one repeating timer').toHaveLength(1);
    return this.timers[0]!;
  }
  /** Fires the running timer once; resolves when the firing's work is over. */
  fire(): Promise<void> {
    const timer = this.sole();
    expect(timer.stopped, 'timer still running').toBe(false);
    return timer.tick();
  }
  /** Fires the timer even after stop (a callback already queued in the event loop). */
  fireLate(): Promise<void> {
    return this.sole().tick();
  }
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Lets pending work (database round trips included) run for a while. */
export function pause(ms = 100): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
