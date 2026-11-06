import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { describe, expect, it } from 'vitest';
import { LinkingUnionIdentity } from './link-open-conversion.ts';
import {
  activatePddBinding,
  generatePddAuthorityLink,
  PDD_QUERY_CONCURRENCY,
  queryPddAuthority,
} from './pdd-authority.ts';

// Synthetic ids of one app's user and one union account.
const APP = 'synthetic-app';
const USER = '0199a3b4-5c6d-7000-8000-0000000000a1';
const ACCOUNT = '0199a3b4-5c6d-7000-8000-0000000000b1';
const NOW = new Date('2026-10-18T02:00:00.000Z');
const RELEASED_AT = new Date('2026-08-01T00:00:00.000Z');

/**
 * A scripted connection: every statement is recorded, and the answer is chosen by the table it
 * reads. The user's only pdd row is an old released one at row_version 3; `banned` sets the
 * committed risk state.
 */
function scripted(banned = false): { readonly db: Kysely<DB>; readonly statements: string[] } {
  const statements: string[] = [];
  const rowsFor = (sql: string): unknown[] => {
    if (sql.includes('from "users"')) return [{ id: USER }];
    if (sql.includes('from "user_risk_state"')) return banned ? [{ state: 'banned' }] : [];
    if (sql.startsWith('insert into "union_bindings"')) {
      return [{ id: '0199a3b4-5c6d-7000-8000-0000000000c2', union_account_id: ACCOUNT }];
    }
    if (sql.includes('from "union_bindings"')) {
      return [
        {
          id: '0199a3b4-5c6d-7000-8000-0000000000c1',
          status: 'released',
          union_account_id: ACCOUNT,
          row_version: 3,
          released_at: RELEASED_AT,
          cooldown_until: RELEASED_AT,
        },
      ];
    }
    return [];
  };
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(query.sql);
      return { rows: rowsFor(query.sql) as R[], numAffectedRows: 0n };
    },
    async *streamQuery() {
      throw new Error('not streamed');
    },
  };
  const driver: Driver = {
    async init() {},
    async acquireConnection() {
      return connection;
    },
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    async releaseConnection() {},
    async destroy() {},
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, statements };
}

const clock = { now: () => NOW } as Parameters<typeof activatePddBinding>[1];
const input = { appId: APP, userId: USER, accountId: ACCOUNT, custom: '{"app":"n"}' };

describe('activatePddBinding user lock (F1-07c, BR-ID-20 / BR-ID-31)', () => {
  it('[AC-F1-07c] the user lock comes first; a banned user gets banned and nothing is written', async () => {
    const { db, statements } = scripted(true);
    const written = await activatePddBinding(db, clock, input);
    expect(written).toEqual({ kind: 'banned' });
    expect(statements[0]).toContain('for no key update');
    expect(statements.some((s) => s.startsWith('insert'))).toBe(false);
    expect(statements.some((s) => s.startsWith('update'))).toBe(false);
  });

  it('[AC-F1-07c] a valid filing activates as before, after the lock and outside its savepoints', async () => {
    const { db, statements } = scripted();
    const written = await activatePddBinding(db, clock, input);
    expect(written.kind).toBe('active');
    expect(statements[0]).toContain('for no key update');
    expect(statements.some((s) => s.includes('from "union_auth_sessions"'))).toBe(false);
    expect(statements.some((s) => s.startsWith('insert into "union_bindings"'))).toBe(true);
  });
});

describe('generatePddAuthorityLink shares PDD_QUERY_CONCURRENCY (B1-04zzj, D10-692 S2-8)', () => {
  const identity = new LinkingUnionIdentity({
    appId: APP,
    platform: 'pdd',
    promotionSlot: 'synthetic-pid',
    userKey: 'pdd0000a',
    customParameters: { app: 'n', uid: 'pdd0000a', sc: 'self_buy' },
  });
  const input = { appId: APP, identity, traceId: 'synthetic-trace', events: 'linking.unit' };

  it('[B1-04zzj unit] failing generations free their slots: then every query slot is free, and a generation over the cap waits for one', async () => {
    const gates: PromiseWithResolvers<unknown>[] = [];
    let generated = 0;
    const adapter = {
      pddAuthorityUrl: async () => {
        generated += 1;
        const gate = Promise.withResolvers<unknown>();
        gates.push(gate);
        return gate.promise;
      },
      queryPddAuthority: async () => ({ authorized: true }),
    };
    const deps = {
      registry: { get: () => adapter },
      logger: { warn: () => undefined },
    } as unknown as Parameters<typeof generatePddAuthorityLink>[0];
    const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

    // Every slot taken by a generation that then fails (throw / null answer / no web link).
    const failing = Array.from({ length: PDD_QUERY_CONCURRENCY }, () =>
      generatePddAuthorityLink(deps, input),
    );
    const waiting = generatePddAuthorityLink(deps, input);
    await tick();
    expect(generated).toBe(PDD_QUERY_CONCURRENCY);
    // A query over the cap is refused at once, without calling the port.
    expect(await queryPddAuthority(deps, input)).toBeNull();

    gates[0]!.reject(new Error('synthetic failure'));
    await tick();
    // The freed slot went to the waiting generation, not back to the pool.
    expect(generated).toBe(PDD_QUERY_CONCURRENCY + 1);
    expect(await queryPddAuthority(deps, input)).toBeNull();
    gates
      .slice(1, PDD_QUERY_CONCURRENCY)
      .forEach((gate, i) =>
        gate.resolve(i % 2 === 0 ? null : { short_url: 'https://short.example.invalid/s/unit' }),
      );
    expect(await Promise.all(failing)).toEqual(
      Array.from({ length: PDD_QUERY_CONCURRENCY }, () => null),
    );
    gates[PDD_QUERY_CONCURRENCY]!.resolve({ url: 'https://landing.example.invalid/unit' });
    expect(await waiting).toEqual({ webUrl: 'https://landing.example.invalid/unit', scheme: null });

    // All slots are free again: the cap's worth of queries enter at once.
    const queries = await Promise.all(
      Array.from({ length: PDD_QUERY_CONCURRENCY }, () => queryPddAuthority(deps, input)),
    );
    expect(queries).toEqual(Array.from({ length: PDD_QUERY_CONCURRENCY }, () => true));
  });
});
