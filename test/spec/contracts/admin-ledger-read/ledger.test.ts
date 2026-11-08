// CT-24zzc GET /admin/v1/ledger?user_id=（adminListLedgerEntries）的契约形状（任务书第 9 节第 2、3 项；
// BR-FUND-13、BR-FUND-15、BR-FUND-16）。独立预期，不从契约生成；静态读 contracts。
import { expect, it } from 'vitest';
import {
  accepts,
  at,
  contract,
  enumField,
  field,
  list,
  missingRejected,
  object,
  resolve,
  text,
  type Obj,
} from '../admin-order-actions/kit.ts';
import { examples } from '../order-claims/kit.ts';
import {
  adjustEntry,
  badDates,
  badTimes,
  boundRef,
  closedKeys,
  closedShape,
  creditEntry,
  dataOf,
  entries,
  entryKeys,
  entrySchema,
  enumValues,
  envelopeOf,
  freezeEntry,
  goodDates,
  goodTimes,
  ledgerFilters,
  ledgerPath,
  ledgerTypes,
  linkKeys,
  linkTypes,
  objectBranch,
  operation,
  param,
  rawParams,
  subAccounts,
  unlinkedEntry,
  userId,
  voucherKeys,
  writeoffEntry,
} from './kit.ts';

function paramSchema(doc: Obj, name: string): Obj {
  return resolve(doc, at(param(doc, ledgerPath, name), 'schema'));
}

// 把参数 schema 包成对象属性，复用 enumField 的取值核对。
function holder(doc: Obj, name: string): Obj {
  return { type: 'object', properties: { [name]: at(param(doc, ledgerPath, name), 'schema') } };
}

function page(items: unknown[]): Obj {
  return { items, page: 1, page_size: 20, total: items.length };
}

it('[AC-CT-24zzc#13] 参数恰为 X-Trace-Id、user_id（必填）、六个可选筛选与 page、page_size；分页引用 AdminPage / AdminPageSize（≤ 200）', () => {
  const doc = contract();
  const raws = rawParams(doc, ledgerPath);
  for (const name of ['TraceId', 'AdminPage', 'AdminPageSize'])
    expect(raws, name).toContainEqual({ $ref: `#/components/parameters/${name}` });
  expect(raws.map((raw) => text(resolve(doc, raw)['name'])).toSorted()).toEqual(
    ['X-Trace-Id', 'page', 'page_size', ...ledgerFilters].toSorted(),
  );
  expect(param(doc, ledgerPath, 'X-Trace-Id')['in']).toBe('header');
  for (const name of ledgerFilters) expect(param(doc, ledgerPath, name)['in'], name).toBe('query');
  expect(param(doc, ledgerPath, 'user_id')['required']).toBe(true);
  accepts(doc, paramSchema(doc, 'user_id'), [userId], [1, null]);
  for (const name of ledgerFilters.filter((entry) => entry !== 'user_id'))
    expect([undefined, false], name).toContain(param(doc, ledgerPath, name)['required']);
  const size = paramSchema(doc, 'page_size');
  expect(size['maximum']).toBe(200);
  accepts(doc, size, [1, 200], [0, 201, 1.5, '20']);
  accepts(doc, paramSchema(doc, 'page'), [1, 2], [0, -1, 1.5]);
});

it('[AC-CT-24zzc#14] 筛选取值：ledger_type 取 13 种 ledger_type，sub_account 取 ledger_sub_account，sub_type / ref 为字符串，记账日期区间为 date', () => {
  const doc = contract();
  expect(enumValues('ledger_type').toSorted()).toEqual(ledgerTypes.toSorted());
  enumField(doc, holder(doc, 'ledger_type'), 'ledger_type', ledgerTypes);
  enumField(doc, holder(doc, 'sub_account'), 'sub_account', subAccounts);
  accepts(doc, paramSchema(doc, 'sub_type'), ['RECON_FIX', 'invite'], [1, null, {}]);
  accepts(doc, paramSchema(doc, 'ref'), ['pdd:231006-1234567890'], [1, null, {}]);
  for (const name of ['accounting_date_from', 'accounting_date_to']) {
    const schema = paramSchema(doc, name);
    expect(schema['format'], name).toBe('date');
    accepts(doc, schema, goodDates, badDates);
  }
});

it('[AC-CT-24zzc#15] 200 是后台分页信封：data 封闭且恰为 items、page、page_size、total，items 元素为 AdminLedgerEntry', () => {
  const doc = contract();
  const envelope = envelopeOf(doc, ledgerPath);
  expect(list(envelope['required'])).toEqual(
    expect.arrayContaining(['code', 'msg', 'data', 'trace_id']),
  );
  accepts(doc, at(envelope, 'properties', 'code'), [0], [1, '0', null]);
  const data = dataOf(doc, ledgerPath);
  closedKeys(doc, data, ['items', 'page', 'page_size', 'total']);
  const items = field(doc, data, 'items');
  expect(items['type']).toBe('array');
  expect(at(items, 'items')['$ref']).toBe('#/components/schemas/AdminLedgerEntry');
  accepts(doc, field(doc, data, 'page'), [1, 2], [0, -1, 1.5, '1', null]);
  accepts(doc, field(doc, data, 'page_size'), [1, 200], [0, 201, 1.5, '1', null]);
  accepts(doc, field(doc, data, 'total'), [0, 1], [-1, 1.5, '1', null]);
  accepts(
    doc,
    data,
    [page(entries), page([])],
    [
      { items: entries, page: 1, page_size: 20 },
      { ...page([]), extra: 1 },
    ],
  );
});

