import { existsSync } from 'node:fs';
import {
  AGENT_REPORT_EVENTS,
  AGENT_REPORT_STATES,
  AGENT_REPORT_TRANSITIONS,
  transitionAgentReport,
} from '@couli/domain';
import { expect, it } from 'vitest';
import { list, object, yaml } from '../../contracts/agent-history/kit.ts';

it.each([
  { from: null, event: 'REPORT', to: 'pending' },
  { from: 'pending', event: 'HANDLE', to: 'handled' },
] as const)(
  '[AC-B3-08zf#16][BR-ID-15] agent-report 合法迁移 $from --$event--> $to',
  ({ from, event, to }) => {
    const result = transitionAgentReport(from, event);
    expect(result).toEqual({ ok: true, to, id: expect.any(String), noop: false });
    expect(result).toHaveProperty('id', expect.stringMatching(/\S/u));
  },
);

it.each([
  { from: null, event: 'HANDLE' },
  { from: 'pending', event: 'REPORT' },
  { from: 'handled', event: 'REPORT' },
  { from: 'handled', event: 'HANDLE' },
] as const)(
  '[AC-B3-08zf#17][BR-ID-15] agent-report 表外迁移 $from --$event--> 非法',
  ({ from, event }) => {
    expect(transitionAgentReport(from, event)).toEqual({ ok: false, reason: 'illegal', id: null });
  },
);

it('[AC-B3-08zf#18][BR-ID-15] agent-report YAML 字段和生成常量只有 pending、handled 与两条迁移', () => {
  const path = 'specs/state-machines/agent-report.yaml';
  expect(existsSync(new URL(`../../../../${path}`, import.meta.url)), path).toBe(true);
  const spec = yaml(path);
  expect(spec['name']).toBe('agent-report');
  expect(spec['field']).toBe('report_status');
  expect(spec['states']).toEqual(['pending', 'handled']);
  expect(spec['events']).toEqual(['REPORT', 'HANDLE']);
  expect(AGENT_REPORT_STATES).toEqual(['pending', 'handled']);
  expect(AGENT_REPORT_EVENTS).toEqual(['REPORT', 'HANDLE']);
  const rows = list(spec['transitions']).map(object);
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => ({ from: row['from'], event: row['event'], to: row['to'] }))).toEqual([
    { from: [null], event: 'REPORT', to: 'pending' },
    { from: ['pending'], event: 'HANDLE', to: 'handled' },
  ]);
  expect(AGENT_REPORT_TRANSITIONS).toEqual(rows);
});
