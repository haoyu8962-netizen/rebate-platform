import { expect, it } from 'vitest';
import { code, previousInboxTitles, text, texts, titles } from './kit.ts';

it.each(Object.entries(titles))(
  '[AC-CT-26za#4] %s 默认文案逐字等于 D10-773 定案',
  (key, expected) => {
    expect(text(key)).toBe(expected);
  },
);

it('[AC-CT-26za#5] 契约只加三个站内信短标题，不加正文键', () => {
  const keys = Object.keys(texts()).filter((key) => key.includes(code));
  expect(keys.toSorted()).toEqual(Object.keys(titles).toSorted());
});

it('[AC-CT-26za#6] 新增标题后原有 inbox.title.* 键与取值一个不改、不删', () => {
  const dictionary = texts();
  for (const key of Object.keys(titles)) {
    expect(Object.hasOwn(dictionary, key), `缺少 ${key}`).toBe(true);
  }
  for (const [key, value] of Object.entries(previousInboxTitles)) {
    expect(dictionary[key], key).toBe(value);
  }
});

it('[AC-CT-26za#7] 三个新键按字典序插在 inbox.title.* 之间', () => {
  const inbox = Object.keys(texts()).filter((key) => key.startsWith('inbox.title.'));
  for (const key of Object.keys(titles)) expect(inbox, `缺少 ${key}`).toContain(key);
  expect(inbox).toEqual(inbox.toSorted());
});
