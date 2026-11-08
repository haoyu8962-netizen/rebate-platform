// Kill-switch drill CLI (QA-05c). Runbook: ./README.md; semantics: ./drill.ts.
// Exit code 0 only after every case passed, every switch is confirmed back to its original value
// with the degradation gone, and the record is durably written; otherwise 1.

import { readFileSync, realpathSync } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertSwitchTarget,
  createStepUpSource,
  createSwitchApi,
  planSwitchDrill,
  runSwitchDrill,
  SwitchDrillError,
  switchObservationOf,
  type HttpRequest,
  type SwitchDrillOptions,
  type SwitchDrillResult,
  type SwitchTarget,
} from './drill.ts';
import { createConvertProbe, type ConvertProbeConfig, type SignedRequest } from './probe.ts';

export interface SwitchArgs {
  readonly keys: readonly string[];
  readonly runsDir: string;
  readonly target: SwitchTarget;
  readonly bearer: string;
  readonly stepUpToken: string;
}

export interface CliPorts {
  readonly repoRoot: string;
  /** Canonicalizes existing ancestors, including symlinks in drills/switches. */
  readonly canonical: (path: string) => Promise<string>;
  /** Must reserve exclusively (wx, mode 0600), before any remote write. */
  readonly reserve: (
    path: string,
    options: { readonly flag: 'wx'; readonly mode: 0o600 },
  ) => Promise<{
    write(record: SwitchDrillResult): Promise<void>;
    close(): Promise<void>;
  }>;
  readonly onSignal: (name: 'SIGINT' | 'SIGTERM', handler: () => void) => () => void;
  readonly drill: Omit<SwitchDrillOptions, 'target' | 'keys' | 'signal'>;
  /** Where the record went or why nothing ran; codes and paths only, never credentials. */
  readonly report?: (line: {
    readonly ok: boolean;
    readonly code?: string;
    readonly record?: string;
  }) => void;
}

const VALUE_FLAGS = new Set(['--keys', '--base-url', '--runs-dir', '--bearer', '--step-up-token']);
const BOOLEAN_FLAGS = new Set(['--staging']);

/** APP_ENV, bearer and step-up may come from injected env; never reads .env files. */
export function parseSwitchArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  stagingOrigins: readonly string[],
): SwitchArgs {
  const values = new Map<string, string>();
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined || seen.has(flag)) throw new SwitchDrillError('invalid_option');
    seen.add(flag);
    if (BOOLEAN_FLAGS.has(flag)) continue;
    if (!VALUE_FLAGS.has(flag)) throw new SwitchDrillError('invalid_option');
    const value = argv[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      throw new SwitchDrillError('invalid_option');
    }
    values.set(flag, value);
    index += 1;
  }
  const keysText = values.get('--keys');
  const baseUrl = values.get('--base-url');
  const runsDir = values.get('--runs-dir');
  const bearer = values.get('--bearer') ?? env['DRILL_ADMIN_TOKEN'];
  const stepUpToken = values.get('--step-up-token') ?? env['DRILL_STEP_UP_TOKEN'];
  if (
    keysText === undefined ||
    baseUrl === undefined ||
    runsDir === undefined ||
    !isAbsolute(runsDir) ||
    bearer === undefined ||
    bearer.length === 0 ||
    stepUpToken === undefined ||
    stepUpToken.length === 0
  ) {
    throw new SwitchDrillError('invalid_option');
  }
  const keys = keysText.split(',').map((key) => key.trim());
  planSwitchDrill(keys);
  const target: SwitchTarget = {
    appEnv: env['APP_ENV'] ?? '',
    baseUrl,
    staging: seen.has('--staging'),
    stagingOrigins: [...stagingOrigins],
  };
  assertSwitchTarget(target);
  return { keys, runsDir, target, bearer, stepUpToken };
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** Absolute repository-external runs directory; same-name record is never overwritten. */
export function switchRecordPath(repoRoot: string, runsDir: string, startedAt: Date): string {
  if (!isAbsolute(repoRoot) || !isAbsolute(runsDir) || Number.isNaN(startedAt.getTime())) {
    throw new SwitchDrillError('invalid_option');
  }
  const root = resolve(repoRoot);
  const runs = resolve(runsDir);
  if (isInside(root, runs)) throw new SwitchDrillError('record_in_repo');
  const stamp = startedAt
    .toISOString()
    .replace(/\.\d{3}Z$/u, 'Z')
    .replace(/[-:]/gu, '');
  return join(runs, 'drills', 'switches', `switches-${stamp}.json`);
}

