// Unit tests of the operations reset's use case (B1-34t) on a scripted Kysely driver: no database.
// The driver answers each statement from a queue and records the SQL and the transaction calls.
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
import { FixedClock } from '../../platform/index.ts';
import { issuedBeforeVoid } from '../infra/admin-revocations.ts';
import {
  OPERATOR_TOTP_RESET_REASON_MAX,
  createOperatorTotpReset,
  createTerminalLineEditor,
  operatorResetReasonOk,
  type OperatorTotpResetDeps,
} from './operator-totp-reset.ts';

const APP = 'couli';
const LOGIN = 'owner-admin';
const REQUEST = { appId: APP, loginName: LOGIN, reason: '已当面核对本人身份' };
const BOUND = new Date('2026-11-20T02:00:00.000Z');

interface Row {
  id: string;
  login_name: string;
  is_super: boolean;
  status: string;
  totp_bound_at: Date | null;
  row_version: number;
}

const row = (fields: Partial<Row> = {}): Row => ({
  id: '00000000-0000-7000-8000-000000000001',
  login_name: LOGIN,
  is_super: true,
  status: 'active',
  totp_bound_at: BOUND,
  row_version: 3,
  ...fields,
});

function scripted(answers: QueryResult<unknown>[], commitFailures = 0) {
  let failingCommits = commitFailures;
  const sqls: string[] = [];
  const events: string[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      sqls.push(query.sql);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`unexpected statement: ${query.sql}`);
      return Promise.resolve(answer as QueryResult<R>);
    },
    streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => {
      events.push('begin');
    },
    commitTransaction: async () => {
      if (failingCommits > 0) {
        failingCommits -= 1;
        events.push('commit-failed');
        throw new Error('synthetic commit failure');
      }
      events.push('commit');
    },
    rollbackTransaction: async () => {
      events.push('rollback');
    },
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, sqls, events };
}

function setup(answers: QueryResult<unknown>[], commitFailures = 0) {
  const s = scripted(answers, commitFailures);
  const clock = new FixedClock('2026-11-25T02:00:00.250Z');
  const appendAction = vi.fn<OperatorTotpResetDeps['audit']['appendAction']>(async () => {
    s.events.push('audit');
  });
  // In-memory voiding instant that, like the Redis script, keeps the later instant.
  let voidedAt: number | null = null;
  const voidBefore = vi.fn<OperatorTotpResetDeps['revocations']['voidBefore']>(async (_, atMs) => {
    s.events.push('void');
    voidedAt = voidedAt === null ? atMs : Math.max(voidedAt, atMs);
  });
  const useCase = createOperatorTotpReset({
    db: s.db,
    clock,
    audit: { appendAction },
    revocations: { voidBefore },
  });
  return { ...s, clock, appendAction, voidBefore, useCase, voidedAt: () => voidedAt };
}

const rows = (...list: Row[]): QueryResult<unknown> => ({ rows: list });
const updated = (count: bigint): QueryResult<unknown> => ({ rows: [], numAffectedRows: count });

it('[AC-B1-34t] the reason is 1–200 characters and not whitespace only', () => {
  expect(operatorResetReasonOk('因')).toBe(true);
  expect(operatorResetReasonOk('因'.repeat(OPERATOR_TOTP_RESET_REASON_MAX))).toBe(true);
  expect(operatorResetReasonOk('因'.repeat(OPERATOR_TOTP_RESET_REASON_MAX + 1))).toBe(false);
  expect(operatorResetReasonOk('')).toBe(false);
  expect(operatorResetReasonOk(' \t\n ')).toBe(false);
  // Counted in characters (code points), not UTF-16 units.
  expect(operatorResetReasonOk('😀'.repeat(OPERATOR_TOTP_RESET_REASON_MAX))).toBe(true);
});

it('[AC-B1-34t] an invalid reason is refused before any statement', async () => {
  const f = setup([]);
  expect(await f.useCase.reset({ ...REQUEST, reason: '   ' })).toEqual({
    kind: 'refused',
    reason: 'invalid_reason',
  });
  expect(f.sqls).toEqual([]);
  expect(f.events).toEqual([]);
});

