// B2-12a：admin-adjustment、bad-debt-writeoff 两个状态机的共用断言。
// 只按 YAML、生成物与 @couli/domain 的外部行为判定，不导入任何骨架。
import * as domain from '@couli/domain';
import { expect } from 'vitest';
import {
  MACHINES,
  renderStateMachine,
} from '../../../../../packages/domain/scripts/state-machines.ts';
import { parseYamlLite } from '../../../../../tools/lib/yaml-lite.ts';
import { generatedExports, readRequired, type Machine } from '../../../state-machines/order/kit.ts';

export interface ExpectedRow {
  readonly id: string;
  readonly from: string | null;
  readonly event: string;
  readonly to: string;
}

export interface Contract {
  readonly name: string;
  readonly prefix: string;
  readonly functionName: string;
  readonly enumName: string;
  readonly states: readonly string[];
  readonly events: readonly string[];
  readonly rows: readonly ExpectedRow[];
}

export const ENTRIES = ['public', 'generated'] as const;
export type Entry = (typeof ENTRIES)[number];

// 与既有 CT-04a / B2-03j / B2-04d 一致：领域函数返回 illegal，调用方转 IllegalTransition。
export const ILLEGAL = { ok: false, reason: 'illegal', id: null };

export function transition(contract: Contract, entry: Entry) {
  const exports: Record<string, unknown> =
    entry === 'public'
      ? domain
      : generatedExports(
          readRequired(`packages/domain/src/state-machines/${contract.name}.gen.ts`),
        );
  const fn = exports[contract.functionName];
  expect(fn, `${entry}: ${contract.functionName}`).toEqual(expect.any(Function));
  return fn as (from: string | null, event: string) => unknown;
}

export function machine(contract: Contract): Machine {
  // 缺 YAML 必须是断言失败，不能以 ENOENT 或解析错误充当先红。
  const source = readRequired(`specs/state-machines/${contract.name}.yaml`);
  expect(() => parseYamlLite(source)).not.toThrow();
  const doc = parseYamlLite(source);
  expect(doc).toMatchObject({
    name: contract.name,
    field: 'status',
    states: expect.any(Array),
    events: expect.any(Array),
    transitions: expect.any(Array),
  });
  return doc as Machine;
}

export function assertDefinition(contract: Contract): void {
  const doc = machine(contract);
  expect([...doc.states].sort()).toEqual([...contract.states].sort());
  expect([...doc.events].sort()).toEqual([...contract.events].sort());
  expect(doc.transitions).toHaveLength(contract.rows.length);
  expect(new Set(doc.transitions.map((row) => row.id)).size).toBe(contract.rows.length);
  const actual = doc.transitions.flatMap((row) =>
    row.from.map((from) => ({ id: row.id, from, event: row.event, to: row.to })),
  );
  expect(actual).toHaveLength(contract.rows.length);
  expect(actual).toEqual(expect.arrayContaining([...contract.rows]));
  for (const row of doc.transitions) {
    expect(row.kind === undefined || row.kind === 'transition').toBe(true);
    expect(row).not.toHaveProperty('alternatives');
    expect(row.guard).toEqual(expect.any(String));
    expect(row.guard.length).toBeGreaterThan(0);
    expect(row.test_id).toMatch(/^AC-B2-12a#\d+$/);
  }
  // 状态值以契约 contracts/enums/fund.yaml 为唯一来源。
  const enums = parseYamlLite(readRequired('contracts/enums/fund.yaml')) as {
    enums: Record<string, { values: Record<string, string> }>;
  };
  expect(enums.enums[contract.enumName]).toBeDefined();
  expect(Object.keys(enums.enums[contract.enumName]?.values ?? {}).sort()).toEqual(
    [...doc.states].sort(),
  );
}

export function assertGenerated(contract: Contract): void {
  const doc = machine(contract);
  expect(MACHINES).toContain(contract.name);
  const source = readRequired(`specs/state-machines/${contract.name}.yaml`);
  const target = readRequired(`packages/domain/src/state-machines/${contract.name}.gen.ts`);
  expect(() => renderStateMachine(source)).not.toThrow();
  expect(target).toBe(renderStateMachine(source));
  expect(target).toContain(`specs/state-machines/${contract.name}.yaml`);
  for (const exports of [domain, generatedExports(target)] as Record<string, unknown>[]) {
    expect(exports[`${contract.prefix}_STATES`]).toEqual(doc.states);
    expect(exports[`${contract.prefix}_EVENTS`]).toEqual(doc.events);
    expect(exports[`${contract.prefix}_TRANSITIONS`]).toEqual(doc.transitions);
    expect(exports[contract.functionName]).toEqual(expect.any(Function));
  }
}

export function illegalPairs(contract: Contract) {
  return [null, ...contract.states].flatMap((from) =>
    contract.events
      .filter((event) => !contract.rows.some((row) => row.from === from && row.event === event))
      .map((event) => ({ from, event })),
  );
}

export function guardOf(contract: Contract, id: string): string {
  const row = machine(contract).transitions.find((candidate) => candidate.id === id);
  expect(row, `missing ${id}`).toBeDefined();
  return row?.guard ?? '';
}
