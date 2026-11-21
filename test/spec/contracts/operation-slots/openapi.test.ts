// CT-27 · openapi：热词与关键词直达的后台增改接口、搜索框默认词字段（04 §6.3 `GET /v1/search/hot-words`
// 行 2026-11-20：后台补一个热词与直达的编辑页，读写仍是 `search.hot_words`、`search.keyword_routes` 两个配置项、
// 不另建表；直达目标保存时按 contracts/routes.json 校验，非法项整条拒绝（D10-419）；搜索框默认词随本接口或
// /v1/config 下发，以契约为准（01 F-PROD-16：未下发时用文案键 search.placeholder））。
// 路径、operationId、权限点 04 / 08 都没定：按语义找操作（路径或 operationId 含 hot-word / keyword），
// 权限点只要求是 specs/permissions.yaml 已登记的一个（见 notes）。新操作由 B1-36 实现，本单只登记为 planned。
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/planned-operations.gen.ts';
import {
  HOT_WORDS,
  KEYWORD_ROUTES,
  adminWritesAbout,
  compileOpenapi,
  defaultWordFields,
  isObj,
  object,
  openapi,
  permissionKeys,
  resolve,
  text,
  type Obj,
  type Operation,
} from './kit.ts';

function label({ method, path }: Operation): string {
  return `${method.toUpperCase()} ${path}`;
}

/** 后台写操作的共同形状：admin 鉴权、admin_token、权限点、请求体、错误码（04 §6.6、§11.2）。 */
function expectAdminWrite(doc: Obj, operation: Operation): void {
  const { op } = operation;
  const name = label(operation);
  expect(typeof op['operationId'], `${name} 有 operationId`).toBe('string');
  expect(op['x-auth'], `${name} x-auth`).toBe('admin');
  const security: unknown[] = Array.isArray(op['security']) ? op['security'] : [];
  expect(
    security.some((entry) => isObj(entry) && Object.hasOwn(entry, 'adminBearerAuth')),
    `${name} security 含 adminBearerAuth`,
  ).toBe(true);
  const codes = Array.isArray(op['x-error-codes']) ? op['x-error-codes'] : [];
  // 10001 令牌失效、10403 缺权限点、20001 校验不合（含直达目标不在 routes.json，整条拒绝）。
  expect(codes, `${name} x-error-codes`).toEqual(expect.arrayContaining([10001, 10403, 20001]));
  const body = resolve(doc, op['requestBody']);
  expect(body['required'], `${name} 请求体必填`).toBe(true);
  const content = object(body['content'], `${name} requestBody.content`);
  expect(Object.hasOwn(content, 'application/json'), `${name} 请求体是 JSON`).toBe(true);
  const description = text(op['description'], `${name} description`);
  const known = permissionKeys();
  const named = [...description.matchAll(/`([a-z_]+(?:\.[a-z_]+)+)`/g)]
    .map((m) => m[1])
    .filter((key): key is string => key !== undefined && known.includes(key));
  const message = `${name} 的 description 写明守卫它的权限点（specs/permissions.yaml 已登记）`;
  expect(named.length, message).toBeGreaterThan(0);
}

it('[AC-CT-27#13] 有热词（search.hot_words）的后台增改接口：admin 鉴权、写明权限点、请求体必填、错误码含 10001 / 10403 / 20001', () => {
  const doc = openapi();
  const ops = adminWritesAbout(doc, HOT_WORDS);
  expect(ops.map(label), '/admin/v1 下与热词相关的 POST / PUT / PATCH').not.toEqual([]);
  for (const operation of ops) expectAdminWrite(doc, operation);
});

it('[AC-CT-27#14] 有关键词直达（search.keyword_routes）的后台增改接口：同上，且写明直达目标保存时按 routes.json 校验', () => {
  const doc = openapi();
  const ops = adminWritesAbout(doc, KEYWORD_ROUTES);
  expect(ops.map(label), '/admin/v1 下与关键词直达相关的 POST / PUT / PATCH').not.toEqual([]);
  for (const operation of ops) {
    expectAdminWrite(doc, operation);
    // D10-419：直达目标保存时按 contracts/routes.json 校验，非法项整条拒绝（20001）。
    const description = text(operation.op['description']);
    expect(description, `${label(operation)} 写明按 routes.json 校验`).toContain('routes.json');
  }
});

it('[AC-CT-27#15] 新的热词与直达后台接口登记为 planned（由 B1-36 实现），并进了生成的 planned 清单；用户侧 getSearchHotWords 不变', () => {
  const doc = openapi();
  const ops = [...adminWritesAbout(doc, HOT_WORDS), ...adminWritesAbout(doc, KEYWORD_ROUTES)];
  expect(ops.map(label), '热词与直达的后台写操作').not.toEqual([]);
  for (const operation of ops) {
    const id = text(operation.op['operationId'], `${label(operation)}.operationId`);
    expect(operation.op['x-implementation'], `${id} x-implementation`).toBe('planned');
    expect(plannedOperations.has(id), `planned-operations.gen.ts 含 ${id}（重跑 codegen）`).toBe(
      true,
    );
  }
  const paths = object(doc['paths'], 'paths');
  const hot = object(object(paths['/v1/search/hot-words'], '/v1/search/hot-words')['get'], 'get');
  expect(hot['operationId']).toBe('getSearchHotWords');
  expect(hot['x-auth'], '用户侧热词照旧免登录').toBe('none');
  expect(plannedOperations.has('getSearchHotWords')).toBe(false);
});

it('[AC-CT-27#16] 用户侧有搜索框默认词字段（热词接口或 /v1/config 的响应里）：一段非空文字，可不下发', () => {
  // 01 F-PROD-16：默认词由服务端下发；未下发时客户端用文案键 search.placeholder，所以字段可缺或为 null，
  // 下发时是非空文字（空串等于没配，不该让输入框显示空白提示）。
  const doc = openapi();
  const fields = defaultWordFields(doc);
  expect(
    fields.map((f) => `${f.where}.${f.name}`),
    'getSearchHotWords / getConfig 响应里名字含 default 或 placeholder 的默认词字段',
  ).not.toEqual([]);
  for (const field of fields) {
    const where = `${field.where}.${field.name}`;
    const validate = compileOpenapi(doc, field.schema);
    expect(validate('洗衣液'), `${where} 收「洗衣液」`).toBe(true);
    expect(validate(''), `${where} 拒空串`).toBe(false);
    expect(validate(12), `${where} 拒数字`).toBe(false);
    expect(!field.required || validate(null), `${where} 可不下发（非必填或可为 null）`).toBe(true);
  }
});
