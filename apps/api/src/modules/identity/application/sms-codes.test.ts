// Unit tests of the SMS code service around Redis: the scripts themselves run against a real Redis
// in the rule tests (test/spec/identity/sms-codes) and in ../infra/sms-code-store.int.test.ts;
// here the namespace is a stub that answers each script with a canned reply, to pin the order of
// checks, the short-circuits of the insertion points and the handling of every sender and Redis
// outcome.
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DynamicModule, FactoryProvider } from '@nestjs/common';
import { expect, it, vi } from 'vitest';
import {
  FixedClock,
  ROOT_LOGGER,
  RedisUnavailableError,
  createRootLogger,
  type AppConfig,
  type AppEnv,
  type FieldCrypto,
  type RedisHandle,
  type RedisScriptOptions,
  type StagingTestPhones,
} from '../../platform/index.ts';
import type { BlocklistService } from '../../risk/index.ts';
import { IdentityModule, STAGING_TEST_PHONES, landingSmsCodes } from '../identity.module.ts';
import { identityRiskPorts } from './risk-ports.ts';
import { SMS_CODES, STEP_UP } from './tokens.ts';
import type { StepUpService } from './step-up.ts';
import {
  createSmsCodeService,
  type SmsHooks,
  type SmsMessage,
  type SmsCodeService,
  type SmsSender,
} from './sms-codes.ts';

const NUMBER = '13912345678';
const START = '2026-10-06T10:00:00+08:00';

type Kind = 'reserve' | 'mark' | 'commit' | 'release' | 'verify' | 'consume';
interface Call {
  readonly kind: Kind;
  readonly namespace: string;
  readonly options: RedisScriptOptions;
  readonly script: string;
}

function kindOf(script: string): Kind {
  const kind = /^-- sms:([a-z]+)/.exec(script)?.[1];
  if (kind === undefined) throw new Error('unlabelled script');
  return kind as Kind;
}

function setup(
  overrides: {
    hooks?: SmsHooks;
    sender?: SmsSender;
    reply?: (kind: Kind, options: RedisScriptOptions) => unknown;
    /** Answer of mark (default: 1, the candidate is now sending). */
    mark?: () => unknown;
    config?: unknown;
    sendTimeoutMs?: number;
    appEnv?: AppEnv;
    stagingTestPhones?: StagingTestPhones | null;
  } = {},
) {
  const clock = new FixedClock(START);
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const calls: Call[] = [];
  const reply =
    overrides.reply ??
    ((kind: Kind) =>
      ({
        reserve: [1, clock.now().getTime() + 60_000],
        mark: 1,
        commit: clock.now().getTime() + 60_000,
        release: 1,
        verify: 3,
        consume: 0,
      })[kind]);
  const redis: RedisHandle = {
    namespace: (namespace: string) => ({
      get: async () => {
        throw new Error('the SMS code store only runs scripts');
      },
      set: async () => {
        throw new Error('the SMS code store only runs scripts');
      },
      eval: async (script: string, options: RedisScriptOptions) => {
        const kind = kindOf(script);
        calls.push({ kind, namespace, options, script });
        if (kind === 'mark') return (overrides.mark ?? (() => 1))();
        return reply(kind, options);
      },
    }),
    close: async () => undefined,
    onApplicationShutdown: async () => undefined,
  };
  const messages: SmsMessage[] = [];
  const sender: SmsSender = overrides.sender ?? {
    send: async (message) => {
      messages.push(message);
      return 'accepted';
    },
  };
  const key = Buffer.alloc(32, 7);
  const hmac = vi.fn((text: string) => createHmac('sha256', key).update(text).digest('hex'));
  const configValue = vi.fn(async () =>
    overrides.config === undefined ? null : { value: overrides.config, version: 3 },
  );
  const service = createSmsCodeService({
    clock,
    redis,
    sender,
    logger,
    hmac,
    config: { configValue },
    ...(overrides.hooks === undefined ? {} : { hooks: overrides.hooks }),
    ...(overrides.sendTimeoutMs === undefined ? {} : { sendTimeoutMs: overrides.sendTimeoutMs }),
    ...(overrides.appEnv === undefined ? {} : { appEnv: overrides.appEnv }),
    ...(overrides.stagingTestPhones === undefined
      ? {}
      : { stagingTestPhones: overrides.stagingTestPhones }),
  });
  const send = (phone = NUMBER) =>
    service.send({
      app_id: 'couli',
      phone,
      purpose: 'login',
      device_id: 'd1',
      client_ip: '203.0.113.7',
    });
  return { clock, lines, calls, messages, hmac, configValue, service, send, redis, logger };
}

it('[BR-ID-05] the blocklist insertion point gets the normalised number, and its 44001 short-circuits the rest', async () => {
  const phoneBlocklist = vi.fn(async () => ({
    code: 44001 as const,
    kind: 'phone_blocklist' as const,
  }));
  const captcha = vi.fn(async () => null);
  const deviceQuota = vi.fn(async () => null);
  const afterAccepted = vi.fn(async () => undefined);
  const f = setup({ hooks: { phoneBlocklist, captcha, deviceQuota, afterAccepted } });
  expect(await f.send(`+86 ${NUMBER}`)).toEqual({ code: 44001, kind: 'phone_blocklist' });
  expect(phoneBlocklist).toHaveBeenCalledTimes(1);
  expect(phoneBlocklist).toHaveBeenCalledWith(
    expect.objectContaining({
      app_id: 'couli',
      phone: NUMBER,
      purpose: 'login',
      device_id: 'd1',
      client_ip: '203.0.113.7',
    }),
  );
  expect(captcha).not.toHaveBeenCalled();
  expect(deviceQuota).not.toHaveBeenCalled();
  expect(afterAccepted).not.toHaveBeenCalled();
  expect(f.calls).toEqual([]);
  expect(f.messages).toEqual([]);
});

it('[BR-ID-05] a device-quota 42901 short-circuits before the phone quota: nothing reserved or sent', async () => {
  const deviceQuota = vi.fn(async () => ({ code: 42901 as const, retryAfterSec: 1200 }));
  const afterAccepted = vi.fn(async () => undefined);
  const f = setup({ hooks: { deviceQuota, afterAccepted } });
  expect(await f.send()).toEqual({ code: 42901, retryAfterSec: 1200 });
  expect(f.calls).toEqual([]);
  expect(f.messages).toEqual([]);
  expect(afterAccepted).not.toHaveBeenCalled();
});

