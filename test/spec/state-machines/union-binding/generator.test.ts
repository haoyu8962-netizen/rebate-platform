import { expect, it } from 'vitest';
import {
  MACHINES,
  renderStateMachine,
} from '../../../../packages/domain/scripts/state-machines.ts';
import { generatedExports } from '../order/kit.ts';
import {
  EVENTS,
  GENERATED,
  ILLEGAL,
  LEGAL,
  STATES,
  machine,
  readRequired,
  transitionFunction,
  yamlText,
} from './kit.ts';

it('[CT-10a#13] 自动发现 union-binding，生成物与 render 逐字一致且保留全表', () => {
  expect(MACHINES).toContain('union-binding');
  const rendered = renderStateMachine(yamlText());
  expect(readRequired(GENERATED)).toBe(rendered);
  const exports = generatedExports(rendered);
  const doc = machine();
  expect(exports['UNION_BINDING_STATES']).toEqual(STATES);
  expect(exports['UNION_BINDING_EVENTS']).toEqual(EVENTS);
  expect(exports['UNION_BINDING_STATES']).toEqual(doc.states);
  expect(exports['UNION_BINDING_EVENTS']).toEqual(doc.events);
  expect(exports['UNION_BINDING_TRANSITIONS']).toEqual(doc.transitions);
});

it('[CT-10a#14] 生成物不含 outcome 第三参数与 backward / same_state 分支，transition 只有两个参数', () => {
  const text = readRequired(GENERATED);
  expect(text).not.toContain('UNION_BINDING_STAGES');
  expect(text).not.toContain('UNION_BINDING_EVENT_STATES');
  const fn = transitionFunction(generatedExports(text));
  expect(fn.length).toBe(2);
});

it('[CT-10a#15] guard 即使包含可执行字样也只是文字，全部迁移结果不变', () => {
  const yaml = yamlText();
  const guard = 'throw new Error("guard must remain text")';
  const changed = yaml.replace(/^(\s*guard:)\s*[^\r\n]+/gm, `$1 '${guard}'`);
  expect(changed).not.toBe(yaml);
  const exports = generatedExports(renderStateMachine(changed));
  expect(exports['UNION_BINDING_TRANSITIONS']).toEqual(
    machine().transitions.map((row) => ({ ...row, guard })),
  );
  const original = transitionFunction(generatedExports(readRequired(GENERATED)));
  const transition = transitionFunction(exports);
  for (const row of LEGAL) {
    const expected = { ok: true, to: row.to, id: row.id, noop: false };
    expect(original(row.from, row.event)).toEqual(expected);
    expect(transition(row.from, row.event)).toEqual(expected);
  }
  for (const row of ILLEGAL) {
    const expected = { ok: false, reason: 'illegal', id: null };
    expect(original(row.from, row.event)).toEqual(expected);
    expect(transition(row.from, row.event)).toEqual(expected);
  }
});
