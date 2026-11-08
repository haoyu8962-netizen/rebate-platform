// CT-24zzc 两个后台只读接口共有的约定：新枚举、登记、权限说明、错误码、响应头、禁止键与示例
// （任务书第 9 节第 1–5 项）。独立预期，不从契约生成；静态读 contracts，不连库、不 listen。
import { expect, it } from 'vitest';
import {
  accepts,
  at,
  check,
  compile,
  contract,
  expand,
  list,
  object,
  resolve,
  text,
  yaml,
} from '../admin-order-actions/kit.ts';
import { examples } from '../order-claims/kit.ts';
import {
  closedKeys,
  creditEntry,
  descriptionOf,
  entries,
  enumValues,
  envelopeKeys,
  envelopeOf,
  errorCodes,
  forbiddenKeys,
  ledgerPath,
  negativeSummary,
  operation,
  permissions,
  plainSummary,
  propertyNames,
  rawParams,
  routes,
  subAccounts,
  summaryPath,
} from './kit.ts';

it('[AC-CT-24zzc#1] contracts/enums/fund.yaml 新增枚举 ledger_sub_account，取值恰为 available、frozen', () => {
  expect(enumValues('ledger_sub_account').toSorted()).toEqual(subAccounts.toSorted());
});

it('[AC-CT-24zzc#2] 两个接口都登记为 GET：operationId、后台鉴权、无请求体与 step-up、错误码恰为 10001/10403/20001', () => {
  const doc = contract();
  const catalog = list(yaml('contracts/error-codes.yaml')['codes']);
  for (const [path, operationId] of routes) {
    const pathItem = at(doc, 'paths', path);
    // 只读：路径上只有 GET。
    for (const method of ['post', 'put', 'patch', 'delete'])
      expect(pathItem, `${path} ${method}`).not.toHaveProperty(method);
    const op = operation(doc, path);
    expect(op, path).toMatchObject({ operationId, 'x-auth': 'admin' });
    expect(op['security'], path).toEqual([{ adminBearerAuth: [] }]);
    expect(op, path).not.toHaveProperty('x-step-up');
    expect(op, path).not.toHaveProperty('requestBody');
    for (const key of ['x-signed', 'x-idempotent', 'x-min-version-gate'])
      expect([undefined, false], `${path} ${key}`).toContain(op[key]);
    const names = rawParams(doc, path).map((raw) => text(resolve(doc, raw)['name']).toLowerCase());
    for (const name of ['x-step-up-token', 'idempotency-key'])
      expect(names, path).not.toContain(name);
    const codes = list(op['x-error-codes']);
    expect(codes.toSorted(), path).toEqual(errorCodes.toSorted());
    for (const code of codes)
      expect(
        catalog.filter((entry) => at(entry)['code'] === code),
        String(code),
      ).toHaveLength(1);
  }
});

const either = /其一|任一|之一|either|any\s+one\s+of|one\s+of/i;
const noStepUp =
  /(无|不需要?|不设|没有|无需|不要求)\s*`?(step-up|二次验证)|no\s+`?step-up|without\s+`?step-up|not?\s+(require|need)s?\s+(a\s+)?`?step-up/i;

it('[AC-CT-24zzc#3] 描述写明权限点 fund.view 或 user.lookup 持其一即可、不需二次验证、缺权限 10403', () => {
  const doc = contract();
  for (const [path] of routes) {
    const desc = descriptionOf(doc, path);
    for (const point of permissions) expect(desc, `${path} ${point}`).toContain(point);
    expect(desc, path).toMatch(/Permission point/i);
    expect(desc, path).toMatch(either);
    expect(desc, path).toMatch(noStepUp);
    expect(desc, path).toContain('10403');
  }
});

