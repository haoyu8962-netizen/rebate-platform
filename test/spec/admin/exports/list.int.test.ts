import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { seed, grant } from '../accounts/kit.ts';
import { error, harness, LIST, ok, setup, text, type Page } from './kit.ts';

const h = harness(createTestDatabase, acquireTestRedis);

it('[AC-B1-34f#11] 默认只本人，audit.view_all 实时放宽；超管也仅本 app，不写审计或发链接', async () => {
  const f = await setup(h);
  const other = await seed(h, f.appId);
  const foreign = await seed(h, 'foreign_exports');
  const own = await f.task();
  const theirs = await f.task({ created_by: other.id });
  await f.task({ app_id: foreign.appId, created_by: foreign.id });
  const before = await f.audits();
  let page = await ok<Page>(await f.list(), LIST, 'get');
  expect(page).toMatchObject({ page: 1, page_size: 20, total: 1 });
  expect(page.items.map((row) => row.id)).toEqual([own.public_id]);
  await grant(h, f.actor, f.actor, ['audit.view_all']);
  page = await ok<Page>(await f.list(), LIST, 'get');
  expect(page.total).toBe(2);
  expect(page.items.map((row) => row.id).sort()).toEqual([own.public_id, theirs.public_id].sort());
  await f.revoke('audit.view_all');
  expect((await ok<Page>(await f.list(), LIST, 'get')).items.map((row) => row.id)).toEqual([
    own.public_id,
  ]);
  await h.db
    .updateTable('admin_users')
    .set({ is_super: true })
    .where('id', '=', f.actor.id)
    .execute();
  page = await ok<Page>(await f.list(), LIST, 'get');
  expect(page.total).toBe(2);
  expect(text(page)).not.toMatch(/object_key|url|signature|13812345678/);
  expect(f.sign).not.toHaveBeenCalled();
  expect(await f.audits()).toEqual(before);
});

it('[AC-B1-34f#12] 列表与创建人名称反映当前数据；只有 running 有 progress，done 库值 100 不泄露', async () => {
  const f = await setup(h);
  const states = ['pending', 'running', 'done', 'failed', 'expired', 'cancelled'] as const;
  for (const status of states) {
    await f.task({
      status,
      progress: status === 'done' ? 100 : 42,
      failure_reason: status === 'failed' ? '生成超时' : null,
    });
  }
  await h.db
    .updateTable('admin_users')
    .set({ display_name: '当前管理员' })
    .where('id', '=', f.actor.id)
    .execute();
  const page = await ok<Page>(await f.list(), LIST, 'get');
  expect(page.total).toBe(6);
  for (const status of states) {
    expect(page.items.find((row) => row.status === status)).toMatchObject({
      progress: status === 'running' ? 42 : null,
      created_by_name: '当前管理员',
      failure_reason: status === 'failed' ? '生成超时' : null,
    });
  }
});

it('[AC-B1-34f#13] 时间区间左闭右开，筛选 AND、倒序分页、同刻不重不漏', async () => {
  const f = await setup(h);
  const start = '2026-10-01T00:00:00.000Z';
  const end = '2026-10-02T00:00:00.000Z';
  const a = await f.task({ status: 'failed', resource: 'users', created_at: start });
  const b = await f.task({
    status: 'failed',
    resource: 'users',
    created_at: '2026-10-01T12:00:00Z',
  });
  const c = await f.task({
    status: 'failed',
    resource: 'users',
    created_at: '2026-10-01T12:00:00Z',
  });
  await f.task({ created_at: end });
  await f.task({ created_at: '2026-09-30T23:59:59.999Z' });
  await f.task({ created_at: start, status: 'pending' });
  await f.task({ created_at: start, resource: 'audit_logs' });
  const query = `?status=failed&resource=users&from=${start}&to=${end}&page_size=1`;
  const pages: Page[] = [];
  for (const page of [1, 2, 3, 4])
    pages.push(await ok<Page>(await f.list(`${query}&page=${page}`), LIST, 'get'));
  expect(pages.map((page) => page.total)).toEqual([3, 3, 3, 3]);
  expect(pages.map((page) => page.page)).toEqual([1, 2, 3, 4]);
  expect(pages.every((page) => page.page_size === 1)).toBe(true);
  expect(pages[3]!.items).toEqual([]);
  const ids = pages.flatMap((page) => page.items.map((row) => row.id));
  expect(ids.slice(0, 2).sort()).toEqual([b.public_id, c.public_id].sort());
  expect(ids[2]).toBe(a.public_id);
  const repeated = await ok<Page>(await f.list(`${query}&page=1`), LIST, 'get');
  expect(repeated.items).toEqual(pages[0]!.items);
});

it.each([
  ['?page_size=201', ['page_size']],
  ['?from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z', ['from', 'to']],
  ['?status=unknown', ['status']],
  ['?resource=not_a_resource', ['resource']],
] as const)('[AC-B1-34f#14] 列表拒绝非法筛选 %s', async (query, fields) => {
  const f = await setup(h);
  await error(await f.list(query), 20001, { fields }, LIST, 'get');
  expect(await f.audits()).toEqual([]);
});

it('[AC-B1-34f#15] audit.view_all 不代替 export 权限', async () => {
  const f = await setup(h, ['audit.view_all']);
  await error(await f.list(), 10403, { reason: 'admin_permission_denied' }, LIST, 'get');
  expect(await f.audits()).toEqual([]);
});
