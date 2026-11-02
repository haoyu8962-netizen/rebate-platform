// Unit tests of the processing round over a scripted driver (no PG connection): the stop check, an
// unavailable port's daily blocked line without cleaned_at, a failing request's log fields, and an
// Apple attempt without a keyring counting as a failure.
import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock, createRootLogger } from '../../platform/index.ts';
import type { DeletionCleanupPorts } from '../ports/deletion-cleanup.ts';
import { createDailyDedup } from './daily-dedup.ts';
import { createDeletionProcessing } from './deletion-processing.ts';

const APP = 'couli';
const REQUEST = '0199a3b4-5c6d-7e8f-9a0b-000000000010';
const USER = '0199a3b4-5c6d-7e8f-9a0b-000000000011';
const NOW = '2026-10-23T04:00:00.000Z';

interface Progress {
  status: string;
  cleaned_at: Date | null;
  apple_revoke_attempts: number;
  apple_revoke_result: string | null;
}

/** Answers each statement by its shape; records the SQL text with its parameters. */
function scriptedDb(progress: Progress, options: { appleCipher?: Buffer; failOn?: RegExp } = {}) {
  const queries: { text: string; values: unknown[] }[] = [];
  const answer = (text: string): { rows: unknown[]; rowCount: number } => {
    if (options.failOn !== undefined && options.failOn.test(text)) {
      const error = new Error('synthetic detail 13800138000');
      error.name = 'SyntheticFailure';
      throw error;
    }
    if (/^select "app_id", "id", "user_id" from "app"\."deletion_requests"/.test(text)) {
      return { rows: [{ app_id: APP, id: REQUEST, user_id: USER }], rowCount: 1 };
    }
    if (/^select "status", "cleaned_at"/.test(text)) return { rows: [progress], rowCount: 1 };
    if (/^select "id" from "app"\."users"/.test(text)) return { rows: [{ id: USER }], rowCount: 1 };
    if (/^select "id" from "app"\."deletion_requests"/.test(text)) {
      return { rows: [{ id: REQUEST }], rowCount: 1 };
    }
    if (/^select "apple_refresh_token_cipher"/.test(text)) {
      return options.appleCipher === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ apple_refresh_token_cipher: options.appleCipher }], rowCount: 1 };
    }
    if (/^update "app"\."deletion_requests" set "apple_revoke_attempts"/.test(text)) {
      progress.apple_revoke_attempts += 1;
      return { rows: [], rowCount: 1 };
    }
    if (/^update/.test(text)) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const client = {
    release: () => undefined,
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      return { command: text.split(' ')[0]!.toUpperCase(), ...answer(text) };
    },
  };
  const pool = { connect: async () => client, end: async () => undefined, options: {} };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  });
  return { db, queries };
}

function harness(db: Kysely<DB>, cleanup: DeletionCleanupPorts) {
  const clock = new FixedClock(NOW);
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'worker', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const appleCalls: unknown[] = [];
  const runner = createDeletionProcessing({
    db,
    clock,
    logger,
    cleanup,
    funds: { closingAdjustmentState: async () => 'none_needed' },
    withdrawals: { hasSucceeded: async () => false },
    apple: {
      async revoke(input) {
        appleCalls.push(input);
      },
    },
  });
  const warns = (msg: string) =>
    lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line['level'] === 40 && line['msg'] === msg);
  return { clock, lines, runner, warns, appleCalls };
}

const noop = async () => undefined;
const allAvailable: DeletionCleanupPorts = {
  linking: noop,
  growth: noop,
  notification: noop,
  agent: noop,
  catalog: noop,
};

it('[AC-B1-02zr] the re-verification data goes inside the cleanup transaction, scoped to the user, before the ports', async () => {
  const { db, queries } = scriptedDb({
    status: 'processing',
    cleaned_at: null,
    apple_revoke_attempts: 0,
    apple_revoke_result: null,
  });
  const portCalls: number[] = [];
  const h = harness(db, {
    ...allAvailable,
    linking: async () => void portCalls.push(queries.length),
  });
  await h.runner.runOnce();
  const texts = queries.map((q) => q.text);
  const update = queries.find((q) => /^update "app"\."users" set "nickname"/.test(q.text));
  const removal = queries.find((q) => /^delete from "app"\."reverified_devices"/.test(q.text));
  for (const column of [
    'last_active_at',
    'last_login_device_hash',
    'reverify_flagged_at',
    'reverify_trusted',
    'reverify_fail_day',
  ]) {
    expect(update?.text).toContain(`"${column}" = $`);
  }
  expect(update?.text).toContain('"reverify_fail_count" = $');
  expect(update?.text).not.toContain('reverify_fail_epoch');
  expect(removal?.values).toEqual([APP, USER]);
  const removedAt = texts.indexOf(removal!.text);
  const begun = texts.indexOf('begin');
  expect(begun).toBeGreaterThanOrEqual(0);
  expect(removedAt).toBeGreaterThan(begun);
  expect(removedAt).toBeLessThan(texts.indexOf('commit'));
  expect(portCalls).toHaveLength(1);
  expect(removedAt).toBeLessThan(portCalls[0]!);
});

