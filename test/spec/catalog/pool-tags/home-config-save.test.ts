// CT-07e (D10-1777 ②): the console saves a page (adminCreatePageConfigVersion → PageConfigAdmin.save,
// with content's real save check of contracts/home-schema.json) whose product_pool data source has
// `tags`. The save normalizes them as pool items' tags are normalized (NFKC, trimmed, inner whitespace
// one space, blanks dropped) and keeps one of each duplicate in first-seen order, so the saved version
// carries the normalized list. A list that normalizes to nothing (all blanks) is refused with 20001
// pointing at that data source's tags and nothing is saved: dropping every item would silently turn
// "only items with these tags" into "no filter".
import { expect, it } from 'vitest';
import type { AuditInput } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  PageConfigAdmin,
  PageFieldsError,
  type PageActor,
  type PageConfigStore,
  type PageConfigTx,
  type PageRow,
  type PageVersionView,
} from '../../../../apps/api/src/modules/content/application/page-config-admin.ts';
import { createPageSectionsCheck } from '../../../../apps/api/src/modules/content/application/page-sections-check.ts';
import { homeSectionsSchema } from '../../../../apps/api/src/modules/content/infra/home-schema.ts';
import { NBSP, WIDE_SPACE, modelTags } from './model.ts';

const NOW = new Date('2026-11-16T02:00:00.000Z');
const ACTOR: PageActor = { appId: 'app_ct07e', adminId: 'admin_ct07e', ip: null };
const TAGS_OF_SOURCE = 'sections.0.data_source.tags';

function unused(): Promise<never> {
  return Promise.reject(new Error('unused'));
}

/** One page `home` with no saved version yet, in memory. */
function memory() {
  let page: PageRow | undefined;
  const inserted: { version: number; sections: unknown }[] = [];
  const audits: AuditInput[] = [];
  const tx: PageConfigTx = {
    pages: unused,
    versions: unused,
    page: unused,
    version: (_app, key, version) => {
      const row = inserted.find((entry) => entry.version === version);
      if (row === undefined) return Promise.resolve(undefined);
      const view: PageVersionView = {
        page_key: key,
        version: row.version,
        status: 'draft',
        render_count: 0,
        error_count: 0,
        publish_at: null,
        publisher: null,
        created_by: ACTOR.adminId,
        created_at: NOW.toISOString(),
        sections: row.sections as Record<string, unknown>[],
      };
      return Promise.resolve(view);
    },
    unionHostBlock: () => Promise.resolve(undefined),
    ensurePage: () => {
      page ??= { currentVersion: null, grayVersion: null, grayPercent: 0, revision: 0, slot: null };
      return Promise.resolve();
    },
    lock: () => Promise.resolve(page === undefined ? undefined : { ...page }),
    latestVersion: () =>
      Promise.resolve(
        inserted.length === 0 ? null : Math.max(...inserted.map((entry) => entry.version)),
      ),
    versionRow: unused,
    insertVersion: (input) => {
      inserted.push({ version: input.version, sections: structuredClone(input.sections) });
      return Promise.resolve();
    },
    setVersionStatus: unused,
    successor: unused,
    updatePage: (_app, _key, pointers, revision, _admin, _at, slot) => {
      page = { ...pointers, revision, slot: slot ?? null };
      return Promise.resolve();
    },
    audit: (input) => {
      audits.push(input);
      return Promise.resolve();
    },
    enqueueScheduleDue: unused,
  };
  const store: PageConfigStore = {
    pages: unused,
    page: unused,
    versions: unused,
    version: unused,
    transaction: (work) => work(tx),
  };
  const admin = new PageConfigAdmin(
    store,
    { now: () => NOW },
    createPageSectionsCheck(homeSectionsSchema()),
  );
  return { admin, inserted, audits, page: () => page };
}

/** Section 0 is a product_pool grid with these tags; section 1 a pool scroll without tags. */
function sections(tags: readonly string[]): Record<string, unknown>[] {
  return [
    {
      id: 'pool_tagged',
      type: 'product_grid',
      version: 1,
      props: { columns: 2 },
      data_source: { kind: 'product_pool', pool_id: 'pool_demo_daily', limit: 20, tags: [...tags] },
    },
    {
      id: 'pool_plain',
      type: 'product_scroll',
      version: 1,
      props: {},
      data_source: { kind: 'product_pool', pool_id: 'pool_demo_daily', limit: 10 },
    },
  ];
}

function save(admin: PageConfigAdmin, tags: readonly string[]) {
  return admin.save(ACTOR, 'home', { sections: sections(tags), expected_revision: 0 });
}

function savedTags(value: unknown): unknown {
  return (value as { data_source?: { tags?: unknown } }[])[0]?.data_source?.tags;
}

const DUPLICATED: readonly string[] = [
  '新品',
  ' 新品 ',
  'ＡＢ',
  'ab',
  'AB',
  '618  大促',
  `618${WIDE_SPACE}大促`,
];
const DEDUPED: readonly string[] = ['新品', 'AB', 'ab', '618 大促'];

it('[CT-07e][D10-1777] 首页配置 product_pool 的 tags 规范化后有重复：保存的版本只留一个（保序、大小写不折叠），其余字段与别的数据源原样', async () => {
  expect(modelTags(DUPLICATED)).toEqual(DEDUPED);
  const m = memory();

  const view = await save(m.admin, DUPLICATED);

  expect(m.inserted).toHaveLength(1);
  const stored = m.inserted[0]!.sections;
  expect(savedTags(stored)).toEqual(DEDUPED);
  expect(savedTags(view.sections)).toEqual(DEDUPED);
  const expected = sections(DEDUPED);
  expect(stored).toEqual(expected);
  expect(view.sections).toEqual(expected);
  expect(m.page()).toMatchObject({ revision: 1 });
});

it('[CT-07e][D10-1777] 首页配置 product_pool 的 tags 已是规范化后的值、无重复：原样保存', async () => {
  const m = memory();

  await save(m.admin, DEDUPED);

  expect(m.inserted.map((entry) => entry.sections)).toEqual([sections(DEDUPED)]);
});

it.each([
  { label: '半角空格与全角空格', tags: ['  ', WIDE_SPACE] },
  { label: '不换行空格', tags: [NBSP] },
  { label: '多个空白项', tags: [' ', `${WIDE_SPACE} ${NBSP}`] },
])(
  '[CT-07e][D10-1777] 首页配置 product_pool 的 tags 规范化后为空数组（$label）→ 20001 拒绝保存，data.fields 指向该数据源的 tags，什么都不写',
  async ({ tags }) => {
    expect(modelTags(tags)).toEqual([]);
    // The same save with tags that keep a value goes through, normalized.
    const ok = memory();
    await save(ok.admin, [' 新品 ', '新品']);
    expect(ok.inserted.map((entry) => savedTags(entry.sections))).toEqual([['新品']]);

    const m = memory();
    let error: unknown;
    try {
      await save(m.admin, tags);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(PageFieldsError);
    const fields = (error as PageFieldsError).fields;
    expect(fields.length, 'refused').toBeGreaterThan(0);
    for (const field of fields) expect(field.startsWith(TAGS_OF_SOURCE), field).toBe(true);
    expect(m.inserted).toEqual([]);
    expect(m.audits).toEqual([]);
  },
);