it('[AC-CT-24zzc#16] 流水项封闭且恰为 10 个必填字段', () => {
  const doc = contract();
  const schema = entrySchema(doc);
  closedKeys(doc, schema, entryKeys);
  missingRejected(doc, schema, creditEntry, entryKeys);
  accepts(doc, schema, entries, [
    { ...creditEntry, extra: 1 },
    { ...creditEntry, masked: false },
    { ...creditEntry, user_id: userId },
  ]);
});

it('[AC-CT-24zzc#17] 流水项取值：booked_at 为 date-time，accounting_date 为 date，amount_fen 带符号整数，balance_after_fen 整数或 null，sub_type 字符串或 null', () => {
  const doc = contract();
  const schema = entrySchema(doc);
  accepts(doc, field(doc, schema, 'entry_id'), [creditEntry.entry_id], [null, 1]);
  accepts(doc, field(doc, schema, 'booked_at'), goodTimes, badTimes);
  accepts(doc, field(doc, schema, 'accounting_date'), goodDates, badDates);
  accepts(doc, field(doc, schema, 'sub_type'), [null, 'RECON_FIX', 'DIRECT'], [1, {}]);
  const amount = field(doc, schema, 'amount_fen');
  expect(amount['format']).toBe('int64');
  accepts(doc, amount, [-300, 0, 120], [1.5, '120', null]);
  accepts(doc, field(doc, schema, 'balance_after_fen'), [null, -1200, 0, 1320], [1.5, '1320']);
  accepts(doc, schema, [adjustEntry, freezeEntry], [{ ...adjustEntry, amount_fen: -0.5 }]);
});

it('[AC-CT-24zzc#18] ledger_type 与 sub_account 是对 ledger_type、ledger_sub_account 枚举组件的 $ref', () => {
  const doc = contract();
  const schema = entrySchema(doc);
  boundRef(at(schema, 'properties', 'ledger_type'), 'ledger_type');
  boundRef(at(schema, 'properties', 'sub_account'), 'ledger_sub_account');
  enumField(doc, schema, 'ledger_type', ledgerTypes);
  enumField(doc, schema, 'sub_account', subAccounts);
});

it('[AC-CT-24zzc#19] voucher 封闭且恰为 voucher_id、uniq_key、biz_type、biz_id（字符串）；link 为对象或 null，对象恰为 type、id', () => {
  const doc = contract();
  const schema = entrySchema(doc);
  // voucher 不可为 null：字段本身就是封闭对象；link 是唯一允许 null 的对象。
  const voucher = field(doc, schema, 'voucher');
  closedKeys(doc, voucher, voucherKeys);
  const sample: Record<string, string> = creditEntry.voucher;
  for (const name of voucherKeys)
    accepts(doc, field(doc, voucher, name), [sample[name]], [null, 1, {}]);
  missingRejected(doc, voucher, creditEntry.voucher, voucherKeys);
  accepts(doc, field(doc, schema, 'voucher'), [creditEntry.voucher], [null, {}, 'x']);

  const linkField = field(doc, schema, 'link');
  accepts(
    doc,
    linkField,
    [null, creditEntry.link, freezeEntry.link, adjustEntry.link, writeoffEntry.link],
    [{}, { type: 'order' }, { id: 'x' }, { type: 'refund', id: 'x' }, 'order'],
  );
  const link = objectBranch(doc, linkField);
  closedShape(link, linkKeys);
  enumField(doc, link, 'type', linkTypes);
  accepts(doc, field(doc, link, 'id'), ['pdd:231006-1234567890'], [null, 1]);
  const nullId = { ...creditEntry, link: { type: 'withdrawal', id: null } };
  accepts(doc, schema, [unlinkedEntry], [nullId]);
});

// 用户视角的符号（任务书第 17 节）：入账为正、扣减为负。存储口径相反（08 BR-FUND 期间汇总按
// 「−Σ amount_fen」取数），所以只写 signed、或写成「入账为负 / 扣减为正」都不算。
const userView = /user'?s?\s+(view|perspective|point\s+of\s+view)|用户视角|用户角度/i;
const creditWord = String.raw`(credits?|入账)\s*(is\s+|are\s+|为\s*)?`;
const debitWord = String.raw`(debits?|扣减|扣回|出账)\s*(is\s+|are\s+|为\s*)?`;

