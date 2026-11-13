// Test transport only: real AppModule worker, injected replay Clock, captured queue deliveries.
// Worker timers may enqueue; the transport never executes a job automatically.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, vi } from 'vitest';
import { createAuditWriter } from '../../../apps/api/src/modules/admin/infra/audit-writer.ts';
import type { OrderSyncRuntime } from '../../../apps/api/src/modules/orders/worker-runtime.ts';
import {
  createIdempotency,
  createRootLogger,
  type JobHandler,
  type JobPayload,
  type QueueRuntime,
} from '../../../apps/api/src/modules/platform/index.ts';
import {
  LocalKeyProvider,
  createWrappedKeyring,
} from '../../../apps/api/src/modules/platform/crypto/index.ts';
import { createAdminSettleCommandDeps } from '../../../apps/api/src/modules/settlement/application/admin-settle-commands.ts';
import type { SettlementWorkerPorts } from '../../../apps/api/src/modules/settlement/worker/ports.ts';
import type { startReplay } from '../qa-03a/driver.ts';

const root = new URL('../../../', import.meta.url);
export const logger = createRootLogger({ level: 'silent', entry: 'worker', appEnv: 'test' });
type Replay = Awaited<ReturnType<typeof startReplay>>;
interface Context {
  get<T>(token: unknown, options?: { strict: boolean }): T;
  close(): Promise<void>;
}

export async function startWorker(h: Replay) {
  // URL imports keep Nest's decorator graph outside the rule-test TypeScript project.
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', root).href)) as {
    AppModule: { forEntry(options: object): unknown };
  };
  const platform = (await import(new URL('apps/api/src/modules/platform/index.ts', root).href)) as {
    PlatformModule: { forRoot(options: object): { providers?: unknown[] } };
    JOB_QUEUE: symbol;
    loadConfig(env: Record<string, string>): unknown;
  };
  const { SettlementModule } = (await import(
    new URL('apps/api/src/modules/settlement/index.ts', root).href
  )) as {
    SettlementModule: { forWorker(ports: SettlementWorkerPorts, options?: object): unknown };
  };
  const { orderSyncToken } = (await import(
    new URL('apps/api/src/modules/orders/index.ts', root).href
  )) as {
    orderSyncToken(): symbol;
  };
  const requireApi = createRequire(new URL('apps/api/package.json', root));
  const { NestFactory } = (await import(
    pathToFileURL(requireApi.resolve('@nestjs/core')).href
  )) as {
    NestFactory: { createApplicationContext(module: unknown, options: object): Promise<Context> };
  };
  const handlers = new Map<string, JobHandler>();
  const queue = {
    send: vi.fn<QueueRuntime['send']>(async () => randomUUID()),
    register: (name: string, handler: JobHandler) => {
      handlers.set(name, handler);
    },
    start: async () => undefined,
    stop: async () => undefined,
  } satisfies QueueRuntime;
  const originalPlatform = platform.PlatformModule.forRoot.bind(platform.PlatformModule);
  const queueSpy = vi.spyOn(platform.PlatformModule, 'forRoot').mockImplementation((options) => {
    const module = originalPlatform(options);
    return {
      ...module,
      providers: (module.providers ?? []).map((p) =>
        typeof p === 'object' && p !== null && 'provide' in p && p.provide === platform.JOB_QUEUE
          ? { provide: platform.JOB_QUEUE, useValue: queue }
          : p,
      ),
    };
  });
  const captured: { ports?: SettlementWorkerPorts } = {};
  const originalSettlement = SettlementModule.forWorker.bind(SettlementModule);
  const portsSpy = vi.spyOn(SettlementModule, 'forWorker').mockImplementation((given, options) => {
    captured.ports = given;
    return originalSettlement(given, options);
  });
  const base = fileURLToPath(new URL('.tmp/', root));
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'qa03b-'));
  let context: Context | undefined;
  try {
    const material = randomBytes(32);
    const ring = await createWrappedKeyring(new LocalKeyProvider(material));
    const materialFile = join(directory, 'synthetic-master.hex');
    const ringFile = join(directory, 'synthetic-keyring.json');
    writeFileSync(materialFile, material.toString('hex'), { mode: 0o600 });
    writeFileSync(ringFile, JSON.stringify(ring), { mode: 0o600 });
    context = await NestFactory.createApplicationContext(
      AppModule.forEntry({
        entry: 'worker',
        config: platform.loadConfig({
          APP_ENV: 'test',
          FIELD_KEY_PROVIDER: 'local',
          FIELD_MASTER_KEY_FILE: materialFile,
          FIELD_KEYRING_FILE: ringFile,
        }),
        clock: h.clock,
        logger,
        dbHandles: { db: h.db, dbRead: null, close: async () => undefined },
      }),
      { logger: false, abortOnError: false },
    );
    expect(captured.ports, 'production settlement ports must be wired').toBeDefined();
    expect(handlers.has('settle')).toBe(true);
    expect(handlers.has('ledger-check')).toBe(true);
    const commands = createAdminSettleCommandDeps(
      {
        ...captured.ports!,
        auditWriter: (db, clock) => createAuditWriter({ db, clock }),
      },
      {
        db: h.db,
        clock: h.clock,
        logger,
        idempotency: createIdempotency({ db: h.db, clock: h.clock, logger }),
      },
    );
    const active = context;
    return {
      queue,
      commands,
      pipeline: active.get<OrderSyncRuntime>(orderSyncToken(), { strict: false }).pipeline,
      async deliver(name: string, payload: JobPayload, queueName = 'settle') {
        expect(handlers.has(queueName)).toBe(true);
        await handlers.get(queueName)!({
          id: randomUUID(),
          queue: queueName,
          name,
          payload,
          attempt: 1,
        });
      },
      async close() {
        try {
          await active.close();
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      await context?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    throw error;
  } finally {
    portsSpy.mockRestore();
    queueSpy.mockRestore();
  }
}
