import { expect } from 'vitest';

export const ROOT = new URL('../../../../', import.meta.url);
export const METRIC = 'couli_agent_reply_empty_total';

/** Exact unlabelled sample; exactly one English single-line HELP and one counter TYPE. */
export function assertCounter(text: string, total: number): void {
  const lines = text.split('\n');
  expect(lines.filter((line) => line.startsWith(`# TYPE ${METRIC} `))).toEqual([
    `# TYPE ${METRIC} counter`,
  ]);
  const helps = lines.filter((line) => line.startsWith(`# HELP ${METRIC} `));
  expect(helps).toHaveLength(1);
  const help = helps[0]!.slice(`# HELP ${METRIC} `.length);
  expect(help).toMatch(/^[\x20-\x7e]+$/);
  expect(help).toMatch(/[A-Za-z]{2,}/);
  expect(help).not.toContain('\\n');
  expect(lines.filter((line) => line.startsWith(METRIC))).toEqual([`${METRIC} ${total}`]);
}

/** No static import of the Nest composition root in the test TypeScript project. */
export async function loadCounterToken(): Promise<symbol> {
  const agent = (await import(new URL('apps/api/src/modules/agent/index.ts', ROOT).href)) as {
    agentEmptyReplyCounterToken(): symbol;
  };
  const token = agent.agentEmptyReplyCounterToken();
  expect(typeof token).toBe('symbol');
  expect(agent.agentEmptyReplyCounterToken()).toBe(token);
  return token;
}