it('[BR-ID-05] a captcha 44003 short-circuits before the device quota', async () => {
  const deviceQuota = vi.fn(async () => null);
  const f = setup({ hooks: { captcha: async () => ({ code: 44003 }), deviceQuota } });
  expect(await f.send()).toEqual({ code: 44003 });
  expect(deviceQuota).not.toHaveBeenCalled();
  expect(f.calls).toEqual([]);
});

it('[BR-ID-05] the candidate is stored with the reservation before the SMS goes out; keys and values carry HMACs only', async () => {
  const sent: string[] = [];
  const f = setup({
    sender: {
      send: async (message) => {
        sent.push(message.code);
        expect(f.calls.map((call) => call.kind)).toEqual(['reserve', 'mark']);
        return 'accepted';
      },
    },
  });
  expect(await f.send(`0086 ${NUMBER}`)).toEqual({
    code: 0,
    data: { resend_after_sec: 60, expires_in_sec: 300 },
  });
  expect(f.calls.map((call) => call.kind)).toEqual(['reserve', 'mark', 'commit']);
  for (const call of f.calls) {
    expect(call.namespace).toBe('sms');
    expect(JSON.stringify(call.options)).not.toContain(NUMBER);
  }
  const code = sent[0]!;
  expect(code).toMatch(/^[0-9]{6}$/);
  const [reserve, mark, commit] = f.calls;
  expect(reserve!.options.ttlSeconds).toBe(90_000);
  expect(reserve!.options.keys[0]).toMatch(/^q:[0-9a-f]{64}$/);
  expect(reserve!.options.keys[1]).toMatch(/^c:couli:login:[0-9a-f]{64}$/);
  expect(reserve!.options.keys[1]!.endsWith(reserve!.options.keys[0]!.slice(2))).toBe(true);
  // ARGV[13] code TTL, ARGV[14] candidate HMAC, ARGV[15] purpose (args start at ARGV[2]).
  expect(reserve!.options.args[11]).toBe('300');
  expect(reserve!.options.args[12]).toBe(f.hmac.mock.results.at(-1)!.value);
  expect(f.hmac.mock.calls.at(-1)![0]).toContain(code);
  expect(reserve!.options.args[13]).toBe('login');
  // ARGV[16] the in-flight bound: send timeout plus margin.
  expect(reserve!.options.args[14]).toBe(String(10_000 + 5_000));
  expect(reserve!.options.args).not.toContain(code);
  expect(mark!.options.keys).toEqual(reserve!.options.keys);
  expect(mark!.options.args[1]).toBe(reserve!.options.args[1]);
  expect(commit!.options.keys).toEqual(reserve!.options.keys);
  expect(commit!.options.args[1]).toBe(reserve!.options.args[1]);
  expect(commit!.options.args).not.toContain(code);
});

it('[BR-ID-05] resend_after_sec is the time until the next send may go (latest release, at least 60)', async () => {
  const nextHour = new Date('2026-10-06T11:00:00+08:00').getTime();
  const f = setup({
    reply: (kind) => (kind === 'reserve' ? [1, 0] : kind === 'commit' ? nextHour : 1),
  });
  expect(await f.send()).toEqual({
    code: 0,
    data: { resend_after_sec: 3600, expires_in_sec: 300 },
  });
});

it('[BR-ID-05] a limit answers 42901 with the seconds until the release the script reports', async () => {
  const release = new Date(START).getTime() + 55_000;
  const f = setup({ reply: (kind) => (kind === 'reserve' ? [0, release] : 1) });
  expect(await f.send()).toEqual({ code: 42901, retryAfterSec: 55 });
  expect(f.messages).toEqual([]);
});

it('[BR-ID-05] Redis unavailable at the reservation: 42901 with Retry-After 5, nothing sent, no number logged', async () => {
  const f = setup({
    reply: () => {
      throw new RedisUnavailableError('connect_failed', 'ECONNREFUSED');
    },
  });
  expect(await f.send(`+86 ${NUMBER}`)).toEqual({ code: 42901, retryAfterSec: 5 });
  expect(f.messages).toEqual([]);
  expect(f.lines.join('')).toContain('sms_quota_unavailable');
  expect(f.lines.join('')).not.toContain(NUMBER);
});

it('[BR-ID-05] any other error of the store is not turned into a rate limit', async () => {
  const f = setup({
    reply: () => {
      throw new TypeError('bug');
    },
  });
  await expect(f.send()).rejects.toThrow('bug');
  expect(f.messages).toEqual([]);
});

it('[BR-ID-05] a definite rejection releases the reservation and answers 50001, even when the release fails', async () => {
  const rejecting: SmsSender = { send: async () => 'rejected' };
  const afterAccepted = vi.fn(async () => undefined);
  const ok = setup({ sender: rejecting, hooks: { afterAccepted } });
  expect(await ok.send()).toEqual({ code: 50001 });
  expect(ok.calls.map((call) => call.kind)).toEqual(['reserve', 'mark', 'release']);
  expect(ok.calls[2]!.options.keys).toEqual(ok.calls[0]!.options.keys);
  expect(afterAccepted).not.toHaveBeenCalled();

  const failing = setup({
    sender: rejecting,
    reply: (kind) => {
      if (kind === 'release') throw new RedisUnavailableError('command_timeout');
      return [1, 0];
    },
  });
  expect(ok.calls[2]!.options.args[1]).toBe(ok.calls[0]!.options.args[1]);
  expect(await failing.send()).toEqual({ code: 50001 });
  expect(failing.lines.join('')).toContain('sms_release_failed');
});

const throwing: SmsSender = {
  send: async () => {
    throw new Error('socket hang up');
  },
};
const odd: SmsSender = { send: async () => 'queued' as never };
const unknown: SmsSender = { send: async () => 'unknown' };

it.each([
  ['throws', throwing],
  ['answers something else', odd],
  ['answers unknown', unknown],
] as const)('[BR-ID-05] a sender that %s counts as sent: committed, 0', async (_name, sender) => {
  const afterAccepted = vi.fn(async () => undefined);
  const f = setup({ sender, hooks: { afterAccepted } });
  expect((await f.send()).code).toBe(0);
  expect(f.calls.map((call) => call.kind)).toEqual(['reserve', 'mark', 'commit']);
  expect(afterAccepted).toHaveBeenCalledTimes(1);
  expect(f.lines.join('')).not.toContain('socket hang up');
});