function codeOf(error: unknown): string {
  return error instanceof SwitchDrillError ? error.code : 'drill_failed';
}

/** Only the result fields, rebuilt: nothing else (and no upstream text) reaches the record. */
function sanitize(result: SwitchDrillResult): SwitchDrillResult {
  return {
    ok: result.ok,
    problems: result.problems.map((problem) => ({ key: problem.key, code: problem.code })),
    restored: [...result.restored],
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
  };
}

/** Returns 0 only after successful restoration, verification and durable record writing. */
export async function runSwitchCli(args: SwitchArgs, ports: CliPorts): Promise<0 | 1> {
  const report = ports.report ?? (() => {});
  let destination: string;
  let file: Awaited<ReturnType<CliPorts['reserve']>>;
  const startedAt = ports.drill.clock.now();
  try {
    // Refuse a bad target or key list before anything is reserved or sent.
    assertSwitchTarget(args.target);
    planSwitchDrill(args.keys);
    const runsDir = await ports.canonical(args.runsDir);
    const path = switchRecordPath(ports.repoRoot, runsDir, startedAt);
    // Check the final parent too: drills/switches itself could be a symlink into the checkout.
    const parent = await ports.canonical(dirname(path));
    switchRecordPath(ports.repoRoot, parent, startedAt);
    destination = join(parent, basename(path));
    file = await ports.reserve(destination, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    report({ ok: false, code: codeOf(error) });
    return 1;
  }

  const controller = new AbortController();
  const offs = [
    ports.onSignal('SIGINT', () => controller.abort('SIGINT')),
    ports.onSignal('SIGTERM', () => controller.abort('SIGTERM')),
  ];
  let result: SwitchDrillResult | undefined;
  let recorded = false;
  let closed = false;
  try {
    // A crash (SIGKILL) leaves this incomplete record behind as the trail to check by hand.
    await file.write({
      ok: false,
      problems: [{ key: '*', code: 'incomplete' }],
      restored: [],
      startedAt: startedAt.toISOString(),
      finishedAt: startedAt.toISOString(),
    });
    try {
      result = await runSwitchDrill({
        ...ports.drill,
        target: args.target,
        keys: args.keys,
        signal: controller.signal,
      });
    } catch (error) {
      result = {
        ok: false,
        problems: [{ key: '*', code: codeOf(error) }],
        restored: [],
        startedAt: startedAt.toISOString(),
        finishedAt: ports.drill.clock.now().toISOString(),
      };
    }
    await file.write(sanitize(result));
    recorded = true;
  } catch {
    // Record writing failed; the drill itself always restores before returning.
  } finally {
    try {
      await file.close();
      closed = true;
    } catch {
      closed = false;
    }
    for (const off of offs) off();
  }
  const ok = result?.ok === true && recorded && closed;
  report(
    recorded
      ? { ok, record: destination }
      : { ok: false, code: 'record_failed', record: destination },
  );
  return ok ? 0 : 1;
}

// ---- Composition root: real fetch, files and signals. Not used by the rule tests. ----

/** Resolve existing ancestors as well, so a symlink cannot send records into the checkout. */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonical(parent), basename(path));
  }
}

/** Staging origins come from the reviewed file next to this script, never from flags or env. */
function trustedStagingOrigins(): readonly string[] {
  const file = fileURLToPath(new URL('./staging-origins.json', import.meta.url));
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new SwitchDrillError('invalid_option');
  }
  return parsed;
}

async function transport(request: HttpRequest): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
    redirect: request.redirect,
    signal: AbortSignal.timeout(10_000),
  };
  if (request.body !== undefined) init.body = JSON.stringify(request.body);
  const response = await fetch(request.url, init);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

async function signedTransport(request: SignedRequest): Promise<{ status: number; body: unknown }> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: request.redirect,
    signal: AbortSignal.timeout(request.timeoutMs),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

/**
 * Keys a real run cannot observe (drill.ts switchObservationOf): the whole run is refused before
 * anything is reserved, read or written, naming those keys.
 */
export function unobservableKeys(keys: readonly string[]): readonly string[] {
  return keys.filter((key) => switchObservationOf(key)?.kind !== 'convert_link');
}

/**
 * The convertLink probe's settings, from the environment only (never .env files): the probe
 * user's demo login and device, and one product url per drilled platform. The user-facing API
 * origin passes the same environment / allowlist check as the admin one.
 */
