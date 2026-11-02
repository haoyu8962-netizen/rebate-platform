// B2-04zj: 一列一个写者（D10-583 S1；apps/api AGENTS.md 硬规则 1）。order_settlements 只有 settlement 的
// 结算记录端口写，orders.settle_commission_fen 只有 orders 写。只读源码，不连库。
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const MODULES = fileURLToPath(new URL('../../../../apps/api/src/modules/', import.meta.url));
const RECORD_PORT = 'settlement/settlements/';
const ORDERS = 'orders/';

const INSERT_RECORD =
  /insertInto\(\s*['"](?:app\.)?order_settlements['"]|INSERT\s+INTO\s+app\.order_settlements/u;
const WRITE_COLUMN =
  /updateTable\(\s*['"](?:app\.)?orders['"]\s*\)[\s\S]{0,400}?settle_commission_fen\s*:/u;

/** Every production source under apps/api/src/modules, path relative to it. */
function sources(): { readonly path: string; readonly text: string }[] {
  return readdirSync(MODULES, { recursive: true, encoding: 'utf8' })
    .map((path) => path.split('\\').join('/'))
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'))
    .map((path) => ({ path, text: readFileSync(`${MODULES}${path}`, 'utf8') }));
}

it('[AC-B2-04zj#1] order_settlements 的写入只在 settlement 的结算记录端口：端口里有写入，别处一处都没有', () => {
  const writers = sources().filter((file) => INSERT_RECORD.test(file.text));
  expect(writers.map((file) => file.path).filter((path) => !path.startsWith(RECORD_PORT))).toEqual(
    [],
  );
  expect(writers.length, 'the record port writes order_settlements').toBeGreaterThan(0);
});

it('[AC-B2-04zj#2] orders.settle_commission_fen 的写入只在 orders：别的模块不 UPDATE 这一列，结算记录端口只写自己的表', () => {
  const files = sources();
  expect(
    files
      .filter((file) => !file.path.startsWith(ORDERS) && WRITE_COLUMN.test(file.text))
      .map((file) => file.path),
  ).toEqual([]);
  const port = files.filter((file) => file.path.startsWith(RECORD_PORT));
  expect(port.filter((file) => INSERT_RECORD.test(file.text)).length).toBeGreaterThan(0);
  expect(port.filter((file) => /updateTable\(/u.test(file.text)).map((file) => file.path)).toEqual(
    [],
  );
});