it('[BR-ID-05] the 60-second window starts when the provider answered', async () => {
  let providerAnswers = (): void => undefined;
  const slow = setup({
    sender: {
      send: async () => {
        providerAnswers();
        return 'accepted';
      },
    },
  });
  providerAnswers = () => slow.clock.advanceMs(30_000);
  expect((await slow.send()).code).toBe(0);
  const accepted = String(new Date(START).getTime() + 30_000);
  expect(slow.calls[0]!.options.args[0]).toBe(String(new Date(START).getTime()));
  expect(slow.calls[2]!.kind).toBe('commit');
  expect(slow.calls[2]!.options.args[0]).toBe(accepted);
});

it('[BR-ID-05] a failed commit is retried once with the same token and never resends; the answer stays 0 with a conservative wait', async () => {
  const nextHour = new Date('2026-10-06T11:00:00+08:00').getTime();
  const afterAccepted = vi.fn(async () => undefined);
  const f = setup({
    hooks: { afterAccepted },
    reply: (kind) => {
      if (kind === 'commit') throw new RedisUnavailableError('command_failed', 'OOM');
      return [1, nextHour];
    },
  });
  expect(await f.send()).toEqual({
    code: 0,
    data: { resend_after_sec: 3600, expires_in_sec: 300 },
  });
  expect(f.calls.map((call) => call.kind)).toEqual(['reserve', 'mark', 'commit', 'commit']);
  expect(f.calls[2]!.options.args[1]).toBe(f.calls[0]!.options.args[1]);
  expect(f.calls[3]!.options.args[1]).toBe(f.calls[0]!.options.args[1]);
  expect(f.messages).toHaveLength(1);
  expect(afterAccepted).toHaveBeenCalledTimes(1);
  expect(f.lines.join('')).toContain('sms_commit_failed');

  // Without a limit in the reservation's estimate, the wait is the 60 s window from acceptance.
  const plain = setup({
    reply: (kind) => {
      if (kind === 'commit') throw new RedisUnavailableError('command_timeout');
      return [1, new Date(START).getTime() + 60_000];
    },
  });
  expect(await plain.send()).toMatchObject({ code: 0, data: { resend_after_sec: 60 } });
});

it('[BR-ID-05] a commit that fails once and then runs answers from the commit', async () => {
  let failures = 1;
  const nextDay = new Date('2026-10-07T00:00:00+08:00').getTime();
  const f = setup({
    reply: (kind) => {
      if (kind === 'commit' && failures-- > 0) throw new RedisUnavailableError('command_timeout');
      return kind === 'commit' ? nextDay : [1, 0];
    },
  });
  expect(await f.send()).toMatchObject({ code: 0, data: { resend_after_sec: 50_400 } });
  expect(f.calls.map((call) => call.kind)).toEqual(['reserve', 'mark', 'commit', 'commit']);
  expect(f.lines.join('')).not.toContain('sms_commit_failed');
});

it('[BR-ID-05] a candidate that collides with a known code is drawn again, with the same reservation token', async () => {
  const replies: unknown[] = [
    [2, 0],
    [2, 0],
  ];
  const f = setup({
    reply: (kind) =>
      kind === 'reserve' ? (replies.shift() ?? [1, 0]) : new Date(START).getTime() + 60_000,
  });
  expect((await f.send()).code).toBe(0);
  const reserves = f.calls.filter((call) => call.kind === 'reserve');
  expect(reserves).toHaveLength(3);
  expect(new Set(reserves.map((call) => call.options.args[1])).size).toBe(1);
  const candidates = reserves.map((call) => call.options.args[12]);
  expect(new Set(candidates).size).toBe(3);
  expect(f.messages).toHaveLength(1);
  // The code sent is the one of the reservation that succeeded.
  const sentHash = f.hmac.mock.results[
    f.hmac.mock.calls.findIndex(([text]) => text.endsWith(`:${f.messages[0]!.code}`))
  ]!.value as string;
  expect(sentHash).toBe(candidates[2]);
});

it('[BR-ID-05] eight collisions in a row answer 50001 without sending', async () => {
  const f = setup({ reply: (kind) => (kind === 'reserve' ? [2, 0] : 1) });
  expect(await f.send()).toEqual({ code: 50001 });
  expect(f.calls.filter((call) => call.kind === 'reserve')).toHaveLength(8);
  expect(f.messages).toEqual([]);
  expect(f.lines.join('')).toContain('sms_code_collision');
});

it('[BR-ID-05] a send that outlasts sendTimeoutMs counts as unknown: committed, 0', async () => {
  const f = setup({ sendTimeoutMs: 20, sender: { send: () => new Promise(() => undefined) } });
  expect((await f.send()).code).toBe(0);
  expect(f.calls.map((call) => call.kind)).toEqual(['reserve', 'mark', 'commit']);
  expect(f.lines.join('')).toContain('sms_delivery_timeout');
  expect(() => setup({ sendTimeoutMs: 0 })).toThrow(TypeError);
});

it('[BR-ID-05] a failing post-acceptance counter is logged by class and does not change the answer', async () => {
  const f = setup({
    hooks: {
      afterAccepted: async () => {
        throw new RangeError(`counter down for ${NUMBER}`);
      },
    },
  });
  expect(await f.send()).toEqual({ code: 0, data: { resend_after_sec: 60, expires_in_sec: 300 } });
  const line = f.lines.find((entry) => entry.includes('sms_after_accepted_failed'));
  expect(line).toContain('"error_class":"RangeError"');
  expect(f.lines.join('')).not.toContain(NUMBER);
});

it('[BR-ID-05] a malformed sms.blocked_prefixes keeps the 08 default and logs the key, not the value', async () => {
  const f = setup({ config: { prefixes: ['+86139'] } });
  expect(await f.send('17012345678')).toEqual({ code: 44001, kind: 'blocked_prefix' });
  expect(await f.send()).toMatchObject({ code: 0 });
  expect(f.configValue).toHaveBeenCalledWith('couli', 'sms.blocked_prefixes');
  const warning = f.lines.find((line) => line.includes('sms_config_invalid'));
  expect(warning).toContain('"config_version":3');
  expect(warning).not.toContain('+86139');
});

it('[BR-ID-05] verifyAndConsume maps the script answers and never hashes a value that cannot be a code', async () => {
  const answers = [0, 2, 3];
  const f = setup({ reply: (kind) => (kind === 'verify' ? answers.shift() : 1) });
  const verify = (code: string, phone = NUMBER) =>
    f.service.verifyAndConsume({ app_id: 'couli', phone, purpose: 'bind', code });
  expect(await verify('123456', `+86 ${NUMBER}`)).toEqual({ code: 0 });
  expect(await verify('123456')).toEqual({ code: 20002 });
  expect(await verify('123456')).toEqual({ code: 20003 });
  expect(f.calls.every((call) => call.options.keys[0]!.startsWith('c:couli:bind:'))).toBe(true);
  expect(new Set(f.calls.map((call) => call.options.keys[0])).size).toBe(1);

  f.hmac.mockClear();
  answers.push(2);
  expect(await verify('12345a')).toEqual({ code: 20002 });
  expect(f.calls.at(-1)!.options.args[0]).toBe('');
  expect(f.hmac.mock.calls.some(([text]) => text.includes('12345a'))).toBe(false);

  const before = f.calls.length;
  expect(await verify('123456', '+852 5123 4567')).toEqual({ code: 20003 });
  expect(f.calls).toHaveLength(before);
});

