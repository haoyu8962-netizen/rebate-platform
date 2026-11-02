import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect } from 'vitest';
import { FixedClock, type Clock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type {
  RebateDependencies,
  RebateHoldAudit,
} from '../../../../apps/api/src/modules/settlement/index.ts';

const ROOT = new URL('../../../../', import.meta.url);

// Expected values come from the task notes and contracts/enums/admin.yaml (audit_system_actor),
// never from production constants.
export const SYSTEM_RISK = 'system:risk';
export const SYSTEM_RISK_NAME = '系统（风控）';
export const AUTO_HOLD = 'order_auto_hold';
export const UNMAPPED = 'UNMAPPED_STATUS';

/** An instant no test clock uses: a row carrying it took `at` from the input, not from Clock. */
const INPUT_AT = new FixedClock('2001-02-03T04:05:06.000Z').now();

interface AdminSystemAudit {
  createSystemAuditWriter(deps: { readonly clock: Clock }): RebateDependencies['audit'];
}

/** The adapter as other code gets it: admin's public surface, typed by settlement's port. */
export async function systemAudit(clock: Clock): Promise<RebateDependencies['audit']> {
  // Do not pull Nest decorators into the erasable-only rule-test TypeScript project.
  const admin = (await import(
    new URL('apps/api/src/modules/admin/index.ts', ROOT).href
  )) as AdminSystemAudit;
  return admin.createSystemAuditWriter({ clock });
}

export function holdAudit(
  appId: string,
  orderId: string = randomUUID(),
  reasonBefore: string | null = null,
): RebateHoldAudit {
  return {
    appId,
    orderId,
    attrAt: INPUT_AT,
    actor: 'system:risk',
    reason: 'UNMAPPED_STATUS',
    before: { hold: false, holdReason: reasonBefore },
    after: { hold: true, holdReason: 'UNMAPPED_STATUS' },
    at: INPUT_AT,
  };
}

/** One committed system row written by the real adapter; returns its order id. */
export async function appendHold(
  db: Kysely<DB>,
  clock: Clock,
  appId: string,
  orderId: string = randomUUID(),
): Promise<string> {
  const writer = await systemAudit(clock);
  await db.transaction().execute((trx) => writer.append(trx, holdAudit(appId, orderId)));
  return orderId;
}

export interface StoredAudit {
  readonly app_id: string;
  readonly admin_id: string | null;
  readonly system_actor: string | null;
  readonly action: string;
  readonly target: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly ip: string | null;
  readonly at: Date;
}

/** Raw read: system_actor is not in the generated types of the test phase. */
export async function stored(db: Kysely<DB>, appId: string): Promise<StoredAudit[]> {
  const result = await sql<StoredAudit>`select * from app.audit_logs
    where app_id = ${appId} order by id`.execute(db);
  return result.rows;
}

/** A stored snapshot: the hold flag plus exactly one field, the reason code (its key is free). */
export function expectHoldSnapshot(value: unknown, hold: boolean, reason: string | null) {
  expect(value).toMatchObject({ hold });
  const others = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== 'hold')
    .map(([, field]) => field);
  expect(others).toEqual([reason]);
}

/**
 * A handle bound once, like createDb's. auth/kit.ts binds the schema a second time on h.db, which
 * this returns to the createDb form on the same pool: createDb adds no plugin but the schema.
 */
export function singleBound(db: Kysely<DB>): Kysely<DB> {
  return db.withoutPlugins().withSchema('app');
}

interface ProvisionedDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

/** The provisioner is passed in by the *.int.test.ts file, the only place allowed to import it. */
export function useDatabase(provision: () => Promise<ProvisionedDatabase>) {
  let database: ProvisionedDatabase | undefined;
  let db: Kysely<DB>;
  beforeAll(async () => {
    database = await provision();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  }, 180_000);
  afterAll(async () => {
    try {
      if (db !== undefined) await destroyDb(db);
    } finally {
      await database?.drop();
    }
  }, 30_000);
  return { db: () => db };
}

/**
 * Inserts one audit row by hand (the actor columns are the rule under test): 'accepted', or the
 * SQLSTATE the database refused it with.
 */
export async function insertState(
  db: Kysely<DB>,
  appId: string,
  adminId: string | null,
  systemActor: string | null,
): Promise<string> {
  try {
    await sql`insert into app.audit_logs (app_id, admin_id, system_actor, action, target, at)
      values (${appId}, ${adminId}::uuid, ${systemActor}::text, ${AUTO_HOLD},
        ${`orders:${randomUUID()}`}, '2026-10-08T03:00:00.000Z'::timestamptz)`.execute(db);
    return 'accepted';
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
}
