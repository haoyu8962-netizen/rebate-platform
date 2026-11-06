// B1-28p rule-test kit: product feedback (CT-26q submitProductFeedback,
// POST /v1/products/{product_key}/feedback; 08 BR-ID-02 细则「商品反馈与进店」, BR-ID-30 细则
// 「商品反馈记录」, BR-ID-28; orchestrator brief §9.1–§9.3). The real api entry (createHttpApp) over
// PostgreSQL as couli_app and a real Redis. A guest who accepted the privacy policy is a device
// registered through POST /v1/devices (registration follows the consent, 04 §6.1); requests are
// signed with the issued install_secret; a login is a session identity creates on the same device.
// app.product_feedbacks does not exist before the implementation migration: every read goes through
// feedbackRows(), which asserts the table first, so a missing table fails as an assertion and never
// as SQL undefined_table. The database and Redis come from the *.int.test.ts (this kit never imports
// @couli/db/testing). Fake secrets are low-entropy repeated strings; app ids stay within 32 chars.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';
import type { TokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import { TOKEN_SERVICE } from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { seedUser } from '../../identity/registration/kit.ts';
import { buildApp, type HttpApp, type Response } from '../../identity/sms-codes/http-kit.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';

export type { Response } from '../../identity/sms-codes/http-kit.ts';

export const ROOT = new URL('../../../../', import.meta.url);
/** The contract path of submitProductFeedback. */
export const PATH = '/v1/products/{product_key}/feedback';
/** 2026-11-06 10:00 +08:00. */
export const NOW = '2026-11-06T02:00:00.000Z';
export const TRACE = 'b128000000000000000000000000000a';
/** feedback.daily_limit_per_device when the key is not configured (BR-ID-02 细则). */
export const DEFAULT_DAILY_LIMIT = 20;
export const PRODUCT_KEY = 'jd:synthetic-4001';
/** The quote time the page showed (before NOW). */
export const QUOTED_AT = '2026-11-06T09:55:00+08:00';
/** A secret no server issued: low entropy on purpose. */
export const FAKE_SECRET = 'plain-plain-plain-plain';

/**
 * The columns of app.product_feedbacks (brief §9.2 ②): exactly what BR-ID-30 细则「商品反馈记录」
 * lists, plus the row id, app and creation time. No contact column.
 */
export const STORED_COLUMNS = [
  'id',
  'app_id',
  'device_id',
  'user_id',
  'platform',
  'product_key',
  'item_ref',
  'link_id',
  'shown_final_price_fen',
  'shown_rebate_fen',
  'quoted_at',
  'reason',
  'note',
  'created_at',
] as const;

interface Database {
  urlFor(role: string): string;
  drop(): Promise<void>;
}
interface Redis {
  url: string;
  stop(): Promise<void>;
}

interface ResponseEntry {
  content?: Record<string, { schema: JsonSchema }>;
}
interface Operation {
  'x-implementation'?: string;
  'x-auth'?: string;
  'x-signed'?: boolean;
  'x-idempotent'?: boolean;
  responses: Record<string, ResponseEntry>;
}
export interface Document {
  paths: Record<string, { post?: Operation }>;
}

export async function contract(): Promise<Document> {
  const requireApi = createRequire(new URL('apps/api/package.json', ROOT));
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string, options: object): Promise<Document>;
  };
  return parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
    resolve: { external: false },
  });
}

