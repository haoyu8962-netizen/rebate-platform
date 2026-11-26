// Child process of exit.test.ts (QA-13d ④, D10-3244 ②). It is started with plain
// `node <this file> <crash> <transport> <dsn>` (Node's own type stripping): a real process whose
// exit status the parent sees, unlike a Vitest worker. It starts crash reporting of the worker
// entry from loadConfig (APP_ENV=test, CRASH_REPORT_DSN=<dsn>, empty = unset) with an in-process
// fake fetch (never the network), keeps itself alive as the worker entry does, then lets an error
// escape: `uncaught` throws from a timer, `rejection` leaves a rejected promise unhandled.
// stdout lines (written synchronously, so none is lost on exit):
//   load-failed <json>           loading the modules failed (exit status 4)
//   setup-failed <json>          startCrashReporting threw or rejected (exit status 3)
//     <json> = { stage, name, message, code?, stack }: the original error, so the parent can
//     rethrow it with its own type (a NotImplemented skeleton, a missing module and a TypeError
//     stay distinguishable from a failed exit-behaviour assertion)
//   armed enabled=<true|false>   crash reporting started
//   crash-at <epoch ms>          the error is about to escape
//   fetch                        the fake fetch was called (fetch(url, init) or fetch(request))
//   event <json>                 the event items of that request: [{ type, value }] per exception,
//                                said once the body is decoded, before the fake answers
//   sent                         the fake fetch's answer (200) is handed back to the caller
//   exit <code>                  the process's 'exit' event
// Import only the types of this file (`import type`): importing it for real would run it.
import { writeSync } from 'node:fs';
import { gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';
import type {
  CrashFetch,
  CrashReporter,
} from '../../../../apps/api/src/modules/platform/crash-report/index.ts';
import type { RootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';

type ConfigModule = typeof import('../../../../apps/api/src/modules/platform/config/config.ts');
type CrashModule = typeof import('../../../../apps/api/src/modules/platform/crash-report/index.ts');

const CONFIG_MODULE = '../../../../apps/api/src/modules/platform/config/config.ts';
const CRASH_MODULE = '../../../../apps/api/src/modules/platform/crash-report/index.ts';

/** How the error escapes. */
export type ChildCrash = 'uncaught' | 'rejection';
/**
 * ok: 200 at once; slow: 200 after SLOW_MS; fail: rejects like an unreachable server; hang: never
 * answers (until aborted).
 */
export type ChildTransport = 'ok' | 'slow' | 'fail' | 'hang';
/** The delay of the `slow` transport. */
const SLOW_MS = 300;

/** What a failed load or start-up reports to the parent. */
export interface ChildFailure {
  readonly stage: 'load' | 'start';
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly stack: string;
}

/** One exception of a sent event, as the `event` line lists it. */
export interface ChildException {
  readonly type?: string;
  readonly value?: string;
}

interface EventItem {
  readonly exception?: { readonly values?: readonly ChildException[] };
}

function say(line: string): void {
  writeSync(1, `${line}\n`);
}

function failureJson(stage: ChildFailure['stage'], error: unknown): string {
  const failure = error instanceof Error ? error : new Error(String(error));
  const code = (failure as { code?: unknown }).code;
  const report: ChildFailure = {
    stage,
    name: failure.name,
    message: failure.message,
    ...(typeof code === 'string' ? { code } : {}),
    stack: failure.stack ?? '',
  };
  return JSON.stringify(report);
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

function parse(text: string | undefined): unknown {
  try {
    return JSON.parse(text ?? '') as unknown;
  } catch {
    return undefined;
  }
}

/** `deflate` content: zlib-wrapped, or raw as some servers and clients send it. */
function inflateDeflate(bytes: Buffer): Buffer {
  try {
    return inflateSync(bytes);
  } catch {
    return inflateRawSync(bytes);
  }
}

/** Says the event items of one envelope body. */
function sayEvents(bytes: Buffer, encoding: string): void {
  let raw = bytes;
  try {
    if (encoding.includes('gzip') || (raw[0] === 0x1f && raw[1] === 0x8b)) raw = gunzipSync(raw);
    else if (encoding.includes('deflate')) raw = inflateDeflate(raw);
  } catch {
    say('event-undecodable');
    return;
  }
  const lines = raw.toString('utf8').split('\n');
  for (let index = 1; index < lines.length; index += 2) {
    const header = parse(lines[index]) as { type?: unknown } | undefined;
    if (header?.type !== 'event') continue;
    const event = parse(lines[index + 1]) as EventItem | undefined;
    const values = (event?.exception?.values ?? []).map(({ type, value }) => ({ type, value }));
    say(`event ${JSON.stringify(values)}`);
  }
}

/** The body bytes of one call: from init.body when given, else from the Request object. */
async function bodyBytes(
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<Buffer> {
  if (init?.body !== undefined && init.body !== null) {
    return Buffer.from(await new Response(init.body).arrayBuffer());
  }
  if (input instanceof Request) return Buffer.from(await input.clone().arrayBuffer());
  return Buffer.alloc(0);
}

/** Reads the whole body (whatever its kind) and says its event items. */
async function sayBody(
  input: string | URL | Request,
  init: RequestInit | undefined,
  encoding: string,
): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await bodyBytes(input, init);
  } catch {
    say('event-undecodable');
    return;
  }
  sayEvents(bytes, encoding);
}

/**
 * Accepts `fetch(url, init)` as well as `fetch(request)` (init, when given, wins, as in fetch):
 * body, content-encoding and signal are read from either. The event is decoded (its `event` line
 * said) before the fake answers, fails or starts hanging.
 */
function childFetch(transport: string): CrashFetch {
  return async (input, init) => {
    say('fetch');
    const fromRequest = input instanceof Request ? input : undefined;
    const headers = new Headers(init?.headers ?? fromRequest?.headers);
    const signal = init?.signal ?? fromRequest?.signal;
    await sayBody(input, init, headers.get('content-encoding') ?? '');
    if (transport === 'fail') throw new TypeError('fetch failed (qa13d child)');
    if (transport === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted === true) reject(new Error('aborted (qa13d child)'));
        signal?.addEventListener('abort', () => reject(new Error('aborted (qa13d child)')));
      });
    }
    const delay = transport === 'slow' ? SLOW_MS : 0;
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    say('sent');
    return new Response('{}', { status: 200 });
  };
}

