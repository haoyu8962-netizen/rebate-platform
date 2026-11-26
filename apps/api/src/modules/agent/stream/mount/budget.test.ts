// B3-09m · BR-AI-16: the budgeted model path's admission plan (./budget.ts). Synthetic ports only
// (no database, no listen, no network).
import { expect, it, vi } from 'vitest';

import type { RunBodyInput } from '../../http/index.ts';
import type { AdmissionRequest, AdmissionResult } from '../admission/index.ts';
import type { RunContext } from '../run/index.ts';
import type { BudgetedAdmissionRequest, RunBudgetPlan } from '../pg/admit.ts';
import { createBudgetedModelPath } from './budget.ts';

const DAILY = 'agent.daily_budget_fen';
const RESERVE = 'agent.budget.reserve_mfen_per_run';
const MODEL = 'qwen-flash-2026-09-01';

function path(failing: string | null) {
  const warn = vi.fn();
  const gateway = { invoke: vi.fn() };
  const built = createBudgetedModelPath({
    gateway,
    route: async () => ({
      mode: 'models',
      attempts: [
        {
          id: 'flash',
          vendor: 'qwen',
          tier: 'flash',
          model: MODEL,
          evaluation: { report: 'reports/synthetic.md', signed: true },
        },
      ],
      dropped: [],
    }),
    content: {
      async configValuesByKey(key) {
        if (key === failing) throw new Error('synthetic read failure');
        return [{ appId: 'synthetic-app', value: key === DAILY ? 100 : 5_000 }];
      },
      async freshConfigValue(_appId, key) {
        // B3-09o: agent.model_timeout_ms is not set here (the run takes the 8,000 ms default).
        if (key !== 'agent.models') return null;
        return {
          value: { [MODEL]: { in_mfen_per_m: 100_000, out_mfen_per_m: 400_000, version: 'v1' } },
          version: 1,
        };
      },
    },
    clock: { now: () => new Date('2026-10-06T12:00:00+08:00') },
    scheduler: { now: () => 0, sleep: () => new Promise<void>(() => undefined) },
    logger: { warn } as never,
    attemptTimeoutMs: 20_000,
  });
  return { built, warn, gateway };
}

const request = { runId: 'synthetic-run', sessionId: 'synthetic-session' } as AdmissionRequest;
const accepted = { kind: 'accepted' } as AdmissionResult;

it('[AC-B3-09m#u24] 读全平台上限 agent.daily_budget_fen 失败时本 run 按 budget 降级：不抛错、不预占、发告警', async () => {
  const { built, warn, gateway } = path(DAILY);
  let plan: RunBudgetPlan | undefined;
  const result = await built.admit(request, async (budgeted: BudgetedAdmissionRequest) => {
    plan = await budgeted.budget!.plan('synthetic-app');
    return accepted;
  });
  expect(result).toBe(accepted);
  expect(plan).toMatchObject({ blocked: true });
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ run_id: 'synthetic-run' }),
    'agent.budget_unavailable',
  );
  // The accepted run has no reservation verdict: its model call degrades with reason budget.
  const body = built.bind({ runId: 'synthetic-run' } as RunBodyInput, async () => {
    const outcome = await built.model.complete(
      { system: '', tools: [], messages: [] },
      {
        clock: { remainingMs: () => 1_000, charge: () => undefined },
        signal: new AbortController().signal,
      },
    );
    expect(outcome).toMatchObject({ kind: 'degraded', reason: 'budget' });
    return { kind: 'done', finishReason: 'budget' };
  });
  await body({} as RunContext);
  expect(gateway.invoke).not.toHaveBeenCalled();
});

it('[AC-B3-09o#u8] 读预占额 agent.budget.reserve_mfen_per_run 失败时按默认 5,000 mfen 照常判熔断与预占，并告警', async () => {
  const { built, warn } = path(RESERVE);
  let plan: RunBudgetPlan | undefined;
  await built.admit(request, async (budgeted) => {
    plan = await budgeted.budget!.plan('synthetic-app');
    return accepted;
  });
  // The budget read on its own still counts; the reservation is the BR default.
  expect(plan).toEqual({
    blocked: false,
    budgetMfen: 100_000n,
    reserveMfen: 5_000n,
    priceVersion: 'v1',
  });
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      run_id: 'synthetic-run',
      config_key: RESERVE,
      error_name: 'Error',
    }),
    'agent.budget_reserve_unread',
  );
  expect(warn).not.toHaveBeenCalledWith(expect.anything(), 'agent.budget_unavailable');
  // The platform-wide budget for settlements does not depend on the reservation read either.
  await expect(built.budgetLimit()).resolves.toBe(100_000n);
});

it('[AC-B3-09m#u25] 计划可读时按全平台值给出预占额、预算与受理时取定的单价版本', async () => {
  const { built } = path(null);
  let plan: RunBudgetPlan | undefined;
  await built.admit(request, async (budgeted) => {
    plan = await budgeted.budget!.plan('synthetic-app');
    return { kind: 'rejected', code: 30504, reason: 'expired' } as AdmissionResult;
  });
  expect(plan).toEqual({
    blocked: false,
    budgetMfen: 100_000n,
    reserveMfen: 5_000n,
    priceVersion: 'v1',
  });
});

it('[AC-B3-09m#u26] 已判 budget 的 run 不读提示词；受理前读展示标签时提示词失败不抛错', async () => {
  const { built } = path(DAILY);
  const inner = { current: vi.fn(async () => Promise.reject(new Error('synthetic timeout'))) };
  const prompt = built.prompt(inner);
  await expect(prompt.current('synthetic-app')).resolves.toBeNull();
  await built.admit(request, async (budgeted) => {
    await budgeted.budget!.plan('synthetic-app');
    return accepted;
  });
  inner.current.mockClear();
  const body = built.bind({ runId: 'synthetic-run' } as RunBodyInput, async () => {
    expect(await prompt.current('synthetic-app')).toEqual({ version: 'none', system: '' });
    return { kind: 'done', finishReason: 'budget' };
  });
  await body({} as RunContext);
  expect(inner.current).not.toHaveBeenCalled();
});
