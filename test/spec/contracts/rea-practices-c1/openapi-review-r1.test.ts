import { expect, it } from 'vitest';
import { at, readOpenApi } from './kit.ts';

function sentences(description: unknown): string[] {
  return typeof description === 'string' ? description.split(/[。！？!?]|\.(?=\s|$)/u) : [];
}

it('[AC-CT-26zs#7] 小程序配对和兼容值须有专属契约说明', async () => {
  // 只给 mini_program 属性写原始 ID 和线上版本时，现有 SDK 说明无法替代以下断言。
  const doc = await readOpenApi();
  const step = at(doc, 'components', 'schemas', 'JumpStep');
  const properties = at(step, 'properties');
  const miniProgram = at(properties, 'mini_program');
  const miniProgramNotes = sentences(miniProgram['description']);
  const schemas = [step, ...Object.values(properties).map((property) => at(property))];
  const notes = schemas.flatMap((schema) => sentences(schema['description']));
  const pairingNotes = notes.filter((note) => /\bmini_program\b/u.test(note));
  const required = /\b(?:required|mandatory|must (?:carry|include))\b|必填|必带|必须/iu;

  expect(
    pairingNotes.some((note) => required.test(note)),
    'type=mini_program 时须带 mini_program',
  ).toBe(true);
  expect(
    [...pairingNotes, ...miniProgramNotes].some(
      (note) =>
        /\b(?:other|remaining|otherwise)\b|其余|其他|否则/iu.test(note) &&
        /\b(?:never|absent|omitted|not)\b|不带|不传|不得/iu.test(note),
    ),
    '其他类型不带 mini_program',
  ).toBe(true);

  const hasValue = (note: string) => /\bvalue\b/u.test(note);
  const valueNotes = notes.filter((note) => hasValue(note) && /\buser_name\b/u.test(note));
  const repeatsUserName = /\b(?:repeats?|duplicates?|matches|equals)\b|重复|等于|一致/iu;
  expect(
    valueNotes.some((note) => repeatsUserName.test(note)),
    '小程序步骤的 value 重复 mini_program.user_name',
  ).toBe(true);
  const miniProgramValueNotes = pairingNotes.filter(hasValue);
  const valuePurpose = [...valueNotes, ...miniProgramValueNotes].join(' ');
  expect(valuePurpose).toMatch(/\b(?:logs?|logging)\b|日志/iu);
  expect(valuePurpose).toMatch(/compatib|兼容/iu);
});

it('[AC-CT-26zs#8] 提醒配置说明不抄录业务规则中的默认分钟数', async () => {
  // 在对象或字段说明里写「默认 60」或「default 60」，即使没有 default 属性，也会失败。
  const doc = await readOpenApi();
  const response200 = at(doc, 'paths', '/v1/config', 'get', 'responses', '200');
  const config = at(response200, 'content', 'application/json', 'schema', 'properties', 'data');
  const reminder = at(config, 'properties', 'pdd_compare_reminder');
  const minutes = at(reminder, 'properties', 'delay_minutes');

  expect(String(reminder['description'] ?? '')).not.toMatch(/\b60\b/u);
  expect(String(minutes['description'] ?? '')).not.toMatch(/\b60\b/u);
});
