// B3-09m · BR-AI-16 (D10-2884): configValuesByKey bound to one handle, for the composition root
// (app.module) to hand agent a cross-app read without agent ever holding content's db argument
// (BR-AI-02; test/spec/agent/foreign-db-handoff). Read-only, no cache: each call is one SELECT.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

import { configValuesByKey, type AppConfigValue } from './config-values-by-key.ts';

export type ConfigValuesByKey = (key: string) => Promise<readonly AppConfigValue[]>;

/** `(key) => configValuesByKey(db, key)`: rejects whenever that read rejects. */
export function configValuesByKeyOf(db: Kysely<DB>): ConfigValuesByKey {
  return (key) => configValuesByKey(db, key);
}
