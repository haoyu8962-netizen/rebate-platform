// CT-07g (FU-POOL-TAGS-NORMALIZE-SINGLE, D10-2034): one normalization of pool tags. catalog/index.ts
// exports it (normalizePoolTags, port type PoolTagsNormalizer); app.module hands it to content's
// home configuration save (PageConfigAdmin's fourth constructor argument), so content keeps no copy
// of its own. No new rule: the table below is the CT-07e / CT-07f expectation, row by row the
// rows of test/spec/catalog/pool-tags/normalize.test.ts whose answer is a list (or a value, sent as
// a one-item list) and SAME_AS_CATALOG of content/domain/pages/pool-source-tags.test.ts.
//
// Shared by the rule tests of this directory only: shapes and expectations are written out, never
// taken from the code under test.
import type { PoolTagsNormalizer } from '../../../../apps/api/src/modules/catalog/index.ts';
import {
  PageConfigAdmin,
  type PageActor,
  type PageConfigStore,
  type PageConfigTx,
  type PageRow,
  type PageSectionsCheck,
  type PageVersionView,
} from '../../../../apps/api/src/modules/content/application/page-config-admin.ts';
import { FixedClock, type Clock } from '../../../../apps/api/src/modules/platform/index.ts';
import { NBSP, TEN_TAGS, WIDE_SPACE } from '../pool-tags/model.ts';

const ASTRAL = '𠀀';

export interface TagsRow {
  readonly label: string;
  readonly input: readonly string[];
  readonly expected: readonly string[];
}

/** The one input/output table of the normalization (CT-07e / CT-07f, D10-2034). */
export const TABLE: readonly TagsRow[] = [
  { label: '空数组', input: [], expected: [] },
  {
    label: 'NFKC、去首尾空白、内部空白并一、丢空串、去重保序、大小写不折叠',
    input: ['  新品  ', 'ＡＢ', 'AB', 'ab', WIDE_SPACE, `618${WIDE_SPACE} ${NBSP}大促`, '新品'],
    expected: ['新品', 'AB', 'ab', '618 大促'],
  },
  { label: '去重保留第一次出现', input: ['乙', '甲', '乙', ' 甲 '], expected: ['乙', '甲'] },
  { label: 'NFKC 后相同的去重', input: ['①', '1'], expected: ['1'] },
  { label: '全是空白', input: ['   ', WIDE_SPACE, NBSP], expected: [] },
  { label: '一项空串', input: [''], expected: [] },
  { label: '一项只有空格', input: ['   '], expected: [] },
  { label: '一项只有全角空格', input: [WIDE_SPACE.repeat(2)], expected: [] },
  { label: '16 个增补平面码点', input: [ASTRAL.repeat(16)], expected: [ASTRAL.repeat(16)] },
  { label: '16 个汉字', input: ['中'.repeat(16)], expected: ['中'.repeat(16)] },
  {
    label: '去首尾空白后 16 个码点',
    input: [`  ${'中'.repeat(16)}  `],
    expected: ['中'.repeat(16)],
  },
  { label: 'NFKC 展开后 16 个码点', input: ['㍿'.repeat(4)], expected: ['株式会社'.repeat(4)] },
  { label: '10 项', input: TEN_TAGS, expected: TEN_TAGS },
  {
    label: '重复与空串去掉后 10 项',
    input: [...TEN_TAGS, ' 标签0 ', '  ', '标签9'],
    expected: TEN_TAGS,
  },
  { label: '单项 [甲]', input: ['甲'], expected: ['甲'] },
  { label: '单项 新品', input: ['新品'], expected: ['新品'] },
  { label: '单项  ＡＢ ', input: ['  ＡＢ '], expected: ['AB'] },
  { label: '单项 ab', input: ['ab'], expected: ['ab'] },
  {
    label: '单项内部两个全角空格',
    input: [`618${WIDE_SPACE}${WIDE_SPACE}大促`],
    expected: ['618 大促'],
  },
  { label: '单项 去首尾空白', input: [' 新品 '], expected: ['新品'] },
];

/** A pool id in the shape adminCreateProductPool stores (UUIDv7, lowercase). */
export const POOL_ID = '0199f107-cccc-7000-8000-00000000f007';

/** A product_pool data source; `tags` undefined leaves the key out. */
export function poolSource(tags?: readonly string[]): Record<string, unknown> {
  return {
    kind: 'product_pool',
    pool_id: POOL_ID,
    limit: 20,
    ...(tags === undefined ? {} : { tags: [...tags] }),
  };
}

/** A product_grid section of the home schema around a data source. */
export function gridSection(id: string, dataSource: unknown): Record<string, unknown> {
  return { id, type: 'product_grid', version: 1, data_source: dataSource };
}

