import ts from 'typescript';
import { expect, it } from 'vitest';
import { scene_basis, user_basis } from '../../../../packages/contracts-ts/src/enums.gen.ts';
import { data, enumField } from '../admin-order-actions/kit.ts';
import { at, contract, list, read, text, yaml } from '../order-claims/kit.ts';
import { initializer, namedInterface, property, source } from '../order-claims/source-kit.ts';

// 规划/04 §2.3 与 BR-ATTR-08/09。link 表示按服务端登记的转链记录判定 buy_type。
const sceneBases = ['pid', 'param', 'link', 'fallback'];
const userBases = ['param', 'claim', 'admin'];
const orderPath = '/admin/v1/orders/{order_id}';
const generatedEnums = 'packages/contracts-ts/src/enums.gen.ts';

function activePidDescription(): string {
  const values = at(yaml('contracts/enums/admin.yaml'), 'enums', 'union_pid_status', 'values');
  return text(values['active']);
}

function expectAccountScopedUniqueness(description: string): void {
  const restrictions = description
    .split(/[；;。]/)
    .filter((clause) => /(?:至多|最多)\s*(?:有\s*)?[一1]\s*条/.test(clause));
  expect(restrictions, 'active 的唯一性说明').toHaveLength(1);
  const restriction = restrictions[0]?.replaceAll('`', '');
  expect(restriction).toMatch(
    /\bapp(?:_id)?\s*[×,，]\s*platform\s*[×,，]\s*(?:union_account_id|联盟账号)\s*[×,，]\s*pid_scene\b/,
  );
}

function expectGeneratedUnion(schemas: ts.Node, name: string, values: string[]): void {
  const type = property(schemas, name).type;
  const members = type && ts.isUnionTypeNode(type) ? type.types : [];
  const literals = members.flatMap((node) =>
    ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal) ? [node.literal.text] : [],
  );

  expect(literals, name).toHaveLength(members.length);
  expect(literals.toSorted(), name).toEqual(values.toSorted());
}

it('[AC-CT-01f#1] 交易枚举仅在场景依据的 param 与 fallback 之间加入 link', () => {
  const catalog = yaml('contracts/enums/trade.yaml');
  const values = at(catalog, 'enums', 'scene_basis', 'values');

  expect(Object.keys(values)).toEqual(sceneBases);
  expect(values['link']).toBe('服务端登记的转链记录');
  expect(at(catalog, 'enums', 'user_basis', 'values')).toEqual({
    param: '推广参数',
    claim: '找回',
    admin: '管理员',
  });
});

it('[AC-CT-01f#2] OpenAPI 仅在 AdminOrderSceneBasis 加入 link', () => {
  const schemas = at(contract(), 'components', 'schemas');
  const expected = {
    AdminOrderSceneBasis: sceneBases,
    AdminOrderBuyType: ['self', 'share'],
    AdminOrderUserBasis: userBases,
  };

  for (const [name, values] of Object.entries(expected)) {
    const schema = at(schemas, name);
    expect(schema['type'], name).toBe('string');
    expect(list(schema['enum']).toSorted(), name).toEqual(values.toSorted());
  }
});

it('[AC-CT-01f#3] 后台订单详情区分场景依据和用户依据，两个字段均接受 null', () => {
  const doc = contract();
  const detail = data(doc, orderPath, 'get');

  enumField(doc, detail, 'scene_basis', sceneBases, true);
  enumField(doc, detail, 'user_basis', userBases, true);
});

it('[AC-CT-01f#4] contracts-ts 的枚举数组与后台订单类型仅在场景依据包含 link', () => {
  const file = source('packages/contracts-ts/src/openapi.gen.ts');
  const schemas = property(namedInterface(file, 'components'), 'schemas');

  expectGeneratedUnion(schemas, 'AdminOrderSceneBasis', sceneBases);
  expectGeneratedUnion(schemas, 'AdminOrderUserBasis', userBases);
  expect(scene_basis).toEqual(sceneBases);
  expect(user_basis.toSorted()).toEqual(userBases.toSorted());
});

it('[AC-CT-01f#5] active 推广位按 App、平台、联盟账号和推广位场景联合限定唯一', () => {
  expectAccountScopedUniqueness(activePidDescription());
});

it('[AC-CT-01f#6] 生成枚举中的 active 说明同步联盟账号维度', () => {
  const activeLine = initializer(generatedEnums, 'union_pid_status')
    .getText()
    .split('\n')
    .find((line) => /^\s*["']active["']\s*,/.test(line));
  const description = activeLine?.split('//')[1]?.trim() ?? '';

  expectAccountScopedUniqueness(description);
  expect(description).toBe(activePidDescription().replaceAll('\n', ' '));
});

it('[AC-CT-01f#7] 后台订单详情和返回详情的写操作登记 link 响应枚举扩展', () => {
  const accepted = read('contracts/oasdiff-accepted.txt')
    .split(/\r?\n/)
    .filter((line) => line.endsWith(' response property for the response status `200`'));
  const operations = [
    `GET ${orderPath}`,
    `POST ${orderPath}/hold`,
    `POST ${orderPath}/unhold`,
    `POST ${orderPath}/reason-sub`,
    `POST ${orderPath}/reassign`,
  ];

  for (const operation of operations) {
    expect(accepted, operation).toContainEqual(
      expect.stringContaining(
        operation + ' added the new `link` enum value to the `data/scene_basis',
      ),
    );
  }
});
