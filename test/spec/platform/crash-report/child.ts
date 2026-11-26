// Child process of exit.test.ts (QA-13d ④, D10-3244 ②). It is started with plain
// `node <this file> <crash> <transport> <dsn>` (Node's own type stripping): a real process whose
// exit status the parent sees, unlike a Vitest worker. It starts crash reporting of the worker
// entry from loadConfig (APP_ENV=test, CRASH_REPORT_DSN=<dsn>, empty = unset) with an in-process
// fake fetch (never the network), keeps itself alive as the worker entry does, then lets an error
// escape: `uncaught` throws from a timer, `rejection` leaves a rejected promise unhandled.
// stdout lines (written synchronously, so none is lost on exit):
//   armed enabled=<true|false>   crash reporting started
//   setup-failed <message>       starting it failed (exit status 3)
//   crash-at <epoch ms>          the error is about to escape
//   fetch                        the fake fetch was called
// Import only the types of this file (`import type`): importing it for real would run it.
import { writeSync } from 'node:fs';
import type { CrashFetch } from '../../../../apps/api/src/modules/platform/crash-report/index.ts';
import type { RootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';

type ConfigModule = typeof import('../../../../apps/api/src/modules/platform/config/config.ts');
type CrashModule = typeof import('../../../../apps/api/src/modules/platform/crash-report/index.ts');

const CONFIG_MODULE = '../../../../apps/api/src/modules/platform/config/config.ts';
const CRASH_MODULE = '../../../../apps/api/src/modules/platform/crash-report/index.ts';

/** How the error escapes. */
export type ChildCrash = 'uncaught' | 'rejection';
/** ok: 200; fail: rejects like an unreachable server; hang: never answers (until aborted). */
export type ChildTransport = 'ok' | 'fail' | 'hang';

function say(line: string): void {
  writeSync(1, `${line}\n`);
}

/** A logger that writes nothing (the parent reads only the lines above). */
function quietLogger(): RootLogger {
  const noop = (): void => undefined;
  const logger: Record<string, unknown> = {
    level: 'info',
    fatal: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    silent: noop,
    isLevelEnabled: () => true,
    bindings: () => ({}),
  };
  logger['child'] = () => logger;
  return logger as unknown as RootLogger;
}

function childFetch(transport: string): CrashFetch {
  return (_input, init) => {
    say('fetch');
    if (transport === 'fail') return Promise.reject(new TypeError('fetch failed (qa13d child)'));
    if (transport === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted (qa13d child)')));
      });
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
}

async function arm(transport: string, dsn: string): Promise<void> {
  const config = (await import(new URL(CONFIG_MODULE, import.meta.url).href)) as ConfigModule;
  const crashReport = (await import(new URL(CRASH_MODULE, import.meta.url).href)) as CrashModule;
  const reporter = await crashReport.startCrashReporting({
    entry: 'worker',
    config: config.loadConfig({ APP_ENV: 'test', CRASH_REPORT_DSN: dsn }),
    logger: quietLogger(),
    fetch: childFetch(transport),
  });
  say(`armed enabled=${String(reporter.enabled)}`);
}

const [crash = 'uncaught', transport = 'ok', dsn = ''] = process.argv.slice(2);
try {
  await arm(transport, dsn);
} catch (error) {
  say(`setup-failed ${error instanceof Error ? error.message : String(error)}`);
  process.exit(3);
}
// Keeps the process alive as the worker and payout entries do.
setInterval(() => undefined, 2 ** 30);
setTimeout(() => {
  say(`crash-at ${String(Date.now())}`);
  if (crash === 'rejection') void Promise.reject(new Error('qa13d-child-rejection'));
  else throw new Error('qa13d-child-uncaught');
}, 20);
