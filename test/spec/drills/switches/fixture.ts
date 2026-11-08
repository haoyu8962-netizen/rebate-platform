import type {
  Observation,
  SwitchDrillOptions,
  SwitchRow,
  SwitchTarget,
} from '../../../../infra/drills/switches/drill.ts';

export const LOCAL: SwitchTarget = {
  appEnv: 'local',
  baseUrl: 'http://127.0.0.1:3100',
  staging: false,
  stagingOrigins: [],
};
export const TOKEN = 'fixture.admin.bearer';
export const STEP_UP = 'fixture.admin.step.up';
export const BASELINE: Observation = { code: 0, modelCalled: true, cards: true };
export const DEGRADED: Observation = {
  code: 0,
  modelCalled: false,
  cards: true,
  fixedCopy: true,
};

export function row(key: string, value: boolean | null = true, version = 7): SwitchRow {
  return {
    key,
    value,
    version,
    default: true,
    value_type: 'boolean',
    options: null,
    permissions: ['switch.all'],
    admin_editable: true,
    updated_by: null,
    updated_at: null,
  };
}

export function fixture(keys: readonly string[] = ['agent.enabled']) {
  const events: string[] = [];
  const rows = new Map(keys.map((key) => [key, row(key)]));
  const controller = new AbortController();
  let elapsed = 0;
  const hooks: {
    afterWrite?: (key: string, value: unknown) => void;
    beforeList?: () => void;
    observe?: (key: string, value: unknown, elapsed: number) => Observation;
  } = {};
  const options: SwitchDrillOptions = {
    target: LOCAL,
    keys,
    signal: controller.signal,
    clock: { now: () => new Date(Date.UTC(2026, 10, 9) + elapsed) },
    sleep: async (ms) => {
      elapsed += ms;
    },
    api: {
      list: async () => {
        events.push('read');
        hooks.beforeList?.();
        return [...rows.values()].map((item) => ({ ...item }));
      },
      update: async (key, value, version) => {
        events.push(`write:${key}:${String(value)}:${version}`);
        const previous = rows.get(key);
        if (!previous || previous.version !== version) throw new Error('CAS conflict');
        const next = { ...previous, value, version: version + 1 };
        rows.set(key, next);
        hooks.afterWrite?.(key, value);
        return { ...next };
      },
    },
    probe: async (key) => {
      const value = rows.get(key)?.value;
      events.push(`probe:${key}:${String(value)}`);
      if (hooks.observe) return hooks.observe(key, value, elapsed);
      if (value !== false) return BASELINE;
      if (key.startsWith('convert.enabled.')) return { code: 50301 };
      if (key === 'parse.tpwd.enabled') return { code: 30132, guideTitleSearch: true };
      if (key === 'jev.enabled')
        return {
          code: 0,
          judgeCalled: false,
          cards: true,
          specPending: true,
          semanticPrecheckSkipped: true,
        };
      return DEGRADED;
    },
  };
  return { options, events, rows, controller, hooks, elapsed: () => elapsed };
}