/** A banner whose static data source carries a key named `tags`: not a product_pool data source. */
export function staticWithTags(id: string, tags: readonly string[]): Record<string, unknown> {
  return {
    id,
    type: 'banner',
    version: 1,
    data_source: { kind: 'static', tags: [...tags], items: [] },
  };
}

/** The tags of the data source of section `index`, as a saved list holds them. */
export function tagsAt(sections: unknown, index: number): unknown {
  if (!Array.isArray(sections)) return undefined;
  const section: unknown = sections[index];
  if (typeof section !== 'object' || section === null) return undefined;
  const source = (section as Record<string, unknown>)['data_source'];
  if (typeof source !== 'object' || source === null) return undefined;
  return (source as Record<string, unknown>)['tags'];
}

/** A normalizer that records every argument it is called with and answers with `answer`. */
export interface Recorded {
  readonly normalize: PoolTagsNormalizer;
  readonly calls: (readonly string[])[];
}

export function recording(answer: PoolTagsNormalizer): Recorded {
  const calls: (readonly string[])[] = [];
  return {
    calls,
    normalize: (input) => {
      calls.push([...input]);
      return answer(input);
    },
  };
}

/** PageConfigAdmin as wired by CT-07g: the normalizer is its fourth constructor argument. */
type PageConfigAdminWithTags = new (
  store: PageConfigStore,
  clock: Clock,
  check: PageSectionsCheck,
  normalizeTags: PoolTagsNormalizer,
) => PageConfigAdmin;

const ACTOR: PageActor = { appId: 'couli', adminId: 'admin-ct07g', ip: null };

/** What a save left behind: the sections inserted and the sections the save check was given. */
export interface Bench {
  /** One save of page `home` at expected_revision 0. */
  readonly save: (sections: readonly Record<string, unknown>[]) => Promise<PageVersionView>;
  readonly inserted: unknown[];
  readonly checked: unknown[];
}

/**
 * The home configuration's save over an in-memory store (one transaction, rolled back on a throw)
 * and a sections check that accepts anything and records what it was given; `normalizeTags` is
 * handed to PageConfigAdmin as app.module hands catalog's normalization.
 */
export function bench(normalizeTags: PoolTagsNormalizer): Bench {
  let page: PageRow | undefined;
  const inserted: unknown[] = [];
  const checked: unknown[] = [];
  const unused = (): Promise<never> => Promise.reject(new Error('kit: not used by a save'));
  const tx: PageConfigTx = {
    pages: unused,
    page: unused,
    versions: unused,
    version: async (_appId, key, version) => {
      const sections = inserted[version - 1];
      if (sections === undefined) return undefined;
      return {
        page_key: key,
        version,
        status: 'draft',
        render_count: 0,
        error_count: 0,
        publish_at: null,
        publisher: null,
        created_by: ACTOR.adminId,
        created_at: '2026-11-18T08:00:00.000Z',
        sections: sections as Record<string, unknown>[],
      };
    },
    unionHostBlock: async () => undefined,
    ensurePage: async () => {
      page ??= { currentVersion: null, grayVersion: null, grayPercent: 0, revision: 0, slot: null };
    },
    lock: async () => (page === undefined ? undefined : { ...page }),
    latestVersion: async () => (inserted.length === 0 ? null : inserted.length),
    versionRow: unused,
    insertVersion: async (input) => {
      inserted.push(input.sections);
    },
    setVersionStatus: unused,
    successor: unused,
    updatePage: async (_appId, _key, pointers, revision, _adminId, _at, slot) => {
      page = { ...pointers, revision, slot: slot === undefined ? (page?.slot ?? null) : slot };
    },
    audit: async () => undefined,
    enqueueScheduleDue: unused,
  };
  const store: PageConfigStore = {
    ...tx,
    async transaction(work) {
      const before = { page, inserted: inserted.length };
      try {
        return await work(tx);
      } catch (error) {
        page = before.page;
        inserted.length = before.inserted;
        throw error;
      }
    },
  };
  const check: PageSectionsCheck = (sections) => {
    checked.push(sections);
    return [];
  };
  const Admin = PageConfigAdmin as unknown as PageConfigAdminWithTags;
  const admin = new Admin(store, new FixedClock('2026-11-18T08:00:00.000Z'), check, normalizeTags);
  return {
    save: (sections) =>
      admin.save(ACTOR, 'home', { sections: [...sections], expected_revision: 0 }),
    inserted,
    checked,
  };
}

/** The answer of one save, settled: a refusal is handed to the assertions, never thrown before them. */
export type Outcome =
  | { readonly ok: true; readonly value: PageVersionView }
  | { readonly ok: false; readonly error: unknown };

export async function attempt(run: () => Promise<PageVersionView>): Promise<Outcome> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}
