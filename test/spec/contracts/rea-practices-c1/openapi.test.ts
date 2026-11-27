import { beforeAll, expect, it } from 'vitest';
import { jump_type as generatedJumpTypes } from '../../../../packages/contracts-ts/src/enums.gen.ts';
import { apiRequire, at, list, readMapping, readOpenApi } from './kit.ts';

// 规划/04 §8.4、§10.1、§10.2，BR-ATTR-27 与 BR-TEXT-03 细则。
interface Ajv {
  addFormat(name: string, format: { type: 'number'; validate: (value: number) => boolean }): void;
  compile(schema: object): (data: unknown) => boolean;
}
const { Ajv2020 } = apiRequire('ajv/dist/2020.js') as {
  Ajv2020: new (options: { strict: true; allErrors: true }) => Ajv;
};
const addFormats = apiRequire('ajv-formats') as (ajv: Ajv) => void;
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addFormat('int32', {
  type: 'number',
  validate: (value) => Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
});
ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });

let doc: Awaited<ReturnType<typeof readOpenApi>>;
beforeAll(async () => {
  doc = await readOpenApi();
});

const legacyTypes = ['sdk', 'scheme', 'universal_link', 'h5', 'copy_tpwd'];
const userName = 'gh_123abc456def';
const miniProgramStep = {
  type: 'mini_program',
  value: userName,
  mini_program: { user_name: userName },
};

it('[AC-CT-26zs#5] 三处外跳枚举同步增加小程序类型', async () => {
  // 漏改三处之一，或误用 miniProgram / 移除现有步骤类型，都会失败。
  const trade = await readMapping('contracts/enums/trade.yaml');
  const sourceTypes = Object.keys(at(trade, 'enums', 'jump_type', 'values')).sort();
  const openApiTypes = list(
    at(doc, 'components', 'schemas', 'JumpStep', 'properties', 'type')['enum'],
    'JumpStep.type.enum',
  ).sort();
  expect(sourceTypes).toEqual(expect.arrayContaining([...legacyTypes, 'mini_program']));
  expect(openApiTypes).toEqual(sourceTypes);
  expect([...generatedJumpTypes].sort()).toEqual(sourceTypes);
});

it('[AC-CT-26zs#6] 可选小程序指令校验原始 ID、路径与版本', () => {
  // 错把对象或路径设为必填、接受 app_id、拒绝 release 或改默认值，都会失败。
  const step = at(doc, 'components', 'schemas', 'JumpStep');
  const miniProgram = at(step, 'properties', 'mini_program');
  const properties = at(miniProgram, 'properties');
  expect(step).not.toHaveProperty('oneOf');
  expect(list(step['required'], 'JumpStep.required').sort()).toEqual(['type', 'value']);
  expect(at(step, 'properties', 'value')).toMatchObject({ type: 'string', minLength: 1 });
  expect(miniProgram).toMatchObject({ type: 'object', required: ['user_name'] });
  expect(Object.keys(properties).sort()).toEqual(['mini_program_type', 'path', 'user_name']);
  const release = properties['mini_program_type'];
  expect(release).toMatchObject({ type: 'string', default: 'release' });
  const validate = ajv.compile(step);
  expect(validate({ type: 'scheme', value: 'openapp.example://item' })).toBe(true);
  expect(validate(miniProgramStep)).toBe(true);
  for (const path of ['', 'pages/detail/index?id=42']) {
    expect(
      validate({
        ...miniProgramStep,
        mini_program: { user_name: userName, path, mini_program_type: 'release' },
      }),
    ).toBe(true);
  }
  for (const invalid of [
    {},
    { user_name: '' },
    { user_name: 'gh_' },
    { user_name: 'wx123abc456def' },
    { user_name: userName, path: 42 },
    { user_name: userName, mini_program_type: 'unknown' },
    { user_name: userName, app_id: 'wx123abc456def' },
  ]) {
    const accepted = validate({ ...miniProgramStep, mini_program: invalid });
    expect(accepted, JSON.stringify(invalid)).toBe(false);
  }
});

function checkPairing(step: Record<string, unknown>): void {
  expect(Object.hasOwn(step, 'sdk')).toBe(step['type'] === 'sdk');
  expect(Object.hasOwn(step, 'mini_program')).toBe(step['type'] === 'mini_program');
  if (step['type'] === 'mini_program') {
    expect(step['value']).toBe(at(step, 'mini_program')['user_name']);
  }
}

