import { expect, it } from 'vitest';
import {
  parseSwitchArgs,
  runSwitchCli,
  switchRecordPath,
  type CliPorts,
  type SwitchArgs,
} from '../../../../infra/drills/switches/cli.ts';
import type { SwitchDrillResult } from '../../../../infra/drills/switches/drill.ts';
import { fixture, LOCAL, STEP_UP, TOKEN } from './fixture.ts';

const ARGV = [
  '--keys',
  'agent.enabled,jev.enabled',
  '--base-url',
  LOCAL.baseUrl,
  '--runs-dir',
  '/workspace/couli-runs',
];
const ENV = { APP_ENV: 'local', DRILL_ADMIN_TOKEN: TOKEN, DRILL_STEP_UP_TOKEN: STEP_UP };

function cliFixture() {
  const f = fixture();
  const records: SwitchDrillResult[] = [];
  const signals = new Map<string, () => void>();
  const args: SwitchArgs = {
    keys: ['agent.enabled'],
    runsDir: '/workspace/couli-runs',
    target: LOCAL,
    bearer: TOKEN,
    stepUpToken: STEP_UP,
  };
  const ports: CliPorts = {
    repoRoot: '/workspace/rebate-platform',
    drill: f.options,
    canonical: async (path) => path,
    reserve: async (path, options) => {
      expect(options).toEqual({ flag: 'wx', mode: 0o600 });
      f.events.push(`reserve:${path}`);
      return {
        write: async (record) => {
          records.push(record);
          f.events.push('record');
        },
        close: async () => {
          f.events.push('close');
        },
      };
    },
    onSignal: (name, handler) => {
      signals.set(name, handler);
      return () => {
        signals.delete(name);
      };
    },
  };
  return { ...f, args, ports, signals, records };
}

it('[AC-QA-05c#28] 参数及环境提供目标与凭据；不需要 .env 文件', () => {
  expect(parseSwitchArgs(ARGV, ENV, [])).toEqual({
    keys: ['agent.enabled', 'jev.enabled'],
    runsDir: '/workspace/couli-runs',
    target: LOCAL,
    bearer: TOKEN,
    stepUpToken: STEP_UP,
  });
  expect(
    parseSwitchArgs(
      [
        '--keys',
        'agent.enabled',
        '--base-url',
        'https://stage.example.invalid',
        '--runs-dir',
        '/workspace/couli-runs',
        '--staging',
        '--bearer',
        TOKEN,
        '--step-up-token',
        STEP_UP,
      ],
      { APP_ENV: 'staging' },
      ['https://stage.example.invalid'],
    ),
  ).toMatchObject({
    target: { appEnv: 'staging', staging: true, baseUrl: 'https://stage.example.invalid' },
    bearer: TOKEN,
    stepUpToken: STEP_UP,
  });
});

it.each([
  ['--env-file', '.env'],
  ['--allow-host', 'prod.example.invalid'],
  ['--keys', 'agent.enabled'],
  ['--unknown'],
])('[AC-QA-05c#29] CLI 拒绝重复、未知及会绕过白名单的参数 %j', (...extra) => {
  expect(() => parseSwitchArgs([...ARGV, ...extra], ENV, [])).toThrow(
    expect.objectContaining({ code: 'invalid_option' }),
  );
});

it.each([
  { APP_ENV: 'local' },
  { APP_ENV: 'local', DRILL_ADMIN_TOKEN: TOKEN },
  { APP_ENV: 'local', DRILL_STEP_UP_TOKEN: STEP_UP },
])('[AC-QA-05c#30] 缺凭据时不能进入演练 %j', (env) => {
  expect(() => parseSwitchArgs(ARGV, env, [])).toThrow(
    expect.objectContaining({ code: 'invalid_option' }),
  );
});