interface Loaded {
  readonly config: ConfigModule;
  readonly crashReport: CrashModule;
}

async function load(): Promise<Loaded> {
  const config = (await import(new URL(CONFIG_MODULE, import.meta.url).href)) as ConfigModule;
  const crashReport = (await import(new URL(CRASH_MODULE, import.meta.url).href)) as CrashModule;
  return { config, crashReport };
}

/** async: a synchronous throw of startCrashReporting becomes a rejection here. */
async function arm(loaded: Loaded, transport: string, dsn: string): Promise<CrashReporter> {
  return loaded.crashReport.startCrashReporting({
    entry: 'worker',
    config: loaded.config.loadConfig({ APP_ENV: 'test', CRASH_REPORT_DSN: dsn }),
    logger: quietLogger(),
    fetch: childFetch(transport),
  });
}

const [crash = 'uncaught', transport = 'ok', dsn = ''] = process.argv.slice(2);
process.on('exit', (code) => {
  say(`exit ${String(code)}`);
});
const loaded = await load().catch((error: unknown) => {
  say(`load-failed ${failureJson('load', error)}`);
  return process.exit(4);
});
const reporter = await arm(loaded, transport, dsn).catch((error: unknown) => {
  say(`setup-failed ${failureJson('start', error)}`);
  return process.exit(3);
});
say(`armed enabled=${String(reporter.enabled)}`);
// Keeps the process alive as the worker and payout entries do.
setInterval(() => undefined, 2 ** 30);
setTimeout(() => {
  say(`crash-at ${String(Date.now())}`);
  if (crash === 'rejection') void Promise.reject(new Error('qa13d-child-rejection'));
  else throw new Error('qa13d-child-uncaught');
}, 20);
