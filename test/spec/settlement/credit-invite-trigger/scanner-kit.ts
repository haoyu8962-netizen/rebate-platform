// B2-04zzc rule tests round 3 (task brief §11, money r1 S1): growth's invite reward scanner exactly
// as app.module assembles it on the worker entry (its daily expiry, with the late trigger, and the
// payout scan), never built here. The dynamic module that provides the scanner token is taken from
// AppModule.forEntry({ entry: 'worker' }) and started in a Nest context over the fixture's database,
// clock and event writer, with a field cipher under a throwaway local key.
import { randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import {
  inviteRewardScannerToken,
  type InviteRewardScanner,
} from '../../../../apps/api/src/modules/growth/application/invite-reward.ts';
import {
  LocalKeyProvider,
  createWrappedKeyring,
  openFieldCrypto,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { NOW, type Fixture } from '../batch-executor/kit.ts';
import { ROOT, workerContext } from '../worker/kit.ts';
import { captureLogger } from './kit.ts';

interface ModuleLike {
  readonly providers?: unknown;
  readonly imports?: unknown;
}

function provides(provider: unknown, token: symbol): boolean {
  return (
    typeof provider === 'object' &&
    provider !== null &&
    (provider as { readonly provide?: unknown }).provide === token
  );
}

/** Every dynamic module under `root` (through imports) that lists a provider of `token`. */
function modulesProviding(root: unknown, token: symbol): unknown[] {
  const found: unknown[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null || seen.has(node)) return;
    seen.add(node);
    const candidate = node as ModuleLike;
    if (
      Array.isArray(candidate.providers) &&
      candidate.providers.some((provider) => provides(provider, token))
    ) {
      found.push(node);
    }
    if (Array.isArray(candidate.imports)) {
      for (const child of candidate.imports) visit(child);
    }
  };
  visit(root);
  return found;
}

/** The module app.module's worker entry provides the invite reward scanner with. */
async function workerScannerModule(): Promise<unknown> {
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    AppModule: { forEntry(options: object): unknown };
  };
  const assembled = AppModule.forEntry({
    entry: 'worker',
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock(NOW),
    logger: createRootLogger({ level: 'silent', entry: 'worker', appEnv: 'test' }, { write() {} }),
  });
  const modules = modulesProviding(assembled, inviteRewardScannerToken());
  expect(modules, 'app.module: no invite reward scanner on worker').toHaveLength(1);
  return modules[0];
}

/**
 * Runs `body` with the production scanner of the worker entry over the fixture's database, its
 * clock (FixedClock: the test moves it) and its event writer.
 */
export async function withProductionScanner(
  f: Fixture,
  body: (scanner: InviteRewardScanner) => Promise<void>,
  logger: RootLogger = captureLogger().logger,
): Promise<void> {
  const scannerModule = await workerScannerModule();
  const provider = new LocalKeyProvider(randomBytes(32));
  const crypto = await openFieldCrypto(await createWrappedKeyring(provider), provider);
  const context = await workerContext(scannerModule, {
    clock: f.h.clock,
    logger,
    db: f.db,
    crypto,
    events: { publish: f.h.publish },
  });
  try {
    const scanner = context.get(inviteRewardScannerToken()) as InviteRewardScanner | null;
    expect(scanner, 'the worker scanner was not assembled').not.toBeNull();
    if (scanner === null) return;
    await body(scanner);
  } finally {
    await context.close();
  }
}