it('[BR-ID-05] an unexpected script answer is a Redis failure, not a verdict', async () => {
  const f = setup({ reply: () => 'OK' });
  await expect(
    f.service.verifyAndConsume({
      app_id: 'couli',
      phone: NUMBER,
      purpose: 'login',
      code: '123456',
    }),
  ).rejects.toBeInstanceOf(RedisUnavailableError);
  expect(await f.send()).toEqual({ code: 42901, retryAfterSec: 5 });
});

it('[BR-ID-05] a reservation whose reply is lost is released with its token, nothing is sent, 42901 with Retry-After 5', async () => {
  const f = setup({
    reply: (kind) => {
      if (kind === 'reserve') throw new RedisUnavailableError('command_timeout');
      return 1;
    },
  });
  expect(await f.send()).toEqual({ code: 42901, retryAfterSec: 5 });
  expect(f.calls.map((call) => call.kind)).toEqual(['reserve', 'release']);
  expect(f.calls[1]!.options.args[1]).toBe(f.calls[0]!.options.args[1]);
  expect(f.calls[1]!.options.keys).toEqual(f.calls[0]!.options.keys);
  expect(f.messages).toEqual([]);

  // The best-effort release may fail as well: the answer does not change.
  const down = setup({
    reply: () => {
      throw new RedisUnavailableError('connect_failed');
    },
  });
  expect(await down.send()).toEqual({ code: 42901, retryAfterSec: 5 });
  expect(down.calls.map((call) => call.kind)).toEqual(['reserve', 'release', 'release']);
  expect(down.lines.join('')).toContain('sms_release_failed');
});

it('[BR-ID-05] a candidate that cannot be marked as sending is released and no SMS goes out', async () => {
  const gone = setup({ mark: () => 0 });
  expect(await gone.send()).toEqual({ code: 42901, retryAfterSec: 5 });
  expect(gone.calls.map((call) => call.kind)).toEqual(['reserve', 'mark', 'release']);
  expect(gone.messages).toEqual([]);
  expect(gone.lines.join('')).toContain('"reason":"refused"');

  const down = setup({
    mark: () => {
      throw new RedisUnavailableError('command_timeout');
    },
  });
  expect(await down.send()).toEqual({ code: 42901, retryAfterSec: 5 });
  expect(down.calls.map((call) => call.kind)).toEqual(['reserve', 'mark', 'mark', 'release']);
  expect(down.calls[3]!.options.args[1]).toBe(down.calls[0]!.options.args[1]);
  expect(down.messages).toEqual([]);
  expect(down.lines.join('')).toContain('"reason":"unavailable"');

  let failures = 1;
  const flaky = setup({
    mark: () => {
      if (failures-- > 0) throw new RedisUnavailableError('command_timeout');
      return 1;
    },
  });
  expect((await flaky.send()).code).toBe(0);
  expect(flaky.calls.map((call) => call.kind)).toEqual(['reserve', 'mark', 'mark', 'commit']);
  expect(flaky.messages).toHaveLength(1);
});

it('[BR-ID-05] a send rejected only after sendTimeoutMs leaves no unhandled rejection behind', async () => {
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  try {
    const f = setup({
      sendTimeoutMs: 20,
      sender: {
        send: () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('provider gave up late')), 60);
          }),
      },
    });
    expect((await f.send()).code).toBe(0);
    expect(f.calls.map((call) => call.kind)).toEqual(['reserve', 'mark', 'commit']);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(unhandled).not.toHaveBeenCalled();
    expect(f.lines.join('')).not.toContain('provider gave up late');
  } finally {
    process.off('unhandledRejection', unhandled);
  }
});

it('[BR-ID-05] a process that stalled more than the margin after the reservation releases instead of sending', async () => {
  let stall = 5_001;
  const late = setup({
    mark: () => {
      late.clock.advanceMs(stall);
      return 1;
    },
  });
  expect(await late.send()).toEqual({ code: 42901, retryAfterSec: 5 });
  expect(late.calls.map((call) => call.kind)).toEqual(['reserve', 'mark', 'release']);
  expect(late.calls[2]!.options.args[1]).toBe(late.calls[0]!.options.args[1]);
  expect(late.messages).toEqual([]);
  expect(late.lines.join('')).toContain('"late_ms":5001');

  stall = 5_000;
  const onTime = setup({
    mark: () => {
      onTime.clock.advanceMs(stall);
      return 1;
    },
  });
  expect((await onTime.send()).code).toBe(0);
  expect(onTime.messages).toHaveLength(1);
});

it('[BR-ID-05] a release is retried once with the same token; a second failure is only logged', async () => {
  let failures = 1;
  const rejecting: SmsSender = { send: async () => 'rejected' };
  const flaky = setup({
    sender: rejecting,
    reply: (kind) => {
      if (kind === 'release' && failures-- > 0) throw new RedisUnavailableError('command_timeout');
      return [1, 0];
    },
  });
  expect(await flaky.send()).toEqual({ code: 50001 });
  expect(flaky.calls.map((call) => call.kind)).toEqual(['reserve', 'mark', 'release', 'release']);
  expect(flaky.calls[3]!.options.args[1]).toBe(flaky.calls[0]!.options.args[1]);
  expect(flaky.lines.join('')).not.toContain('sms_release_failed');

  const down = setup({
    sender: rejecting,
    reply: (kind) => {
      if (kind === 'release') throw new RedisUnavailableError('command_timeout');
      return [1, 0];
    },
  });
  expect(await down.send()).toEqual({ code: 50001 });
  expect(down.calls.map((call) => call.kind)).toEqual(['reserve', 'mark', 'release', 'release']);
  expect(down.lines.join('')).toContain('sms_release_failed');
});

