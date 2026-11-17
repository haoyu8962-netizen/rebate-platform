// CT-24zzm · ledger 导出任务的列表、下载与重试（规划/08 BR-ID-42：每次下载重新鉴权并现签
// min(5 分钟, 剩余时长) 的链接；下载与重试只限创建人；audit.view_all 只放宽列表；只有 failed 可重试；
// 04 §11.1：来源列表的读权限 fund.view 或 user.lookup 任一 + export，下载与重试时按创建人现有权限复查）。
// 任务都经 HTTP 创建、经真实 worker 入口生成：表在实现打开前不收 ledger，红必须是断言。
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { grant } from '../accounts/kit.ts';
import {
  DOWNLOAD,
  error,
  LIST,
  ok,
  RETRY,
  text,
  type Download,
  type Page,
  type View,
} from '../exports/kit.ts';
import {
  books,
  colleague,
  DENIED,
  EXPORT,
  exported,
  harness,
  LINK_TTL_MS,
  LOOKUP,
  openConsole,
  seedStory,
  setMaxRows,
  VIEW,
  type Console,
} from './kit.ts';

const h = harness(createTestDatabase, acquireTestRedis);

/** A done ledger task of the actor over a seeded member. */
async function doneTask(f: Console) {
  const story = await seedStory(books(h, f.appId));
  const { view, row } = await exported(f, { user_id: story.a.userId });
  expect(row).toMatchObject({ status: 'done', row_count: 6 });
  return view;
}

/** A failed ledger task of the actor: the member has more rows than admin.export.max_rows. */
async function failedTask(f: Console) {
  await setMaxRows(h, f.appId, 1);
  const story = await seedStory(books(h, f.appId));
  const { view, row } = await exported(f, { user_id: story.a.userId });
  expect(row.status).toBe('failed');
  return view;
}

it('[AC-CT-24zzm#20] 列表：本人的 ledger 任务带 resource=ledger，可按 resource=ledger 筛出，不带链接与对象键', async () => {
  const f = await openConsole(h, [EXPORT, VIEW]);
  const own = await doneTask(f);
  const users = await f.task({ resource: 'users' });
  const page = await ok<Page>(await f.list(), LIST, 'get');
  expect(page.items.map((item) => item.id).sort()).toEqual([own.id, users.public_id].sort());
  expect(page.items.find((item) => item.id === own.id)).toMatchObject({
    resource: 'ledger',
    masked: true,
    status: 'done',
    row_count: 6,
    created_by: f.actor.id,
  });
  const only = await ok<Page>(await f.list('?resource=ledger'), LIST, 'get');
  expect(only.items.map((item) => item.id)).toEqual([own.id]);
  expect(only.total).toBe(1);
  expect(text(page)).not.toMatch(/object_key|signature|\.csv\?/);
});

it.each([[[EXPORT, VIEW]], [[EXPORT, LOOKUP]]] as const)(
  '[AC-CT-24zzm#21] 创建人（持 %j）下载：现签 5 分钟链接、no-store、每次记 export_download（resource=ledger、masked=true）',
  async (points) => {
    const f = await openConsole(h, points);
    const view = await doneTask(f);
    const { store } = await f.entry();
    const before = await f.audits();
    const first = await f.download(view.id);
    const data = await ok<Download>(first, DOWNLOAD, 'get');
    expect(first.headers['cache-control']).toBe('no-store');
    expect(new Date(data.url_expires_at).getTime()).toBe(f.clock.now().getTime() + LINK_TTL_MS);
    expect(data.url).toContain(`/${f.appId}/${view.id}.csv?`);
    expect(store.verify(data.url, f.clock.now())).toBe(true);
    f.clock.advanceMs(60_000);
    const second = await ok<Download>(await f.download(view.id), DOWNLOAD, 'get');
    expect(second.url).not.toBe(data.url);
    const added = (await f.audits()).slice(before.length);
    expect(added).toEqual([
      expect.objectContaining({
        action: 'export_download',
        admin_id: f.actor.id,
        after: expect.objectContaining({ task_id: view.id, resource: 'ledger', masked: true }),
      }),
      expect.objectContaining({ action: 'export_download' }),
    ]);
    expect(text(added)).not.toContain(data.url);
    expect(f.sign).toHaveBeenCalledTimes(2);
  },
);