it('[AC-QA-05c#31] 记录在仓库外绝对目录，文件名使用注入 UTC 时钟', () => {
  expect(
    switchRecordPath(
      '/workspace/rebate-platform',
      '/workspace/couli-runs',
      new Date('2026-11-09T01:02:03.000Z'),
    ),
  ).toBe('/workspace/couli-runs/drills/switches/switches-20261109T010203Z.json');
});

it.each([
  'relative',
  '/workspace/rebate-platform',
  '/workspace/rebate-platform/.tmp/runs',
  '/workspace/other/../rebate-platform/runs',
])('[AC-QA-05c#32] 记录目录 %s 不满足绝对路径且仓库外的条件', (runsDir) => {
  expect(() =>
    switchRecordPath('/workspace/rebate-platform', runsDir, new Date('2026-11-09')),
  ).toThrow(
    expect.objectContaining({ code: expect.stringMatching(/invalid_option|record_in_repo/) }),
  );
});

it('[AC-QA-05c#33] 正常结束先预留记录，再切换；恢复完成写记录，退出 0 并卸载信号处理', async () => {
  const f = cliFixture();
  expect(await runSwitchCli(f.args, f.ports)).toBe(0);
  expect(f.events[0]).toMatch(/^reserve:\/workspace\/couli-runs\/drills\/switches\//);
  expect(f.events.at(-1)).toBe('close');
  expect(f.records.at(-1)).toMatchObject({ ok: true, restored: ['agent.enabled'] });
  expect(f.events.lastIndexOf('record')).toBeGreaterThan(
    f.events.indexOf('write:agent.enabled:true:8'),
  );
  expect(f.signals.size).toBe(0);
  expect(JSON.stringify(f.records)).not.toContain(TOKEN);
  expect(JSON.stringify(f.records)).not.toContain(STEP_UP);
});

it('[AC-QA-05c#34] 同名记录预留失败不覆盖、不切换，退出 1', async () => {
  const f = cliFixture();
  const ports = {
    ...f.ports,
    reserve: async () => {
      throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    },
  };
  expect(await runSwitchCli(f.args, ports)).toBe(1);
  expect(f.events).toEqual([]);
  expect(f.records).toEqual([]);
});

it.each(['runs-root', 'record-parent'])(
  '[AC-QA-05c#35] 符号链接把 %s 指回仓库时，预留记录和写开关前拒绝',
  async (location) => {
    const f = cliFixture();
    const ports: CliPorts = {
      ...f.ports,
      canonical: async (path) => {
        if (location === 'runs-root' || path.includes('/drills/switches'))
          return '/workspace/rebate-platform/records';
        return path;
      },
    };
    expect(await runSwitchCli(f.args, ports)).toBe(1);
    expect(f.events).toEqual([]);
  },
);

it.each(['SIGINT', 'SIGTERM'] as const)(
  '[AC-QA-05c#36] CLI 接到 %s 时恢复、记录失败、退出 1，并移除两个处理器',
  async (name) => {
    const f = cliFixture();
    f.hooks.afterWrite = (_key, value) => {
      if (value === false) f.signals.get(name)?.();
    };
    expect(await runSwitchCli(f.args, f.ports)).toBe(1);
    expect(f.rows.get('agent.enabled')?.value).toBe(true);
    expect(f.records.at(-1)).toMatchObject({ ok: false, restored: ['agent.enabled'] });
    expect(f.signals.size).toBe(0);
  },
);

it('[AC-QA-05c#37] 最终记录失败不能返回成功，开关仍恢复且文件关闭', async () => {
  const f = cliFixture();
  const ports: CliPorts = {
    ...f.ports,
    reserve: async () => ({
      write: async () => {
        throw new Error(`disk full ${TOKEN}`);
      },
      close: async () => {
        f.events.push('close');
      },
    }),
  };
  expect(await runSwitchCli(f.args, ports)).toBe(1);
  expect(f.rows.get('agent.enabled')?.value).toBe(true);
  expect(f.events.at(-1)).toBe('close');
  expect(f.signals.size).toBe(0);
});
