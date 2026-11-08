// Unit tests of the agent trace missing gauge's registration (B3-08za): no database, a fake port.
import { describe, expect, it } from 'vitest';
import { FixedClock } from '../clock/index.ts';
import {
  createAgentTraceMissingCollector,
  type AgentTraceMissingPort,
} from './agent-trace-missing.ts';
import { createMetricsRegistry } from './registry.ts';

const NAME = 'couli_agent_trace_missing_runs';
const NOW = '2026-11-09T04:00:00.000Z';

function sampleLines(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith(`${NAME}{`) || line.startsWith(`${NAME} `));
}

describe('couli_agent_trace_missing_runs', () => {
  it('[AC-B3-08za#1] 端口按注入的时钟取数，每个 app_id 一个样本、只有 app_id 标签', async () => {
    const seen: Date[] = [];
    const port: AgentTraceMissingPort = {
      countMissing: async (now) => {
        seen.push(now);
        return [
          { app_id: 'couli', runs: 2 },
          { app_id: 'couli-other', runs: 0 },
        ];
      },
    };
    const registry = createMetricsRegistry({
      entry: 'worker',
      collectAgentTraceMissing: createAgentTraceMissingCollector(port, new FixedClock(NOW)),
    });
    const text = await registry.render();
    expect(text).toContain(`# TYPE ${NAME} gauge\n`);
    expect(sampleLines(text)).toEqual([
      `${NAME}{app_id="couli"} 2`,
      `${NAME}{app_id="couli-other"} 0`,
    ]);
    expect(seen.map((date) => date.toISOString())).toEqual([NOW]);
  });

  it('[AC-B3-08za#2] 端口未注入时采集拒绝，render() 拒绝，不编造 0', async () => {
    const collect = createAgentTraceMissingCollector(undefined, new FixedClock(NOW));
    await expect(collect()).rejects.toThrow(/not wired/);
    const registry = createMetricsRegistry({ entry: 'worker', collectAgentTraceMissing: collect });
    await expect(registry.render()).rejects.toThrow(/not wired/);
  });

  it('[AC-B3-08za#3] 只在 worker 上出现：api / admin 给了也不调用；worker 不给则没有这一项、其余照常', async () => {
    let calls = 0;
    const collectAgentTraceMissing = async () => {
      calls += 1;
      return { missingRuns: { couli: 1 } };
    };
    for (const entry of ['api', 'admin'] as const) {
      const text = await createMetricsRegistry({ entry, collectAgentTraceMissing }).render();
      expect(text).not.toContain(NAME);
    }
    expect(calls).toBe(0);
    const bare = await createMetricsRegistry({ entry: 'worker' }).render();
    expect(bare).not.toContain(NAME);
    expect(bare).toContain('process_cpu_seconds_total ');
  });
});