it('[AC-CT-24zzc#4] 描述写明不含内部备注，两种权限同形同值；未知用户 20001', () => {
  const doc = contract();
  for (const [path] of routes) {
    const desc = descriptionOf(doc, path);
    expect(desc, path).toMatch(
      /不含[^。；;\n]{0,12}内部备注|(no|without|never|not)\b[^.;\n]{0,30}internal\s+(notes?|memos?|remarks?)/i,
    );
    expect(desc, path).toMatch(
      /同形同值|same\s+shape\s+and\s+(the\s+)?same\s+values?|identical\s+(in\s+)?shape\s+and\s+values?/i,
    );
    // 未知用户 20001：写在描述里或 user_id 参数的描述里。
    const userParam = rawParams(doc, path)
      .map((raw) => resolve(doc, raw))
      .filter((entry) => entry['name'] === 'user_id');
    expect(userParam, path).toHaveLength(1);
    const paramText = userParam[0]!['description'];
    expect(`${desc}\n${typeof paramText === 'string' ? paramText : ''}`, path).toContain('20001');
  }
});

it('[AC-CT-24zzc#5] 每个响应声明 X-Trace-Id；200 响应声明必填 Cache-Control: no-store', () => {
  const doc = contract();
  for (const [path] of routes) {
    const responses = at(operation(doc, path), 'responses');
    expect(Object.keys(responses), path).toContain('200');
    for (const [status, raw] of Object.entries(responses)) {
      const header = resolve(doc, at(resolve(doc, raw), 'headers', 'X-Trace-Id'));
      expect(header['required'], `${path} ${status}`).toBe(true);
    }
    const ok = resolve(doc, at(responses, '200'));
    const cache = resolve(doc, at(ok, 'headers', 'Cache-Control'));
    expect(cache['required'], path).toBe(true);
    const value = resolve(doc, at(cache, 'schema'));
    accepts(doc, value, ['no-store'], ['no-cache', 'private', '', null]);
  }
});

it('[AC-CT-24zzc#6] 两个接口的响应在任意层级都不含 memo / operator / note / reject_note / source_ref / created_by', () => {
  const doc = contract();
  for (const [path] of routes) {
    const names = propertyNames(expand(doc, envelopeOf(doc, path)));
    expect(names.length, path).toBeGreaterThan(0);
    expect(
      names.filter((name) => forbiddenKeys.includes(name)),
      path,
    ).toEqual([]);
  }
  // 两个成功信封最外层也封闭（类型恰为 object、不可为 null）。
  for (const [path] of routes) closedKeys(doc, envelopeOf(doc, path), envelopeKeys);
  // 封闭对象：最外层、data、items 元素、voucher、link、withdraw_block 各层加上禁止键都不过。
  const summary = compile(doc, envelopeOf(doc, summaryPath));
  const ledger = compile(doc, envelopeOf(doc, ledgerPath));
  const wrap = (data: unknown) => ({ code: 0, msg: '', data, trace_id: 'ct-24zzc-synthetic' });
  const pageData = (items: unknown[]) => ({ items, page: 1, page_size: 20, total: items.length });
  check(summary, wrap(negativeSummary), true);
  check(summary, wrap(plainSummary), true);
  check(ledger, wrap(pageData(entries)), true);
  for (const key of forbiddenKeys) {
    const extra = { [key]: 'x' };
    check(summary, { ...wrap(negativeSummary), ...extra }, false);
    check(summary, wrap({ ...negativeSummary, ...extra }), false);
    check(
      summary,
      wrap({ ...plainSummary, withdraw_block: { ...plainSummary.withdraw_block, ...extra } }),
      false,
    );
    const voucher = { ...creditEntry.voucher, ...extra };
    const link = { ...creditEntry.link, ...extra };
    check(ledger, { ...wrap(pageData(entries)), ...extra }, false);
    check(ledger, wrap({ ...pageData(entries), ...extra }), false);
    check(ledger, wrap(pageData([{ ...creditEntry, ...extra }])), false);
    check(ledger, wrap(pageData([{ ...creditEntry, voucher }])), false);
    check(ledger, wrap(pageData([{ ...creditEntry, link }])), false);
  }
});

it('[AC-CT-24zzc#7] 200 响应至少有一个示例，示例都过 schema', () => {
  const doc = contract();
  for (const [path] of routes) {
    const media = at(
      resolve(doc, at(operation(doc, path), 'responses', '200')),
      'content',
      'application/json',
    );
    const validate = compile(doc, envelopeOf(doc, path));
    const samples = examples(doc, media);
    for (const sample of samples) {
      check(validate, sample, true);
      expect(object(sample)['code'], path).toBe(0);
    }
  }
});