// A key without a TTL could only appear if a script failed between the write that creates a key
// and that key's EXPIRE. That cannot be provoked from outside a Lua script (once a script has
// written, Redis no longer refuses its commands for memory), so the order itself is pinned: in
// every script that may create a key, each ZADD and HSET is followed directly by an EXPIRE.
it('[BR-ID-05] every ZADD and HSET of the send scripts is followed directly by an EXPIRE', async () => {
  const scripts = new Map<Kind, string>();
  for (const f of [setup({ sender: { send: async () => 'rejected' } }), setup()]) {
    await f.send();
    for (const call of f.calls) scripts.set(call.kind, call.script);
  }
  expect([...scripts.keys()].sort()).toEqual(['commit', 'mark', 'release', 'reserve']);
  for (const [kind, script] of scripts) {
    const calls = [...script.matchAll(/redis\.call\('([A-Z]+)'/g)].map((match) => match[1]);
    calls.forEach((name, index) => {
      if (name === 'ZADD' || name === 'HSET') {
        expect(`${kind}: ${name} → ${calls[index + 1] ?? 'end'}`).toBe(`${kind}: ${name} → EXPIRE`);
      }
    });
  }
});

/** A landing send's hooks: a gate whose commit / finish are recorded in order. */
function landing(
  overrides: Parameters<typeof setup>[0] = {},
  commitResult: 'slot' | 'limited' = 'slot',
) {
  const order: string[] = [];
  const finish = vi.fn(async (outcome: string) => void order.push(`finish:${outcome}`));
  const commit = vi.fn(async () => {
    order.push('commit');
    return commitResult === 'slot'
      ? { code: 0 as const, finish }
      : { code: 42901 as const, retryAfterSec: 3611 };
  });
  const landingQuota = vi.fn(async () => {
    order.push('check');
    return { code: 0 as const, commit };
  });
  const afterAccepted = vi.fn(async () => void order.push('afterAccepted'));
  const f = setup({ ...overrides, hooks: { landingQuota, afterAccepted, ...overrides.hooks } });
  const send = (phone = NUMBER) =>
    f.service.send({
      app_id: 'couli',
      phone,
      purpose: 'login',
      client_ip: '203.0.113.7',
      channel: 'landing',
    });
  return { ...f, order, finish, commit, landingQuota, afterAccepted, send };
}

it('[AC-B1-11g#7] a landing send runs phoneBlocklist then landingQuota, never captcha or deviceQuota; the attempt is committed after the phone quota', async () => {
  const phoneBlocklist = vi.fn(async () => null);
  const captcha = vi.fn(async () => ({ code: 44003 as const }));
  const deviceQuota = vi.fn(async () => ({ code: 42901 as const, retryAfterSec: 9 }));
  const f = landing({ hooks: { phoneBlocklist, captcha, deviceQuota } });
  expect(await f.send(`+86 ${NUMBER}`)).toMatchObject({ code: 0 });
  expect(phoneBlocklist).toHaveBeenCalledOnce();
  expect(f.landingQuota).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ phone: NUMBER, channel: 'landing', client_ip: '203.0.113.7' }),
  );
  expect(captcha).not.toHaveBeenCalled();
  expect(deviceQuota).not.toHaveBeenCalled();
  expect(f.calls.map((call) => call.kind).slice(0, 2)).toEqual(['reserve', 'mark']);
  expect(f.order).toEqual(['check', 'commit', 'afterAccepted', 'finish:accepted']);
  expect(f.messages).toHaveLength(1);
});

it('[AC-B1-11g#10] a landing 42901 from landingQuota short-circuits the phone quota', async () => {
  const landingQuota = vi.fn(async () => ({ code: 42901 as const, retryAfterSec: 16 }));
  const f = setup({ hooks: { landingQuota } });
  const result = await f.service.send({
    app_id: 'couli',
    phone: NUMBER,
    purpose: 'login',
    client_ip: '203.0.113.7',
    channel: 'landing',
  });
  expect(result).toEqual({ code: 42901, retryAfterSec: 16 });
  expect(f.calls).toEqual([]);
  expect(f.messages).toEqual([]);
});

it('[AC-B1-11g#11] a landing send without a landingQuota hook is refused, never sent unjudged', async () => {
  const f = setup();
  const result = await f.service.send({
    app_id: 'couli',
    phone: NUMBER,
    purpose: 'login',
    client_ip: '203.0.113.7',
    channel: 'landing',
  });
  expect(result).toMatchObject({ code: 42901 });
  expect(f.calls).toEqual([]);
  expect(f.messages).toEqual([]);
});

it('[AC-B1-11g#27] a phone-limited landing send commits no attempt (nothing counts for the IP)', async () => {
  const f = landing({
    reply: (kind) => (kind === 'reserve' ? [0, Date.parse(START) + 60_000] : 1),
  });
  expect(await f.send()).toEqual({ code: 42901, retryAfterSec: 60 });
  expect(f.order).toEqual(['check']);
  expect(f.messages).toEqual([]);
});

it('[AC-B1-11g#58] a commit refused under the IP lock releases the phone reservation and sends nothing', async () => {
  const f = landing({}, 'limited');
  expect(await f.send()).toEqual({ code: 42901, retryAfterSec: 3611 });
  expect(f.order).toEqual(['check', 'commit']);
  expect(f.calls.map((call) => call.kind)).toEqual(['reserve', 'release']);
  expect(f.messages).toEqual([]);
});

it('[AC-B1-11g#20] a landing send the provider refuses writes its attempt failed (stops counting)', async () => {
  const f = landing({ sender: { send: async () => 'rejected' } });
  expect(await f.send()).toEqual({ code: 50001 });
  expect(f.order).toEqual(['check', 'commit', 'finish:failed']);
  expect(f.afterAccepted).not.toHaveBeenCalled();
});

it('[AC-B1-11g#19] an unknown landing send (timeout or thrown adapter error) writes its attempt unknown', async () => {
  for (const sender of [
    { send: async () => 'unknown' as const },
    {
      send: async () => {
        throw new Error('adapter down');
      },
    },
  ]) {
    const f = landing({ sender });
    expect(await f.send()).toMatchObject({ code: 0 });
    expect(f.order).toEqual(['check', 'commit', 'afterAccepted', 'finish:unknown']);
  }
});

it('[AC-B1-11g#6] a landing send whose phone quota store is unavailable commits no attempt', async () => {
  const f = landing({
    reply: (kind) => {
      if (kind === 'reserve') throw new RedisUnavailableError('command_failed');
      return 1;
    },
  });
  expect(await f.send()).toMatchObject({ code: 42901 });
  expect(f.order).toEqual(['check']);
  expect(f.messages).toEqual([]);
});