it('[AC-B1-34t] the target and every super admin of the app are locked in one statement', async () => {
  const f = setup([rows()]);
  await f.useCase.reset({ ...REQUEST, loginName: 'missing' });
  expect(f.sqls).toHaveLength(1);
  const lock = f.sqls[0] ?? '';
  expect(lock).toMatch(/for update$/);
  expect(lock).toContain('"app_id" = $1');
  expect(lock).toContain('"login_name" = $2 or "is_super" = $3');
  expect(lock).toContain('order by "id"');
});

it.each([
  ['unknown', [] as Row[]],
  ['not_super', [row({ is_super: false })]],
  [
    'another_usable_super',
    [row(), row({ id: '00000000-0000-7000-8000-000000000002', login_name: 'other' })],
  ],
] as const)(
  '[AC-B1-34t] %s is refused, rolled back, nothing audited or voided',
  async (reason, list) => {
    const f = setup([rows(...list)]);
    expect(await f.useCase.reset(REQUEST)).toEqual({ kind: 'refused', reason });
    expect(f.events).toEqual(['begin', 'rollback']);
    expect(f.sqls).toHaveLength(1);
    expect(f.appendAction).not.toHaveBeenCalled();
    expect(f.voidBefore).not.toHaveBeenCalled();
  },
);

it('[AC-B1-34t] disabled or unbound super admins do not block; the reset clears, audits, voids, commits', async () => {
  const others = [
    row({ id: '00000000-0000-7000-8000-000000000002', login_name: 'off', status: 'disabled' }),
    row({ id: '00000000-0000-7000-8000-000000000003', login_name: 'nb', totp_bound_at: null }),
  ];
  const f = setup([rows(row(), ...others), updated(1n)]);
  expect(await f.useCase.reset(REQUEST)).toEqual({ kind: 'reset' });
  expect(f.events).toEqual(['begin', 'audit', 'void', 'commit']);
  const update = f.sqls[1] ?? '';
  expect(update).toMatch(
    /^update "admin_users" set "totp_secret_cipher" = \$1, "totp_bound_at" = \$2, "totp_last_step" = \$3, "row_version" = \$4/,
  );
  expect(update).toContain('"row_version" = $');
  const target = row();
  expect(f.appendAction).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    appId: APP,
    actor: 'system:ops_command',
    action: 'admin_totp_reset',
    target: `admins:${target.id}`,
    before: { totp_bound: true },
    after: { admin_id: target.id, totp_bound: false, reason: REQUEST.reason },
  });
  expect(f.voidBefore).toHaveBeenCalledExactlyOnceWith(
    { appId: APP, adminId: target.id },
    f.clock.now().getTime(),
  );
});

it('[AC-B1-34t] a lost row_version race throws and rolls back before the audit', async () => {
  const f = setup([rows(row()), updated(0n)]);
  await expect(f.useCase.reset(REQUEST)).rejects.toThrow('locked account row not updated');
  expect(f.events).toEqual(['begin', 'rollback']);
  expect(f.voidBefore).not.toHaveBeenCalled();
});

it('[AC-B1-34t] a failing voiding write rolls the reset and its audit back', async () => {
  const f = setup([rows(row()), updated(1n)]);
  f.voidBefore.mockRejectedValueOnce(new Error('synthetic redis failure'));
  await expect(f.useCase.reset(REQUEST)).rejects.toThrow('synthetic redis failure');
  expect(f.events).toEqual(['begin', 'audit', 'rollback']);
});

it('[AC-B1-34t] inspect reads the binding state by app and login name, null when unknown', async () => {
  const f = setup([rows(row()), rows(row({ totp_bound_at: null })), rows()]);
  expect(await f.useCase.inspect({ appId: APP, loginName: LOGIN })).toEqual({
    totpBound: true,
    snapshot: { rowVersion: 3, totpBoundAtMs: BOUND.getTime() },
  });
  expect(await f.useCase.inspect({ appId: APP, loginName: LOGIN })).toEqual({
    totpBound: false,
    snapshot: { rowVersion: 3, totpBoundAtMs: null },
  });
  expect(await f.useCase.inspect({ appId: APP, loginName: 'missing' })).toBeNull();
  expect(f.sqls[0]).toContain('where "app_id" = $1 and "login_name" = $2');
  expect(f.sqls[0]).not.toContain('for update');
});