it('[AC-CT-24zzm#22] 下载按创建人现有权限复查来源：失去 fund.view 仍有 user.lookup 可下，两个都失去 → 20001 [id]，不签链接', async () => {
  const f = await openConsole(h, [EXPORT, VIEW, LOOKUP]);
  const view = await doneTask(f);
  await f.revoke(VIEW);
  await ok<Download>(await f.download(view.id), DOWNLOAD, 'get');
  expect(f.sign).toHaveBeenCalledTimes(1);
  await f.revoke(LOOKUP);
  const audits = await f.audits();
  await error(await f.download(view.id), 20001, { fields: ['id'] }, DOWNLOAD, 'get');
  expect(f.sign).toHaveBeenCalledTimes(1);
  expect(await f.audits()).toEqual(audits);
});

it('[AC-CT-24zzm#23] 创建人失去 export：下载 20001 [id]（另持 tax.export_full 也一样），不签链接', async () => {
  const f = await openConsole(h, [EXPORT, VIEW]);
  const view = await doneTask(f);
  await ok<Download>(await f.download(view.id), DOWNLOAD, 'get');
  await f.revoke(EXPORT);
  await grant(h, f.actor, f.actor, ['tax.export_full']);
  await error(await f.download(view.id), 20001, { fields: ['id'] }, DOWNLOAD, 'get');
  expect(f.sign).toHaveBeenCalledTimes(1);
});

it.each(['download', 'retry'] as const)(
  '[AC-CT-24zzm#24] audit.view_all 只放宽列表：能看见别人的 ledger 任务，%s 仍 20001 [id]',
  async (operation) => {
    const f = await openConsole(h, [EXPORT, VIEW, LOOKUP, 'audit.view_all']);
    const story = await seedStory(books(h, f.appId));
    const other = await colleague(h, f, [EXPORT, VIEW]);
    const theirs = await exported(f, { user_id: story.a.userId }, other.token);
    expect(theirs.row.status).toBe('done');
    const page = await ok<Page>(await f.list('?resource=ledger'), LIST, 'get');
    expect(page.items.map((item) => item.id)).toEqual([theirs.view.id]);
    expect(page.items[0]).toMatchObject({ created_by: other.who.id, resource: 'ledger' });
    const audits = await f.audits();
    if (operation === 'download') {
      await error(await f.download(theirs.view.id), 20001, { fields: ['id'] }, DOWNLOAD, 'get');
    } else {
      await error(await f.retry(theirs.view.id), 20001, { fields: ['id'] }, RETRY);
    }
    expect(f.sign).not.toHaveBeenCalled();
    expect(await f.audits()).toEqual(audits);
  },
);

it('[AC-CT-24zzm#25] 只有 failed 可重试：done 的 ledger 任务重试 30417 status=done', async () => {
  const f = await openConsole(h, [EXPORT, VIEW]);
  const view = await doneTask(f);
  await error(await f.retry(view.id), 30417, { status: 'done' }, RETRY);
});

it('[AC-CT-24zzm#26] 重试失败的 ledger 任务：不收 reason；来源权限按任一复查（只剩 user.lookup 可重试，都没有 10403）；重试入队并审计 export_retry', async () => {
  const f = await openConsole(h, [EXPORT, VIEW, LOOKUP]);
  const view = await failedTask(f);
  await error(await f.retry(view.id, { reason: '多余' }), 20001, { fields: ['reason'] }, RETRY);
  await f.revoke(VIEW);
  await f.revoke(LOOKUP);
  await error(await f.retry(view.id), 10403, DENIED, RETRY);
  await grant(h, f.actor, f.actor, [LOOKUP]);
  const before = f.send.mock.calls.length;
  const retried = await ok<View>(await f.retry(view.id, {}), RETRY);
  expect(retried).toMatchObject({
    id: view.id,
    resource: 'ledger',
    masked: true,
    status: 'pending',
    failure_reason: null,
  });
  const row = (await f.tasks()).find((task) => task.public_id === view.id)!;
  expect(f.send.mock.calls.slice(before).filter(([queue]) => queue === 'export')).toEqual([
    [
      'export',
      'generate',
      { appId: f.appId, taskId: row.id },
      expect.objectContaining({ trx: expect.anything() }),
    ],
  ]);
  const actions = (await f.audits()).map((audit) => audit.action);
  expect(actions.at(-1)).toBe('export_retry');
  expect(actions).not.toContain('export_unmasked');
  expect((await f.audits()).at(-1)).toMatchObject({
    after: expect.objectContaining({ task_id: view.id, resource: 'ledger', masked: true }),
  });
});