it('[AC-B1-11g#6] a committed attempt whose mark fails is written failed (nothing was sent)', async () => {
  const f = landing({ mark: () => 0 });
  expect(await f.send()).toMatchObject({ code: 42901 });
  expect(f.order).toEqual(['check', 'commit', 'finish:failed']);
  expect(f.messages).toEqual([]);
});

it('[AC-B1-11g#64] a failing outcome write is only logged; the answer stays 0', async () => {
  const f = landing();
  f.finish.mockRejectedValueOnce(new Error('down 203.0.113.7'));
  expect(await f.send()).toMatchObject({ code: 0 });
  expect(f.lines.join('')).toContain('sms_attempt_slot_finish_failed');
  expect(f.lines.join('')).not.toContain('203.0.113.7');
});

it('[AC-B1-11g#13] an app send with an attempt gate commits after the phone quota and writes each outcome', async () => {
  for (const [delivery, outcome] of [
    ['rejected', 'failed'],
    ['accepted', 'accepted'],
    ['unknown', 'unknown'],
  ] as const) {
    const finish = vi.fn(async () => undefined);
    const commit = vi.fn(async () => ({ code: 0 as const, finish }));
    const f = setup({
      hooks: { deviceQuota: async () => ({ code: 0 as const, commit }) },
      sender: { send: async () => delivery },
    });
    expect((await f.send()).code).toBe(delivery === 'rejected' ? 50001 : 0);
    expect(commit).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledExactlyOnceWith(outcome);
  }
});

it('[AC-B1-11g#13] a phone-limited app send never commits its attempt', async () => {
  const commit = vi.fn();
  const f = setup({
    hooks: { deviceQuota: async () => ({ code: 0 as const, commit }) },
    reply: (kind) => (kind === 'reserve' ? [0, Date.parse(START) + 60_000] : 1),
  });
  expect(await f.send()).toEqual({ code: 42901, retryAfterSec: 60 });
  expect(commit).not.toHaveBeenCalled();
});

it('[AC-B1-03zh#5][BR-ID-36][BR-ID-05] SMS_BLOCKED_PREFIX 停用：先问规则状态，号段内号码不判定、不记命中，照常往下发码', async () => {
  const blockedPrefixInForce = vi.fn(async () => false);
  const blockedPrefix = vi.fn(async () => undefined);
  const phoneBlocklist = vi.fn(async () => null);
  const f = setup({ hooks: { blockedPrefixInForce, blockedPrefix, phoneBlocklist } });
  expect(await f.send('17012345678')).toMatchObject({ code: 0 });
  expect(blockedPrefixInForce).toHaveBeenCalledWith(
    expect.objectContaining({ app_id: 'couli', phone: '17012345678', purpose: 'login' }),
  );
  expect(blockedPrefix).not.toHaveBeenCalled();
  // No prefix decision at all: the prefix list is not even read.
  expect(f.configValue).not.toHaveBeenCalledWith('couli', 'sms.blocked_prefixes');
  expect(phoneBlocklist).toHaveBeenCalledTimes(1);
  expect(f.messages.map((m) => m.phone)).toEqual(['17012345678']);
});

it('[AC-B1-03zh#5][BR-ID-36][BR-ID-05] SMS_BLOCKED_PREFIX 生效（或无此端口）：照旧 44001 并记命中', async () => {
  const blockedPrefix = vi.fn(async () => undefined);
  const enabled = setup({ hooks: { blockedPrefixInForce: async () => true, blockedPrefix } });
  expect(await enabled.send('17012345678')).toEqual({ code: 44001, kind: 'blocked_prefix' });
  expect(blockedPrefix).toHaveBeenCalledTimes(1);
  expect(enabled.messages).toEqual([]);
  const absent = setup({ hooks: { blockedPrefix } });
  expect(await absent.send('17012345678')).toEqual({ code: 44001, kind: 'blocked_prefix' });
  expect(blockedPrefix).toHaveBeenCalledTimes(2);
});

it('[AC-B1-03zh#5][BR-ID-36] 规则状态读取失败：照常抛出，不发码也不放行', async () => {
  const f = setup({
    hooks: {
      blockedPrefixInForce: async () => {
        throw new Error('down');
      },
    },
  });
  await expect(f.send('17012345678')).rejects.toThrow('down');
  expect(f.messages).toEqual([]);
  expect(f.calls).toEqual([]);
});

/** risk's port fake: the rule is in force on its first read and disabled on every later one. */
function expiringRisk() {
  let reads = 0;
  const risk = {
    check: vi.fn<BlocklistService['check']>(async () => null),
    checkRegistration: vi.fn<BlocklistService['checkRegistration']>(async () => null),
    matchRegistration: vi.fn<BlocklistService['matchRegistration']>(async () => null),
    recordHit: vi.fn<BlocklistService['recordHit']>(async () => ({ ref_id: 'r' })),
    recordDecidedHit: vi.fn<NonNullable<BlocklistService['recordDecidedHit']>>(async () => ({
      ref_id: 'r',
    })),
    recordHits: vi.fn<BlocklistService['recordHits']>(async () => ({ ref_id: 'r' })),
    allowBlockedRegistration: vi.fn<BlocklistService['allowBlockedRegistration']>(
      async () => false,
    ),
    ruleInForce: vi.fn<NonNullable<BlocklistService['ruleInForce']>>(async () => {
      reads += 1;
      return reads === 1;
    }),
  };
  const crypto = { blindIndex: (value: string, context: string) => `${context}:${value}` };
  return { risk, ports: identityRiskPorts(risk, crypto as unknown as FieldCrypto) };
}

it('[AC-B1-03zh#19][BR-ID-36][BR-ID-05] 号段拦截一次判定只读一次规则状态：拒绝（44001）后经 recordDecidedHit 记命中，不再读状态', async () => {
  const { risk, ports } = expiringRisk();
  const f = setup({ hooks: ports.smsHooks });
  expect(await f.send('17012345678')).toEqual({ code: 44001, kind: 'blocked_prefix' });
  expect(risk.ruleInForce).toHaveBeenCalledTimes(1);
  expect(risk.recordHit).not.toHaveBeenCalled();
  expect(risk.recordDecidedHit).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ rule_id: 'SMS_BLOCKED_PREFIX', dimension: 'phone_prefix' }),
  );
  expect(f.messages).toEqual([]);
});

