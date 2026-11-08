// Unit tests of the archive override of executeInTransaction (task B1-01zzs; contract in
// ./archive.ts). A scripted driver runs Kysely's real transaction wrapper without a database and
// records every statement with its parameters, so the stored response can be read back.
import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../clock/index.ts';
import type { IdempotencyArchiveOptions } from './archive.ts';
import {
  IdempotencyError,
  createIdempotency,
  requestHashOf,
  type HandlerResult,
  type IdempotentRequest,
  type ResponseEnvelope,
} from './index.ts';

const request: IdempotentRequest = {
  appId: 'couli',
  actor: { userId: '0199a3b4-5c6d-7e8f-9a0b-000000000001', deviceId: null, phoneHmac: null },
  method: 'POST',
  path: '/v1/auth/merge',
  key: 'unit-archive-key',
  body: { merge_ticket: 'unit-ticket' },
  traceId: 'unit-trace',
};

function fixture(row?: Record<string, unknown>) {
  const calls: { text: string; parameters: readonly unknown[] }[] = [];
  const client = {
    release: vi.fn(),
    async query(text: string, parameters: readonly unknown[] = []) {
      calls.push({ text, parameters });
      let rows: unknown[] = [];
      if (text.includes('pg_try_advisory_xact_lock')) rows = [{ acquired: true }];
      else if (text.includes('current_setting')) rows = [{ value: '0' }];
      else if (text.startsWith('select') && row !== undefined) rows = [row];
      else if (text.startsWith('insert'))
        rows = [{ id: 1n, ownership_created_at: '2031-01-01 00:00:00+00' }];
      return { command: 'SELECT', rowCount: rows.length, rows };
    },
  };
  const pool = { connect: async () => client, end: async () => undefined, options: {} };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  }).withSchema('app');
  const idem = createIdempotency({
    db,
    clock: new FixedClock('2031-01-01T00:00:00Z'),
    logger: { warn: vi.fn(), error: vi.fn() },
  });
  const texts = () => calls.map((call) => call.text);
  const updates = () => calls.filter((call) => call.text.startsWith('update'));
  /** The `response` written by the completed update, if any. */
  const storedResponse = () => {
    const update = updates()[0];
    if (update === undefined) return undefined;
    const value = update.parameters.find(
      (parameter) =>
        (typeof parameter === 'string' && parameter.includes('"body"')) ||
        (typeof parameter === 'object' && parameter !== null && 'body' in parameter),
    );
    return typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  };
  return { db, idem, texts, updates, storedResponse };
}

function envelope(code = 0): ResponseEnvelope {
  return {
    code,
    msg: '',
    data: { user_id: 'u-target', tokens: { access: 'at-unit-1', refresh: 'rt-unit-1' } },
    trace_id: 'unit-trace',
  };
}

const withTokens = (code = 0) =>
  `{"code":${String(code)},"msg":"","data":{"user_id":"u-target","tokens":{"access":"at-unit-1","refresh":"rt-unit-1"}},"trace_id":"unit-trace"}`;
const withoutTokens = (code = 0) =>
  `{"code":${String(code)},"msg":"","data":{"user_id":"u-target","tokens":null},"trace_id":"unit-trace"}`;

function handlerOf(result: HandlerResult) {
  return vi.fn(async () => result);
}

it('[AC-B1-01zzs#1] without the option the stored body is the returned body, as before', async () => {
  for (const options of [undefined, {}, { archive: undefined }] as const) {
    const f = fixture();
    try {
      const response = await f.idem.executeInTransaction(
        request,
        handlerOf({ status: 200, envelope: envelope() }),
        options,
      );
      expect(response).toStrictEqual({ status: 200, body: withTokens(), source: 'handler' });
      expect(f.storedResponse()).toStrictEqual({ status: 200, body: withTokens() });
    } finally {
      await f.db.destroy();
    }
  }
});

