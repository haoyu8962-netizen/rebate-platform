// Unit tests of the B2-02ze money r1 S1 fix (item 4) without a database: create and retry read
// the creator's display name inside their transaction, before the COMMIT, and run nothing that
// reads the database after it. Kysely runs on a scripted driver that records the statements and
// the transaction boundaries; a display-name reader that would time out (57014) is never asked.
import { randomUUID } from 'node:crypto';
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
import { expect, it, vi } from 'vitest';
import { FixedClock, type ExportStore, type JobQueue } from '../../platform/index.ts';
import { createAdminExports } from './admin-exports.ts';

const APP = 'couli';
const ADMIN = randomUUID();
const NOW = '2026-10-09T02:00:00.000Z';

function taskRow(patch: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    app_id: APP,
    public_id: 'exp_x',
    resource: 'users',
    filters: {},
    filters_summary: '',
    masked: false,
    created_by: ADMIN,
    status: 'pending',
    progress: null,
    failure_reason: null,
    file_name: null,
    object_key: null,
    row_count: null,
    generated_at: null,
    expires_at: null,
    created_at: new Date(NOW),
    updated_at: new Date(NOW),
    row_version: 0,
    ...patch,
  };
}

function setup(creator: { display_name: string | null; login_name: string }) {
  const events: string[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      events.push(compiled.sql);
      if (compiled.sql.includes('from "app"."admin_users"')) {
        return Promise.resolve({ rows: [{ status: 'active', ...creator }] } as QueryResult<R>);
      }
      if (compiled.sql.startsWith('insert into "app"."export_tasks"')) {
        return Promise.resolve({ rows: [taskRow()] } as QueryResult<R>);
      }
      if (compiled.sql.startsWith('update "app"."export_tasks"')) {
        return Promise.resolve({ rows: [taskRow({ row_version: 4 })] } as QueryResult<R>);
      }
      return Promise.resolve({ rows: [], numAffectedRows: 1n } as QueryResult<R>);
    },
    streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => {
      events.push('BEGIN');
    },
    commitTransaction: async () => {
      events.push('COMMIT');
    },
    rollbackTransaction: async () => {
      events.push('ROLLBACK');
    },
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
  const queue = { send: vi.fn(async () => 'job') } as unknown as JobQueue;
  // The money r1 scenario: the display-name read after the COMMIT hit a statement timeout.
  const displayNames = vi.fn(async () => {
    throw Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
  });
  const exports = createAdminExports({
    db,
    clock: new FixedClock(NOW),
    queue,
    store: {} as ExportStore,
    profiles: { permissionKeys: async () => [] },
    names: { displayNames },
  });
  const actor = { appId: APP, adminId: ADMIN, isSuper: true, loginName: 'ops' };
  return { exports, events, displayNames, actor };
}

it('[AC-B2-02ze-R3#4] money r1 第 4 条：明文导出 create 的创建人显示名在提交前于事务内读取，提交后不再读库（显示名读取器即使会 57014 也不被调用）', async () => {
  const s = setup({ display_name: '财务小王', login_name: 'fin' });
  const view = await s.exports.create(
    s.actor,
    { resource: 'users', filters: {}, unmasked: true, reason: '季度核对' },
    null,
  );
  expect(view.created_by_name).toBe('财务小王');
  expect(s.displayNames).not.toHaveBeenCalled();
  const read = s.events.findIndex((text) => text.includes('from "app"."admin_users"'));
  const commit = s.events.indexOf('COMMIT');
  expect(s.events.indexOf('BEGIN')).toBeLessThan(read);
  expect(read).toBeLessThan(commit);
  // Nothing at all reaches the database after the COMMIT.
  expect(commit).toBe(s.events.length - 1);
});

it('[AC-B2-02ze-R3#4] money r1 第 4 条：retry 同样在提交前读显示名；display_name 为空时取 login_name（与 AdminDisplayNameReader 一致）', async () => {
  const s = setup({ display_name: '', login_name: 'fin' });
  const failed = taskRow({ status: 'failed', row_version: 3, masked: false }) as never;
  const view = await s.exports.retry(s.actor, { task: failed, reason: '重新生成' }, null);
  expect(view.created_by_name).toBe('fin');
  expect(s.displayNames).not.toHaveBeenCalled();
  const read = s.events.findIndex((text) => text.includes('from "app"."admin_users"'));
  const commit = s.events.indexOf('COMMIT');
  expect(read).toBeLessThan(commit);
  expect(commit).toBe(s.events.length - 1);
});