it('[AC-B1-03zh#20][BR-ID-36] 设备注册上限的拒绝命中经 recordDecidedHit 写（判定已在注册事务里读过状态），不再读状态', async () => {
  const { risk, ports } = expiringRisk();
  await ports.login.recordDeviceLimit!({
    app_id: 'a',
    device_hash: 'h',
    count: 3,
    limit: 3,
    phone: NUMBER,
  });
  expect(risk.ruleInForce).not.toHaveBeenCalled();
  expect(risk.recordHit).not.toHaveBeenCalled();
  expect(risk.recordDecidedHit).toHaveBeenCalledExactlyOnceWith({
    app_id: 'a',
    request_type: 'register',
    related_phone: NUMBER,
    dimension: 'device',
    value_hmac: 'h',
    rule_id: 'DEVICE_REGISTER_LIMIT',
  });
});

// B1-02zza (D10-611): staging test phones. Synthetic values only.
const TEST_PHONE = '19900000099';
const TEST_CODE = '864213';
const TEST_PHONES: StagingTestPhones = { phones: [TEST_PHONE], code: TEST_CODE };

it('[AC-B1-02zza#u1] staging: a listed number’s app login / step_up code runs every store step but never reaches the sender', async () => {
  for (const purpose of ['login', 'step_up'] as const) {
    const f = setup({ appEnv: 'staging', stagingTestPhones: TEST_PHONES });
    const result = await f.service.send({
      app_id: 'couli',
      phone: `+86 ${TEST_PHONE}`,
      purpose,
      device_id: 'd1',
      client_ip: '203.0.113.7',
    });
    expect(result).toEqual({ code: 0, data: { resend_after_sec: 60, expires_in_sec: 300 } });
    expect(f.messages).toEqual([]);
    expect(f.calls.map((call) => call.kind)).toEqual(['reserve', 'mark', 'commit']);
    const logs = f.lines.join('');
    expect(logs).toContain('sms_staging_test_phone_not_sent');
    expect(logs).not.toContain(TEST_PHONE);
    expect(logs).not.toContain(TEST_CODE);
  }
});

it('[AC-B1-02zza#u2] staging: bind, the landing route and unlisted numbers still go to the sender', async () => {
  const f = setup({
    appEnv: 'staging',
    stagingTestPhones: TEST_PHONES,
    hooks: {
      landingQuota: async () => ({
        code: 0,
        commit: async () => ({ code: 0, finish: async () => undefined }),
      }),
    },
  });
  expect((await f.service.send({ app_id: 'couli', phone: TEST_PHONE, purpose: 'bind' })).code).toBe(
    0,
  );
  expect(
    (
      await f.service.send({
        app_id: 'couli',
        phone: TEST_PHONE,
        purpose: 'login',
        channel: 'landing',
      })
    ).code,
  ).toBe(0);
  expect((await f.send(NUMBER)).code).toBe(0);
  expect(f.messages.map((message) => [message.phone, message.purpose])).toEqual([
    [TEST_PHONE, 'bind'],
    [TEST_PHONE, 'login'],
    [NUMBER, 'login'],
  ]);
});

it('[AC-B1-02zza#u3] verify: the fixed code of a listed login / step_up consumes the current code; anything else is the ordinary check', async () => {
  const f = setup({ appEnv: 'staging', stagingTestPhones: TEST_PHONES });
  const verify = (
    code: string,
    purpose: 'login' | 'step_up' | 'bind' = 'login',
    phone = TEST_PHONE,
    options?: { stagingTestCode?: boolean },
  ) => f.service.verifyAndConsume({ app_id: 'couli', phone, purpose, code }, options);
  expect(await verify(TEST_CODE)).toEqual({ code: 0, staging_test_phone: true });
  expect(f.calls.at(-1)!.kind).toBe('consume');
  expect(f.calls.at(-1)!.options.keys[0]!.startsWith('c:couli:login:')).toBe(true);
  expect(await verify(TEST_CODE, 'step_up')).toEqual({ code: 0, staging_test_phone: true });
  expect(f.calls.at(-1)!.options.keys[0]!.startsWith('c:couli:step_up:')).toBe(true);
  const consumes = f.calls.filter((call) => call.kind === 'consume').length;
  // Wrong code, bind, unlisted, landing (stagingTestCode false): the verify script, never consume.
  expect(await verify('000000')).toEqual({ code: 20003 });
  expect(await verify(TEST_CODE, 'bind')).toEqual({ code: 20003 });
  expect(await verify(TEST_CODE, 'login', NUMBER)).toEqual({ code: 20003 });
  expect(await verify(TEST_CODE, 'login', TEST_PHONE, { stagingTestCode: false })).toEqual({
    code: 20003,
  });
  expect(f.calls.filter((call) => call.kind === 'consume')).toHaveLength(consumes);
  expect(f.calls.slice(-4).map((call) => call.kind)).toEqual([
    'verify',
    'verify',
    'verify',
    'verify',
  ]);
  expect(f.lines.join('')).not.toContain(TEST_CODE);
});

it('[AC-B1-02zza#u4] verify: no current code for the fixed code answers 20003 without the staging flag', async () => {
  const f = setup({
    appEnv: 'staging',
    stagingTestPhones: TEST_PHONES,
    reply: (kind) => (kind === 'consume' ? 3 : 1),
  });
  expect(
    await f.service.verifyAndConsume({
      app_id: 'couli',
      phone: TEST_PHONE,
      purpose: 'login',
      code: TEST_CODE,
    }),
  ).toEqual({ code: 20003 });
});

it('[AC-B1-02zza#u5] construction: test phones outside staging (or without appEnv) or a malformed fixed code are refused', () => {
  for (const appEnv of ['local', 'test', 'prod', undefined] as const) {
    expect(() =>
      setup({ ...(appEnv === undefined ? {} : { appEnv }), stagingTestPhones: TEST_PHONES }),
    ).toThrow(/APP_ENV=staging/);
    expect(() =>
      setup({ ...(appEnv === undefined ? {} : { appEnv }), stagingTestPhones: null }),
    ).not.toThrow();
  }
  for (const code of ['12345', '1234567', 'abcdef', '']) {
    expect(() =>
      setup({ appEnv: 'staging', stagingTestPhones: { phones: [TEST_PHONE], code } }),
    ).toThrow(/6 ASCII digits/);
  }
});

// identity.module's wiring (review-spec r1 S2 ②): the factories of the real module are called with
// stand-ins, so what reaches createSmsCodeService / createStepUpService is the module's own code.
function factoryOf(module: DynamicModule, token: symbol): FactoryProvider {
  const provider = (module.providers ?? []).find(
    (candidate) =>
      typeof candidate === 'object' && 'provide' in candidate && candidate.provide === token,
  );
  expect(provider).toBeDefined();
  expect(provider).toHaveProperty('useFactory');
  return provider as FactoryProvider;
}