it('[AC-B1-15g] a stop requested before the round: no statement, scanned 0', async () => {
  const { db, queries } = scriptedDb({
    status: 'processing',
    cleaned_at: null,
    apple_revoke_attempts: 0,
    apple_revoke_result: null,
  });
  const h = harness(db, allAvailable);
  expect(await h.runner.runOnce(() => true)).toEqual({ scanned: 0 });
  expect(queries).toEqual([]);
});

it('[AC-B1-15g] an unavailable port: the cleanup commits without cleaned_at, one blocked line per port and day, no Apple or completion', async () => {
  const { db, queries } = scriptedDb({
    status: 'processing',
    cleaned_at: null,
    apple_revoke_attempts: 0,
    apple_revoke_result: null,
  });
  const h = harness(db, { ...allAvailable, linking: { unavailable: 'W1' } });
  expect(await h.runner.runOnce()).toEqual({ scanned: 1 });
  expect(queries.filter((q) => q.text === 'commit')).toHaveLength(1);
  await h.runner.runOnce();
  const blocked = h.warns('identity_deletion_cleanup_blocked');
  expect(blocked).toHaveLength(1);
  expect(blocked[0]).toMatchObject({ app_id: APP, deletion_request_id: REQUEST, port: 'linking' });
  expect(queries.some((q) => /set "cleaned_at"/.test(q.text))).toBe(false);
  expect(queries.some((q) => /"user_oauth"/.test(q.text))).toBe(false);
  h.clock.set(new Date(Date.parse(NOW) + 86_400_000));
  await h.runner.runOnce();
  expect(h.warns('identity_deletion_cleanup_blocked')).toHaveLength(2);
});

it('[AC-B1-15g] a failing request: one cleanup_failed line with app_id, deletion_request_id and error_name only', async () => {
  const { db } = scriptedDb(
    { status: 'processing', cleaned_at: null, apple_revoke_attempts: 0, apple_revoke_result: null },
    { failOn: /^update "app"\."login_logs"/ },
  );
  const h = harness(db, allAvailable);
  await h.runner.runOnce();
  const failed = h.warns('identity_deletion_cleanup_failed');
  expect(failed).toHaveLength(1);
  const { level, time, pid, hostname, entry, env, msg, ...rest } = failed[0]!;
  void [level, time, pid, hostname, entry, env, msg];
  expect(rest).toEqual({
    app_id: APP,
    deletion_request_id: REQUEST,
    error_name: 'SyntheticFailure',
  });
  expect(h.lines.join('')).not.toContain('13800138000');
});

it('[AC-B1-15g] an Apple binding without a keyring: the attempt counts as failed, the revoker is not called', async () => {
  const progress = {
    status: 'processing',
    cleaned_at: new Date(NOW),
    apple_revoke_attempts: 0,
    apple_revoke_result: null,
  };
  const { db, queries } = scriptedDb(progress, { appleCipher: Buffer.from('opaque') });
  const h = harness(db, allAvailable);
  await h.runner.runOnce();
  expect(h.appleCalls).toEqual([]);
  const attempt = queries.find((q) =>
    /^update "app"\."deletion_requests" set "apple_revoke_attempts"/.test(q.text),
  );
  expect(attempt?.values.slice(0, 2)).toEqual([1, null]);
  expect(h.warns('identity_deletion_apple_revoke_failed')).toEqual([]);
});

it('[AC-B1-15g] the daily dedup: once per key and +08:00 day', () => {
  const dedup = createDailyDedup();
  const at = (iso: string) => new Date(iso);
  expect(dedup.first('k', at('2026-10-23T04:00:00.000Z'))).toBe(true);
  expect(dedup.first('k', at('2026-10-23T15:59:59.000Z'))).toBe(false);
  expect(dedup.first('other', at('2026-10-23T15:59:59.000Z'))).toBe(true);
  expect(dedup.first('k', at('2026-10-23T16:00:00.000Z'))).toBe(true);
});