async function open(database: Database, redis: Redis) {
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 16 });
  const clock = new FixedClock(NOW);
  const { logger, lines } = memoryLogger();
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b1-28p-'));
  let app: HttpApp | undefined;
  try {
    app = await buildApp(db, dir, redis.url, clock, logger);
    await app.init();
    const live = app;
    return {
      app: live,
      db,
      clock,
      lines,
      document: await contract(),
      compile: createValidatorCompiler(),
      async close() {
        try {
          await live.close();
        } finally {
          await destroyDb(db);
          rmSync(dir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      await app?.close();
    } finally {
      await destroyDb(db);
      rmSync(dir, { recursive: true, force: true });
    }
    throw error;
  }
}
export type Harness = Awaited<ReturnType<typeof open>>;

/** Only *.int.test.ts import the database testing package and pass its factories here. */
export function suite(
  createDatabase: () => Promise<Database>,
  acquireRedis: () => Promise<Redis>,
): () => Harness {
  let database: Database | undefined;
  let redis: Redis | undefined;
  let harness: Harness | undefined;
  beforeAll(async () => {
    database = await createDatabase();
    redis = await acquireRedis();
    harness = await open(database, redis);
  }, 180_000);
  beforeEach(() => {
    if (harness === undefined) return;
    harness.clock.set(NOW);
    harness.lines.length = 0;
  });
  afterAll(async () => {
    try {
      await harness?.close();
    } finally {
      try {
        await database?.drop();
      } finally {
        await redis?.stop();
      }
    }
  }, 30_000);
  return () => {
    expect(harness, 'the api harness did not open').toBeDefined();
    return harness!;
  };
}

// ---- tenants, devices, logins ---------------------------------------------------------------

/** A fresh app id (23 characters). */
export function newAppId(): string {
  return `fb_${randomBytes(10).toString('hex')}`;
}

function baseHeaders(appId: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-app-id': appId,
    'x-platform': 'ios',
    'x-app-version': '2.0.0',
    'x-trace-id': TRACE,
  };
}

export interface Device {
  readonly appId: string;
  readonly id: string;
  readonly secret: string;
}

/**
 * A guest who accepted the privacy policy: the device registered through POST /v1/devices, then
 * the first-launch privacy consent reported for it (BR-ID-12), as the client does.
 */
export async function registerDevice(h: Harness, appId: string): Promise<Device> {
  const response = await h.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers: baseHeaders(appId),
    payload: JSON.stringify({
      device_hash: createHash('sha256').update(randomUUID()).digest('hex'),
      id_source: 'idfv',
    }),
  });
  expect(response.statusCode, 'POST /v1/devices must register the fixture device').toBe(200);
  const { data } = response.json<{ data: { device_id: string; install_secret: string } }>();
  expect(data).toMatchObject({ device_id: expect.any(String), install_secret: expect.any(String) });
  const device = { appId, id: data.device_id, secret: data.install_secret };
  await recordPrivacy(h, device, true);
  return device;
}

/** POST /v1/consents type=privacy for the device (device level, no token). */
async function recordPrivacy(h: Harness, device: Device, accepted: boolean): Promise<void> {
  const response = await h.app.inject({
    method: 'POST',
    url: '/v1/consents',
    headers: { ...baseHeaders(device.appId), 'x-device-id': device.id },
    payload: JSON.stringify({
      type: 'privacy',
      version: 1,
      accepted,
      channel: accepted ? 'first_launch' : 'privacy_center',
      client_at: h.clock.now().toISOString(),
    }),
  });
  expect(response.statusCode, `the privacy consent (accepted=${accepted}) must be recorded`).toBe(
    200,
  );
}

/** A device id no server issued, signed with a fake secret. */
export function unregisteredDevice(appId: string): Device {
  return { appId, id: randomUUID(), secret: FAKE_SECRET };
}

export interface Login {
  readonly uid: string;
  readonly token: string;
}

/** A user's risk state row as the other HTTP suites seed it (normal). */
export async function normalRisk(h: Harness, appId: string, uid: string): Promise<void> {
  await h.db
    .insertInto('user_risk_state')
    .values({
      app_id: appId,
      user_id: uid,
      state: 'normal',
      changed_by: 'b1-28p-fixture',
      changed_at: h.clock.now(),
      created_at: h.clock.now(),
      updated_at: h.clock.now(),
    })
    .execute();
}

/**
 * A full session of `uid` (a new users row of the device's app when not given) on `device`,
 * created by identity's createSession with the app's TokenService.
 */
