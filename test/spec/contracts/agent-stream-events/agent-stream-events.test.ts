import { expect, it } from 'vitest';
import {
  agentEvents,
  bannedFieldNames,
  baselineVersion,
  diagnosticFields,
  doc,
  event,
  events,
  eventsPath,
  expectedFields,
  field,
  fields,
  headerTodo,
  notRegistered,
  object,
  sharedFields,
  testRequire,
} from './kit.ts';

const { checkEvents } = testRequire(
  '../../../../packages/contracts-ts/scripts/events.ts',
) as typeof import('../../../../packages/contracts-ts/scripts/events.ts');
const { loadEnums } = testRequire(
  '../../../../packages/contracts-ts/scripts/catalog.ts',
) as typeof import('../../../../packages/contracts-ts/scripts/catalog.ts');

// AC-CT-13a#n 是 D10-1315 验收点的本地分组，不新增业务 AC / BR。

it.each(agentEvents)(
  '[AC-CT-13a#1] %s 登记在 events 下，事件名直接以 agent_ 开头、不带点，有 description 与 source',
  (name) => {
    const entry = event(name);
    expect(name, '不是「族名.事件」写法').not.toContain('.');
    expect(typeof entry['description'], `${name}.description 必须是字符串`).toBe('string');
    expect(String(entry['description']).trim(), `${name}.description 不能为空`).not.toBe('');
    expect(typeof entry['source'], `${name}.source 必须是字符串`).toBe('string');
    expect(String(entry['source']), `${name}.source 指向 03 §4.7`).toMatch(/03[^§]*§4\.7/u);
  },
);

it('[AC-CT-13a#2] agent_ 开头的事件恰好是这四个；agent_output_filtered 不登记，也没有 agent 族', () => {
  const all = events();
  const registered = Object.keys(all)
    .filter((name) => name.startsWith('agent_') || name.startsWith('agent.'))
    .sort();
  expect(registered, 'agent_* 事件只有 03 §4.7 表里的四个').toEqual([...agentEvents].sort());
  expect(Object.hasOwn(all, notRegistered), `${notRegistered} 不是客户端事件，不登记`).toBe(false);
  const families = doc()['families'];
  const familyNames = families === undefined ? [] : Object.keys(object(families, 'families'));
  expect(
    familyNames.filter((name) => name === 'agent' || name.startsWith('agent_')),
    'agent_* 不是族，不在 families 下登记',
  ).toEqual([]);
});

it.each(agentEvents)('[AC-CT-13a#3] %s 的字段恰好是共有六项加自己的字段，不多不少', (name) => {
  const got = Object.keys(fields(name)).sort();
  expect(got, `${name} 的字段集合`).toEqual(Object.keys(expectedFields(name)).sort());
});

it.each(agentEvents)(
  '[AC-CT-13a#4] %s 的共有字段：run_id / message_id 是可缺的 string，四个诊断字段是必填 string',
  (name) => {
    for (const [fieldName, spec] of Object.entries(sharedFields)) {
      const def = field(name, fieldName);
      expect(def['type'], `${name}.${fieldName}.type`).toBe(spec.type);
      expect(def['required'], `${name}.${fieldName}.required`).toBe(spec.required);
      expect(def['required_when'], `${name}.${fieldName} 不用 required_when`).toBeUndefined();
      expect(def['values'], `${name}.${fieldName} 不是 enum`).toBeUndefined();
    }
  },
);

it.each(agentEvents)(
  '[AC-CT-13a#5] %s 的四个诊断字段在 note 里写明取不到时填 "unknown"',
  (name) => {
    for (const fieldName of diagnosticFields) {
      const def = field(name, fieldName);
      expect(typeof def['note'], `${name}.${fieldName}.note 必须是字符串`).toBe('string');
      expect(String(def['note']), `${name}.${fieldName}.note 写明 unknown`).toContain('unknown');
    }
  },
);

