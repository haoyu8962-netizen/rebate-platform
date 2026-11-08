// B1-02zzg (BR-ID-26 细则「配置」, D10-1034 ①): helpers of the rule tests of the real-name age line
// read from minor.min_realname_age. Built on the frozen B1-13d kit (../realname/kit.ts), only
// imported here: real AppModule, PG and Redis, only the vendor is replaced.
//
// Readings fixed by this kit:
// - the configuration is the app's app.config_items row of minor.min_realname_age, written as a raw
//   row (no registry check), so dirty values can be stored as they could be by hand or by an older
//   writer;
// - content caches configuration per (app, key), so every scenario uses fresh apps and writes the
//   row before the app's first real-name request; a value is never changed within a test;
// - a failing configuration read is a PG statement of this one key of this one app that rejects
//   (pg.Client.prototype.query, the client every pool of @couli/db uses), whatever module or port
//   issues it; other keys and other apps are untouched;
// - "passes the age line" is a definite vendor answer (match → 0, verified row); "refused" is 30407
//   with no realname row of the user.
import { createRequire } from 'node:module';
import { sql } from 'kysely';
import { expect } from 'vitest';
import {
  NAME,
  ROOT,
  envelope,
  fixture,
  residentId,
  type Fixture,
  type Kit,
  type Response,
} from '../realname/kit.ts';

export const KEY = 'minor.min_realname_age';

/** No config row for the app (the key is unset). */
export const NO_ROW = Symbol('no minor.min_realname_age row');

/** Writes the raw current-value row of the key for the app (any JSON value). */
export async function putAge(kit: Kit, appId: string, value: unknown): Promise<void> {
  const at = kit.clock.now();
  await sql`INSERT INTO app.config_items (app_id, key, value, version, updated_by, created_at, updated_at)
    VALUES (${appId}, ${KEY}, ${JSON.stringify(value)}::jsonb, 1, 'b1-02zzg', ${at}, ${at})`.execute(
    kit.db,
  );
}

/** A user of a new app whose age line is `age` (NO_ROW: no config row). */
export async function newApp(kit: Kit, age: unknown): Promise<Fixture> {
  const f = await fixture(kit);
  if (age !== NO_ROW) await putAge(kit, f.appId, age);
  return f;
}

/** Every vendor call of the test answers match. */
export function matchVendor(kit: Kit): void {
  kit.vendor.mockResolvedValue({ outcome: 'match', provider: 'test-two-elements' });
}

export const idOf = (birth: string, serial?: string) => residentId(birth, serial);

/** The user submits an ID number born on `birth`: 30407, and nothing is stored for the user. */
export async function refused(
  kit: Kit,
  f: Fixture,
  birth: string,
  serial?: string,
): Promise<Response> {
  const response = await f.submit({ name: NAME, id_no: idOf(birth, serial) });
  expect(response.json<{ code?: unknown }>().code, `born ${birth}: 30407`).toBe(30407);
  envelope(kit, response, 30407);
  expect(await f.rows(), `born ${birth}: no realname row`).toEqual([]);
  return response;
}

/** The user submits an ID number born on `birth`: past the age line, verified (vendor match). */
export async function passes(
  kit: Kit,
  f: Fixture,
  birth: string,
  serial?: string,
): Promise<Response> {
  const response = await f.submit({ name: NAME, id_no: idOf(birth, serial) });
  expect(response.json<{ code?: unknown }>().code, `born ${birth}: verified`).toBe(0);
  envelope(kit, response, 0);
  const rows = await f.rows();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.['status']).toBe('verified');
  return response;
}

// ---- failing configuration read ---------------------------------------------------------------

type Query = (this: unknown, ...args: unknown[]) => unknown;
interface PgModule {
  readonly Client: { readonly prototype: { query: Query } };
}

function statementOf(args: readonly unknown[]): { text: string; values: readonly unknown[] } {
  const [first, second] = args;
  if (typeof first === 'string') {
    return { text: first, values: Array.isArray(second) ? second : [] };
  }
  if (typeof first === 'object' && first !== null) {
    const config = first as { text?: unknown; values?: unknown };
    const values = Array.isArray(config.values)
      ? config.values
      : Array.isArray(second)
        ? second
        : [];
    return { text: typeof config.text === 'string' ? config.text : '', values };
  }
  return { text: '', values: [] };
}

/** A read of the key of `appId` (any statement on config_items naming both but a write). */
function readsAgeOf(args: readonly unknown[], appId: string): boolean {
  const { text, values } = statementOf(args);
  if (!text.includes('config_items')) return false;
  if (/^\s*(insert|update|delete)\b/i.test(text)) return false;
  const flat = values.flatMap((value) => (Array.isArray(value) ? value : [value]));
  return flat.includes(appId) && (flat.includes(KEY) || text.includes(KEY));
}

/**
 * Makes every read of the key of `state.appId` reject while it is set, counting them in
 * `state.hits`. `restore()` puts the original query method back.
 */
export function configReadFault() {
  const pg = createRequire(new URL('packages/db/package.json', ROOT))('pg') as PgModule;
  const prototype = pg.Client.prototype;
  const original = prototype.query;
  const state: { appId: string | null; hits: number } = { appId: null, hits: 0 };
  prototype.query = function (this: unknown, ...args: unknown[]) {
    if (state.appId !== null && readsAgeOf(args, state.appId)) {
      state.hits += 1;
      return Promise.reject(new Error('b1-02zzg: injected config_items read failure'));
    }
    return original.apply(this, args);
  };
  return {
    state,
    restore() {
      prototype.query = original;
    },
  };
}
export type ConfigReadFault = ReturnType<typeof configReadFault>;
