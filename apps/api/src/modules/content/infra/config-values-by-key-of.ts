import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

import type { ConfigValue } from '../application/content-reader.ts';

export type ConfigValuesByKey = (
  key: string,
) => Promise<readonly { appId: string; value: ConfigValue | undefined }[]>;

export function configValuesByKeyOf(db: Kysely<DB>): ConfigValuesByKey {
  void db;
  throw new Error('NotImplemented: configValuesByKeyOf');
}
