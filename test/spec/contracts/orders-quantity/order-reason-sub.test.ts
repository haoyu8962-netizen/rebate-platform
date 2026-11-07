import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// AC-CT-24zx#n 是 CT-24zx（D10-850 ①，裁定 D10-910）验收点的本地分组，不新增业务 AC / BR。
// 依据：08 BR-TEXT-05 子原因 reason_sub（编码取 enum order_reason_sub，App 显示「{title}：{sub.desc}」）；
// contracts/README 第 8 条（已有 /v1 结构只许新增可选字段）。
// 只静态读取契约；不调用接口、不执行生成代码、不读取数据库。
type Obj = Record<string, unknown>;
const root = new URL('../../../../', import.meta.url);
const apiRequire = createRequire(new URL('apps/api/package.json', root));
const { parse } = apiRequire('@readme/openapi-parser') as {
  parse(path: string): Promise<unknown>;
};

const SUB_REF = '#/components/schemas/OrderReasonSub';

function object(value: unknown): Obj {
  expect(value).not.toBeNull();
  expect(typeof value).toBe('object');
  expect(Array.isArray(value)).toBe(false);
  return value as Obj;
}

function at(value: unknown, ...keys: string[]): Obj {
  let current = object(value);
  for (const key of keys) {
    expect(current, `缺少 ${keys.join('.')}`).toHaveProperty([key]);
    current = object(current[key]);
  }
  return current;
}

function okResponse(doc: unknown, path: string): Obj {
  return at(doc, 'paths', path, 'get', 'responses', '200', 'content', 'application/json');
}

it('[AC-CT-24zx#1] OrderSummary（listOrders）与 OrderDetail（getOrder）都有可选可空的 reason_sub：不进 required，anyOf 为 $ref OrderReasonSub 与 null，示例取值合法', async () => {
  const doc = await parse(fileURLToPath(new URL('contracts/openapi.yaml', root)));
  const schemas = at(doc, 'components', 'schemas');

  // 编码取 order_reason_sub：被引用的 OrderReasonSub 是字符串枚举（CT-24zw 已在主干）。
  const sub = at(schemas, 'OrderReasonSub');
  expect(sub['type']).toBe('string');
  expect(Array.isArray(sub['enum'])).toBe(true);
  const allowed = sub['enum'] as unknown[];
  expect(allowed.length).toBeGreaterThan(0);

  // 两个用户侧接口确实落在这两个 schema 上。
  const listOp = at(doc, 'paths', '/v1/orders', 'get');
  expect(listOp['operationId']).toBe('listOrders');
  expect(at(okResponse(doc, '/v1/orders'), 'schema')['$ref']).toBe(
    '#/components/schemas/OrderListResponse',
  );
  expect(at(schemas, 'OrderListResponse', 'properties', 'data')['$ref']).toBe(
    '#/components/schemas/OrderListData',
  );
  expect(at(schemas, 'OrderListData', 'properties', 'items', 'items')['$ref']).toBe(
    '#/components/schemas/OrderSummary',
  );
  const detailOp = at(doc, 'paths', '/v1/orders/{order_id}', 'get');
  expect(detailOp['operationId']).toBe('getOrder');
  expect(at(okResponse(doc, '/v1/orders/{order_id}'), 'schema')['$ref']).toBe(
    '#/components/schemas/OrderDetailResponse',
  );
  expect(at(schemas, 'OrderDetailResponse', 'properties', 'data')['$ref']).toBe(
    '#/components/schemas/OrderDetail',
  );

  for (const name of ['OrderSummary', 'OrderDetail']) {
    const schema = at(schemas, name);
    const properties = at(schema, 'properties');
    expect(properties, `${name} 缺少 reason_sub`).toHaveProperty(['reason_sub']);
    const field = at(properties, 'reason_sub');

    // 可空：anyOf 恰为两支，一支 $ref OrderReasonSub，一支 type null（顺序不限）。
    expect(Array.isArray(field['anyOf']), `${name}.reason_sub 必须用 anyOf`).toBe(true);
    const branches = (field['anyOf'] as unknown[]).map(object);
    expect(branches).toHaveLength(2);
    expect(branches).toContainEqual({ $ref: SUB_REF });
    expect(branches).toContainEqual({ type: 'null' });
    // 不在字段上另加类型、枚举或默认值来放宽或改写这两支。
    for (const key of ['type', 'enum', 'const', 'default', 'oneOf', 'allOf', '$ref']) {
      expect(field, `${name}.reason_sub 不应带 ${key}`).not.toHaveProperty([key]);
    }
    // 契约给字段写了说明（只读、父编码限定等写在文字里）。
    expect(typeof field['description']).toBe('string');
    expect((field['description'] as string).trim().length).toBeGreaterThan(0);
    // 描述钉住展示规则（子串取契约原文；先把连续空白规范成一个空格，抗换行）。
    const text = (field['description'] as string).replace(/\s+/g, ' ');
    // ① 有值：显示「{父标题}：{子原因说明}」，子原因说明代替父说明。
    expect(text, `${name}.reason_sub 描述缺有值时的显示格式`).toContain(
      '{order_reason.<reason>.title}：{order_reason_sub.<value>.desc}',
    );
    expect(text, `${name}.reason_sub 描述缺「代替父说明」`).toContain(
      "replaces the parent reason's desc",
    );
    // ② null / 缺省：显示父编码的标题与说明。
    const parentShown = text.indexOf("shows the parent reason's title");
    expect(parentShown, `${name}.reason_sub 描述缺 null 时显示父标题`).toBeGreaterThanOrEqual(0);
    expect(
      text.indexOf('and desc', parentShown),
      `${name}.reason_sub 描述缺 null 时显示父说明`,
    ).toBeGreaterThan(parentShown);
    // ③ 只在父编码为 PUNISH / REFUND / RIGHTS 时可能有值。
    expect(text, `${name}.reason_sub 描述缺父编码限定`).toContain('PUNISH, REFUND or RIGHTS');

    // 可选：不进 required（contracts/README 第 8 条）；schema 仍是封闭对象。
    expect(Array.isArray(schema['required'])).toBe(true);
    expect(schema['required']).not.toContain('reason_sub');
    expect(schema['additionalProperties']).toBe(false);
  }

  // 200 示例里带了 reason_sub 的订单，取值只能是 null 或 OrderReasonSub 的枚举值（示例不带也行）。
  const listItems = at(okResponse(doc, '/v1/orders'), 'example', 'data')['items'];
  expect(Array.isArray(listItems)).toBe(true);
  const detailData = at(okResponse(doc, '/v1/orders/{order_id}'), 'example', 'data');
  const invalid = [...(listItems as unknown[]).map(object), detailData]
    .filter((item) => Object.hasOwn(item, 'reason_sub'))
    .map((item) => item['reason_sub'])
    .filter((value) => value !== null && !allowed.includes(value));
  expect(invalid).toEqual([]);
});
