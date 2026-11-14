// B1-10j: linking's read port of link_logs by id for orders' console claim review (the records a
// child order counts as evidence, claim_items.evidence_link_log_ids; BR-ATTR-18 / BR-ATTR-30). It
// answers only each record's time and scene (no product, shop, promotion or raw union data), as
// stored: scene may be null on historical records. Scoped by app_id; ids of another app or unknown
// ids are absent from the answer. Read only, no judgement.
// CT-13m (BR-ATTR-14 默认值; D10-1625): a record whose day partition was dropped survives in
// app.link_log_evidence when a claim item referenced it. link_logs is read first; only the ids it
// does not answer are looked up in the evidence table (same columns, same app scope); ids missing in
// both are absent.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

export interface LinkLogMoment {
  readonly at: Date;
  readonly scene: string | null;
}

export interface LinkLogMomentReader {
  /** link_logs.id (as decimal text) → its created_at and scene. */
  moments(appId: string, ids: readonly bigint[]): Promise<ReadonlyMap<string, LinkLogMoment>>;
}

export function createLinkLogMomentReader(db: Kysely<DB>): LinkLogMomentReader {
  return Object.freeze({
    async moments(appId: string, ids: readonly bigint[]) {
      const wanted = [...new Set(ids.map((id) => id.toString()))];
      const result = new Map<string, LinkLogMoment>();
      if (wanted.length === 0) return result;
      const rows = await db
        .withSchema('app')
        .selectFrom('link_logs')
        .select(['id', 'created_at', 'scene'])
        .where('app_id', '=', appId)
        .where('id', '=', sql<bigint>`ANY(${wanted}::bigint[])`)
        .execute();
      for (const row of rows) {
        result.set(row.id.toString(), { at: row.created_at, scene: row.scene });
      }
      const missing = wanted.filter((id) => !result.has(id));
      if (missing.length === 0) return result;
      const archived = await db
        .withSchema('app')
        .selectFrom('link_log_evidence')
        .select(['id', 'created_at', 'scene'])
        .where('app_id', '=', appId)
        .where('id', '=', sql<bigint>`ANY(${missing}::bigint[])`)
        .execute();
      for (const row of archived) {
        result.set(row.id.toString(), { at: row.created_at, scene: row.scene });
      }
      return result;
    },
  });
}
