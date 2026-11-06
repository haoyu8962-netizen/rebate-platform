// Real worker assembly with a recording pino destination and an inert queue.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { vi } from 'vitest';
import type { Clock, QueueRuntime } from '../../../../apps/api/src/modules/platform/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';

export async function assembled(db: Kysely<DB>, clock: Clock) {
  // URL imports keep Nest decorators out of the erasable-syntax test project.
  const { AppModule } = (await import(
    new URL('../../../../apps/api/src/app.module.ts', import.meta.url).href
  )) as { AppModule: { forEntry(options: object): unknown } };
  const { PlatformModule, JOB_QUEUE, loadConfig } = (await import(
    new URL('../../../../apps/api/src/modules/platform/index.ts', import.meta.url).href
  )) as {
    PlatformModule: { forRoot(options: object): { providers?: unknown[] } };
    JOB_QUEUE: symbol;
    loadConfig(env: Record<string, string>): unknown;
  };
  const apiRequire = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
  const { NestFactory } = (await import(
    pathToFileURL(apiRequire.resolve('@nestjs/core')).href
  )) as {
    NestFactory: {
      createApplicationContext(
        module: unknown,
        options: object,
      ): Promise<{ close(): Promise<void> }>;
    };
  };
  const queue: QueueRuntime = {
    register() {},
    async send() {
      return 'fixture-job';
    },
    async start() {},
    async stop() {},
  };
  const original = PlatformModule.forRoot.bind(PlatformModule);
  const spy = vi.spyOn(PlatformModule, 'forRoot').mockImplementation((options) => {
    const module = original(options);
    return {
      ...module,
      providers: (module.providers ?? []).map((provider) =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === JOB_QUEUE
          ? { provide: JOB_QUEUE, useValue: queue }
          : provider,
      ),
    };
  });
  const lines: string[] = [];
  try {
    const context = await NestFactory.createApplicationContext(
      AppModule.forEntry({
        entry: 'worker',
        config: loadConfig({ APP_ENV: 'test' }),
        clock,
        logger: createRootLogger(
          { level: 'info', entry: 'worker', appEnv: 'test' },
          { write: (line: string) => void lines.push(line) },
        ),
        dbHandles: { db, dbRead: null, close: async () => undefined },
      }),
      { logger: false, abortOnError: false },
    );
    return { lines, close: () => context.close() };
  } finally {
    spy.mockRestore();
  }
}
