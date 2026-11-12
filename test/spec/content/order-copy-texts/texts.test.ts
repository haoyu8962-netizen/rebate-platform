import { expect, it } from 'vitest';
import { checkTextVariables } from '../../../../apps/api/src/modules/content/domain/text-guard/index.ts';
import {
  doneKey,
  doneText,
  expectNewKeysPresent,
  expectedTexts,
  labelKey,
  newKeys,
  placeholders,
  sampleOrderNos,
  spokenKey,
  text,
  textMap,
  texts,
} from './kit.ts';

// 依据：08 BR-TEXT-14 细则表 C「订单行的复制按钮 order_list.copy_label / order_list.copy_spoken」一行
// （文案「复制｜复制订单号 {no}」；copy_label 是看得见的按钮文字，copy_spoken 是读屏名称，{no} 为本行完整
// 订单号 order_no，不缩写、不脱敏；订单列表与订单详情共用；复制成功的提示仍用 order_detail.copy.done）。

it('[AC-CT-26zk#1] 两个复制按钮键在 texts.default.json 里，逐字是 08 表 C 的原句', () => {
  expectNewKeysPresent();
  for (const key of newKeys) {
    const value = text(key);
    expect(value.trim(), `${key} 不能为空`).not.toBe('');
    expect(value, `${key} 不能有首尾空白`).toBe(value.trim());
    expect(value, key).toBe(expectedTexts[key]);
  }
});

it('[AC-CT-26zk#2] 新键加入后 texts 的键仍严格按字母序、不重复', () => {
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

it('[AC-CT-26zk#3] 看得见的按钮文字 copy_label 不带变量、没有占位残留', () => {
  const value = text(labelKey);
  expect(placeholders(value), `${labelKey} 不带变量`).toEqual([]);
  expect(value.includes('{') || value.includes('}'), '不能有花括号').toBe(false);
  for (const leftover of ['TODO', 'XX', '待定', '｜', '|']) {
    expect(value.includes(leftover), `${labelKey} 不能残留「${leftover}」`).toBe(false);
  }
  // 后台改写时变量集合须与默认一致（BR-TEXT-12），按钮文字不能被加上订单号变量。
  const defaults = textMap();
  expect(checkTextVariables(labelKey, value, defaults)).toEqual({ ok: true });
  expect(checkTextVariables(labelKey, '复制 {no}', defaults)).toEqual({
    ok: false,
    reason: 'variables_mismatch',
    missing: [],
    extra: ['no'],
  });
});

it('[AC-CT-26zk#4] 读屏名称 copy_spoken 恰好含一个 {no} 变量，没有别的变量与占位残留', () => {
  const value = text(spokenKey);
  expect(placeholders(value), `${spokenKey} 的变量`).toEqual(['no']);
  const rest = value.replace('{no}', '');
  expect(rest.includes('{') || rest.includes('}'), '去掉 {no} 后不能再有花括号').toBe(false);
  for (const leftover of ['order_no', 'TODO', 'XX', '待定', '｜', '|']) {
    expect(value.includes(leftover), `${spokenKey} 不能残留「${leftover}」`).toBe(false);
  }
});

it('[AC-CT-26zk#5] 读屏名称代入完整订单号后原样带出整串，不缩写、不脱敏', () => {
  const value = text(spokenKey);
  for (const no of sampleOrderNos) {
    const spoken = value.replace('{no}', no);
    expect(spoken, `代入 ${no}`).toBe(`复制订单号 ${no}`);
    expect(spoken.endsWith(no), `读屏名称须以完整订单号 ${no} 结尾`).toBe(true);
  }
  // 文案本身不能带脱敏或缩写的说法（03 §10.5 ②：读屏名称带本行完整订单号）。
  for (const masked of ['*', '…', '...', '尾号', '后四位', '末四位']) {
    expect(value.includes(masked), `${spokenKey} 不能带「${masked}」`).toBe(false);
  }
});

it('[AC-CT-26zk#6] 后台改写 copy_spoken 必须保留 {no}，去掉或换名都被变量校验拒绝', () => {
  const value = text(spokenKey);
  const defaults = textMap();
  expect(checkTextVariables(spokenKey, value, defaults)).toEqual({ ok: true });
  expect(checkTextVariables(spokenKey, '复制订单号', defaults)).toEqual({
    ok: false,
    reason: 'variables_mismatch',
    missing: ['no'],
    extra: [],
  });
  expect(checkTextVariables(spokenKey, '复制订单号 {order_no}', defaults)).toEqual({
    ok: false,
    reason: 'variables_mismatch',
    missing: ['no'],
    extra: ['order_no'],
  });
});

it('[AC-CT-26zk#7] 订单列表与订单详情共用 order_list. 两键，复制成功提示仍是原样的 order_detail.copy.done', () => {
  expectNewKeysPresent();
  const dictionary = texts();
  for (const key of newKeys) {
    expect(key.startsWith('order_list.'), `${key} 用 order_list. 前缀`).toBe(true);
  }
  // 共用同一组键：订单详情不另起一组复制按钮键。
  for (const key of ['order_detail.copy_label', 'order_detail.copy_spoken']) {
    expect(Object.hasOwn(dictionary, key), `订单详情与列表共用，不能另有 ${key}`).toBe(false);
  }
  // 复制成功的提示仍用 order_detail.copy.done，本单不改它，也不另起一个复制成功键。
  expect(dictionary[doneKey], doneKey).toBe(doneText);
  for (const key of ['order_list.copy.done', 'order_list.copy_done']) {
    expect(Object.hasOwn(dictionary, key), `复制成功仍用 ${doneKey}，不能另有 ${key}`).toBe(false);
  }
  expect(text(labelKey), '按钮文字不是复制成功提示').not.toBe(doneText);
  expect(text(spokenKey), '读屏名称不是复制成功提示').not.toBe(doneText);
});