it('[AC-B1-34t] an already unbound target is not written, audited or voided', async () => {
  const f = setup([rows(row({ totp_bound_at: null }))]);
  expect(await f.useCase.reset(REQUEST)).toEqual({ kind: 'already_unbound' });
  expect(f.sqls).toHaveLength(1);
  expect(f.events).toEqual(['begin', 'rollback']);
  expect(f.appendAction).not.toHaveBeenCalled();
  expect(f.voidBefore).not.toHaveBeenCalled();
});

it('[AC-B1-34t] another usable super admin is refused before already_unbound is judged', async () => {
  const f = setup([
    rows(
      row({ totp_bound_at: null }),
      row({ id: '00000000-0000-7000-8000-000000000002', login_name: 'other' }),
    ),
  ]);
  expect(await f.useCase.reset(REQUEST)).toEqual({
    kind: 'refused',
    reason: 'another_usable_super',
  });
});

it('[AC-B1-34t] a rerun after a reset audits once and keeps the binding ticket issued since valid', async () => {
  const f = setup([rows(row()), updated(1n), rows(row({ totp_bound_at: null, row_version: 4 }))]);
  expect(await f.useCase.reset(REQUEST)).toEqual({ kind: 'reset' });
  const firstVoid = f.clock.now().getTime();
  // The owner opens a binding ticket after the reset, then the command is run again.
  f.clock.advanceMs(60_000);
  const ticketIssuedAt = f.clock.now().getTime();
  f.clock.advanceMs(60_000);
  expect(await f.useCase.reset(REQUEST)).toEqual({ kind: 'already_unbound' });
  expect(f.appendAction).toHaveBeenCalledOnce();
  expect(f.voidBefore).toHaveBeenCalledOnce();
  expect(f.voidedAt()).toBe(firstVoid);
  expect(issuedBeforeVoid(ticketIssuedAt, f.voidedAt())).toBe(false);
});

it('[AC-B1-34t] once a new authenticator is bound, a rerun is a new reset', async () => {
  const rebound = new Date('2026-11-25T03:00:00.000Z');
  const f = setup([
    rows(row()),
    updated(1n),
    rows(row({ totp_bound_at: rebound, row_version: 5 })),
    updated(1n),
  ]);
  expect(await f.useCase.reset(REQUEST)).toEqual({ kind: 'reset' });
  f.clock.advanceMs(3_600_000);
  expect(await f.useCase.reset(REQUEST)).toEqual({ kind: 'reset' });
  expect(f.appendAction).toHaveBeenCalledTimes(2);
  expect(f.voidedAt()).toBe(f.clock.now().getTime());
});

it('[AC-B1-34t] after a commit failure (voiding already written) a rerun completes the reset', async () => {
  // The row is still bound after the rollback, so the rerun reads it bound again.
  const f = setup([rows(row()), updated(1n), rows(row()), updated(1n)], 1);
  await expect(f.useCase.reset(REQUEST)).rejects.toThrow('synthetic commit failure');
  expect(f.events).toEqual(['begin', 'audit', 'void', 'commit-failed', 'rollback']);
  f.clock.advanceMs(5_000);
  expect(await f.useCase.reset(REQUEST)).toEqual({ kind: 'reset' });
  expect(f.events.slice(5)).toEqual(['begin', 'audit', 'void', 'commit']);
  expect(f.voidedAt()).toBe(f.clock.now().getTime());
});

const utf8 = (text: string) => new TextEncoder().encode(text);

it('[AC-B1-34t] a Chinese reason whose UTF-8 bytes are split over two chunks reads back verbatim', () => {
  const reason = '已当面核对本人身份';
  const bytes = utf8(`${reason}\r`);
  // Cut right after the first of the three bytes of「核」.
  const cut = utf8('已当面').length + 1;
  const editor = createTerminalLineEditor();
  const first = editor.feed(bytes.slice(0, cut));
  expect(first.done).toBeUndefined();
  expect(first.echo).toBe('已当面');
  const second = editor.feed(bytes.slice(cut));
  expect(second).toEqual({ echo: '核对本人身份', done: reason });
  expect(second.done).not.toContain('\uFFFD');
});

