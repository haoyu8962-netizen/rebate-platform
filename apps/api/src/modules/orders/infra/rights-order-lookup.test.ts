// B1-09c 源码旁单元测试：拼多多存储侧子单号 / 主单号带连字符（适配器把 order_sn 原样写进 sub_order_id）
// 时仍能定位。不连库：Kysely 用无连接驱动编译真实 SQL；假库按 SQL 语义模拟——语句里有
// replace("<列>", …) 分支时按去连字符后的存储值比较，否则按存储值原样比较。
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from 'kysely';
import { expect, it } from 'vitest';
import { findOrderForRights, normalizeOrderNo } from './rights-order-lookup.ts';

interface Stored {
  readonly sub_order_id: string;
  readonly parent_order_id: string | null;
}

function database(rows: readonly Stored[]) {
  const statements: CompiledQuery[] = [];
  class Driver extends DummyDriver {
    override acquireConnection(): Promise<DatabaseConnection> {
      return Promise.resolve({
        executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
          statements.push(query);
          const column = /"parent_order_id" = /.test(query.sql)
            ? 'parent_order_id'
            : 'sub_order_id';
          const stripping = query.sql.includes(`replace("${column}"`);
          const hits = rows.filter((row) => {
            const value = row[column];
            if (value === null) return false;
            const compared = stripping ? value.replaceAll('-', '') : value;
            return query.parameters.includes(compared) || query.parameters.includes(value);
          });
          return Promise.resolve({ rows: hits as unknown as R[] });
        },
        streamQuery() {
          throw new Error('unexpected stream query');
        },
      });
    }
  }
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new Driver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, statements };
}

const APP = 'rights_unit';

it.each([
  ['260101-123456789012345', '260101123456789012345'],
  ['260101-123456789012345', '260101-123456-789012345'],
  ['26-0101-1234', '2601011234'],
])(
  '[AC-B1-09c#21] 拼多多存储值 %s 带连字符，入参 %s 去连字符后仍定位到子订单',
  async (stored, platform_order_no) => {
    const row = { sub_order_id: stored, parent_order_id: null };
    const d = database([row]);
    const result = await findOrderForRights(d.db, {
      app_id: APP,
      platform: 'pdd',
      platform_order_no,
    });
    expect(result).toEqual({ kind: 'found', order: row });
    expect(d.statements).toHaveLength(1);
    expect(d.statements[0]!.sql).toContain('replace("sub_order_id", $');
    expect(d.statements[0]!.parameters).toContain(platform_order_no.replaceAll('-', ''));
    expect(d.statements[0]!.sql).not.toMatch(/\b(?:like|ilike|or)\b/i);
  },
);

it('[AC-B1-09c#25] 拼多多存储的主单号带连字符时，只给主单号报 sub_order_no_missing', async () => {
  const d = database([{ sub_order_id: 'child-1', parent_order_id: '260101-123456789012345' }]);
  const result = await findOrderForRights(d.db, {
    app_id: APP,
    platform: 'pdd',
    platform_order_no: '260101123456789012345',
  });
  expect(result).toEqual({ kind: 'sub_order_no_missing' });
  expect(d.statements).toHaveLength(2);
  expect(d.statements[1]!.sql).toContain('replace("parent_order_id", $');
});

it.each(['taobao', 'jd'] as const)(
  '[AC-B1-09c#22] %s 按存储值原样比较：不去连字符，带连字符的存储值只认原样入参',
  async (platform) => {
    expect(normalizeOrderNo(platform, '000123-456789012345678')).toBe('000123-456789012345678');
    const row = { sub_order_id: '000123-456789012345678', parent_order_id: null };
    const miss = database([row]);
    expect(
      await findOrderForRights(miss.db, {
        app_id: APP,
        platform,
        platform_order_no: '000123456789012345678',
      }),
    ).toEqual({ kind: 'not_found' });
    for (const statement of miss.statements) expect(statement.sql).not.toContain('replace(');
    const hit = database([row]);
    expect(
      await findOrderForRights(hit.db, {
        app_id: APP,
        platform,
        platform_order_no: '000123-456789012345678',
      }),
    ).toEqual({ kind: 'found', order: row });
  },
);

it('[AC-B1-09c#21] 拼多多规范化只去连字符，不改位置、不转 number', () => {
  expect(normalizeOrderNo('pdd', '260101-123456-789012345')).toBe('260101123456789012345');
  expect(normalizeOrderNo('pdd', '000123')).toBe('000123');
});

it.each(['taobao', 'jd', 'pdd'] as const)(
  '[AC-B1-09x-UNIT#7] %s 子单号精确分支经 order_keys 取 (order_id, attr_at)（一条语句、没有 or）；父单号探查带 is not null 走父单号等值',
  async (platform) => {
    const d = database([]);
    expect(
      await findOrderForRights(d.db, { app_id: APP, platform, platform_order_no: '880012340001' }),
    ).toEqual({ kind: 'not_found' });
    expect(d.statements).toHaveLength(2);
    const [sub, parent] = d.statements as [CompiledQuery, CompiledQuery];
    expect(sub.sql).toContain(
      '("order_id", "attr_at") in (select "k"."order_id", "k"."attr_at" from "app"."order_keys" as "k" where "k"."app_id" = $3 and "k"."platform" = $4 and "k"."sub_order_id" = $5)',
    );
    expect(sub.parameters.slice(0, 5)).toEqual([APP, platform, APP, platform, '880012340001']);
    for (const statement of d.statements) expect(statement.sql).not.toMatch(/\bor\b/i);
    expect(parent.sql).not.toContain('order_keys');
    expect(parent.sql).toContain('"parent_order_id" is not null and "parent_order_id" = $3');
  },
);
