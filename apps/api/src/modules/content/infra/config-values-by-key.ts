// B3-09m · BR-AI-16 (D10-2864 S1-1): a read-only read of one configuration key across every app
// (config_items), for agent's platform-wide daily budget, which takes the most conservative value
// of all apps. One SELECT, no cache, no write path; agent never reads config_items itself
// (BR-AI-02 read / write scope), it reads through content's index.ts export.
// Every app that has any configuration item is listed, with `value` undefined when it lacks this
// key: an app without the key takes the BR default, which must take part in the platform-wide
// choice too (rule test [AC-B3-09m#31]).
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

import type { ConfigValue } from '../application/content-reader.ts';

/** One app's current value of a configuration key (undefined: the app has no such item). */
export interface AppConfigValue {
  readonly appId: string;
  readonly value: ConfigValue | undefined;
}

/**
 * The current value of `key` for every app with any configuration item, ordered by app id.
 * Rejects when the read fails; the caller decides what a failure means.
 */
export async function configValuesByKey(
  db: Kysely<DB>,
  key: string,
): Promise<readonly AppConfigValue[]> {
  const { rows } = await sql<{ app_id: string; value: ConfigValue | null; has_key: boolean }>`
    SELECT apps.app_id, item.value, item.app_id IS NOT NULL AS has_key
    FROM (SELECT DISTINCT app_id FROM app.config_items) AS apps
    LEFT JOIN app.config_items AS item ON item.app_id = apps.app_id AND item.key = ${key}
    ORDER BY apps.app_id`.execute(db);
  return rows.map((row) => ({
    appId: row.app_id,
    value: row.has_key ? (row.value as ConfigValue) : undefined,
  }));
}
