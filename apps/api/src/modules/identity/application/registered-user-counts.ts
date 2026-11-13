// B1-34q (01 F-ADM-26 ② 新增用户数): the number of users of one app registered in one accounting
// day — users rows whose created_at lies in [start, end). An account deleted since keeps its row
// (status=deleted) and still counts. Read only; the admin workbench's daily aggregation is the
// caller (through this module's index.ts).
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

export interface RegisteredUserCountRange {
  readonly appId: string;
  /** Inclusive start instant, ISO 8601 with offset (as @couli/domain chinaDayRange). */
  readonly start: string;
  /** Exclusive end instant. */
  readonly end: string;
}

/** users rows of the app created in [start, end), deleted accounts included. */
export async function countRegisteredUsers(
  db: Kysely<DB>,
  input: RegisteredUserCountRange,
): Promise<bigint> {
  const row = await db
    .withSchema('app')
    .selectFrom('users')
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .where('app_id', '=', input.appId)
    .where('created_at', '>=', sql<Date>`${input.start}::timestamptz`)
    .where('created_at', '<', sql<Date>`${input.end}::timestamptz`)
    .executeTakeFirstOrThrow();
  return BigInt(row.total);
}