export async function login(h: Harness, device: Device, uid?: string): Promise<Login> {
  let userId = uid;
  if (userId === undefined) {
    userId = await seedUser(h.db, device.appId);
    await normalRisk(h, device.appId, userId);
  }
  const owner = userId;
  const session = await h.db
    .transaction()
    .execute((trx) =>
      createSession(
        trx,
        { uid: owner, app_id: device.appId, device_id: device.id, scp: 'full' },
        { clock: h.clock, tokens: h.app.get<TokenService>(TOKEN_SERVICE) },
      ),
    );
  return { uid: owner, token: session.access_token };
}

/** Withdraws the privacy consent of the device (POST /v1/consents, BR-ID-13: device revoked). */
export async function withdrawPrivacy(h: Harness, device: Device): Promise<void> {
  await recordPrivacy(h, device, false);
}

// ---- configuration and links ------------------------------------------------------------------

export async function setConfig(
  h: Harness,
  appId: string,
  key: string,
  value: unknown,
): Promise<void> {
  const text = JSON.stringify(value);
  await h.db
    .insertInto('config_items')
    .values({ app_id: appId, key, value: text, updated_by: 'b1-28p-fixture' })
    .onConflict((oc) => oc.columns(['app_id', 'key']).doUpdateSet({ value: text }))
    .execute();
}

/** A registered detail link of the app with its quote snapshot; returns link_id. */
export async function seedLink(
  h: Harness,
  appId: string,
  options: { readonly platform?: string; readonly productKey?: string } = {},
): Promise<string> {
  const linkId = randomUUID();
  const at = new Date(h.clock.now().getTime() - 5 * 60_000);
  await h.db
    .insertInto('links')
    .values({
      link_id: linkId,
      app_id: appId,
      user_id: null,
      device_id: null,
      platform: options.platform ?? 'jd',
      product_key: options.productKey ?? PRODUCT_KEY,
      scene: 'detail',
      quoted_final_price_fen: 12900n,
      quoted_coupon_fen: 1000n,
      quoted_at: at,
      expire_at: new Date(at.getTime() + 86_400_000),
      created_at: at,
      updated_at: at,
    })
    .execute();
  return linkId;
}

/** A complete valid request body for `linkId`. */
export function feedbackBody(
  linkId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    platform: 'jd',
    link_id: linkId,
    shown_final_price_fen: 12900,
    shown_rebate_fen: 350,
    quoted_at: QUOTED_AT,
    reason: 'price',
    note: null,
    ...overrides,
  };
}

// ---- requests ---------------------------------------------------------------------------------

export function feedbackUrl(productKey: string): string {
  return `/v1/products/${encodeURIComponent(productKey)}/feedback`;
}

function signature(
  secret: string,
  url: string,
  payload: string,
  timestamp: string,
  nonce: string,
): string {
  const bodyHash = createHash('sha256').update(payload).digest('hex');
  return createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(['POST', url, timestamp, nonce, bodyHash].join('\n'))
    .digest('hex');
}

export interface SubmitOptions {
  /** Access token (logged in); a guest when absent. */
  readonly token?: string;
  /** The Idempotency-Key header value; a fresh UUID when absent. */
  readonly idempotencyKey?: string;
  readonly productKey?: string;
}

/** POST /v1/products/{product_key}/feedback, signed by `device` at the clock's time. */
export function submit(
  h: Harness,
  device: Device,
  body: Record<string, unknown>,
  options: SubmitOptions = {},
): Promise<Response> {
  const url = feedbackUrl(options.productKey ?? PRODUCT_KEY);
  const payload = JSON.stringify(body);
  const timestamp = String(Math.floor(h.clock.now().getTime() / 1000));
  const nonce = randomBytes(16).toString('hex');
  return h.app.inject({
    method: 'POST',
    url,
    payload,
    headers: {
      ...baseHeaders(device.appId),
      'x-device-id': device.id,
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-sign': signature(device.secret, url, payload, timestamp, nonce),
      'idempotency-key': options.idempotencyKey ?? randomUUID(),
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    },
  });
}

// ---- answers ----------------------------------------------------------------------------------

/** HTTP status per contracts/error-codes.yaml. */
const STATUS: Readonly<Record<number, number>> = {
  0: 200,
  20001: 400,
  20901: 409,
  10402: 401,
  30144: 404,
  30145: 422,
  42901: 429,
};

