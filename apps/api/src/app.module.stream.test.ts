// B3-08zi (D10-2510 / D10-2511): the premise of placing /v1/agent/'s stage ⑦ in agent's controller
// rather than in stream's RiskModule lists. Assembly layer, as the frozen [AC-B1-15m#1]
// (test/spec/identity/deletion-guard-stream/assembly.test.ts): builds the stream entry's module
// tree only (no database, no listen) and reads the rate-limit thresholds it hands RiskModule.
// 若此条因 stream 接入限流而红，B3-08zi 的 ⑦ 必须移进 stream RiskModule 的 beforeRateLimit / beforeRateLimitGuards 清单（排在 ⑥ 之后）并按 rule_change 改 [AC-B1-15m#1]（BR-ID-01：⑦ 在 ⑬ 之前；D10-2509 / D10-2510）
import { expect, it, vi } from 'vitest';
import { AppModule } from './app.module.ts';
import { FixedClock, createRootLogger, loadConfig } from './modules/platform/index.ts';
import { RiskModule, type RateLimitThresholdReaders } from './modules/risk/index.ts';

const APP = 'stream_rate_limit_app';
const ROUTES = [
  'createAgentSession',
  'getCurrentAgentSession',
  'sendAgentMessage',
  'listAgentSessionMessages',
  'cancelAgentRun',
  'setAgentMessageFeedback',
  'reportAgentMessage',
  // A non-agent operation: stream limits nothing at all.
  'convertLink',
] as const;
const DIMENSIONS = ['user', 'device', 'ip'] as const;

it('[AC-B3-08zi#u1] 若此条因 stream 接入限流而红，B3-08zi 的 ⑦ 必须移进 stream RiskModule 的 beforeRateLimit / beforeRateLimitGuards 清单（排在 ⑥ 之后）并按 rule_change 改 [AC-B1-15m#1]（BR-ID-01：⑦ 在 ⑬ 之前；D10-2509 / D10-2510）', async () => {
  const spy = vi.spyOn(RiskModule, 'forRoot');
  try {
    AppModule.forEntry({
      entry: 'stream',
      config: loadConfig({ APP_ENV: 'test' }),
      clock: new FixedClock('2026-10-17T02:00:00.000Z'),
      logger: createRootLogger({ level: 'silent', entry: 'stream', appEnv: 'test' }),
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const thresholds = spy.mock.calls[0]![0].rateLimit?.thresholds;
    expect(thresholds, 'stream hands RiskModule its rate-limit thresholds').toBeDefined();
    const readers = (await thresholds!.useFactory()) as RateLimitThresholdReaders | null;
    expect(readers).not.toBeNull();
    const handle = {} as Parameters<RateLimitThresholdReaders['on']>[0];
    for (const reader of [readers!.pooled, readers!.on(handle)]) {
      for (const operation of ROUTES) {
        expect(await reader.groupFor(APP, operation), operation).toBeNull();
        // Any group name: stream's reader has no rules for one.
        for (const dimension of DIMENSIONS) {
          expect(await reader.rules(APP, operation, dimension), operation).toEqual([]);
        }
      }
    }
  } finally {
    spy.mockRestore();
  }
});
