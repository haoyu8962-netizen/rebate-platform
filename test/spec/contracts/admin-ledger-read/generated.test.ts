// CT-24zzc 契约改动后的生成物：contracts-ts 的枚举与路径类型、后台鉴权路由表、planned 与运行时 schema
// 一致（contracts/README 第 10、11 条）。只解析 AST 与 JSON 文本，不 import、不执行生成物。
import ts from 'typescript';
import { expect, it } from 'vitest';
import { contract, list, object } from '../admin-order-actions/kit.ts';
import {
  generated,
  initializer,
  namedInterface,
  property,
  source,
} from '../order-claims/source-kit.ts';
import { ledgerPath, operation, routes, subAccounts, summaryPath } from './kit.ts';

const platform = 'apps/api/src/modules/platform/';
const fastifyPaths = [
  [summaryPath, '/admin/v1/users/:user_id/fund-summary'],
  [ledgerPath, '/admin/v1/ledger'],
] as const;

// planned-operations.gen.ts 里 `plannedOperations = new Set([...])` 的字符串元素。
function plannedIds(): string[] {
  const value = initializer(
    'packages/contracts-ts/src/planned-operations.gen.ts',
    'plannedOperations',
  );
  expect(ts.isNewExpression(value)).toBe(true);
  const first = ts.isNewExpression(value) ? value.arguments?.[0] : undefined;
  expect(first !== undefined && ts.isArrayLiteralExpression(first)).toBe(true);
  if (first === undefined || !ts.isArrayLiteralExpression(first)) return [];
  return first.elements.map((element) => (ts.isStringLiteral(element) ? element.text : ''));
}

it('[AC-CT-24zzc#20] contracts-ts 的 enums.gen.ts 生成 ledger_sub_account = [available, frozen]', () => {
  const value = initializer('packages/contracts-ts/src/enums.gen.ts', 'ledger_sub_account');
  expect(ts.isArrayLiteralExpression(value)).toBe(true);
  const values = ts.isArrayLiteralExpression(value)
    ? value.elements.map((element) => (ts.isStringLiteral(element) ? element.text : null))
    : [];
  expect(values.toSorted()).toEqual(subAccounts.toSorted());
});

it('[AC-CT-24zzc#21] contracts-ts 的 openapi.gen.ts 生成两个路径的 GET 与 operation 类型、AdminUserFundSummary 与 AdminLedgerEntry', () => {
  const file = source('packages/contracts-ts/src/openapi.gen.ts');
  for (const [path, operationId] of routes) {
    const route = property(property(namedInterface(file, 'paths'), path), 'get');
    expect(route.questionToken, path).toBeUndefined();
    expect(route.type?.getText(file), path).toMatch(
      new RegExp(`^operations\\[["']${operationId}["']\\]$`),
    );
    const op = property(namedInterface(file, 'operations'), operationId);
    property(property(op, '200'), 'application/json');
  }
  const schemas = property(namedInterface(file, 'components'), 'schemas');
  for (const name of ['AdminUserFundSummary', 'AdminLedgerEntry']) property(schemas, name);
});

it('[AC-CT-24zzc#22] 后台鉴权路由表恰好各登记一次 GET（auth admin）；planned 与运行时 schema、planned 清单一致', () => {
  const doc = contract();
  const table = generated(platform + 'http/auth-routes.gen.ts', 'CONTRACT_AUTH_ROUTES');
  const authRoutes = list(table).map(object);
  for (const [, fastifyPath] of fastifyPaths) {
    const matches = authRoutes.filter((entry) => entry['path'] === fastifyPath);
    expect(matches, fastifyPath).toEqual([{ method: 'GET', path: fastifyPath, auth: 'admin' }]);
  }
  const schemas = object(
    generated(platform + 'validation/route-schemas.gen.ts', 'CONTRACT_ROUTE_SCHEMAS'),
  );
  const planned = plannedIds();
  // 不钉方向（D10-1079）：本单标 planned，实现单 B2-02u 去掉标记，两种状态都要与生成物一致。
  // planned → 不在运行时 schema 表、在 plannedOperations；未标 → 在运行时 schema 表、不在
  // plannedOperations。漏标 planned 由仓库级 [AC-CT-02a#1]（apps/api/src/contract.test.ts 的
  // operationId 与已注册路由双向检查）兜底。
  for (const [path, operationId] of routes) {
    const marker = operation(doc, path)['x-implementation'];
    expect([undefined, 'planned'], path).toContain(marker);
    if (marker === 'planned') {
      expect(schemas, operationId).not.toHaveProperty(operationId);
      expect(planned, operationId).toContain(operationId);
    } else {
      expect(schemas, operationId).toHaveProperty(operationId);
      expect(planned, operationId).not.toContain(operationId);
    }
  }
});