it('[AC-CT-13a#6] agent_stream_seq_gap 自己的字段 expected、received 都是必填 integer', () => {
  for (const fieldName of ['expected', 'received']) {
    const def = field('agent_stream_seq_gap', fieldName);
    expect(def['type'], `${fieldName}.type`).toBe('integer');
    expect(def['required'], `${fieldName}.required`).toBe(true);
    expect(def['required_when'], `${fieldName} 不用 required_when`).toBeUndefined();
  }
});

it('[AC-CT-13a#7] agent_stream_frame_too_large 只有共有字段', () => {
  const got = Object.keys(fields('agent_stream_frame_too_large')).sort();
  expect(got, 'frame_too_large 没有自己的字段').toEqual(Object.keys(sharedFields).sort());
});

it('[AC-CT-13a#8] agent_stream_limit 的 kind 是必填 enum，取值恰好 text / cards / frames', () => {
  const def = field('agent_stream_limit', 'kind');
  expect(def['type'], 'kind.type').toBe('enum');
  expect(def['required'], 'kind.required').toBe(true);
  expect(def['required_when'], 'kind 不用 required_when').toBeUndefined();
  expect(Array.isArray(def['values']), 'kind.values 必须是数组').toBe(true);
  const values = (def['values'] as unknown[]).map(String).sort();
  expect(values, 'kind 的取值').toEqual(['cards', 'frames', 'text']);
  expect(def['values'] as unknown[], 'kind 的取值不重复').toHaveLength(3);
});

it('[AC-CT-13a#9] agent_stream_unknown_event 的 type 是必填 string，note 写明只取前 64 个字符', () => {
  const def = field('agent_stream_unknown_event', 'type');
  expect(def['type'], 'type.type').toBe('string');
  expect(def['required'], 'type.required').toBe(true);
  expect(def['required_when'], 'type 不用 required_when').toBeUndefined();
  expect(def['values'], 'type 不是 enum').toBeUndefined();
  expect(typeof def['note'], 'type.note 必须是字符串').toBe('string');
  expect(String(def['note']), 'type.note 写明 64 字符上限').toMatch(/(?<!\d)64(?!\d)/u);
});

it.each(agentEvents)(
  '[AC-CT-13a#10] %s 不带 card_id、帧 data / delta、用户原文、卡片内容与 fallback_text',
  (name) => {
    const got = Object.keys(fields(name));
    expect(
      got.filter((fieldName) => (bannedFieldNames as readonly string[]).includes(fieldName)),
      `${name} 不得带这些字段`,
    ).toEqual([]);
  },
);

it('[AC-CT-13a#11] 共有六项挂在四个事件上，不进 common_fields（诊断字段只给部分事件）', () => {
  for (const name of agentEvents) event(name);
  const common = Object.keys(object(doc()['common_fields'], 'common_fields'));
  expect(
    common.filter((fieldName) => Object.hasOwn(sharedFields, fieldName)),
    'run_id / message_id / 诊断字段不是全体事件的公共字段',
  ).toEqual([]);
});

it(`[AC-CT-13a#12] ${eventsPath} 的 version 递增（大于本任务前的 ${String(baselineVersion)}）`, () => {
  const version = doc()['version'];
  expect(typeof version, 'version 是字符串').toBe('string');
  expect(String(version), 'version 是整数串').toMatch(/^\d+$/u);
  expect(Number(version), 'version 必须递增').toBeGreaterThan(baselineVersion);
});

it('[AC-CT-13a#13] 文件头 TODO 里去掉 agent_*', () => {
  expect(headerTodo(), '文件头 TODO 不再列 agent_*').not.toMatch(/agent_/u);
});

it('[AC-CT-13a#14] 登记四个事件后 events.yaml 仍通过 contracts:check 的事件表校验', () => {
  for (const name of agentEvents) event(name);
  expect(checkEvents(loadEnums()), 'packages/contracts-ts/scripts/events.ts 报的问题').toEqual([]);
});
