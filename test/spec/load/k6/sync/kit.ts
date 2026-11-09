// QA-06c kit 契约：独立入口 sync.ts，同目录 sync.config.json，纯函数 sync-options.ts。
// 实现可从 options.ts 提取共用构造器，但必须保留 QA-06a 三场景校验与原 config/script。
// sync 配置沿用 ScenarioConfig 字段；仅 requests.sync 是后台契约体。
// LOAD_ADMIN_TOKEN 必填；LOAD_ENV 缺省 local，仅 local / wiremock（不开放 staging）。
// setup 在 window 模式 GET limits，sync(setupData) 发送一次 POST；order_nos 无需读 limits。
// 两种模式均须校验配置、令牌、目标；redirects=0；无重试、step-up、幂等键、日志令牌。
// 请求构造的 limits 是响应 data，不是整份响应；窗口必须满足对应平台 earliest_from。
// 规划 01 §7.3 只有总峰值 50；5 = 50 - QA-06a 的 30 - 15 是本地分配，非规划占比。
// 01 §7.1 无后台写接口专条；1500ms / 1% 沿用 QA-06a 本地初值，README 须明确依据。
// 不提交 JSON / README 实现；文件断言在缺失时用断言失败先红，不能产生 ENOENT。
import { existsSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect } from 'vitest';
import * as shared from '../../../../../infra/load/k6/options.ts';
import * as subject from '../../../../../infra/load/k6/sync-options.ts';
import type { SyncConfig, SyncLimits } from '../../../../../infra/load/k6/sync-options.ts';

export { subject };

export function fixture(): SyncConfig {
  return {
    multiplier: 3,
    base_urls: { admin: 'http://127.0.0.1:3002' },
    scenarios: {
      sync: {
        service: 'admin',
        method: 'POST',
        path: '/admin/v1/order-syncs',
        executor: 'ramping-arrival-rate',
        peak: 5,
        ramp_up: '30s',
        hold: '2m',
        latency_metric: 'http_req_duration',
        p95_ms: 1500,
        error_rate: 0.01,
        request_timeout: '10s',
        pre_allocated_vus: 30,
        max_vus: 150,
      },
    },
    requests: { sync: { platform: 'pdd', order_nos: ['local-order-1'] } },
  };
}

export function windowFixture(): SyncConfig {
  const config = fixture();
  config.requests.sync = {
    platform: 'pdd',
    from: '2026-11-08T00:00:00+08:00',
    to: '2026-11-09T00:00:00+08:00',
  };
  return config;
}

export const limits: SyncLimits = {
  items: [{ platform: 'pdd', earliest_from: '2026-11-08T00:00:00+08:00', max_order_nos: 50 }],
};
export const env = { LOAD_ADMIN_TOKEN: 'local-test-admin-token', LOAD_ENV: 'local' };

export function text(path: string): string {
  const url = new URL(`../../../../../${path}`, import.meta.url);
  return existsSync(url) ? readFileSync(url, 'utf8') : '';
}

export function diskConfig(): SyncConfig {
  const source = text('infra/load/k6/sync.config.json');
  expect(source, '同目录 sync.config.json 必须存在').not.toBe('');
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    parsed = null;
  }
  expect(parsed).toBeTruthy();
  return parsed as SyncConfig;
}

// 负面例不能把 NotImplemented 当作正确拒绝（避免骨架假绿）。
export function rejected(run: () => unknown): void {
  let message = '';
  try {
    run();
  } catch (error) {
    message = String(error);
  }
  expect(message).not.toMatch(/NotImplemented|TypeError|ReferenceError|SyntaxError/);
  expect(message).not.toBe('');
  expect(message).not.toContain(env.LOAD_ADMIN_TOKEN);
}

export interface Reply {
  status: number;
  error_code: number;
  body: string | null;
  headers: Record<string, string>;
}
export function success(): Reply {
  return {
    status: 200,
    error_code: 0,
    headers: {},
    body: JSON.stringify({
      code: 0,
      msg: '',
      trace_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b',
      data: {
        sync_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6b01',
        status: 'queued',
        reused: false,
        created_at: '2026-11-09T00:00:00+08:00',
      },
    }),
  };
}

// 容器内执行真实入口（仅转译 TS）；只替换 k6 的传输/检查 API，不监听、不联网。
// ./sync-options.ts 与 ./options.ts 始终是生产函数，禁止测试自己实现请求或 options。
export function boot(
  config: SyncConfig,
  environment: Record<string, string | undefined>,
  reply: Reply,
) {
  const calls: { method: string; url: string; body: unknown; params: Record<string, unknown> }[] =
    [];
  const checks: boolean[] = [];
  const opened: string[] = [];
  const exported: {
    options?: shared.K6Options;
    setup?: () => SyncLimits | undefined;
    sync?: (data?: SyncLimits) => void;
  } = {};
  const http = {
    request(method: string, url: string, body: unknown, params: Record<string, unknown>) {
      calls.push({ method, url, body, params });
      if (url.endsWith('/limits'))
        return {
          ...success(),
          body: JSON.stringify({
            code: 0,
            msg: '',
            data: limits,
            trace_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b',
          }),
        };
      return reply;
    },
    get(url: string, params: Record<string, unknown>) {
      return http.request('GET', url, null, params);
    },
    post(url: string, body: unknown, params: Record<string, unknown>) {
      return http.request('POST', url, body, params);
    },
    expectedStatuses(...statuses: number[]) {
      return statuses;
    },
  };
  const source = text('infra/load/k6/sync.ts');
  expect(source).not.toBe('');
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  runInNewContext(js, {
    exports: exported,
    __ENV: environment,
    open(path: string) {
      opened.push(path);
      expect(path).toBe('./sync.config.json');
      return JSON.stringify(config);
    },
    require(name: string) {
      if (name === './sync-options.ts') return subject;
      if (name === './options.ts') return shared;
      if (name === 'k6/http') return http;
      if (name === 'k6')
        return {
          check(value: unknown, predicates: Record<string, (value: unknown) => boolean>) {
            const results = Object.values(predicates).map((predicate) => predicate(value));
            checks.push(...results);
            return results.every(Boolean);
          },
        };
      throw new Error(`unexpected entry dependency: ${name}`);
    },
  });
  return { exported, calls, checks, opened };
}
