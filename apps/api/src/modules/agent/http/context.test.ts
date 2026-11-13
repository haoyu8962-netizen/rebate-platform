// B3-05q implementation unit tests: context.text (剪贴板文本) is dropped before the run input exists.
import { expect, it } from 'vitest';
import { contextWithoutClipboard, withoutClipboard } from './context.ts';

it('[B3-05q][BR-AI-01] contextWithoutClipboard：只有 text 时整个 context 去掉；其他成员原样保留；没有 text 时原对象不变', () => {
  expect(contextWithoutClipboard({ text: '合成剪贴板' })).toBeUndefined();
  expect(contextWithoutClipboard({ text: '合成剪贴板', product_key: 'tb:x' })).toEqual({
    product_key: 'tb:x',
  });
  const product = { product_key: 'tb:x' };
  expect(contextWithoutClipboard(product)).toBe(product);
  expect(contextWithoutClipboard(undefined)).toBeUndefined();
});

it('[B3-05q][BR-AI-01] withoutClipboard：去掉 text 后的输入不再有 context 键；没有 text 时返回同一个输入', () => {
  const clipped = withoutClipboard({ runId: 'synthetic-run', context: { text: '合成剪贴板' } });
  expect(clipped).toEqual({ runId: 'synthetic-run' });
  expect(Object.hasOwn(clipped, 'context')).toBe(false);
  const plain = { runId: 'synthetic-run', context: { order_id: 'synthetic-order' } };
  expect(withoutClipboard(plain)).toBe(plain);
  const none: { readonly runId: string; readonly context?: Readonly<Record<string, unknown>> } = {
    runId: 'synthetic-run',
  };
  expect(withoutClipboard(none)).toBe(none);
});
