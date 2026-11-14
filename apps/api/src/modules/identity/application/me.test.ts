// Unit tests of accountAppealPrevState (CT-26e; BR-ID-36 细则) without a database: Kysely runs on
// a scripted driver. The query itself runs against PostgreSQL in the rule tests. Also
// maskedBoundPhone (B1-02zzza, D10-1610) with a stub cipher and logger.
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
import { expect, it } from 'vitest';
import { accountAppealPrevState, maskedBoundPhone } from './me.ts';

function setup(rows: readonly Record<string, unknown>[]) {
  const queries: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      queries.push(compiled);
      return Promise.resolve({ rows } as unknown as QueryResult<R>);
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, queries };
}

const SUBJECT = { appId: 'couli', userId: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a01' };

it('[AC-CT-26e-UNIT#7] reads only the processing account appeal of the caller and returns its prev_risk_state', async () => {
  const { db, queries } = setup([{ prev_risk_state: 'banned' }]);
  expect(await accountAppealPrevState(db, SUBJECT)).toBe('banned');
  expect(queries).toHaveLength(1);
  const query = queries[0]!;
  expect(query.sql).toContain('from "app"."appeals"');
  expect(query.sql).toContain(
    'where "app_id" = $1 and "user_id" = $2 and "target_type" = $3 and "target_id" = $4 and "status" = $5',
  );
  expect(query.parameters).toEqual([
    'couli',
    SUBJECT.userId,
    'account',
    SUBJECT.userId,
    'processing',
    1,
  ]);
});

it('[AC-CT-26e-UNIT#8] no appeal or a value outside frozen / banned → null', async () => {
  expect(await accountAppealPrevState(setup([]).db, SUBJECT)).toBeNull();
  expect(await accountAppealPrevState(setup([{ prev_risk_state: null }]).db, SUBJECT)).toBeNull();
  expect(
    await accountAppealPrevState(setup([{ prev_risk_state: 'normal' }]).db, SUBJECT),
  ).toBeNull();
  expect(await accountAppealPrevState(setup([{ prev_risk_state: 'frozen' }]).db, SUBJECT)).toBe(
    'frozen',
  );
});

function phoneDeps(decrypt: (cipher: string, context: string) => string) {
  const warns: { fields: Record<string, unknown>; message: string }[] = [];
  return {
    warns,
    deps: {
      crypto: { decrypt },
      logger: {
        warn: (fields: Record<string, unknown>, message: string) => {
          warns.push({ fields, message });
        },
      } as never,
    },
  };
}

it('[AC-B1-02zzza-UNIT#1] decrypts the bound phone in the users.phone context and masks it 3+4', () => {
  const seen: string[] = [];
  const { deps, warns } = phoneDeps((cipher, context) => {
    seen.push(`${cipher}|${context}`);
    return '13800138000';
  });
  expect(maskedBoundPhone(deps, Buffer.from('v1:abc', 'utf8'), SUBJECT.userId)).toBe('138****8000');
  expect(seen).toEqual(['v1:abc|users.phone']);
  expect(warns).toEqual([]);
});

it('[AC-B1-02zzza-UNIT#2] D10-1610: bound but phone_cipher missing → null, one warn with only user id and reason', () => {
  const { deps, warns } = phoneDeps(() => {
    throw new Error('not called');
  });
  expect(maskedBoundPhone(deps, null, SUBJECT.userId)).toBeNull();
  expect(warns).toEqual([
    {
      fields: { user_id: SUBJECT.userId, reason: 'phone_cipher_missing' },
      message: 'identity_me_masked_phone_unavailable',
    },
  ]);
});

it('[AC-B1-02zzza-UNIT#3] D10-1610: decrypt fails → null (no throw), one warn without the cipher or error text', () => {
  const { deps, warns } = phoneDeps(() => {
    throw new Error('bad tag for v1:secret-cipher');
  });
  expect(
    maskedBoundPhone(deps, Buffer.from('v1:secret-cipher', 'utf8'), SUBJECT.userId),
  ).toBeNull();
  expect(warns).toEqual([
    {
      fields: { user_id: SUBJECT.userId, reason: 'phone_decrypt_failed' },
      message: 'identity_me_masked_phone_unavailable',
    },
  ]);
  expect(JSON.stringify(warns)).not.toContain('secret-cipher');
});
