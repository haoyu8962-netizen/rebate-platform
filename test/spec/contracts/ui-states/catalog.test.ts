import { expect, it } from 'vitest';
import {
  actions,
  announce,
  announceModes,
  catalog,
  components,
  emphases,
  errorKinds,
  idempotencies,
  list,
  requiredNames,
  retry,
  retryModes,
  row,
  rowFields,
  states,
} from './kit.ts';

it('[AC-CT-09s#1] 状态目录存在，version 为 1，sources 写明 08 BR-TEXT-14 / BR-TEXT-10 与规划/03 依据', () => {
  const doc = catalog();
  expect(doc['version']).toBe(1);
  const sources = list(doc['sources'], 'sources');
  expect(sources.length).toBeGreaterThan(0);
  for (const source of sources) {
    expect(typeof source, 'sources 的每项必须是字符串').toBe('string');
    expect((source as string).trim()).not.toBe('');
  }
  const joined = sources.join('\n');
  expect(joined).toContain('BR-TEXT-14');
  expect(joined).toContain('BR-TEXT-10');
  expect(joined).toContain('规划/03');
  expect(states().length).toBeGreaterThan(0);
});

it('[AC-CT-09s#1] 每行字段齐全，取值都在约定的枚举内', () => {
  for (const item of states()) {
    const label = String(item['name']);
    for (const field of rowFields) {
      expect(Object.hasOwn(item, field), `${label} 缺少字段 ${field}`).toBe(true);
    }
    expect(item['id'], `${label}.id`).toMatch(/^UIS-[0-9]{2}$/u);
    expect(item['name'], `${label}.name`).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/u);
    expect(item['trigger'], `${label}.trigger`).toBeTypeOf('string');
    expect(item['trigger'] as string, `${label}.trigger 写中文触发条件`).toMatch(/\p{Script=Han}/u);
    expect(components, `${label}.component`).toContain(item['component']);
    if (item['component'] === 'ErrorState') {
      expect(errorKinds, `${label}.kind`).toContain(item['kind']);
    } else {
      expect(item['kind'], `${label}.kind 非 ErrorState 为 null`).toBeNull();
    }
    for (const field of ['title_key', 'desc_key'] as const) {
      const value = item[field];
      expect(value === null || typeof value === 'string', `${label}.${field}`).toBe(true);
      expect(value, `${label}.${field} 不能为空串`).not.toBe('');
    }
    for (const action of actions(item)) {
      expect(Object.hasOwn(action, 'key'), `${label}.actions[] 缺少 key`).toBe(true);
      expect(Object.hasOwn(action, 'emphasis'), `${label}.actions[] 缺少 emphasis`).toBe(true);
      expect(action['key'], `${label}.actions[].key`).toBeTypeOf('string');
      expect(emphases, `${label}.actions[].emphasis`).toContain(action['emphasis']);
    }
    const a11y = announce(item);
    expect(Object.hasOwn(a11y, 'mode'), `${label}.announce 缺少 mode`).toBe(true);
    expect(Object.hasOwn(a11y, 'key'), `${label}.announce 缺少 key`).toBe(true);
    expect(announceModes, `${label}.announce.mode`).toContain(a11y['mode']);
    expect(a11y['key'] === null || typeof a11y['key'] === 'string', `${label}.announce.key`).toBe(
      true,
    );
    const again = retry(item);
    expect(Object.hasOwn(again, 'mode'), `${label}.retry 缺少 mode`).toBe(true);
    expect(Object.hasOwn(again, 'idempotency'), `${label}.retry 缺少 idempotency`).toBe(true);
    expect(retryModes, `${label}.retry.mode`).toContain(again['mode']);
    expect(idempotencies, `${label}.retry.idempotency`).toContain(again['idempotency']);
    const timeout = item['timeout_ms'];
    expect(
      timeout === null || (Number.isSafeInteger(timeout) && (timeout as number) > 0),
      `${label}.timeout_ms 为正整数或 null`,
    ).toBe(true);
    expect(item['on_timeout'] === null, `${label}.on_timeout 与 timeout_ms 同时为 null`).toBe(
      timeout === null,
    );
    if (item['on_timeout'] !== null) {
      // 08 表 C state.loading 行：加载态到时长上限仍没有结果转加载失败（第 2 次收紧，不再接受 read_timeout）。
      expect(item['on_timeout'], `${label}.on_timeout`).toBe('load_failed');
    }
    const refs = list(item['refs'], `${label}.refs`);
    expect(refs.length, `${label}.refs 不能为空`).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref, `${label}.refs[]`).toBeTypeOf('string');
      expect((ref as string).trim()).not.toBe('');
    }
  }
});

it('[AC-CT-09s#1] id 与 name 各自唯一，13 个必有状态都在', () => {
  const rows = states();
  const ids = rows.map((item) => item['id']);
  const names = rows.map((item) => item['name']);
  expect(new Set(ids).size, 'id 唯一').toBe(ids.length);
  expect(new Set(names).size, 'name 唯一').toBe(names.length);
  for (const name of requiredNames) {
    expect(names, `缺少状态 ${name}`).toContain(name);
  }
});

it('[AC-CT-09s#6] 首次加载有时长上限：timeout_ms 为正整数，到时转入 load_failed（08 表 C state.loading 行）', () => {
  const item = row('first_load');
  const timeout = item['timeout_ms'];
  expect(Number.isSafeInteger(timeout), 'first_load.timeout_ms 为整数').toBe(true);
  expect(timeout as number).toBeGreaterThan(0);
  // 08 表 C：加载态到时仍没有结果「转下一行的加载失败」，取 state.load_failed.desc，不转读超时行。
  expect(item['on_timeout'], 'first_load.on_timeout').toBe('load_failed');
  // 转入的目标行确实在目录里。
  expect(states().map((other) => other['name'])).toContain(item['on_timeout']);
});

it('[AC-CT-09s#6] 除 first_load 外的必有状态不是加载类行：timeout_ms 与 on_timeout 为 null', () => {
  const others = requiredNames.filter((name) => name !== 'first_load');
  for (const name of others) {
    const item = row(name);
    expect(item['timeout_ms'], `${name}.timeout_ms`).toBeNull();
    expect(item['on_timeout'], `${name}.on_timeout`).toBeNull();
  }
});
