import { expect, it } from 'vitest';
import { checkTextVariables } from '../../../../apps/api/src/modules/content/domain/text-guard/index.ts';
import {
  expectNewKeysPresent,
  expectedEntries,
  newKeys,
  ordinaryKeys,
  placeholders,
  searchQKey,
  text,
  textMap,
  texts,
  updatedAtKey,
} from './kit.ts';

// 依据：08 BR-TEXT-14 细则表 C 第八批（2026-11-12 补登，编排裁定 D10-1315）「AI 助手·对话页骨架」至
// 「AI 助手·举报半屏的校验与操作失败」15 行；文案列用「｜」分隔，与场景列的键一一对应，共 53 个键。

/** 带变量的两键与它们唯一的变量；其余 51 键不带变量。 */
const variables: Readonly<Record<string, readonly string[]>> = {
  [searchQKey]: ['q'],
  [updatedAtKey]: ['time'],
};

it('[AC-CT-26zn#1] 表 C 第八批 15 行展开成 53 个键，逐字是表 C 的原句', () => {
  const entries = expectedEntries();
  // 场景列展开的键与 BR-TEXT-12 细则逐键列出的 52 个普通键 + agent.earnings.updated_at 是同一组。
  const expandedKeys = entries.map(([key]) => key);
  expect(expandedKeys).toHaveLength(53);
  expect(new Set(expandedKeys).size, '展开后的键不能重复').toBe(53);
  expect([...expandedKeys].sort()).toEqual([...newKeys].sort());

  expectNewKeysPresent();
  for (const [key, sentence] of entries) {
    const value = text(key);
    expect(value.trim(), `${key} 不能为空`).not.toBe('');
    expect(value, `${key} 不能有首尾空白`).toBe(value.trim());
    expect(value, key).toBe(sentence);
  }
});

it('[AC-CT-26zn#2] 新键加入后 texts 的键仍严格按字母序、不重复', () => {
  expectNewKeysPresent();
  const keys = Object.keys(texts());
  const problems: string[] = [];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1] ?? '';
    const b = keys[i] ?? '';
    if (a >= b) problems.push(`${b} 排在 ${a} 之后`);
  }
  expect(problems).toEqual([]);
});

it('[AC-CT-26zn#3] 只有 agent.search_q 带 {q}、agent.earnings.updated_at 带 {time}，其余 51 句不带变量、没有花括号', () => {
  expectNewKeysPresent();
  for (const key of newKeys) {
    const value = text(key);
    const expected = variables[key] ?? [];
    expect(placeholders(value), `${key} 的变量`).toEqual([...expected]);
    let rest = value;
    for (const name of expected) rest = rest.replace(`{${name}}`, '');
    expect(rest.includes('{') || rest.includes('}'), `${key} 去掉变量后不能再有花括号`).toBe(false);
  }
});

it('[AC-CT-26zn#4] 后台改写时变量集合须与默认一致：去掉或换名 {q}、{time}，或给不带变量的句子加变量，都被拒绝', () => {
  expectNewKeysPresent();
  const defaults = textMap();
  for (const key of newKeys) {
    expect(checkTextVariables(key, text(key), defaults), key).toEqual({ ok: true });
  }
  expect(checkTextVariables(searchQKey, '去搜索', defaults)).toEqual({
    ok: false,
    reason: 'variables_mismatch',
    missing: ['q'],
    extra: [],
  });
  expect(checkTextVariables(searchQKey, '去搜索「{keyword}」', defaults)).toEqual({
    ok: false,
    reason: 'variables_mismatch',
    missing: ['q'],
    extra: ['keyword'],
  });
  expect(checkTextVariables(updatedAtKey, '更新于', defaults)).toEqual({
    ok: false,
    reason: 'variables_mismatch',
    missing: ['time'],
    extra: [],
  });
  expect(checkTextVariables('agent.search', '去搜索「{q}」', defaults)).toEqual({
    ok: false,
    reason: 'variables_mismatch',
    missing: [],
    extra: ['q'],
  });
});

it('[AC-CT-26zn#5] 代入变量后得到界面上的整句：去搜索「关键词」、更新于 HH:mm', () => {
  const search = text(searchQKey);
  expect(search.replace('{q}', '蓝牙耳机')).toBe('去搜索「蓝牙耳机」');
  const updatedAt = text(updatedAtKey);
  // 表 C 本行「动作」列：画板示例「更新于 10:03」，{time} 只显示时刻，不加「今天」「昨天」与日期。
  expect(updatedAt.replace('{time}', '10:03')).toBe('更新于 10:03');
  for (const word of ['今天', '昨天', 'HH:mm', 'hh:mm', 'MM-DD']) {
    expect(updatedAt.includes(word), `${updatedAtKey} 不能带「${word}」`).toBe(false);
  }
});

it('[AC-CT-26zn#6] 次数用完与举报补充说明超长的句子不写数字，输入超长句只写上限 500', () => {
  expectNewKeysPresent();
  // 表 C「AI 助手·次数用完」行：额度数值只在 BR-AI-15，本行不写数字；
  // 「AI 助手·举报半屏的校验与操作失败」行：补充说明的长度上限随契约，本句不写数字。
  for (const key of [
    'agent.quota.guest_hint',
    'agent.quota.phone_hint',
    'agent.quota.input_disabled',
    'agent.report.too_long',
  ]) {
    expect(text(key).match(/[0-9０-９]/g), `${key} 不能写数字`).toBeNull();
  }
  // 「AI 助手·输入与发送」行：500 是输入长度上限（BR-AI-23 ⑤）。
  expect(text('agent.too_long').match(/[0-9]+/g)).toEqual(['500']);
});

it('[AC-CT-26zn#7] 53 句没有占位残留、分隔符或草稿键名，字典里也不另留 agent.draft.* 键', () => {
  expectNewKeysPresent();
  for (const key of newKeys) {
    const value = text(key);
    expect(value, `${key} 的文案不能是键名`).not.toBe(key);
    for (const leftover of ['TODO', 'XX', '待定', '｜', '|', 'agent.', '.draft', '\n']) {
      expect(value.includes(leftover), `${key} 不能残留「${leftover}」`).toBe(false);
    }
  }
  // 键名沿用客户端本地草稿表 agent.draft.* 的后缀并去掉 .draft 一段：入字典的是去掉后的键名。
  const draftKeys = Object.keys(texts()).filter((key) => key.startsWith('agent.draft.'));
  expect(draftKeys, '字典里不能有 agent.draft.* 键').toEqual([]);
  for (const key of ordinaryKeys) {
    expect(key.includes('.draft'), `${key} 要去掉 .draft 一段`).toBe(false);
  }
});
