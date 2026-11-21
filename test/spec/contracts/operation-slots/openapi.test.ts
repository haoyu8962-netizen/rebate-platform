// CT-27 · openapi：热词与关键词直达的后台增改接口、搜索框默认词字段（04 §6.3 `GET /v1/search/hot-words`
// 行 2026-11-20：后台补一个热词与直达的编辑页，读写仍是 `search.hot_words`、`search.keyword_routes` 两个配置项、
// 不另建表；直达目标保存时按 contracts/routes.json 校验，非法项整条拒绝（D10-419）；搜索框默认词随本接口或
// /v1/config 下发，以契约为准（01 F-PROD-16：未下发时用文案键 search.placeholder））。
// 权限点：编排 D10-2383——这两个后台增改接口的权限点就是 `content.page`（不是 config.business，也不是任意
// 一个已登记权限点），不加二次验证（BR-TEXT-28 细则「权限与日志」）；直达目标受白名单约束（20001），契约
// 能表达的部分（外链只收 https）要钉住。
// 路径、operationId 04 / 08 没定：按语义找操作（路径或 operationId 含 hot-word / keyword）。请求体形状也没定：
// 从操作自己的请求示例里找到热词列表（[{text}]）/ 直达列表（[{keyword, target}]）所在的位置，在同一位置换上
// 本文件的合法与非法写入值，用该操作的请求 schema 判。新操作由 B1-36 实现，本单只登记为 planned。
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/planned-operations.gen.ts';
import {
  HOT_WORDS,
  KEYWORD_ROUTES,
  adminWritesAbout,
  compileOpenapi,
  defaultWordFields,
  describesSearchBoxDefault,
  findPaths,
  isObj,
  object,
  openapi,
  permissionKeys,
  requestExamples,
  requestSchema,
  resolve,
  response200Example,
  response200Schema,
  setAt,
  text,
  type Obj,
  type Operation,
  type Path,
} from './kit.ts';

function label({ method, path }: Operation): string {
  return `${method.toUpperCase()} ${path}`;
}

/** D10-2383：热词与直达后台增改接口的权限点。 */
const PERMISSION = 'content.page';

/** 后台写操作的共同形状：admin 鉴权、admin_token、权限点 content.page、不加二次验证、请求体、错误码。 */
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
  // 不加二次验证（BR-TEXT-28 细则「权限与日志」、D10-2383）：没有 10003，也不收 X-Step-Up-Token。
  expect(codes, `${name} 不要求二次验证（无 10003）`).not.toContain(10003);
  const params: unknown[] = Array.isArray(op['parameters']) ? op['parameters'] : [];
  const stepUp = params
    .map((p) => resolve(doc, p))
    .filter((p) => /step-?up/i.test(String(p['name'])));
  expect(
    stepUp.map((p) => p['name']),
    `${name} 不收二次验证令牌`,
  ).toEqual([]);
  const body = resolve(doc, op['requestBody']);
  expect(body['required'], `${name} 请求体必填`).toBe(true);
  const content = object(body['content'], `${name} requestBody.content`);
  expect(Object.hasOwn(content, 'application/json'), `${name} 请求体是 JSON`).toBe(true);
  // 权限点：description 里点名的已登记权限点恰为 content.page。
  const description = text(op['description'], `${name} description`);
  const known = permissionKeys();
  expect(known, 'specs/permissions.yaml 登记了 content.page').toContain(PERMISSION);
  const named = [
    ...new Set(
      [...description.matchAll(/`([a-z_]+(?:\.[a-z_]+)+)`/g)]
        .map((m) => m[1])
        .filter((key): key is string => key !== undefined && known.includes(key)),
    ),
  ];
  expect(named, `${name} 的 description 点名的权限点恰为 ${PERMISSION}`).toEqual([PERMISSION]);
}

