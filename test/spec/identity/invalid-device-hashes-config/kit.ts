// B1-02zzi (08 BR-ID-09 细则「设备标识的无效值」; D10-1034 ②): HTTP / database helpers for the rule
// tests of config device.invalid_hashes as POST /v1/devices reads it. Real AppModule, a migrated
// database clone and a test Redis (B1-03f: registration reserves a per-IP slot); no identity,
// content or risk provider is replaced. Expected business results stay in the rule tests.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { expect } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { HttpApp } from '../../risk/rate-limit/http-kit.ts';
import { acquire, type Server } from '../../risk/rate-limit/kit.ts';
import { responseValidator } from '../devices/kit.ts';
import { closeKit, openKit, type Kit } from '../registration/kit.ts';
import { buildApp, type Response } from '../sms-codes/http-kit.ts';
import { memoryLogger } from '../sms-codes/kit.ts';
import { KEY } from './seeds.ts';

const ROOT = new URL('../../../../', import.meta.url);

/** A broken configuration read: while `on`, every query naming device.invalid_hashes throws. */
export interface ReadFailure {
  on: boolean;
  /** How many such queries were failed so far. */
  count: number;
}

export interface Suite {
  readonly kit: Kit;
  readonly server: Server;
  readonly dir: string;
  readonly app: HttpApp;
  readonly lines: string[];
  readonly readFailure: ReadFailure;
}

/** Does any string inside the query node (identifiers, values, raw fragments) contain `text`? */
function mentions(node: unknown, text: string, seen: Set<object>): boolean {
  if (typeof node === 'string') return node.includes(text);
  if (typeof node !== 'object' || node === null) return false;
  if (ArrayBuffer.isView(node) || seen.has(node)) return false;
  seen.add(node);
  return Object.values(node).some((value) => mentions(value, text, seen));
}

export async function openSuite(): Promise<Suite> {
  const kit = await openKit();
  let server: Server | undefined;
  let dir: string | undefined;
  let app: HttpApp | undefined;
  try {
    server = await acquire();
    const base = fileURLToPath(new URL('.tmp/', ROOT));
    mkdirSync(base, { recursive: true });
    dir = mkdtempSync(join(base, 'spec-b1-02zzi-'));
    const readFailure: ReadFailure = { on: false, count: 0 };
    // The application's handle: the same pool, with a switch that fails the configuration read
    // of device.invalid_hashes (only that key; every other query runs as usual).
    const db = kit.db.withPlugin({
      transformQuery({ node }) {
        if (readFailure.on && mentions(node, KEY, new Set())) {
          readFailure.count += 1;
          throw new Error('B1-02zzi rule test: configuration read failed');
        }
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    const { logger, lines } = memoryLogger();
    app = (await buildApp(
      db,
      dir,
      server.url,
      new FixedClock('2031-05-06T09:00:00Z'),
      logger,
    )) as HttpApp;
    await app.init();
    return { kit, server, dir, app, lines, readFailure };
  } catch (error) {
    await closeParts(kit, server, dir, app);
    throw error;
  }
}

async function closeParts(
  kit: Kit,
  server: Server | undefined,
  dir: string | undefined,
  app: HttpApp | undefined,
): Promise<void> {
  try {
    await app?.close();
  } finally {
    try {
      await server?.stop();
    } finally {
      try {
        await closeKit(kit);
      } finally {
        if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      }
    }
  }
}

export async function closeSuite(suite: Suite | undefined): Promise<void> {
  if (suite === undefined) return;
  await closeParts(suite.kit, suite.server, suite.dir, suite.app);
}

/**
 * Writes device.invalid_hashes of `appId` as an operator's save would leave the row: inserted,
 * or its value replaced with the business version raised by one. Written on the test's own
 * handle (never failed by ReadFailure).
 */
export async function setConfig(suite: Suite, appId: string, value: unknown): Promise<void> {
  await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
    VALUES (${appId}, ${KEY}, ${JSON.stringify(value)}::jsonb, 'b1-02zzi-rule-test')
    ON CONFLICT (app_id, key) DO UPDATE
      SET value = EXCLUDED.value,
          version = app.config_items.version + 1,
          updated_by = EXCLUDED.updated_by`.execute(suite.kit.db);
}

let lastIp = 0;
/** A different client IP for every request, so the per-IP registration cap never interferes. */
function nextIp(): string {
  lastIp += 1;
  return `198.51.${String(100 + Math.floor(lastIp / 250))}.${String((lastIp % 250) + 1)}`;
}

export function register(suite: Suite, appId: string, deviceHash: string): Promise<Response> {
  return suite.app.inject({
    method: 'POST',
    url: '/v1/devices',
    remoteAddress: nextIp(),
    headers: {
      'content-type': 'application/json',
      'x-app-id': appId,
      'x-platform': 'ios',
      'x-app-version': '1.2.3',
    },
    payload: JSON.stringify({ device_hash: deviceHash, id_source: 'idfv' }),
  });
}

async function deviceCount(suite: Suite, appId: string): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM app.devices WHERE app_id = ${appId}
  `.execute(suite.kit.db);
  return rows[0]!.n;
}

let validators: ReturnType<typeof responseValidator> | undefined;

/** 20001 with data.fields=[device_hash]: nothing issued, no device row (BR-ID-09 细则). */
export async function refused(
  suite: Suite,
  appId: string,
  deviceHash: string,
  label: string,
): Promise<void> {
  const before = await deviceCount(suite, appId);
  const response = await register(suite, appId, deviceHash);
  expect(response.statusCode, label).toBe(400);
  const body = response.json<{ code: number; data?: Record<string, unknown> }>();
  expect(body.code, label).toBe(20001);
  expect(body.data?.['fields'], label).toEqual(['device_hash']);
  validators ??= responseValidator();
  const { validateError } = await validators;
  const valid = validateError(body);
  expect(validateError.errors ?? [], label).toEqual([]);
  expect(valid, label).toBe(true);
  expect(body.data, label).not.toHaveProperty('device_id');
  expect(body.data, label).not.toHaveProperty('install_secret');
  expect(await deviceCount(suite, appId), label).toBe(before);
}

/** 200: a device_id and install_secret issued, one device row of this app with this hash. */
export async function issued(
  suite: Suite,
  appId: string,
  deviceHash: string,
  label: string,
): Promise<void> {
  const before = await deviceCount(suite, appId);
  const response = await register(suite, appId, deviceHash);
  expect(response.statusCode, label).toBe(200);
  const body = response.json<{
    code: number;
    data: { device_id: string; install_secret: string };
  }>();
  expect(body.code, label).toBe(0);
  validators ??= responseValidator();
  const { validate } = await validators;
  const valid = validate(body);
  expect(validate.errors ?? [], label).toEqual([]);
  expect(valid, label).toBe(true);
  expect(body.data.install_secret.length, label).toBeGreaterThan(0);
  const { rows } = await sql<{ device_hash: string }>`
    SELECT device_hash FROM app.devices WHERE app_id = ${appId} AND id = ${body.data.device_id}::uuid
  `.execute(suite.kit.db);
  expect(rows, label).toEqual([{ device_hash: deviceHash }]);
  expect(await deviceCount(suite, appId), label).toBe(before + 1);
}
