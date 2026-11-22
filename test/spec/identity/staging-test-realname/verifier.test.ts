import { expect, it } from 'vitest';
import {
  FAKE_REALNAME_PROVIDER,
  createRealnameVerifier,
  createStagingTestRealnameVerifier,
} from '../../../../apps/api/src/modules/identity/infra/fake-realname-verifier.ts';
import type { RealnameVerifierPort } from '../../../../apps/api/src/modules/identity/ports/realname-verifier.ts';
import {
  NAME,
  NOT_STAGING,
  PROVIDER,
  ROOT,
  auditLines,
  countWarnings,
  expectAudit,
  expectHardOff,
  expectNoLeak,
  memoryLogger,
  otherLines,
  residentId,
  userId,
  userIds,
  verification,
} from './kit.ts';

const APP = 'b1-13n-app';
const ID = residentId('1990-01-01');

interface ProviderShape {
  readonly provide?: unknown;
  readonly inject?: readonly unknown[];
  readonly useFactory?: (...args: unknown[]) => unknown;
}

function providerOf(items: readonly unknown[], token: symbol): ProviderShape | undefined {
  for (const item of items) {
    if (typeof item === 'object' && item !== null && (item as ProviderShape).provide === token) {
      return item as ProviderShape;
    }
  }
  return undefined;
}

/** The token of an `inject` entry (`{ token, optional }` or the token itself). */
function tokenOf(token: unknown): unknown {
  if (typeof token === 'object' && token !== null && 'token' in token) return token.token;
  return token;
}

/**
 * identity.module's member-side REALNAME_VERIFIER provider (what POST /v1/me/realname gets),
 * called with `config` as APP_CONFIG and `logger` as ROOT_LOGGER (other tokens: absent).
 */
async function memberAssembly() {
  const { IdentityModule } = (await import(
    new URL('apps/api/src/modules/identity/identity.module.ts', ROOT).href
  )) as { IdentityModule: { forRoot(options: unknown): { providers?: readonly unknown[] } } };
  const { REALNAME_VERIFIER } = (await import(
    new URL('apps/api/src/modules/identity/application/tokens.ts', ROOT).href
  )) as { REALNAME_VERIFIER: symbol };
  const { APP_CONFIG, ROOT_LOGGER } = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as { APP_CONFIG: unknown; ROOT_LOGGER: unknown };
  const module = IdentityModule.forRoot({ config: { useFactory: () => null } });
  const provider = providerOf(module.providers ?? [], REALNAME_VERIFIER);
  expect(provider?.useFactory).toBeTypeOf('function');
  async function build(
    config: Record<string, unknown>,
    logger: unknown,
  ): Promise<RealnameVerifierPort | null> {
    const args = (provider?.inject ?? []).map((token) => {
      const key = tokenOf(token);
      if (key === APP_CONFIG) return config;
      return key === ROOT_LOGGER ? logger : undefined;
    });
    return (await provider!.useFactory!(...args)) as RealnameVerifierPort | null;
  }
  return build;
}