it('[AC-B1-01zzs#2] archive gets a copy: changing it leaves the returned response intact; the archived body is stored', async () => {
  const f = fixture();
  const seen: unknown[] = [];
  const archive = vi.fn((given: ResponseEnvelope) => {
    seen.push(structuredClone(given));
    (given.data as { tokens: unknown }).tokens = null;
    return given;
  });
  const handlerEnvelope = envelope();
  try {
    const response = await f.idem.executeInTransaction(
      request,
      handlerOf({ status: 201, envelope: handlerEnvelope }),
      { archive },
    );
    expect(response).toStrictEqual({ status: 201, body: withTokens(), source: 'handler' });
    expect(archive).toHaveBeenCalledTimes(1);
    expect(seen).toStrictEqual([envelope()]);
    // The handler's own object is not the one given to archive.
    expect(handlerEnvelope).toStrictEqual(envelope());
    expect(f.storedResponse()).toStrictEqual({ status: 201, body: withoutTokens() });
    const written = JSON.stringify(f.updates(), (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(written).not.toContain('at-unit-1');
    expect(written).not.toContain('rt-unit-1');
    expect(f.texts()).toContain('commit');
  } finally {
    await f.db.destroy();
  }
});

it('[AC-B1-01zzs#4] a 3xxxx result is archived; 1xxxx / 2xxxx / 4xxxx / 5xxxx never call archive and roll back', async () => {
  {
    const f = fixture();
    try {
      const response = await f.idem.executeInTransaction(
        request,
        handlerOf({ status: 409, envelope: envelope(30411) }),
        { archive: (given) => ({ ...given, data: { user_id: 'u-target', tokens: null } }) },
      );
      expect(response).toStrictEqual({ status: 409, body: withTokens(30411), source: 'handler' });
      expect(f.storedResponse()).toStrictEqual({ status: 409, body: withoutTokens(30411) });
    } finally {
      await f.db.destroy();
    }
  }
  for (const code of [10002, 20002, 40901, 50001]) {
    const f = fixture();
    const archive = vi.fn((given: ResponseEnvelope) => given);
    try {
      const response = await f.idem.executeInTransaction(
        request,
        handlerOf({ status: 400, envelope: envelope(code) }),
        { archive },
      );
      expect(response, String(code)).toStrictEqual({
        status: 400,
        body: withTokens(code),
        source: 'handler',
      });
      expect(archive, String(code)).not.toHaveBeenCalled();
      expect(f.updates(), String(code)).toEqual([]);
      expect(f.texts(), String(code)).toContain('rollback');
    } finally {
      await f.db.destroy();
    }
  }
});

it('[AC-B1-01zzs#3] a replay returns the stored body and calls neither the handler nor archive', async () => {
  const f = fixture({
    id: 1n,
    status: 'completed',
    request_hash: requestHashOf(request.body),
    response: { status: 200, body: withoutTokens() },
    ownership_created_at: '2031-01-01 00:00:00+00',
  });
  const handler = handlerOf({ status: 200, envelope: envelope() });
  const archive = vi.fn((given: ResponseEnvelope) => given);
  try {
    const response = await f.idem.executeInTransaction(request, handler, { archive });
    expect(response).toStrictEqual({ status: 200, body: withoutTokens(), source: 'replay' });
    expect(handler).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
    expect(f.updates()).toEqual([]);
  } finally {
    await f.db.destroy();
  }
});

it('[AC-B1-01zzs#6] archive throwing rethrows the same error and rolls back without a completed write', async () => {
  const f = fixture();
  const boom = new Error('archive failed');
  try {
    await expect(
      f.idem.executeInTransaction(request, handlerOf({ status: 200, envelope: envelope() }), {
        archive: () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
    expect(f.updates()).toEqual([]);
    expect(f.texts()).toContain('rollback');
    expect(f.texts()).not.toContain('commit');
  } finally {
    await f.db.destroy();
  }
});

it('[AC-B1-01zzs#6] an invalid archive result, a changed code, or a non-function archive is invalid_result and rolls back', async () => {
  const invalid: [string, IdempotencyArchiveOptions][] = [
    ['undefined', { archive: () => undefined as unknown as ResponseEnvelope }],
    ['no trace_id', { archive: () => ({ code: 0, msg: '' }) as unknown as ResponseEnvelope }],
    ['data with undefined', { archive: (given) => ({ ...given, data: { tokens: undefined } }) }],
    ['another code', { archive: (given) => ({ ...given, code: 30411 }) }],
    [
      // Changing the code of the object it was given must not move the comparison with it.
      'code changed in place',
      {
        archive: (given) => {
          (given as { code: number }).code = 30411;
          return given;
        },
      },
    ],
    ['not a function', { archive: 'nope' as unknown as IdempotencyArchiveOptions['archive'] }],
  ];
  for (const [name, options] of invalid) {
    const f = fixture();
    try {
      const failure = await f.idem
        .executeInTransaction(request, handlerOf({ status: 200, envelope: envelope() }), options)
        .then(
          () => 'resolved',
          (error: unknown) => error,
        );
      expect(failure, name).toBeInstanceOf(IdempotencyError);
      expect((failure as IdempotencyError).code, name).toBe('invalid_result');
      expect(f.updates(), name).toEqual([]);
      expect(f.texts(), name).toContain('rollback');
    } finally {
      await f.db.destroy();
    }
  }
});