const validators = new Map<string, ReturnType<Harness['compile']>>();

function validatorFor(h: Harness, key: string): ReturnType<Harness['compile']> {
  const cached = validators.get(key);
  if (cached !== undefined) return cached;
  const operation = h.document.paths[PATH]?.post;
  expect(operation, `${PATH} must be in the contract`).toBeDefined();
  const schema = operation!.responses[key]?.content?.['application/json']?.schema;
  expect(schema, `${PATH} must declare a ${key} JSON response`).toBeDefined();
  const validate = h.compile({ schema: schema!, httpPart: 'body' });
  validators.set(key, validate);
  return validate;
}

/** The envelope of `code` with its HTTP status, trace id and contract shape; returns the body. */
export function answered(h: Harness, response: Response, code: number): Record<string, unknown> {
  const status = STATUS[code];
  expect(status, `no HTTP status known for ${code}`).toBeDefined();
  expect(response.statusCode, `expected code ${code}`).toBe(status);
  const body = response.json<Record<string, unknown>>();
  expect(body).toMatchObject({ code, msg: expect.any(String), trace_id: TRACE });
  expect(response.headers['x-trace-id']).toBe(TRACE);
  const key = status === 200 ? '200' : status === 429 ? '429' : status! < 500 ? '4XX' : '5XX';
  const validate = validatorFor(h, key);
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  if (code === 42901) {
    const retry = Number(response.headers['retry-after']);
    expect(Number.isInteger(retry), 'Retry-After must be whole seconds').toBe(true);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(86_400);
  }
  return body;
}

/** A recorded feedback: 200 with data exactly { feedback_id }; returns feedback_id. */
export function accepted(h: Harness, response: Response): string {
  const body = answered(h, response, 0);
  expect(body['data']).toEqual({ feedback_id: expect.any(String) });
  const id = (body['data'] as { feedback_id: string }).feedback_id;
  expect(id.length).toBeGreaterThan(0);
  return id;
}

// ---- reading app.product_feedbacks -------------------------------------------------------------

export interface FeedbackRow {
  readonly id: string;
  readonly app_id: string;
  readonly device_id: string;
  readonly user_id: string | null;
  readonly platform: string;
  readonly product_key: string;
  readonly item_ref: string | null;
  readonly link_id: string;
  readonly shown_final_price_fen: string;
  readonly shown_rebate_fen: string | null;
  readonly quoted_at: Date;
  readonly reason: string;
  readonly note: string | null;
  readonly created_at: Date;
}

/** Fails as an assertion while the implementation migration has not created the table. */
export async function expectTable(db: Kysely<DB>): Promise<void> {
  const { rows } = await sql<{
    present: boolean;
  }>`SELECT to_regclass('app.product_feedbacks') IS NOT NULL AS present`.execute(db);
  expect(rows[0]?.present, 'implementation must provide app.product_feedbacks').toBe(true);
}

/** The app's feedback rows (amounts as text), oldest first. `db` may be a transaction. */
export async function feedbackRows(db: Kysely<DB>, appId: string): Promise<FeedbackRow[]> {
  await expectTable(db);
  const { rows } = await sql<FeedbackRow>`SELECT id::text AS id, app_id,
      device_id::text AS device_id, user_id::text AS user_id, platform, product_key, item_ref,
      link_id::text AS link_id, shown_final_price_fen::text AS shown_final_price_fen,
      shown_rebate_fen::text AS shown_rebate_fen, quoted_at, reason, note, created_at
    FROM app.product_feedbacks WHERE app_id = ${appId}
    ORDER BY created_at, id`.execute(db);
  return rows;
}

/** The column names of app.product_feedbacks, sorted (empty while the table does not exist). */
export async function columnsOf(db: Kysely<DB>): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`SELECT a.attname::text AS name
    FROM pg_attribute a
    WHERE a.attrelid = to_regclass('app.product_feedbacks') AND a.attnum > 0
      AND NOT a.attisdropped`.execute(db);
  return rows.map((row) => row.name).sort();
}
