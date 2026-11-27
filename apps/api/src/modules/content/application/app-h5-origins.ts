import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export async function readAppH5Origins(db: Kysely<DB>): Promise<ReadonlySet<string>> {
  void db;
  throw new Error('NotImplemented: readAppH5Origins');
}
