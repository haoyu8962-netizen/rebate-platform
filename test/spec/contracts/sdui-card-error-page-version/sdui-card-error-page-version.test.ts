import { expect, it } from 'vitest';
import {
  agentCardError,
  baselineVersion,
  doc,
  eventName,
  eventsPath,
  expectedCardErrorFields,
  expectFieldShape,
  field,
  fields,
  homeCardError,
  testRequire,
  untouchedEvents,
  validateEvent,
  without,
} from './kit.ts';

const { checkEvents } = testRequire(
  '../../../../packages/contracts-ts/scripts/events.ts',
) as typeof import('../../../../packages/contracts-ts/scripts/events.ts');
const { loadEnums } = testRequire(
  '../../../../packages/contracts-ts/scripts/catalog.ts',
) as typeof import('../../../../packages/contracts-ts/scripts/catalog.ts');

// AC-CT-13b#n 是 D10-1376 ③ 验收点的本地分组，不新增业务 AC / BR。

it('[AC-CT-13b#1] sdui_card_error 字段恰好是 type / version / page_version / reason；type、reason 必填 string、version 可缺 integer 照旧，page_version 改为可缺 integer', () => {
  const got = Object.keys(fields(eventName)).sort();
  expect(got, `${eventName} 的字段集合（本单不加、不删字段）`).toEqual(
    Object.keys(expectedCardErrorFields).sort(),
  );
  for (const fieldName of ['type', 'version', 'reason']) {
    const spec = expectedCardErrorFields[fieldName];
    expect(spec, `预期表里有 ${fieldName}`).toBeDefined();
    if (spec !== undefined) expectFieldShape(eventName, fieldName, spec);
  }
  // 本单的改动：page_version 仍是 integer，但不再必填（03 §7.2 AI 助手页卡片没有 page_version）。
  expectFieldShape(eventName, 'page_version', { type: 'integer', required: false });
});

it('[AC-CT-13b#2] page_version 的 note 同时写到首页等配置化页面（03 §6.2）必带与 AI 助手页卡片（03 §7.2）不带', () => {
  const def = field(eventName, 'page_version');
  expect(typeof def['note'], 'page_version.note 必须是字符串').toBe('string');
  const note = String(def['note']);
  expect(note, 'note 指向 03 §6.2（首页等配置化页面必带）').toMatch(/(?<![\d.])6\.2(?![\d])/u);
  expect(note, 'note 指向 03 §7.2（AI 助手页卡片不带）').toMatch(/(?<![\d.])7\.2(?![\d])/u);
});

it(`[AC-CT-13b#3] 其他事件不动（抽查 bridge_call 与四个 agent_stream_*）、仍通过 contracts:check 的事件表校验，${eventsPath} 的 version 递增（大于本任务前的 ${String(baselineVersion)}）`, () => {
  for (const [name, expected] of Object.entries(untouchedEvents)) {
    expect(Object.keys(fields(name)).sort(), `${name} 的字段集合不变`).toEqual(
      Object.keys(expected).sort(),
    );
    for (const [fieldName, spec] of Object.entries(expected)) {
      expectFieldShape(name, fieldName, spec);
    }
  }
  expect(checkEvents(loadEnums()), 'packages/contracts-ts/scripts/events.ts 报的问题').toEqual([]);
  const version = doc()['version'];
  expect(typeof version, 'version 是字符串').toBe('string');
  expect(String(version), 'version 是整数串').toMatch(/^\d+$/u);
  expect(Number(version), 'version 必须递增').toBeGreaterThan(baselineVersion);
});

it('[AC-CT-13b#4] 按事件规格校验：首页卡片事件带 page_version 照旧通过，缺 type / reason 或 page_version 不是整数照旧被拒；AI 助手页卡片事件不带 page_version 也通过', () => {
  // 照旧通过：首页（配置化页面）卡片事件带 page_version；正是缺卡片 version 而解码失败时不带 version。
  expect(validateEvent(eventName, homeCardError()), '首页卡片事件（带 page_version）').toEqual([]);
  expect(
    validateEvent(eventName, without(homeCardError(), 'version')),
    '首页卡片事件不带卡片 version',
  ).toEqual([]);

  // 照旧被拒：缺 type、缺 reason。
  expect(
    validateEvent(eventName, without(homeCardError(), 'type')),
    '缺 type 的事件被拒',
  ).toContain('type: missing');
  expect(
    validateEvent(eventName, without(homeCardError(), 'reason')),
    '缺 reason 的事件被拒',
  ).toContain('reason: missing');
  expect(
    validateEvent(eventName, without(agentCardError(), 'type')),
    'AI 助手页卡片事件缺 type 也被拒',
  ).toContain('type: missing');
  expect(
    validateEvent(eventName, without(agentCardError(), 'reason')),
    'AI 助手页卡片事件缺 reason 也被拒',
  ).toContain('reason: missing');

  // 照旧被拒：page_version 给了但不是整数。
  for (const bad of ['17', 17.5, true]) {
    expect(
      validateEvent(eventName, homeCardError({ page_version: bad })),
      `page_version=${JSON.stringify(bad)} 不是整数，被拒`,
    ).toContain('page_version: wrong type');
  }

  // 本单的改动：AI 助手页（03 §7.2）卡片事件不带 page_version，按规格通过。
  expect(
    validateEvent(eventName, agentCardError()),
    'AI 助手页卡片事件（不带 page_version）',
  ).toEqual([]);
});