it('[AC-CT-26zs#7] 小程序说明与示例沿用 SDK 的配对约定', () => {
  // 若文档漏掉配对条件或 value 含义，已有 SDK 示例被替换，或示例的 type 与字段不匹配，就会失败。
  const step = at(doc, 'components', 'schemas', 'JumpStep');
  const miniProgram = at(step, 'properties', 'mini_program');
  const properties = at(miniProgram, 'properties');
  const stepProperties = at(step, 'properties');
  const notes = [step, ...Object.values(stepProperties), ...Object.values(properties)]
    .map((def) => at(def))
    .map((def) => String(def['description'] ?? ''))
    .join(' ');
  expect(notes).toMatch(/type[`'"]?\s*[:=]\s*[`'"]?mini_program/u);
  expect(notes).toMatch(/(?:require|must|必带|必填)/iu);
  expect(notes).toMatch(/(?:never|only|absent|omit|不带|不传|仅|只)/iu);
  expect(notes).toMatch(/\bvalue\b/u);
  expect(notes).toMatch(/\buser_name\b/u);
  expect(notes).toMatch(/(?:log|日志)/iu);
  expect(notes).toMatch(/(?:compatib|兼容)/iu);
  const releaseOnly =
    /(?:production|线上|生产).{0,60}release|release.{0,60}(?:production|线上|生产)/isu;
  expect(notes).toMatch(releaseOnly);

  const validate = ajv.compile(step);
  const examples = at(doc, 'components', 'examples');
  const legacyPrimary = {
    OpenLinkUnchanged: { type: 'sdk', sdk: { provider: 'baichuan', open_by: 'code' } },
    OpenLinkPriceChanged: { type: 'scheme', value: 'openapp.example://virtual?params=abc' },
    OpenLinkPriceCompare: { type: 'sdk', sdk: { provider: 'baichuan', open_by: 'url' } },
  };
  for (const [name, primary] of Object.entries(legacyPrimary)) {
    expect(at(examples, name, 'value', 'data', 'jump', 'primary')).toMatchObject(primary);
  }
  for (const value of Object.values(examples)) {
    const payload = at(value);
    const exampleValue = payload['value'];
    if (typeof exampleValue !== 'object' || exampleValue === null || !('data' in exampleValue)) {
      continue;
    }
    const data = exampleValue.data;
    if (typeof data !== 'object' || data === null || !('jump' in data) || data.jump === null) {
      continue;
    }
    const jump = at(data, 'jump');
    for (const example of [jump['primary'], ...list(jump['fallbacks'], 'jump.fallbacks')]) {
      checkPairing(at(example));
      expect(validate(example)).toBe(true);
    }
  }
  checkPairing(miniProgramStep);
});

it('[AC-CT-26zs#8] 提醒配置可缺，分钟为正 int32，无默认值', () => {
  // 若字段加错响应层、改为必填、允许 0/超 int32 或把 BR 默认值抄进契约，就会失败。
  const response200 = at(doc, 'paths', '/v1/config', 'get', 'responses', '200');
  const content = at(response200, 'content', 'application/json');
  const response = at(content, 'schema');
  const config = at(response, 'properties', 'data');
  const properties = at(config, 'properties');
  const reminder = at(properties, 'pdd_compare_reminder');
  const minutes = at(reminder, 'properties', 'delay_minutes');
  expect(config['required']).not.toContain('pdd_compare_reminder');
  expect(properties).toHaveProperty('bridge_disabled_methods');
  expect(properties).toHaveProperty('config_version');
  expect(properties).toHaveProperty('lkg_max_age_sec');
  expect(reminder).toMatchObject({ type: 'object', required: ['delay_minutes'] });
  expect(Object.keys(at(reminder, 'properties'))).toEqual(['delay_minutes']);
  expect(minutes).toMatchObject({ type: 'integer', format: 'int32', minimum: 1 });
  expect(reminder).not.toHaveProperty('default');
  expect(minutes).not.toHaveProperty('default');
  const defaultNotes = [reminder['description'], minutes['description']].map(String).join(' ');
  expect(defaultNotes).not.toMatch(/(?:defaults?\s+to|default\s*[:=]|默认(?:为|是|值))\s*`?\d+/iu);

  const validate = ajv.compile(response);
  const example = at(content, 'example');
  const data = { ...at(example, 'data') };
  delete data['pdd_compare_reminder'];
  expect(validate({ ...example, data })).toBe(true);
  const accepts = (value: unknown) =>
    validate({ ...example, data: { ...data, pdd_compare_reminder: value } });
  for (const delay_minutes of [1, 2 ** 31 - 1]) {
    expect(accepts({ delay_minutes })).toBe(true);
  }
  expect(accepts({})).toBe(false);
  expect(accepts(null)).toBe(false);
  for (const delay_minutes of [0, -1, 1.5, 2 ** 31, '5']) {
    expect(accepts({ delay_minutes }), String(delay_minutes)).toBe(false);
  }
});

it('[AC-CT-26zs#9] 小程序外跳开关按平台登记且默认关闭', () => {
  // 若只登记全局开关、文档只提步骤却漏登记键，或默认打开，就会失败。
  const description = [
    at(doc, 'paths', '/admin/v1/kill-switches', 'get')['description'],
    at(doc, 'paths', '/admin/v1/kill-switches/{key}', 'put')['description'],
    at(doc, 'components', 'schemas', 'AdminConfigKey')['description'],
    at(doc, 'components', 'schemas', 'AdminKillSwitch')['description'],
    at(doc, 'components', 'schemas', 'JumpStep')['description'],
  ].map(String);
  const entry = description
    .filter((item) => item.includes('jump.mini_program.enabled.<platform>'))
    .join(' ');
  expect(entry).toContain('jump.mini_program.enabled.<platform>');
  expect(entry).toMatch(
    /(?:default(?:s| value)?[\s:`]*(?:off|false)|默认[\s:`]*(?:off|false|关))/iu,
  );
});
