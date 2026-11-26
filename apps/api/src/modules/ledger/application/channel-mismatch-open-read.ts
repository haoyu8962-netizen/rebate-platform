import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export interface ChannelMismatchOpen {
  readonly open: Readonly<Record<string, number>>;
}

export async function readChannelMismatchOpen(db: Kysely<DB>): Promise<ChannelMismatchOpen> {
  void db;
  throw new Error('NotImplemented: readChannelMismatchOpen');
}