/** The one required option; the factories under test never use the configuration reader. */
const MODULE_OPTIONS = { config: { useFactory: () => null } };

const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));

function stagingConfig(codeFile: string): AppConfig {
  return {
    appEnv: 'staging',
    stagingTestPhones: { phones: [TEST_PHONE], codeFile },
  } as unknown as AppConfig;
}

it('[AC-B1-02zza#u10] identity.module opens the code file on the signing entry in staging; a bad file rejects (the entry does not start); stream and other environments open nothing', async () => {
  const parent = join(ROOT, '.tmp/b1-02zza-identity-module');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'case-'));
  try {
    const codeFile = join(directory, 'code');
    await writeFile(codeFile, `${TEST_CODE}\n`, 'utf8');
    const lines: string[] = [];
    const logger = createRootLogger(
      { level: 'trace', entry: 'api', appEnv: 'test' },
      { write: (line: string) => void lines.push(line) },
    );
    const api = factoryOf(IdentityModule.forRoot(MODULE_OPTIONS), STAGING_TEST_PHONES);
    expect(api.inject).toEqual([expect.anything(), ROOT_LOGGER]);
    await expect(api.useFactory(stagingConfig(codeFile), logger)).resolves.toEqual(TEST_PHONES);
    expect(lines.join('')).toContain('"test_phone_count":1');
    expect(lines.join('')).not.toContain(TEST_PHONE);
    expect(lines.join('')).not.toContain(TEST_CODE);

    for (const bad of ['12345\n', 'abcdef']) {
      await writeFile(codeFile, bad, 'utf8');
      await expect(api.useFactory(stagingConfig(codeFile), logger)).rejects.toThrow(
        /STAGING_TEST_SMS_CODE_FILE/,
      );
    }
    await expect(api.useFactory(stagingConfig(join(directory, 'missing')), logger)).rejects.toThrow(
      /STAGING_TEST_SMS_CODE_FILE/,
    );
    await expect(api.useFactory(stagingConfig(directory), logger)).rejects.toThrow(
      /STAGING_TEST_SMS_CODE_FILE/,
    );

    const stream = factoryOf(
      IdentityModule.forRoot({ ...MODULE_OPTIONS, tokens: 'verify' }),
      STAGING_TEST_PHONES,
    );
    await expect(
      stream.useFactory(stagingConfig(join(directory, 'missing')), logger),
    ).resolves.toBeNull();
    for (const appEnv of ['local', 'test', 'prod'] as const) {
      await expect(
        api.useFactory(
          { ...stagingConfig(join(directory, 'missing')), appEnv } as AppConfig,
          logger,
        ),
      ).resolves.toBeNull();
    }
    await expect(
      api.useFactory({ appEnv: 'staging' } as unknown as AppConfig, logger),
    ).resolves.toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('[AC-B1-02zza#u11] identity.module passes APP_ENV and the opened test phones to the SMS code service; the step-up service gets the root logger', async () => {
  const f = setup();
  const module = IdentityModule.forRoot(MODULE_OPTIONS);
  const smsCodes = factoryOf(module, SMS_CODES);
  expect(smsCodes.inject).toContain(STAGING_TEST_PHONES);
  const messages: SmsMessage[] = [];
  const sender: SmsSender = {
    send: async (message) => {
      messages.push(message);
      return 'accepted';
    },
  };
  const fieldCrypto = {
    blindIndex: (text: string, context: string) =>
      createHmac('sha256', 'unit').update(`${context}:${text}`).digest('hex'),
  } as unknown as FieldCrypto;
  const build = (config: AppConfig, phones: StagingTestPhones | null) =>
    smsCodes.useFactory(
      config,
      f.clock,
      f.logger,
      sender,
      { configValue: async () => null },
      null,
      { smsHooks: {} },
      phones,
      f.redis,
      fieldCrypto,
    ) as SmsCodeService;
  const staged = build({ appEnv: 'staging' } as AppConfig, TEST_PHONES);
  expect((await staged.send({ app_id: 'couli', phone: TEST_PHONE, purpose: 'login' })).code).toBe(
    0,
  );
  expect(messages).toEqual([]);
  expect(
    await staged.verifyAndConsume({
      app_id: 'couli',
      phone: TEST_PHONE,
      purpose: 'login',
      code: TEST_CODE,
    }),
  ).toEqual({ code: 0, staging_test_phone: true });
  // The landing registration's view never takes the fixed code.
  const consumes = f.calls.filter((call) => call.kind === 'consume').length;
  expect(
    await landingSmsCodes(staged).verifyAndConsume({
      app_id: 'couli',
      phone: TEST_PHONE,
      purpose: 'login',
      code: TEST_CODE,
    }),
  ).toEqual({ code: 20003 });
  expect(f.calls.filter((call) => call.kind === 'consume')).toHaveLength(consumes);
  // The module hands appEnv over: test phones with a prod config refuse to build.
  expect(() => build({ appEnv: 'prod' } as AppConfig, TEST_PHONES)).toThrow(/APP_ENV=staging/);

  const stepUp = factoryOf(module, STEP_UP);
  expect(stepUp.inject?.[1]).toBe(ROOT_LOGGER);
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const db = {
    selectFrom: () => {
      const chain = {
        select: () => chain,
        where: () => chain,
        executeTakeFirst: async () => ({
          phone_hmac: 'hmac',
          phone_cipher: Buffer.from(TEST_PHONE, 'utf8'),
        }),
      };
      return chain;
    },
  };
  const service = stepUp.useFactory(
    f.clock,
    logger,
    { configValue: async () => null, minSupportedVersion: async () => null },
    { kid: 'unit', privateKey: pair.privateKey, publicKeys: new Map([['unit', pair.publicKey]]) },
    {
      send: vi.fn(),
      verifyAndConsume: async () => ({ code: 0, staging_test_phone: true }),
    },
    { issue: vi.fn(), consume: vi.fn() },
    null,
    db,
    { decrypt: (text: string) => text },
  ) as StepUpService;
  const uid = '019a0000-0000-7000-8000-000000000010';
  const result = await service.verify({
    principal: { uid, app_id: 'couli', sid: 's', device_id: 'd', scp: 'full' },
    verifiedDevice: { appId: 'couli', deviceId: 'd' },
    body: { action: 'withdraw', code: TEST_CODE },
  });
  expect(result.code).toBe(0);
  const audit = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry['event'] === 'staging_test_phone_login');
  expect(audit).toEqual([
    expect.objectContaining({ purpose: 'step_up', user_id: uid, phone_masked: '199****0099' }),
  ]);
});
