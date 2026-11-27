// Hooks of crash reporting (QA-13d ③ and logger.error): the process's uncaughtException /
// unhandledRejection, and the error / fatal methods of a pino logger and every child made from it.

/** What the process hooks see of the process. */
export interface HookedProcess {
  on(event: string, listener: (value: unknown) => void): unknown;
  off(event: string, listener: (value: unknown) => void): unknown;
  exit(code?: number): unknown;
  readonly stderr?: { write(chunk: string): unknown };
}

/** Longest wait for the report of an escaped error before the process exits anyway. */
export const HOOK_FLUSH_MS = 2_000;
/** Hard limit from the escaped error to the exit, whatever the report does. */
export const HOOK_EXIT_MS = 3_000;

export interface ProcessHookSettings {
  readonly process: HookedProcess;
  /** Reports the escaped error; must not throw. */
  readonly report: (error: unknown, kind: 'uncaughtException' | 'unhandledRejection') => void;
  /** Waits (bounded) for pending reports; must not reject. */
  readonly flush: (timeoutMs: number) => Promise<unknown>;
  /** What Node writes for an escaped error before it exits (stderr; nothing on a stand-in). */
  readonly describe: (error: unknown) => string;
}

/**
 * Installs the two process hooks; returns their removal. Node itself, without a listener, prints
 * the escaped error and exits with status 1 (uncaught exception, and unhandled rejection in the
 * default `throw` mode); a listener replaces that, so the hook does the same after its report:
 * prints, reports, waits at most HOOK_FLUSH_MS for the send, and exits with 1 within HOOK_EXIT_MS.
 */
export function installProcessHooks(settings: ProcessHookSettings): () => void {
  const target = settings.process;
  let exiting = false;
  const handle = (error: unknown, kind: 'uncaughtException' | 'unhandledRejection'): void => {
    if (exiting) return;
    exiting = true;
    let done = false;
    // Ref'd on purpose: it keeps the event loop alive until the exit, even with nothing else left.
    const deadline = setTimeout(() => finish(), HOOK_EXIT_MS);
    function finish(): void {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      target.exit(1);
    }
    try {
      target.stderr?.write(settings.describe(error));
    } catch {
      // Writing the error must not keep the process from exiting.
    }
    try {
      settings.report(error, kind);
    } catch {
      // Reporting must not keep the process from exiting.
    }
    settings.flush(HOOK_FLUSH_MS).then(finish, finish);
  };
  const onUncaught = (error: unknown): void => handle(error, 'uncaughtException');
  const onRejection = (reason: unknown): void => handle(reason, 'unhandledRejection');
  target.on('uncaughtException', onUncaught);
  target.on('unhandledRejection', onRejection);
  return () => {
    target.off('uncaughtException', onUncaught);
    target.off('unhandledRejection', onRejection);
  };
}

// ---------------------------------------------------------------------------------------------
// logger.error / logger.fatal.

export type LogLevelName = 'error' | 'fatal';
/** Receives the arguments of one error / fatal log call; must not throw. */
export type LogCallHandler = (level: LogLevelName, args: readonly unknown[]) => void;

const HOOKED_LEVELS: readonly LogLevelName[] = ['error', 'fatal'];
const HANDLER = Symbol('couli.crashReport.logHandler');
const INNER: Readonly<Record<LogLevelName, symbol>> = {
  error: Symbol('couli.crashReport.error'),
  fatal: Symbol('couli.crashReport.fatal'),
};
const ACCESSOR = Symbol('couli.crashReport.accessor');

type LogMethod = (this: unknown, ...args: unknown[]) => unknown;
type Hooked = Record<PropertyKey, unknown>;

const wrappers = new WeakMap<LogMethod, LogMethod>();

function wrap(inner: LogMethod, level: LogLevelName): LogMethod {
  const cached = wrappers.get(inner);
  if (cached !== undefined) return cached;
  const wrapped: LogMethod = function (this: unknown, ...args: unknown[]): unknown {
    const result = inner.apply(this, args);
    const handler = (this as Hooked | undefined)?.[HANDLER];
    if (typeof handler === 'function') {
      try {
        (handler as LogCallHandler)(level, args);
      } catch {
        // A failed report never affects the log call.
      }
    }
    return result;
  };
  wrappers.set(inner, wrapped);
  return wrapped;
}

/**
 * Hooks the error and fatal methods of `logger` and of every child made from it afterwards (pino
 * children inherit from their parent and assign their level methods, which the accessor stores per
 * logger). Returns the removal: the accessors stay (other children may hold them) but report
 * nothing once the handler is gone.
 */
export function hookLogger(logger: object, handler: LogCallHandler): () => void {
  const target = logger as Hooked;
  for (const level of HOOKED_LEVELS) {
    const descriptor = Object.getOwnPropertyDescriptor(target, level);
    const getter = descriptor?.get as ({ [ACCESSOR]?: true } & (() => unknown)) | undefined;
    if (getter?.[ACCESSOR] === true) continue;
    const current = target[level];
    if (typeof current !== 'function') continue;
    const inner = INNER[level];
    target[inner] = current;
    const get = function (this: Hooked): unknown {
      const method = this[inner];
      return typeof method === 'function' ? wrap(method as LogMethod, level) : method;
    };
    Object.defineProperty(get, ACCESSOR, { value: true });
    Object.defineProperty(target, level, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      get,
      set(this: Hooked, value: unknown) {
        Object.defineProperty(this, inner, { configurable: true, writable: true, value });
      },
    });
  }
  target[HANDLER] = handler;
  return () => {
    if (target[HANDLER] === handler) target[HANDLER] = undefined;
  };
}