export function probeConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  adminTarget: SwitchTarget,
  keys: readonly string[],
): ConvertProbeConfig {
  const read = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.length === 0) throw new SwitchDrillError('probe_unavailable');
    return value;
  };
  const target: SwitchTarget = { ...adminTarget, baseUrl: read('DRILL_PROBE_BASE_URL') };
  assertSwitchTarget(target);
  const urls: Record<string, string> = {};
  for (const key of keys) {
    const platform = key.slice('convert.enabled.'.length);
    urls[platform] = read(`DRILL_PROBE_URL_${platform.toUpperCase()}`);
  }
  return {
    target,
    appId: read('DRILL_PROBE_APP_ID'),
    clientPlatform: read('DRILL_PROBE_CLIENT_PLATFORM') as ConvertProbeConfig['clientPlatform'],
    appVersion: read('DRILL_PROBE_APP_VERSION'),
    deviceId: read('DRILL_PROBE_DEVICE_ID'),
    installSecret: read('DRILL_PROBE_INSTALL_SECRET'),
    userToken: read('DRILL_PROBE_USER_TOKEN'),
    urls,
  };
}

/**
 * Asks on the terminal for the authenticator's current code without echoing it. Ctrl-C or
 * Ctrl-D at the prompt gives up this token (the PUT that needed it is not sent).
 */
function readTotpCode(): Promise<string> {
  const input = process.stdin;
  process.stderr.write(
    '开关写入需要二次验证：请输入身份验证器当前的 6 位动态码（不回显；刚输过的码请等刷新后再输）：',
  );
  return new Promise((resolvePromise, reject) => {
    let code = '';
    const done = (error: Error | null): void => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stderr.write('\n');
      if (error === null) resolvePromise(code);
      else reject(error);
    };
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          done(null);
          return;
        }
        if (char === '\u0003' || char === '\u0004') {
          done(new SwitchDrillError('step_up_unavailable'));
          return;
        }
        if (char === '\u007f' || char === '\b') code = code.slice(0, -1);
        else if (code.length < 16) code += char;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

async function main(): Promise<void> {
  const args = parseSwitchArgs(process.argv.slice(2), process.env, trustedStagingOrigins());
  // Refuse before anything is reserved or written: a drill without real observation proves nothing.
  const refused = unobservableKeys(args.keys);
  if (refused.length > 0) {
    process.stderr.write(
      JSON.stringify({ ok: false, code: 'unobservable_switch', keys: refused }) + '\n',
    );
    process.exitCode = 1;
    return;
  }
  // Every PUT after the first needs a new step-up token, asked for on the terminal.
  if (process.stdin.isTTY !== true) throw new SwitchDrillError('step_up_unavailable');
  const probe = createConvertProbe(
    {
      config: probeConfigFromEnv(process.env, args.target, args.keys),
      transport: signedTransport,
      now: () => new Date(),
    },
    args.keys,
  );
  const repoRoot = await realpath(fileURLToPath(new URL('../../../', import.meta.url)));
  const api = createSwitchApi({
    target: args.target,
    bearer: args.bearer,
    stepUpToken: args.stepUpToken,
    stepUpSource: createStepUpSource({
      target: args.target,
      bearer: args.bearer,
      readTotpCode,
      transport,
    }),
    transport,
  });
  const code = await runSwitchCli(args, {
    repoRoot,
    canonical: async (path) => canonical(resolve(path)),
    reserve: async (path, options) => {
      await mkdir(dirname(path), { recursive: true });
      // The directory now exists: it must still be where the checks said it was.
      if ((await realpath(dirname(path))) !== dirname(path)) {
        throw new SwitchDrillError('record_in_repo');
      }
      const handle = await open(path, options.flag, options.mode);
      return {
        write: async (record) => {
          const bytes = Buffer.from(JSON.stringify(record, null, 2) + '\n');
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesWritten } = await handle.write(
              bytes,
              offset,
              bytes.length - offset,
              offset,
            );
            if (bytesWritten === 0) throw new Error('short write');
            offset += bytesWritten;
          }
          await handle.truncate(bytes.length);
          await handle.sync();
        },
        close: async () => handle.close(),
      };
    },
    onSignal: (name, handler) => {
      process.on(name, handler);
      return () => {
        process.off(name, handler);
      };
    },
    drill: { api, probe, clock: { now: () => new Date() }, sleep: (ms) => sleep(ms) },
    report: (line) => {
      process.stdout.write(JSON.stringify(line) + '\n');
    },
  });
  process.exitCode = code;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  void main().catch((error: unknown) => {
    // Never echo upstream messages, URLs or environment values.
    process.stderr.write(JSON.stringify({ ok: false, code: codeOf(error) }) + '\n');
    process.exitCode = 1;
  });
}