it('[AC-B1-13n#1] staging 名单内 user_id：核验器判一致、provider 为 staging-test-identity、写一条只带 app_id / user_id / provider 的审计；名单外 unavailable；local / test 假实现与 staging / prod 的 createRealnameVerifier（admin 更正用）不变；绕过配置把名单传进工厂，非 staging 也不得判一致', async () => {
  const { logger, lines } = memoryLogger();
  const [listed, other] = userIds(2) as [string, string];
  const outsider = userId();
  const verifier = createStagingTestRealnameVerifier({
    appEnv: 'staging',
    userIds: [listed, other],
    logger,
  });
  expect(verifier).not.toBeNull();
  expect(await verifier!.verify(verification(APP, listed, ID))).toEqual({
    outcome: 'match',
    provider: PROVIDER,
  });
  expect(auditLines(lines)).toHaveLength(1);
  expectAudit(auditLines(lines)[0], APP, listed);

  const refused = await verifier!.verify(verification(APP, outsider, ID));
  expect(refused).toMatchObject({ outcome: 'unavailable' });
  expect(refused).not.toHaveProperty('provider', PROVIDER);
  expect(auditLines(lines)).toHaveLength(1);
  expect(await verifier!.verify(verification(APP, other, ID))).toEqual({
    outcome: 'match',
    provider: PROVIDER,
  });
  expect(auditLines(lines)).toHaveLength(2);
  expectAudit(auditLines(lines)[1], APP, other);

  // Unchanged: the fake of local / test, and no vendor in staging / prod for the admin correction.
  for (const appEnv of ['local', 'test']) {
    const fake = createRealnameVerifier(appEnv);
    expect(await fake!.verify(verification(APP, outsider, ID))).toEqual({
      outcome: 'match',
      provider: FAKE_REALNAME_PROVIDER,
    });
  }
  for (const appEnv of ['staging', 'prod']) expect(createRealnameVerifier(appEnv)).toBeNull();

  // Hard off outside staging, also when the list reaches the factory around the configuration.
  for (const appEnv of NOT_STAGING) {
    await expectHardOff(
      appEnv,
      () => createStagingTestRealnameVerifier({ appEnv, userIds: [listed], logger }),
      verification(APP, listed, ID),
    );
  }
  expect(auditLines(lines)).toHaveLength(2);
  expectNoLeak(lines.join('\n'), [NAME, ID]);
  expectNoLeak(otherLines(lines), [listed, other, outsider]);
});

it('[AC-B1-13n#2] 会员侧核验器装配：staging 配了名单 → 名单内判一致并审计、名单外 unavailable、启用 warn 只带个数；未设 / 空名单仍为 null；local / test 仍是假实现；prod 等非 staging 带名单不得判一致；admin 用的 createRealnameVerifier 在 staging 仍为 null', async () => {
  const build = await memberAssembly();
  const { logger, lines } = memoryLogger();
  const listed = userIds(3) as [string, string, string];
  const verifier = await build({ appEnv: 'staging', stagingTestRealnameUserIds: listed }, logger);
  expect(verifier).not.toBeNull();
  expect(countWarnings(lines, listed.length).length).toBeGreaterThan(0);
  expectNoLeak(lines.join('\n'), listed);
  expect(await verifier!.verify(verification(APP, listed[2], ID))).toEqual({
    outcome: 'match',
    provider: PROVIDER,
  });
  expect(auditLines(lines)).toHaveLength(1);
  expectAudit(auditLines(lines)[0], APP, listed[2]);
  const outsider = userId();
  expect(await verifier!.verify(verification(APP, outsider, ID))).toMatchObject({
    outcome: 'unavailable',
  });
  expect(auditLines(lines)).toHaveLength(1);

  // The admin correction assembles createRealnameVerifier(appEnv): still no vendor in staging.
  expect(createRealnameVerifier('staging')).toBeNull();

  // Unset or empty: as today (no verifier → 50301).
  for (const ids of [undefined, null, []]) {
    expect(await build({ appEnv: 'staging', stagingTestRealnameUserIds: ids }, logger)).toBeNull();
  }
  expect(await build({ appEnv: 'staging' }, logger)).toBeNull();

  // local / test: the fake as today.
  for (const appEnv of ['local', 'test']) {
    const fake = await build({ appEnv }, logger);
    expect(await fake!.verify(verification(APP, outsider, ID))).toEqual({
      outcome: 'match',
      provider: FAKE_REALNAME_PROVIDER,
    });
  }

  // A list that reached a non-staging assembly around loadConfig never answers the test identity.
  for (const appEnv of ['prod', 'local', 'test']) {
    await expectHardOff(
      appEnv,
      () => build({ appEnv, stagingTestRealnameUserIds: [listed[0]] }, logger),
      verification(APP, listed[0], ID),
    );
  }
  expect(auditLines(lines)).toHaveLength(1);
  expectNoLeak(lines.join('\n'), [NAME, ID]);
  expectNoLeak(otherLines(lines), [...listed, outsider]);
});
