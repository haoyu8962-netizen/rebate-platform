import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readAgentUserHashConfig } from './agent-user-hash.ts';
import { ConfigError, loadConfig, normalizeCrashReportDsn, parseCrashReportDsn } from './config.ts';

/** Synthetic AGENT_USER_HASH_KEY for prod inputs (B3-09j: prod refuses to start without it). */
const AGENT_KEY = 'unit-test-agent-user-hash-key';
const PROD_AGENT_KEY = { AGENT_USER_HASH_KEY: AGENT_KEY } as const;

function problemsOf(env: Record<string, string | undefined>): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe('loadConfig', () => {
  it('[AC-B1-01f] applies the documented defaults when only APP_ENV is set', () => {
    expect(loadConfig({ APP_ENV: 'local' })).toEqual({
      appEnv: 'local',
      logLevel: 'info',
      clockNow: undefined,
      exitAfterInit: false,
      apiHost: '127.0.0.1',
      apiPort: 3100,
      streamPort: 3101,
      adminPort: 3102,
      keyring: null,
      jwt: null,
      trustedProxies: [],
      adminAuth: null,
      mediaPublicBaseUrl: 'https://media.local.invalid',
      exportStoreBaseUrl: 'https://exports.local.invalid',
      exportStoreSigningKey: 'local-only-export-store-signing-key-not-secret',
      pdd: null,
      pddQueryCustomParameters: null,
      unionEndpointOverrideDir: null,
      taobaoConvertSource: 'baichuan',
      taobaoSearchSource: 'official',
      agentUserHashKey: null,
    });
  });

  it('[AC-B1-01f] reads every variable and ignores unrelated ones', () => {
    expect(
      loadConfig({
        APP_ENV: 'staging',
        FIELD_KEY_PROVIDER: 'kms',
        FIELD_KEYRING_FILE: '/srv/couli/keyring.json',
        PRIOR_IDENTITY_KEY_PROVIDER: 'kms',
        PRIOR_IDENTITY_KEYRING_FILE: '/srv/couli/prior-identity-keyring.json',
        LOG_LEVEL: 'debug',
        CLOCK_NOW: '2026-10-31T23:59:59.999+08:00',
        COULI_EXIT_AFTER_INIT: '1',
        API_HOST: '0.0.0.0',
        API_PORT: '8080',
        STREAM_PORT: '8081',
        ADMIN_PORT: '8082',
        DATABASE_URL: 'postgres://couli_app@127.0.0.1:54329/couli',
        REDIS_URL: 'redis://127.0.0.1:63790',
        TRUSTED_PROXIES: ' 198.51.100.0/24, 2001:db8::1 ',
        AGENT_USER_HASH_KEY: AGENT_KEY,
        PATH: '/usr/bin',
      }),
    ).toEqual({
      appEnv: 'staging',
      logLevel: 'debug',
      clockNow: '2026-10-31T23:59:59.999+08:00',
      exitAfterInit: true,
      apiHost: '0.0.0.0',
      apiPort: 8080,
      streamPort: 8081,
      adminPort: 8082,
      keyring: { provider: 'kms', keyringFile: '/srv/couli/keyring.json' },
      priorIdentityKeyring: {
        provider: 'kms',
        keyringFile: '/srv/couli/prior-identity-keyring.json',
      },
      jwt: null,
      trustedProxies: ['198.51.100.0/24', '2001:db8::1'],
      adminAuth: null,
      pdd: null,
      pddQueryCustomParameters: null,
      unionEndpointOverrideDir: null,
      taobaoConvertSource: 'baichuan',
      taobaoSearchSource: 'official',
      agentUserHashKey: AGENT_KEY,
    });
  });

  it('[AC-B1-01f] treats empty strings as unset', () => {
    const config = loadConfig({ APP_ENV: 'test', LOG_LEVEL: '', CLOCK_NOW: '', API_PORT: '' });
    expect(config).toMatchObject({ logLevel: 'info', clockNow: undefined, apiPort: 3100 });
  });

  it('[AC-B1-01f] requires APP_ENV', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(problemsOf({})).toHaveLength(1);
    expect(problemsOf({})[0]).toMatch(/^APP_ENV: /);
    expect(problemsOf({ APP_ENV: 'production' })[0]).toMatch(/^APP_ENV: /);
  });

  it('[AC-B1-01f] aggregates every problem into one readable error without echoing values', () => {
    const env = {
      APP_ENV: 'test',
      LOG_LEVEL: 'loud',
      API_PORT: '70000',
      STREAM_PORT: 'http',
      CLOCK_NOW: '2026-10-01 12:00:00',
      DATABASE_URL: 'mysql://user:hunter2@db/couli',
    };
    const problems = problemsOf(env);
    expect(problems.map((problem) => problem.split(':')[0]).sort()).toEqual([
      'API_PORT',
      'CLOCK_NOW',
      'LOG_LEVEL',
      'STREAM_PORT',
    ]);
    let message = '';
    try {
      loadConfig(env);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^Invalid environment configuration:\n- /);
    expect(message).not.toContain('hunter2');
  });

  it.each(['2026-10-01T12:00:00Z', '2026-10-01T12:00:00.123+08:00', '2026-10-01T04:00:00-05:00'])(
    '[AC-B1-01f] accepts CLOCK_NOW=%s outside prod',
    (clockNow) => {
      for (const appEnv of ['local', 'test', 'staging']) {
        expect(
          loadConfig({
            APP_ENV: appEnv,
            CLOCK_NOW: clockNow,
            ...(appEnv === 'staging'
              ? {
                  FIELD_KEY_PROVIDER: 'kms',
                  FIELD_KEYRING_FILE: '/srv/couli/keyring.json',
                  PRIOR_IDENTITY_KEY_PROVIDER: 'kms',
                  PRIOR_IDENTITY_KEYRING_FILE: '/srv/couli/prior-identity-keyring.json',
                }
              : {}),
          }).clockNow,
        ).toBe(clockNow);
      }
    },
  );

  it.each(['2026-10-01T12:00:00', '2026-10-01', '1790000000000', 'now'])(
    '[AC-B1-01f] rejects CLOCK_NOW=%s (no explicit offset or not ISO-8601)',
    (clockNow) => {
      expect(problemsOf({ APP_ENV: 'test', CLOCK_NOW: clockNow })[0]).toMatch(/^CLOCK_NOW: /);
    },
  );

  it('[AC-B1-01f] refuses to start in prod when CLOCK_NOW is set (ADR-0001 §4.2 #10)', () => {
    expect(
      problemsOf({ APP_ENV: 'prod', CLOCK_NOW: '2026-10-01T12:00:00Z', ...PROD_AGENT_KEY }),
    ).toEqual([
      'CLOCK_NOW: must not be set when APP_ENV=prod (the production clock is real time)',
      'FIELD_KEY_PROVIDER: must be set when APP_ENV=prod',
    ]);
    // Refused even when the value is malformed: both findings are reported.
    expect(problemsOf({ APP_ENV: 'prod', CLOCK_NOW: 'tomorrow', ...PROD_AGENT_KEY })).toHaveLength(
      3,
    );
    expect(
      loadConfig({
        APP_ENV: 'prod',
        FIELD_KEY_PROVIDER: 'kms',
        FIELD_KEYRING_FILE: '/srv/couli/keyring.json',
        PRIOR_IDENTITY_KEY_PROVIDER: 'kms',
        PRIOR_IDENTITY_KEYRING_FILE: '/srv/couli/prior-identity-keyring.json',
        ...PROD_AGENT_KEY,
      }).clockNow,
    ).toBeUndefined();
  });

  it.each(['local', 'test'])(
    '[AC-B1-01f] refuses to start in %s when a credential-looking variable is set (规划/11 §8)',
    (appEnv) => {
      const problems = problemsOf({
        APP_ENV: appEnv,
        UNION_TAOBAO_APP_SECRET: 'real-secret-value',
        SMS_ACCESS_KEY_SECRET: 'another-real-value',
      });
      expect(problems).toHaveLength(2);
      expect(problems[0]).toMatch(
        /^SMS_ACCESS_KEY_SECRET: looks like a real third-party credential/,
      );
      expect(problems[1]).toMatch(/^UNION_TAOBAO_APP_SECRET: /);
      expect(problems.join('\n')).not.toMatch(/real-secret-value|another-real-value/);
    },
  );

  it.each(['staging', 'prod'])('[AC-B1-01f] allows credential variables in %s', (appEnv) => {
    expect(
      loadConfig({
        APP_ENV: appEnv,
        ALIPAY_PRIVATE_KEY: 'k',
        FIELD_KEY_PROVIDER: 'kms',
        FIELD_KEYRING_FILE: '/srv/couli/keyring.json',
        PRIOR_IDENTITY_KEY_PROVIDER: 'kms',
        PRIOR_IDENTITY_KEYRING_FILE: '/srv/couli/prior-identity-keyring.json',
        ...PROD_AGENT_KEY,
      }).appEnv,
    ).toBe(appEnv);
  });

  it('[AC-B1-01f] ignores credential-looking variables that are empty', () => {
    expect(loadConfig({ APP_ENV: 'local', UNION_SECRET: '' }).appEnv).toBe('local');
  });

  it('[BR-ID-07] JWT_* problems are merged only when a JWT variable is set, after the other problems', () => {
    // Unset in prod: loadConfig keeps its own findings; identity's key provider refuses at startup.
    expect(
      problemsOf({
        APP_ENV: 'prod',
        FIELD_KEY_PROVIDER: 'kms',
        FIELD_KEYRING_FILE: '/k.json',
        PRIOR_IDENTITY_KEY_PROVIDER: 'kms',
        PRIOR_IDENTITY_KEYRING_FILE: '/prior-k.json',
        ...PROD_AGENT_KEY,
      }),
    ).toEqual([]);
    const pem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    expect(problemsOf({ APP_ENV: 'test', LOG_LEVEL: 'loud', JWT_PRIVATE_KEY_PEM: pem })).toEqual([
      expect.stringMatching(/^LOG_LEVEL: /),
      'JWT_KEY_ID: must be set together with JWT_PRIVATE_KEY_PEM',
    ]);
    const sec1 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .privateKey.export({ type: 'sec1', format: 'pem' })
      .toString();
    const problems = problemsOf({ APP_ENV: 'test', JWT_KEY_ID: 'k1', JWT_PRIVATE_KEY_PEM: sec1 });
    expect(problems).toEqual([expect.stringMatching(/^JWT_PRIVATE_KEY_PEM: .*PKCS#8/)]);
    expect(problems.join('\n')).not.toContain(sec1.trim().split('\n')[1]);
    expect(
      loadConfig({ APP_ENV: 'local', JWT_KEY_ID: 'k1', JWT_PRIVATE_KEY_PEM: pem }).jwt,
    ).toEqual({
      kid: 'k1',
      privateKeyPem: pem,
      verificationKeys: {},
    });
  });
});

describe('loadConfig JWT verify-only reading (B1-02zj)', () => {
  it('[D10-255] JWT_KEY_ID + JWT_PUBLIC_KEY_PEM loads: no signing key, the verification keys in jwtVerify', () => {
    const publicPem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    const config = loadConfig({
      APP_ENV: 'prod',
      FIELD_KEY_PROVIDER: 'kms',
      FIELD_KEYRING_FILE: '/k.json',
      PRIOR_IDENTITY_KEY_PROVIDER: 'kms',
      PRIOR_IDENTITY_KEYRING_FILE: '/prior-k.json',
      ...PROD_AGENT_KEY,
      JWT_KEY_ID: 'k1',
      JWT_PUBLIC_KEY_PEM: publicPem,
    });
    expect(config.jwt).toBeNull();
    expect(config.jwtVerify).toEqual({ kid: 'k1', publicKeyPem: publicPem, verificationKeys: {} });
  });

  it('[D10-255] with the private key both readings are present; without JWT_* jwtVerify is absent', () => {
    const pem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const config = loadConfig({ APP_ENV: 'local', JWT_KEY_ID: 'k1', JWT_PRIVATE_KEY_PEM: pem });
    expect(config.jwt?.kid).toBe('k1');
    expect(config.jwtVerify?.kid).toBe('k1');
    expect(config.jwtVerify?.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(loadConfig({ APP_ENV: 'local' })).not.toHaveProperty('jwtVerify');
  });

  it("[D10-255] a JWT_PUBLIC_KEY_PEM that is not the private key's pair is refused", () => {
    const one = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const two = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const problems = problemsOf({
      APP_ENV: 'test',
      JWT_KEY_ID: 'k1',
      JWT_PRIVATE_KEY_PEM: one.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      JWT_PUBLIC_KEY_PEM: two.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    expect(problems).toEqual([
      expect.stringMatching(/^JWT_PUBLIC_KEY_PEM: must be the public key/),
    ]);
  });
});

describe('readAgentUserHashConfig (B3-09j)', () => {
  const OTHER = 'unrelated-value-never-echoed';

  it('[BR-AI-22] prod without the key (missing, empty or blank): null and one problem naming only the variable', () => {
    for (const value of [undefined, '', '   ', ' \t\n ']) {
      const result = readAgentUserHashConfig('prod', { AGENT_USER_HASH_KEY: value, OTHER });
      expect(result.agentUserHashKey).toBeNull();
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]?.startsWith('AGENT_USER_HASH_KEY')).toBe(true);
      expect(result.problems.join('\n')).not.toContain(OTHER);
    }
    const problems = problemsOf({
      APP_ENV: 'prod',
      FIELD_KEY_PROVIDER: 'kms',
      FIELD_KEYRING_FILE: '/k.json',
      PRIOR_IDENTITY_KEY_PROVIDER: 'kms',
      PRIOR_IDENTITY_KEYRING_FILE: '/prior-k.json',
    });
    expect(problems).toEqual([expect.stringMatching(/^AGENT_USER_HASH_KEY: /)]);
  });

  it('[BR-AI-22] local / test / staging without the key: null and no problem', () => {
    for (const appEnv of ['local', 'test', 'staging'] as const) {
      for (const value of [undefined, '', '  ']) {
        expect(readAgentUserHashConfig(appEnv, { AGENT_USER_HASH_KEY: value })).toEqual({
          agentUserHashKey: null,
          problems: [],
        });
      }
    }
    expect(loadConfig({ APP_ENV: 'test' }).agentUserHashKey).toBeNull();
  });

  it('[BR-AI-22] a non-blank key is kept exactly as set in every APP_ENV', () => {
    for (const appEnv of ['local', 'test', 'staging', 'prod'] as const) {
      for (const value of [AGENT_KEY, `  ${AGENT_KEY}  `]) {
        expect(readAgentUserHashConfig(appEnv, { AGENT_USER_HASH_KEY: value })).toEqual({
          agentUserHashKey: value,
          problems: [],
        });
      }
    }
    expect(loadConfig({ APP_ENV: 'test', ...PROD_AGENT_KEY }).agentUserHashKey).toBe(AGENT_KEY);
  });
});

describe('readTrustedProxies', () => {
  it('[AC-B1-03m#6] rejects hop counts, catch-all ranges and netmasks without echoing values', () => {
    for (const value of ['2', '0.0.0.0/0', '::/0', '10.0.0.0/255.0.0.0', 'fe80::1%eth0', 'a,,b']) {
      const problems = problemsOf({ APP_ENV: 'local', TRUSTED_PROXIES: value });
      expect(problems).toHaveLength(1);
      expect(problems[0]?.startsWith('TRUSTED_PROXIES:')).toBe(true);
      expect(problems.join('\n')).not.toContain(value);
    }
  });

  it('[AC-B1-03m#2] accepts addresses and prefix ranges at both families’ bounds', () => {
    expect(
      loadConfig({ APP_ENV: 'local', TRUSTED_PROXIES: '10.0.0.0/8,198.51.100.1/32,::1/128' })
        .trustedProxies,
    ).toEqual(['10.0.0.0/8', '198.51.100.1/32', '::1/128']);
  });
});

describe('CRASH_REPORT_DSN', () => {
  const DSN = 'https://0123456789abcdef0123456789abcdef@glitchtip.unit.test/5';

  it('[AC-QA-13d#1] unset: no crashReport key at all', () => {
    expect('crashReport' in loadConfig({ APP_ENV: 'local' })).toBe(false);
  });

  it('[AC-QA-13d#1] set: the DSN as given when already normal', () => {
    const config = loadConfig({ APP_ENV: 'local', CRASH_REPORT_DSN: DSN });
    expect(config.crashReport).toEqual({
      dsn: DSN,
      origin: 'https://glitchtip.unit.test',
      host: 'glitchtip.unit.test',
      projectId: '5',
      publicKey: '0123456789abcdef0123456789abcdef',
      envelopeEndpoint: 'https://glitchtip.unit.test/api/5/envelope/',
    });
  });

  it('[AC-QA-13d#1] set: blanks, a trailing slash and a default port are normalised away', () => {
    for (const [value, normal] of [
      [` ${DSN}\n`, DSN],
      [`${DSN}/`, DSN],
      ['HTTPS://unitDsnKey@GlitchTip.Unit.Test:443/5', 'https://unitDsnKey@glitchtip.unit.test/5'],
      ['http://unitDsnKey@10.1.2.3:8000/5', 'http://unitDsnKey@10.1.2.3:8000/5'],
    ] as const) {
      expect(loadConfig({ APP_ENV: 'local', CRASH_REPORT_DSN: value }).crashReport?.dsn).toBe(
        normal,
      );
      expect(normalizeCrashReportDsn(value)).toBe(normal);
    }
  });

  it('[AC-QA-13d#1] the path is exactly /<project id>, with or without one trailing slash', () => {
    for (const [value, endpoint] of [
      ['https://unitDsnKey@glitchtip.unit.test/3', 'https://glitchtip.unit.test/api/3/envelope/'],
      ['https://unitDsnKey@glitchtip.unit.test/3/', 'https://glitchtip.unit.test/api/3/envelope/'],
      ['http://unitDsnKey@10.1.2.3:8000/3/', 'http://10.1.2.3:8000/api/3/envelope/'],
    ] as const) {
      const parsed = parseCrashReportDsn(value);
      expect(parsed?.projectId).toBe('3');
      expect(parsed?.envelopeEndpoint).toBe(endpoint);
      expect(parsed?.dsn).toBe(value.replace(/\/$/, ''));
      expect(loadConfig({ APP_ENV: 'local', CRASH_REPORT_DSN: value }).crashReport).toEqual(parsed);
    }
  });

  it('[AC-QA-13d#1] a DSN with any path prefix is refused naming only the variable', () => {
    for (const value of [
      'https://unitDsnKey@glitchtip.unit.test/error%20tracking/3',
      'https://unitDsnKey@glitchtip.unit.test/error tracking/3',
      'http://unitDsnKey@10.1.2.3:8000/ops/glitch-tip/v1/3/',
      'https://unitDsnKey@glitchtip.unit.test/prefix/3',
      'https://unitDsnKey@glitchtip.unit.test//3',
      'https://unitDsnKey@glitchtip.unit.test/ops//glitch-tip/3',
      'https://unitDsnKey@glitchtip.unit.test/%33',
      'https://unitDsnKey@glitchtip.unit.test/3//',
      'https://unitDsnKey@glitchtip.unit.test/',
    ]) {
      expect(parseCrashReportDsn(value)).toBeUndefined();
      expect(normalizeCrashReportDsn(value)).toBeUndefined();
      const problems = problemsOf({ APP_ENV: 'local', CRASH_REPORT_DSN: value });
      expect(problems).toHaveLength(1);
      expect(problems[0]?.startsWith('CRASH_REPORT_DSN:')).toBe(true);
      expect(problems.join('\n')).not.toContain('unitDsnKey');
      expect(problems.join('\n')).not.toContain('glitchtip.unit.test');
    }
  });

  it('[AC-QA-13d#1] a malformed DSN is refused naming only the variable', () => {
    for (const [name, value] of [
      ['CRASH_REPORT_DSN', 'https://:secret@unit-dsn-a.test/5'],
      ['CRASH_REPORT_DSN', 'https://0123abcd:pass@unit-dsn-b.test/5'],
      ['CRASH_REPORT_DSN', 'https://0123abcd@unit-dsn-c.test/5?x=1'],
      ['CRASH_REPORT_DSN', 'https://01-23abcd@unit-dsn-d.test/5'],
      ['CRASH_REPORT_DSN', 'https://0123abcd@unit-dsn-e.test/5#frag'],
      ['CRASH_REPORT_DSN', 'ftp://0123abcd@unit-dsn-f.test/5'],
      ['CRASH_REPORT_DSN', 'https://0123abcd@unit-dsn-g.test/project'],
      ['CRASH_REPORT_DSN', '   '],
    ] as const) {
      const problems = problemsOf({ APP_ENV: 'local', [name]: value });
      expect(problems).toHaveLength(1);
      expect(problems[0]?.startsWith(`${name}:`)).toBe(true);
      expect(problems.join('\n')).not.toContain(value);
      expect(problems.join('\n')).not.toContain('unit-');
    }
  });
});