it('[AC-B1-34t] the line editor splits every byte apart, erases code points, aborts on Ctrl-C', () => {
  const editor = createTerminalLineEditor();
  const steps = [...utf8('本人😀x\u007f\u007f确认\n')].map((byte) =>
    editor.feed(Uint8Array.of(byte)),
  );
  expect(steps.at(-1)?.done).toBe('本人确认');
  expect(steps.slice(0, -1).every((step) => step.done === undefined)).toBe(true);
  const aborted = createTerminalLineEditor();
  expect(aborted.feed(utf8('原因\u0003')).done).toBeNull();
});

const REBOUND = new Date('2026-11-25T02:30:00.000Z');

async function previewSnapshot(useCase: ReturnType<typeof setup>['useCase']) {
  const snapshot = (await useCase.inspect({ appId: APP, loginName: LOGIN }))?.snapshot;
  if (snapshot === undefined) throw new Error('inspect returned no snapshot');
  return snapshot;
}

it.each([
  // Unbound at the preview, then the owner binds a new authenticator (bindTotp keeps row_version).
  ['unbound → bound', row({ totp_bound_at: null }), row({ totp_bound_at: REBOUND })],
  // Bound at the preview, then unbound (e.g. a super admin's HTTP reset bumped row_version).
  ['bound → unbound', row(), row({ totp_bound_at: null, row_version: 4 })],
  // Bound at the preview, then a new authenticator bound after a reset in between.
  ['bound → rebound', row(), row({ totp_bound_at: REBOUND, row_version: 4 })],
  // Same binding, another write on the row (row_version only).
  ['row_version only', row(), row({ row_version: 4 })],
] as const)(
  '[AC-B1-34t] a row changed after the preview (%s) is state_changed: not written, audited or voided',
  async (_label, previewed, locked) => {
    const f = setup([rows(previewed), rows(locked)]);
    const expected = await previewSnapshot(f.useCase);
    expect(await f.useCase.reset({ ...REQUEST, expected })).toEqual({
      kind: 'state_changed',
    });
    // inspect + the lock, no update.
    expect(f.sqls).toHaveLength(2);
    expect(f.sqls.some((sql) => sql.startsWith('update'))).toBe(false);
    expect(f.events).toEqual(['begin', 'rollback']);
    expect(f.appendAction).not.toHaveBeenCalled();
    expect(f.voidBefore).not.toHaveBeenCalled();
    expect(f.voidedAt()).toBeNull();
  },
);

it('[AC-B1-34t] an unchanged row since the preview is reset as usual', async () => {
  const f = setup([rows(row()), rows(row()), updated(1n)]);
  const expected = await previewSnapshot(f.useCase);
  expect(await f.useCase.reset({ ...REQUEST, expected })).toEqual({
    kind: 'reset',
  });
  expect(f.appendAction).toHaveBeenCalledOnce();
  expect(f.voidBefore).toHaveBeenCalledOnce();
});

it('[AC-B1-34t] an unchanged unbound row since the preview is still already_unbound', async () => {
  const f = setup([rows(row({ totp_bound_at: null })), rows(row({ totp_bound_at: null }))]);
  const expected = await previewSnapshot(f.useCase);
  expect(await f.useCase.reset({ ...REQUEST, expected })).toEqual({
    kind: 'already_unbound',
  });
});

it('[AC-B1-34t] a leading byte order mark is kept, so a BOM-prefixed yes is not yes', () => {
  const editor = createTerminalLineEditor();
  const step = editor.feed(Uint8Array.of(0xef, 0xbb, 0xbf, ...utf8('yes\r')));
  expect(step.done).toBe('\uFEFFyes');
  expect(step.done).not.toBe('yes');
  // Split over chunks as well.
  const split = createTerminalLineEditor();
  expect(split.feed(Uint8Array.of(0xef, 0xbb)).done).toBeUndefined();
  expect(split.feed(Uint8Array.of(0xbf, ...utf8('yes\n'))).done).toBe('\uFEFFyes');
});
