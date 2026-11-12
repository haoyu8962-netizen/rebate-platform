import { expect, it } from 'vitest';
import {
  agentCardError,
  baselineVersion,
  bridgeCall,
  bridgeCallEvent,
  cardError,
  diagnosticFields,
  diagnosticSpec,
  doc,
  eventsPath,
  expectedFields,
  expectFieldShape,
  field,
  fields,
  homeCardError,
  originalFields,
  targetEvents,
  testRequire,
  unknownDiagnostics,
  untouchedEvents,
  validateEvent,
  versionlessCardError,
  without,
  type Obj,
  type TargetEvent,
} from './kit.ts';

const { checkEvents } = testRequire(
  '../../../../packages/contracts-ts/scripts/events.ts',
) as typeof import('../../../../packages/contracts-ts/scripts/events.ts');
const { loadEnums } = testRequire(
  '../../../../packages/contracts-ts/scripts/catalog.ts',
) as typeof import('../../../../packages/contracts-ts/scripts/catalog.ts');

// AC-CT-13c#n 是 D10-1377 验收点的本地分组，不新增业务 AC / BR。

function expectShape(name: TargetEvent): void {
  const got = Object.keys(fields(name)).sort();
  expect(got, `${name} 的字段集合恰好是原有字段加四项诊断字段`).toEqual(
    Object.keys(expectedFields(name)).sort(),
  );
  // 原有字段照旧。
  for (const [fieldName, spec] of Object.entries(originalFields[name])) {
    expectFieldShape(name, fieldName, spec);
  }
  // 本单新增：四项诊断字段都是必填 string（03 §4.7）。
  for (const fieldName of diagnosticFields) {
    expectFieldShape(name, fieldName, diagnosticSpec);
  }
}

function expectNotes(name: TargetEvent): void {
  for (const fieldName of diagnosticFields) {
    const def = field(name, fieldName);
    expect(typeof def['note'], `${name}.${fieldName}.note 必须是字符串`).toBe('string');
    expect(String(def['note']).trim(), `${name}.${fieldName}.note 不能为空`).not.toBe('');
  }
  expect(
    String(field(name, 'schema_version')['note']),
    `${name}.schema_version.note 写明取不到时填 "unknown"`,
  ).toContain('unknown');
}

/** 一条带齐四项的样例事件：缺任一项被拒、四项填 "unknown" 通过、四项给了非字符串被拒。 */
function expectDiagnosticsValidated(name: TargetEvent, sample: Obj, label: string): void {
  expect(validateEvent(name, sample), `${label}（带齐四项诊断字段）`).toEqual([]);
  expect(
    validateEvent(name, { ...sample, ...unknownDiagnostics() }),
    `${label}（四项都填 "unknown"）`,
  ).toEqual([]);
  for (const fieldName of diagnosticFields) {
    expect(
      validateEvent(name, without(sample, fieldName)),
      `${label} 缺 ${fieldName} 被拒`,
    ).toContain(`${fieldName}: missing`);
    for (const bad of [3, 0, true, null]) {
      expect(
        validateEvent(name, { ...sample, [fieldName]: bad }),
        `${label} 的 ${fieldName}=${JSON.stringify(bad)} 不是字符串，被拒`,
      ).toContain(`${fieldName}: wrong type`);
    }
  }
}

it('[AC-CT-13c#1] sdui_card_error 字段恰好是 type / version / page_version / reason 加四项诊断字段；原有字段形状照旧，schema_version / bridge_version / config_version / h5_release 是必填 string', () => {
  expectShape(cardError);
});

it('[AC-CT-13c#2] bridge_call 字段恰好是 method / code 加四项诊断字段；method、code 照旧必填，四项诊断字段是必填 string', () => {
  expectShape(bridgeCall);
});

it('[AC-CT-13c#3] 两个事件的四项诊断字段各有非空 note，schema_version 的 note 写明取不到时填 "unknown"', () => {
  for (const name of targetEvents) expectNotes(name);
});

it(`[AC-CT-13c#4] 其他事件不动（抽查四个 agent_stream_* 与 link_jump）、仍通过 contracts:check 的事件表校验，${eventsPath} 的 version 递增（大于本任务前的 ${String(baselineVersion)}）`, () => {
  for (const [name, expected] of Object.entries(untouchedEvents)) {
    expect(Object.keys(fields(name)).sort(), `${name} 的字段集合不变`).toEqual(
      Object.keys(expected).sort(),
    );
    for (const [fieldName, spec] of Object.entries(expected)) {
      expectFieldShape(name, fieldName, spec);
    }
  }
  const common = Object.keys(doc()['common_fields'] as Obj);
  expect(
    common.filter((fieldName) => (diagnosticFields as readonly string[]).includes(fieldName)),
    '诊断字段只给部分事件，不进 common_fields',
  ).toEqual([]);
  expect(checkEvents(loadEnums()), 'packages/contracts-ts/scripts/events.ts 报的问题').toEqual([]);
  const version = doc()['version'];
  expect(typeof version, 'version 是字符串').toBe('string');
  expect(String(version), 'version 是整数串').toMatch(/^\d+$/u);
  expect(Number(version), 'version 必须递增').toBeGreaterThan(baselineVersion);
});

it('[AC-CT-13c#5] 按事件规格校验 sdui_card_error：首页卡片与 AI 助手页卡片带齐四项通过、四项填 "unknown" 通过、缺任一项或给了非字符串被拒；原有字段的校验照旧', () => {
  // 照旧：缺 type / reason 被拒；page_version 不是整数被拒。
  expect(validateEvent(cardError, without(homeCardError(), 'type'))).toContain('type: missing');
  expect(validateEvent(cardError, without(agentCardError(), 'reason'))).toContain(
    'reason: missing',
  );
  expect(validateEvent(cardError, homeCardError({ page_version: '17' }))).toContain(
    'page_version: wrong type',
  );

  // 本单：四项诊断字段。
  expectDiagnosticsValidated(cardError, homeCardError(), '首页卡片事件');
  expectDiagnosticsValidated(cardError, agentCardError(), 'AI 助手页卡片事件（不带 page_version）');
  expect(
    validateEvent(cardError, versionlessCardError()),
    '因取不到卡片版本而解码失败：不带 version、schema_version 填 "unknown"',
  ).toEqual([]);
});

it('[AC-CT-13c#6] 按事件规格校验 bridge_call：带齐四项通过、四项填 "unknown" 通过、缺任一项或给了非字符串被拒；method / code 的校验照旧', () => {
  // 照旧：缺 method / code 被拒；code 不是整数被拒。
  expect(validateEvent(bridgeCall, without(bridgeCallEvent(), 'method'))).toContain(
    'method: missing',
  );
  expect(validateEvent(bridgeCall, without(bridgeCallEvent(), 'code'))).toContain('code: missing');
  expect(validateEvent(bridgeCall, bridgeCallEvent({ code: '90002' }))).toContain(
    'code: wrong type',
  );

  // 本单：四项诊断字段。
  expectDiagnosticsValidated(bridgeCall, bridgeCallEvent(), 'bridge_call 事件');
});
