import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export interface SettleBillMismatch {
  readonly bills: Readonly<
    Record<string, { readonly amountMismatch: number; readonly generatedAtSeconds: number }>
  >;
}

export async function readSettleBillMismatch(db: Kysely<DB>): Promise<SettleBillMismatch> {
  void db;
  throw new Error('NotImplemented: readSettleBillMismatch');
}
