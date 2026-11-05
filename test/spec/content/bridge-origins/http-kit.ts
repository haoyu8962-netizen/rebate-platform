// Synthetic keys only. Same HTTP fixture as config/kit, adding a known signing public key.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { onTestFinished } from 'vitest';
import {
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import { fixture } from '../../identity/token/kit.ts';
import { ROOT } from '../config/kit.ts';
import { configApp, type Harness as AgreementHarness } from '../agreements-min-version/kit.ts';

export interface Response {
  statusCode: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  json<T = unknown>(): T;
}
export interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(input: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
  }): Promise<Response>;
  getHttpAdapter(): {
    getInstance(): { hasRoute(input: { method: 'GET'; url: string }): boolean };
  };
}
type Entry = 'api' | 'admin' | 'stream';
type CreateHttpApp = (
  entry: Entry,
  options: {
    config: ReturnType<typeof loadConfig>;
    clock: ReturnType<typeof fixture>['clock'];
    logger: ReturnType<typeof createRootLogger>;
    dbHandles?: DbHandles;
    redisUrl?: ReturnType<typeof loadConnectionConfig>['redisUrl'];
  },
) => Promise<HttpApp>;

export async function harness(db: Kysely<DB>, databaseUrl: string, redisUrl: string) {
  const deps = fixture();
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'f1-02zzzb-'));
  const signing = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const signingFile = join(directory, 'synthetic-signing.pem');
  const signingPem = signing.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  writeFileSync(signingFile, signingPem, { mode: 0o600 });
  const apps: HttpApp[] = [];
  const logs: string[] = [];
  try {
    // Synthetic, ephemeral fixture keys only; never reads operator credentials.
    const master = randomBytes(32);
    const wrapped = await createWrappedKeyring(new LocalKeyProvider(master));
    const masterFile = join(directory, 'synthetic-master.hex');
    const keyringFile = join(directory, 'synthetic-keyring.json');
    writeFileSync(masterFile, master.toString('hex'), { mode: 0o600 });
    writeFileSync(keyringFile, JSON.stringify(wrapped), { mode: 0o600 });
    const config = loadConfig({
      APP_ENV: 'test',
      CONFIG_SIGN_KEY_FILE: signingFile,
      CONFIG_SIGN_KEY_ID: 'fixture-config-key',
      FIELD_KEY_PROVIDER: 'local',
      FIELD_MASTER_KEY_FILE: masterFile,
      FIELD_KEYRING_FILE: keyringFile,
      JWT_KEY_ID: deps.keyring.kid,
      JWT_PRIVATE_KEY_PEM: deps.keyring.privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString(),
    });
    const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
      createHttpApp: CreateHttpApp;
    };
    async function start(entry: Entry, handle: Kysely<DB> | null = db) {
      const app = await createHttpApp(entry, {
        config,
        clock: deps.clock,
        logger: createRootLogger(
          { level: 'trace', entry, appEnv: 'test' },
          { write: (line: string) => void logs.push(line) },
        ),
        ...(handle === null
          ? {}
          : {
              dbHandles: { db: handle, dbRead: null, close: async () => undefined },
              redisUrl: loadConnectionConfig(entry, {
                DATABASE_URL: databaseUrl,
                REDIS_URL: redisUrl,
              }).redisUrl,
            }),
      });
      apps.push(app);
      await app.init();
      return app;
    }
    const app = await start('api');
    return {
      db,
      app,
      signing,
      signingPem,
      start,
      logs,
      deps,
      async close() {
        try {
          for (const instance of apps.toReversed()) await instance.close();
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      for (const instance of apps.toReversed()) await instance.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    throw error;
  }
}
export type Harness = Awaited<ReturnType<typeof harness>>;

/** Scope the known signing key to #8; other frozen agreement cases keep their original fixture. */
export async function signedConfigApp(h: AgreementHarness) {
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'f1-02zzzb-agreement-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const signing = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const file = join(directory, 'synthetic-signing.pem');
  writeFileSync(file, signing.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const f = await configApp({
    ...h,
    env: { ...h.env, CONFIG_SIGN_KEY_FILE: file, CONFIG_SIGN_KEY_ID: 'fixture-config-key' },
  });
  return { ...f, signing };
}
