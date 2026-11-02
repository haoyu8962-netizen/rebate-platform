import { expect, it } from 'vitest';
import { accepts, contract, field, item, syncPath } from './kit.ts';

it('[AC-B1-04zu#7] limits 的 max_order_nos 最小值为 0：0 表示该平台不支持按单号，负数和非整数仍不合法', () => {
  const doc = contract();
  const schema = field(doc, item(doc, `${syncPath}/limits`), 'max_order_nos');
  expect(schema).toMatchObject({ type: 'integer', minimum: 0 });
  accepts(doc, schema, [0, 1, 50], [-1, 1.5, '0', null]);
});