it('[AC-CT-27#13] 有热词（search.hot_words）的后台增改接口：admin 鉴权、权限点 content.page、不加二次验证、请求体必填、错误码含 10001 / 10403 / 20001', () => {
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

it('[AC-CT-27#16] 用户侧有搜索框默认词字段（热词接口或 /v1/config 的搜索语境里）：说明写明是搜索框默认词；完整响应配了「洗衣液」与没配置都合契约；空串、数字拒收', () => {
  // 01 F-PROD-16：默认词由服务端下发；未下发时客户端用文案键 search.placeholder，所以字段可缺或为 null，
  // 下发时是非空文字（空串等于没配，不该让输入框显示空白提示）。名字像、语义不对的字段（如默认语言
  // default_locale）不算：候选只在搜索语境里找，且字段说明必须写明「搜索（输入）框的默认词 / 占位文字」。
  const doc = openapi();
  const fields = defaultWordFields(doc).filter((f) => describesSearchBoxDefault(f.schema));
  expect(
    fields.map((f) => `${f.where}.${f.name}`),
    'getSearchHotWords.data / getConfig.data 的搜索语境里、说明写明搜索框默认词的字段',
  ).not.toEqual([]);
  for (const field of fields) {
    const where = `${field.where}.${field.name}`;
    const validate = compileOpenapi(doc, field.schema);
    expect(validate('洗衣液'), `${where} 收「洗衣液」`).toBe(true);
    expect(validate(''), `${where} 拒空串`).toBe(false);
    expect(validate(12), `${where} 拒数字`).toBe(false);
    expect(!field.required || validate(null), `${where} 可不下发（非必填或可为 null）`).toBe(true);

    // 完整响应：以该接口自己的 200 示例为底，配了「洗衣液」与没配置两种都合整份响应契约。
    const envelope = compileOpenapi(doc, response200Schema(doc, field.path, 'get'));
    const example = response200Example(doc, field.path, 'get');
    expect(envelope(example), `${field.path} 的 200 示例合契约`).toBe(true);
    const configured = setAt(example, field.bodyPath, '洗衣液');
    expect(envelope(configured), `${where}=「洗衣液」的完整响应`).toBe(true);
    const absent = setAt(example, field.bodyPath, field.required ? null : undefined);
    expect(envelope(absent), `${where} 没配置的完整响应`).toBe(true);
    expect(envelope(setAt(example, field.bodyPath, '')), `${where}=空串的完整响应`).toBe(false);
  }
});

// ---------------------------------------------------------------------------------------------
// 请求体：合法写入与非法形状

const HOT_KEY = 'search.hot_words';
const ROUTES_KEY = 'search.keyword_routes';
const WORD_21 = '一二三四五六七八九十一二三四五六七八九十一';

const isHotList = (node: unknown): boolean =>
  Array.isArray(node) &&
  node.length > 0 &&
  node.every((e) => isObj(e) && typeof e['text'] === 'string' && e['keyword'] === undefined);
const isRouteList = (node: unknown): boolean =>
  Array.isArray(node) &&
  node.length > 0 &&
  node.every((e) => isObj(e) && typeof e['keyword'] === 'string' && isObj(e['target']));

const GOOD_HOT: unknown[] = [
  [],
  [{ text: '洗衣液' }],
  [{ text: '洗衣液' }, { text: '蓝牙耳机' }],
  Array.from({ length: 10 }, (_, i) => ({ text: `热词${i}` })),
];
const BAD_HOT: unknown[] = [
  [{ text: '' }],
  [{ text: WORD_21 }],
  [{ word: '洗衣液' }],
  ['洗衣液'],
  [{ text: '洗衣液', extra: 1 }],
  [{ text: 12 }],
  { text: '洗衣液' },
  '洗衣液',
  Array.from({ length: 11 }, (_, i) => ({ text: `热词${i}` })),
];
const ROUTE_HOT_RANK = { keyword: '热销榜', target: { route: 'HotRankList', params: {} } };
const GOOD_ROUTES: unknown[] = [
  [],
  [ROUTE_HOT_RANK],
  [{ keyword: '签到', target: { route: 'Help', params: { article_id: 'sign_in_guide' } } }],
  [ROUTE_HOT_RANK, { keyword: '帮助', target: { route: 'Help' } }],
];
const BAD_ROUTES: unknown[] = [
  [{ ...ROUTE_HOT_RANK, keyword: '' }],
  [{ ...ROUTE_HOT_RANK, keyword: WORD_21 }],
  [{ keyword: '热销榜' }],
  [{ keyword: '热销榜', target: 'HotRankList' }],
  [{ keyword: '热销榜', target: { params: {} } }],
  [{ keyword: '热销榜', target: { route: '' } }],
  [{ ...ROUTE_HOT_RANK, extra: 1 }],
  // D10-2383：外链只收 https（契约能表达的白名单部分）。
  [{ keyword: '活动', target: { route: 'ExternalPage', params: { url: 'http://example.com/a' } } }],
  [{ keyword: '活动', target: { route: 'WebPage', params: { url: 'http://h5.example.com/t' } } }],
  [{ keyword: '活动', target: { route: 'WebPage', params: { url: 'javascript:alert(1)' } } }],
  { keyword: '热销榜', target: { route: 'HotRankList' } },
  Array.from({ length: 51 }, (_, i) => ({ ...ROUTE_HOT_RANK, keyword: `词${i}` })),
];

type Slot = { name: string; example: unknown; path: Path; validate: (body: unknown) => boolean };

/** 操作请求示例里热词 / 直达列表所在的位置（每个操作、每个示例、每个位置一条）。 */
function slots(doc: Obj, ops: Operation[], match: (node: unknown) => boolean): Slot[] {
  const out: Slot[] = [];
  for (const operation of ops) {
    const validate = compileOpenapi(doc, requestSchema(doc, operation.op));
    requestExamples(doc, operation.op).forEach((example, n) => {
      for (const path of findPaths(example, match)) {
        const name = `${label(operation)} 示例 #${n} @${path.join('.')}`;
        out.push({ name, example, path, validate });
      }
    });
  }
  return out;
}

function expectWrites(
  concept: RegExp,
  match: (node: unknown) => boolean,
  key: string,
  good: unknown[],
  bad: unknown[],
  other: unknown,
): void {
  const doc = openapi();
  const ops = adminWritesAbout(doc, concept);
  expect(ops.map(label), `/admin/v1 下与 ${key} 相关的写操作`).not.toEqual([]);
  const shared = new Set(
    [...adminWritesAbout(doc, HOT_WORDS), ...adminWritesAbout(doc, KEYWORD_ROUTES)]
      .map(label)
      .filter((name, i, all) => all.indexOf(name) !== i),
  );
  const found = slots(doc, ops, match);
  expect(
    found.map((s) => s.name),
    `${key} 写操作的请求示例里有该配置的列表（04 §6.3：读写仍是 ${key} 这个配置项）`,
  ).not.toEqual([]);
  for (const { name, example, path, validate } of found) {
    expect(validate(example), `${name}：示例本身合请求 schema`).toBe(true);
    if ([...shared].some((s) => name.startsWith(`${s} `))) {
      // 两个配置共用一个操作：样例必须标明写的是哪个配置项（写出配置键，或列表所在的属性就叫
      // hot_words / keyword_routes），且不能把另一项的值当成这一项提交。
      const tail = key.slice(key.indexOf('.') + 1);
      const identifies = JSON.stringify(example).includes(key) || path.includes(tail);
      expect(identifies, `${name}：共用操作的样例标明配置键 ${key}`).toBe(true);
      expect(validate(setAt(example, path, other)), `${name}：把另一项的值写进 ${key}`).toBe(false);
    }
    for (const value of good) {
      const body = setAt(example, path, value);
      expect(validate(body), `${name}：${key} 写 ${JSON.stringify(value)}`).toBe(true);
    }
    for (const value of bad) {
      const body = setAt(example, path, value);
      expect(validate(body), `${name}：${key} 写 ${JSON.stringify(value)}`).toBe(false);
    }
  }
}

it('[AC-CT-27#29] 热词后台写接口的请求体能提交 search.hot_words 的值：[{text}]（1–20 字、至多 10 个、可为空列表）通过，错形状、空文字、超长、多余键、超量都拒收', () => {
  // 04 §6.3：读写仍是 search.hot_words 这个配置项；值的形状同用户侧 SearchHotWord（text 1–20 字）、至多 10 个。
  expectWrites(HOT_WORDS, isHotList, HOT_KEY, GOOD_HOT, BAD_HOT, [ROUTE_HOT_RANK]);
});

it('[AC-CT-27#30] 关键词直达后台写接口的请求体能提交 search.keyword_routes 的值：[{keyword, target:{route, params}}] 通过；缺目标、目标不是 {route}、http 外链 / WebPage、超长、超量都拒收', () => {
  // 04 §6.3：读写仍是 search.keyword_routes；直达目标按 routes.json 校验，非法项整条拒绝（D10-419）；
  // D10-2383：目标受白名单约束，契约能表达的「外链只收 https」要钉住。
  expectWrites(KEYWORD_ROUTES, isRouteList, ROUTES_KEY, GOOD_ROUTES, BAD_ROUTES, [
    { text: '洗衣液' },
  ]);
});