it('[AC-CT-24zzc#23] amount_fen 的描述写明用户视角：入账为正、扣减为负（不是存储符号）', () => {
  const doc = contract();
  const desc = text(field(doc, entrySchema(doc), 'amount_fen')['description']);
  expect(desc).toMatch(userView);
  expect(desc).toMatch(new RegExp(`${creditWord}(positive|正)`, 'i'));
  expect(desc).toMatch(new RegExp(`${debitWord}(negative|负)`, 'i'));
  expect(desc).not.toMatch(new RegExp(`${creditWord}(negative|负)`, 'i'));
  expect(desc).not.toMatch(new RegExp(`${debitWord}(positive|正)`, 'i'));
});

interface Row {
  ledgerType: string;
  subAccount: string;
  amount: number;
  balance: number | null;
  uniqKey: string;
}

// 用户视角下各类型的方向（BR-FUND-15）。坏账核销冲掉负余额，对用户是加（08 BR-FUND 例「核销 +800」）。
const creditTypes = [
  'REBATE_CREDIT',
  'SHARE_CREDIT',
  'REFERRAL_CREDIT',
  'REWARD',
  'BAD_DEBT_WRITEOFF',
];
const debitTypes = ['CLAWBACK', 'WITHDRAW_PAID', 'WITHDRAW_FEE', 'TAX_WITHHOLD'];
// 冻结与退回在两个子户各记一条：冻结是 available 减、frozen 加，退回反过来。
const legSigns: Partial<Record<string, Partial<Record<string, number>>>> = {
  WITHDRAW_FREEZE: { available: -1, frozen: 1 },
  WITHDRAW_RETURN: { available: 1, frozen: -1 },
};
// 红冲沿用原分录的 ledger_type，方向相反（BR-FUND-16 :REVERSE；R14 的 REASSIGN_REV），不按类型核。
const reversal = /:REVERSE$|REASSIGN_REV/;

function integer(value: unknown): number {
  expect(Number.isSafeInteger(value), String(value)).toBe(true);
  return value as number;
}

function exampleRows(doc: Obj): Row[][] {
  const media = at(
    resolve(doc, at(operation(doc, ledgerPath), 'responses', '200')),
    'content',
    'application/json',
  );
  return examples(doc, media).map((sample) =>
    list(at(sample, 'data')['items']).map((raw) => {
      const item = object(raw);
      const balance = item['balance_after_fen'];
      return {
        ledgerType: text(item['ledger_type']),
        subAccount: text(item['sub_account']),
        amount: integer(item['amount_fen']),
        balance: balance === null ? null : integer(balance),
        uniqKey: text(at(item, 'voucher')['uniq_key']),
      };
    }),
  );
}

function expectedSign(row: Row): number {
  if (reversal.test(row.uniqKey)) return 0;
  if (creditTypes.includes(row.ledgerType)) return 1;
  if (debitTypes.includes(row.ledgerType)) return -1;
  return legSigns[row.ledgerType]?.[row.subAccount] ?? 0;
}

it('[AC-CT-24zzc#24] 流水示例按用户视角记符号（至少一正一负），同一子户相邻两行余额与金额衔接，frozen 余额不为负', () => {
  const doc = contract();
  let positives = 0;
  let negatives = 0;
  let balanceChecks = 0;
  for (const rows of exampleRows(doc)) {
    for (const row of rows) {
      const sign = expectedSign(row);
      const label = `${row.ledgerType}/${row.subAccount} ${row.amount}`;
      if (sign > 0) {
        expect(row.amount, label).toBeGreaterThan(0);
        positives += 1;
      }
      if (sign < 0) {
        expect(row.amount, label).toBeLessThan(0);
        negatives += 1;
      }
    }
    for (const account of subAccounts) {
      // 列表按 booked_at 倒序：前一行较新。较新一行余额 = 较旧一行余额 + 较新一行金额。
      const chain = rows.filter((row) => row.subAccount === account);
      for (const [index, newer] of chain.entries()) {
        const older = chain[index + 1];
        if (older === undefined || newer.balance === null || older.balance === null) continue;
        expect(newer.balance, `${account} #${index}`).toBe(older.balance + newer.amount);
        balanceChecks += 1;
      }
    }
    // frozen 不为负（BR-FUND-13）：记账后与记账前（余额 − 金额）都 ≥ 0，存储符号的示例过不了。
    for (const row of rows.filter((entry) => entry.subAccount === 'frozen')) {
      if (row.balance === null) continue;
      expect(row.balance, `frozen ${row.amount}`).toBeGreaterThanOrEqual(0);
      expect(row.balance - row.amount, `frozen ${row.amount}`).toBeGreaterThanOrEqual(0);
      balanceChecks += 1;
    }
  }
  expect(positives, '示例里至少一条按类型应为正的流水').toBeGreaterThan(0);
  expect(negatives, '示例里至少一条按类型应为负的流水').toBeGreaterThan(0);
  expect(balanceChecks, '示例里至少一处可核的余额').toBeGreaterThan(0);
});
