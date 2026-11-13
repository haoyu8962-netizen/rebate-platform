// B1-34q (01 F-ADM-26 ② 转链数; D10-1403 Q2): the number of conversions of one app in one
// accounting day — link_logs rows of event=convert whose created_at lies in [start, end). The
// precompute / register / open events are not conversions. Read only; the admin workbench's
// daily aggregation is the caller (through this module's index.ts).
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

export interface LinkLogCountRange {
  readonly appId: string;
  /** Inclusive start instant, ISO 8601 with offset (as @couli/domain chinaDayRange). */
  readonly start: string;
  /** Exclusive end instant. */
  readonly end: string;
}

/** link_logs of event=convert of the app created in [start, end). */
export async function countConvertLinkLogs(
  db: Kysely<DB>,
  input: LinkLogCountRange,
): Promise<bigint> {
  const row = await db
    .withSchema('app')
    .selectFrom('link_logs')
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .where('app_id', '=', input.appId)
    .where('event', '=', 'convert')
    .where('created_at', '>=', sql<Date>`${input.start}::timestamptz`)
    .where('created_at', '<', sql<Date>`${input.end}::timestamptz`)
    .executeTakeFirstOrThrow();
  return BigInt(row.total);
}
