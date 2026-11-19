import { expect, it } from 'vitest';
import type { AuditInput, Clock } from '../../platform/index.ts';
import {
  PageConfigAdmin,
  PageConflictError,
  PageFieldsError,
  PageNotFoundError,
  PageScheduleNotFoundError,
  type PageActor,
  type PageConfigStore,
  type PageConfigTx,
  type PageRow,
  type PageView,
} from './page-config-admin.ts';

interface Version {
  version: number;
  status: string;
  sections: unknown;
  publishAt: Date | null;
  publisher?: string | null;
}

class Clockwork implements Clock {
  ms = Date.UTC(2026, 9, 17, 2);
  now(): Date {
    return new Date(this.ms);
  }
}

function memory(switchValue: unknown = undefined) {
  let page: (PageRow & { updatedBy: string | null }) | undefined;
  let versions: Version[] = [];
  const audits: AuditInput[] = [];
  const changes: { version: number; from: string; event: string; to: string }[] = [];
  const enqueued: { key: string; delaySeconds: number }[] = [];
  let casMisses = 0;
  const view = (): PageView | undefined =>
    page === undefined || versions.length === 0
      ? undefined
      : {
          page_key: 'home',
          current_version: page.currentVersion,
          gray_version: page.grayVersion,
          gray_percent: page.grayPercent,
          revision: page.revision,
          latest_version: Math.max(...versions.map((v) => v.version)),
          updated_by: page.updatedBy,
          updated_at: null,
        };
  const find = (n: number) => versions.find((v) => v.version === n);
  const tx: PageConfigTx = {
    pages: () => Promise.reject(new Error('unused')),
    versions: () => Promise.reject(new Error('unused')),
    page: async () => view(),
    version: async (_a, key, n) => {
      const v = find(n);
      return v === undefined
        ? undefined
        : {
            page_key: key,
            version: v.version,
            status: v.status as 'draft',
            render_count: 0,
            error_count: 0,
            publish_at: v.publishAt?.toISOString() ?? null,
            publisher: null,
            created_by: 'ops',
            created_at: '2026-10-17T02:00:00.000Z',
            sections: v.sections as Record<string, unknown>[],
          };
    },
    unionHostBlock: async () => switchValue,
    ensurePage: async () => {
      page ??= {
        currentVersion: null,
        grayVersion: null,
        grayPercent: 0,
        revision: 0,
        updatedBy: null,
        slot: null,
      };
    },
    lock: async () => (page === undefined ? undefined : { ...page }),
    latestVersion: async () =>
      versions.length === 0 ? null : Math.max(...versions.map((v) => v.version)),
    versionRow: async (_a, _k, n) => find(n),
    insertVersion: async (input) => {
      versions.push({
        version: input.version,
        status: 'draft',
        sections: input.sections,
        publishAt: null,
      });
    },
    // Same CAS as the store: the row changes only while its status is still change.from.
    setVersionStatus: async (_a, _k, n, change, stamp) => {
      changes.push({ version: n, from: change.from, event: change.event, to: change.to });
      const row = find(n);
      if (row === undefined || row.status !== change.from || casMisses-- > 0) return false;
      Object.assign(
        row,
        { status: change.to },
        stamp === null ? {} : { publishAt: stamp.at, publisher: stamp.publisher },
      );
      return true;
    },
    successor: async (_a, _k, except) =>
      versions
        .filter((v) => v.status === 'published' && v.version !== except)
        .sort((a, b) => b.publishAt!.getTime() - a.publishAt!.getTime() || b.version - a.version)[0]
        ?.version,
    updatePage: async (_a, _k, p, revision, adminId, _at, slot) => {
      page = { ...p, revision, updatedBy: adminId, slot: slot === undefined ? page!.slot : slot };
    },
    audit: async (input) => {
      audits.push(input);
    },
    enqueueScheduleDue: async (_a, key, delaySeconds) => {
      enqueued.push({ key, delaySeconds });
    },
  };
  const store: PageConfigStore = {
    ...tx,
    // Rolls back on a throw, like the database transaction.
    async transaction(work) {
      const saved = {
        page,
        versions: versions.map((v) => ({ ...v })),
        audits: audits.length,
        enqueued: enqueued.length,
      };
      try {
        return await work(tx);
      } catch (error) {
        page = saved.page;
        versions = saved.versions;
        audits.length = saved.audits;
        enqueued.length = saved.enqueued;
        throw error;
      }
    },
  };
  return {
    store,
    audits,
    changes,
    enqueued,
    state: () => ({ page, versions }),
    /** The next `n` status CASes miss, as if another writer changed the row first. */
    missCas: (n: number) => {
      casMisses = n;
    },
  };
}

const ACTOR: PageActor = { appId: 'a1', adminId: 'admin-1', ip: null };
const ok = () => [] as string[];
// CT-07g: these saves carry no product_pool tags, so the injected normalization is never reached.
const noTags = (): never => {
  throw new Error('test: no product_pool tags in these saves');
};

function setup(
  check: (s: unknown, block: boolean) => readonly string[] = ok,
  switchValue?: unknown,
) {
  const clock = new Clockwork();
  const m = memory(switchValue);
  const admin = new PageConfigAdmin(m.store, clock, check, noTags);
  const save = (rev: number) => {
    clock.ms += 1000;
    return admin.save(ACTOR, 'home', { sections: [], expected_revision: rev });
  };
  const publish = (rev: number, version: number, gray_percent = 100) => {
    clock.ms += 1000;
    return admin.publish(ACTOR, 'home', { version, gray_percent, expected_revision: rev });
  };
  return { ...m, clock, admin, save, publish };
}

it('[AC-F1-09f] first save makes version 1 at revision 1 and audits page_version_create', async () => {
  const t = setup();
  expect(await t.save(0)).toMatchObject({ version: 1, status: 'draft' });
  expect(t.state().page).toMatchObject({ revision: 1, updatedBy: 'admin-1' });
  expect(t.audits).toHaveLength(1);
  expect(t.audits[0]).toMatchObject({
    action: 'page_version_create',
    before: { revision: 0, version: 1 },
    after: { revision: 1, version: 1, current_version: null },
  });
});

it('[AC-F1-09f] a stale first save is 20902 and leaves no page row', async () => {
  const t = setup();
  await expect(t.save(1)).rejects.toBeInstanceOf(PageConflictError);
  expect(t.state().page).toBeUndefined();
});

it('[AC-F1-09f] sections are checked with the switch value; anything but false blocks', async () => {
  const seen: boolean[] = [];
  for (const value of [undefined, true, 'false', 0, false]) {
    const t = setup((_s, block) => {
      seen.push(block);
      return [];
    }, value);
    await t.save(0);
  }
  expect(seen).toEqual([true, true, true, true, false]);
  const bad = setup(() => ['sections.0.id']);
  await expect(bad.save(0)).rejects.toEqual(new PageFieldsError(['sections.0.id']));
  expect(bad.state().page).toBeUndefined();
});

it('[AC-F1-09f] publish edges: first only 100, no publish while gray, only drafts', async () => {
  const t = setup();
  await t.save(0);
  await expect(t.publish(1, 1, 10)).rejects.toEqual(new PageFieldsError(['gray_percent']));
  expect(await t.publish(1, 1)).toMatchObject({ current_version: 1, revision: 2 });
  await expect(t.publish(2, 1)).rejects.toEqual(new PageFieldsError(['version']));
  await expect(t.publish(2, 9)).rejects.toEqual(new PageFieldsError(['version']));
  await t.save(2);
  expect(await t.publish(3, 2, 10)).toMatchObject({
    current_version: 1,
    gray_version: 2,
    gray_percent: 10,
  });
  await t.save(4);
  await expect(t.publish(5, 3)).rejects.toEqual(new PageFieldsError(['version']));
});

it('[AC-F1-09f] order: 30701 before 20902 before state checks', async () => {
  const t = setup();
  await expect(t.publish(0, 1)).rejects.toBeInstanceOf(PageNotFoundError);
  await t.save(0);
  await expect(t.publish(0, 99)).rejects.toBeInstanceOf(PageConflictError);
  await expect(
    t.admin.gray(ACTOR, 'home', { gray_percent: 50, expected_revision: 1 }),
  ).rejects.toEqual(new PageFieldsError(['gray_percent']));
});

it('[AC-F1-09f] gray 100 releases fully without touching the old full version', async () => {
  const t = setup();
  await t.save(0);
  await t.save(1);
  await t.publish(2, 1);
  await t.publish(3, 2, 10);
  expect(
    await t.admin.gray(ACTOR, 'home', { gray_percent: 50, expected_revision: 4 }),
  ).toMatchObject({ gray_percent: 50, gray_version: 2 });
  expect(
    await t.admin.gray(ACTOR, 'home', { gray_percent: 100, expected_revision: 5 }),
  ).toMatchObject({ current_version: 2, gray_version: null, gray_percent: 0, revision: 6 });
  expect(t.state().versions.map((v) => v.status)).toEqual(['published', 'published']);
  expect(t.audits.at(-1)).toMatchObject({ action: 'page_gray_update', after: { version: 2 } });
});

it('[AC-F1-09f] rollback goes back by publish_at, not by version number', async () => {
  const t = setup();
  await t.save(0);
  await t.save(1);
  await t.publish(2, 2);
  await t.publish(3, 1);
  await expect(
    t.admin.rollback(ACTOR, 'home', { version: 2, expected_revision: 4 }),
  ).rejects.toEqual(new PageFieldsError(['version']));
  expect(await t.admin.rollback(ACTOR, 'home', { version: 1, expected_revision: 4 })).toMatchObject(
    { current_version: 2, revision: 5 },
  );
  expect(t.state().versions.map((v) => v.status)).toEqual(['rolled_back', 'published']);
  await expect(
    t.admin.rollback(ACTOR, 'home', { version: 2, expected_revision: 5 }),
  ).rejects.toEqual(new PageFieldsError(['version']));
});

it('[AC-F1-09f] rollback of the gray version clears it; the full one is refused while gray', async () => {
  const t = setup();
  await t.save(0);
  await t.save(1);
  await t.publish(2, 1);
  await t.publish(3, 2, 25);
  await expect(
    t.admin.rollback(ACTOR, 'home', { version: 1, expected_revision: 4 }),
  ).rejects.toEqual(new PageFieldsError(['version']));
  expect(await t.admin.rollback(ACTOR, 'home', { version: 2, expected_revision: 4 })).toMatchObject(
    { current_version: 1, gray_version: null, gray_percent: 0 },
  );
  expect(t.audits.at(-1)).toMatchObject({
    action: 'page_rollback',
    before: { gray_version: 2, gray_percent: 25, version: 2 },
    after: { gray_version: null, version: 2 },
  });
});

it('[AC-F1-09f] reads: unknown page or version is 30701; list pages by page_size', async () => {
  const t = setup();
  await expect(t.admin.page('a1', 'home')).rejects.toBeInstanceOf(PageNotFoundError);
  await expect(t.admin.versions('a1', 'home')).rejects.toBeInstanceOf(PageNotFoundError);
  await t.save(0);
  await expect(t.admin.version('a1', 'home', 9)).rejects.toBeInstanceOf(PageNotFoundError);
  expect(await t.admin.version('a1', 'home', 1)).toMatchObject({ version: 1 });
});

it('[F1-09f 裁定13#4] publish and rollback change status only through the generated transition, by CAS', async () => {
  const t = setup();
  await t.save(0);
  await t.publish(1, 1);
  await t.save(2);
  await t.publish(3, 2, 10);
  t.clock.ms += 1000;
  await t.admin.rollback(ACTOR, 'home', { version: 2, expected_revision: 4 });
  expect(t.changes).toEqual([
    { version: 1, from: 'draft', event: 'PUBLISH', to: 'published' },
    { version: 2, from: 'draft', event: 'PUBLISH', to: 'published' },
    { version: 2, from: 'published', event: 'ROLLBACK', to: 'rolled_back' },
  ]);
});

it('[F1-09f 裁定13#5] a missed status CAS on publish is 20902 and changes nothing', async () => {
  const t = setup();
  await t.save(0);
  const before = JSON.stringify(t.state());
  t.missCas(1);
  await expect(t.publish(1, 1)).rejects.toBeInstanceOf(PageConflictError);
  expect(JSON.stringify(t.state())).toBe(before);
  expect(t.audits).toHaveLength(1);
});

it('[F1-09f 裁定13#6] a missed status CAS on rollback is 20902 and changes nothing', async () => {
  const t = setup();
  await t.save(0);
  await t.publish(1, 1);
  await t.save(2);
  await t.publish(3, 2, 10);
  const before = JSON.stringify(t.state());
  t.missCas(1);
  t.clock.ms += 1000;
  await expect(
    t.admin.rollback(ACTOR, 'home', { version: 2, expected_revision: 4 }),
  ).rejects.toBeInstanceOf(PageConflictError);
  expect(JSON.stringify(t.state())).toBe(before);
  expect(t.audits).toHaveLength(4);
});

const SECOND = 1000;
const DAY = 86_400_000;

async function withDraft() {
  const t = setup();
  await t.save(0);
  await t.publish(1, 1);
  await t.save(2);
  const schedule = (rev: number, at: number, version = 2, gray_percent = 100) =>
    t.admin.publish(ACTOR, 'home', {
      version,
      gray_percent,
      expected_revision: rev,
      publish_at: new Date(at).toISOString(),
    });
  return { ...t, schedule };
}

it('[AC-F1-09p#u1] scheduling writes the slot, audits it, enqueues the due job; version stays draft', async () => {
  const t = await withDraft();
  const at = t.clock.ms + 10 * SECOND + 1;
  expect(await t.schedule(3, at)).toMatchObject({ current_version: 1, revision: 4 });
  expect(t.state().page).toMatchObject({
    currentVersion: 1,
    revision: 4,
    slot: { version: 2, grayPercent: 100, at: new Date(at), by: 'admin-1' },
  });
  expect(t.state().versions[1]).toMatchObject({ status: 'draft', publishAt: null });
  expect(t.enqueued).toEqual([{ key: 'home', delaySeconds: 11 }]);
  expect(t.audits.at(-1)).toMatchObject({
    action: 'page_publish_schedule',
    before: { revision: 3, scheduled: null },
    after: {
      revision: 4,
      scheduled: { version: 2, gray_percent: 100, publish_at: new Date(at).toISOString() },
    },
  });
});

it('[AC-F1-09p#u2] publish_at must be in (now, now + 30 days]; version checks come first', async () => {
  const t = await withDraft();
  const now = t.clock.ms;
  for (const at of [now, now - 1, now + 30 * DAY + 1]) {
    await expect(t.schedule(3, at)).rejects.toEqual(new PageFieldsError(['publish_at']));
  }
  await expect(t.schedule(3, now, 1)).rejects.toEqual(new PageFieldsError(['version']));
  expect(t.enqueued).toEqual([]);
  expect(await t.schedule(3, now + 30 * DAY)).toMatchObject({ revision: 4 });
  expect(t.enqueued).toEqual([{ key: 'home', delaySeconds: 2_592_000 }]);
});

it('[AC-F1-09p#u3] a pending slot refuses any publish; CAS is checked first', async () => {
  const t = await withDraft();
  await t.schedule(3, t.clock.ms + 60 * SECOND);
  await expect(t.publish(3, 2)).rejects.toBeInstanceOf(PageConflictError);
  await expect(t.publish(4, 2)).rejects.toEqual(new PageFieldsError(['publish_at']));
  await expect(t.schedule(4, t.clock.ms + 90 * SECOND)).rejects.toEqual(
    new PageFieldsError(['publish_at']),
  );
});

it('[AC-F1-09p#u4] a due slot is applied before the CAS of the next write, by the scheduler at its time', async () => {
  const t = await withDraft();
  const at = t.clock.ms + 10 * SECOND;
  await t.schedule(3, at);
  t.clock.ms = at;
  await expect(t.save(4)).rejects.toBeInstanceOf(PageConflictError);
  expect(t.state().page).toMatchObject({ revision: 4, slot: { version: 2 } });
  await t.save(5);
  expect(t.state().page).toMatchObject({ currentVersion: 2, revision: 6, slot: null });
  expect(t.state().versions[1]).toMatchObject({
    status: 'published',
    publishAt: new Date(at),
    publisher: 'admin-1',
  });
  expect(t.changes.at(-1)).toEqual({
    version: 2,
    from: 'draft',
    event: 'PUBLISH',
    to: 'published',
  });
  // One audit row for the save; applying the slot writes none.
  expect(t.audits.map((a) => a.action).slice(-2)).toEqual([
    'page_publish_schedule',
    'page_version_create',
  ]);
});

it('[AC-F1-09p#u5] a gray slot keeps the full version and sets the gray pointer', async () => {
  const t = await withDraft();
  const at = t.clock.ms + 5 * SECOND;
  await t.schedule(3, at, 2, 10);
  t.clock.ms = at + SECOND;
  expect(
    await t.admin.gray(ACTOR, 'home', { gray_percent: 20, expected_revision: 5 }),
  ).toMatchObject({ current_version: 1, gray_version: 2, gray_percent: 20, revision: 6 });
});

it('[AC-F1-09p#u6] cancel clears the slot; none or a due one is 30701 after the CAS', async () => {
  const t = await withDraft();
  await expect(t.admin.cancelSchedule(ACTOR, 'home', 3)).rejects.toBeInstanceOf(
    PageScheduleNotFoundError,
  );
  const at = t.clock.ms + 10 * SECOND;
  await t.schedule(3, at);
  await expect(t.admin.cancelSchedule(ACTOR, 'home', 3)).rejects.toBeInstanceOf(PageConflictError);
  expect(await t.admin.cancelSchedule(ACTOR, 'home', 4)).toMatchObject({ revision: 5 });
  expect(t.state().page).toMatchObject({ revision: 5, slot: null, currentVersion: 1 });
  expect(t.audits.at(-1)).toMatchObject({
    action: 'page_schedule_cancel',
    before: { scheduled: { version: 2 } },
    after: { scheduled: null },
  });
  await t.schedule(5, at);
  t.clock.ms = at;
  await expect(t.admin.cancelSchedule(ACTOR, 'home', 7)).rejects.toBeInstanceOf(
    PageScheduleNotFoundError,
  );
  // The refusal rolled the applied slot back with it.
  expect(t.state().page).toMatchObject({ revision: 6, slot: { version: 2 } });
});

it('[AC-F1-09p#u7] a due slot whose version is no longer a draft throws and changes nothing', async () => {
  const t = await withDraft();
  const at = t.clock.ms + 10 * SECOND;
  await t.schedule(3, at);
  t.state().versions[1]!.status = 'published';
  const before = JSON.stringify(t.state());
  t.clock.ms = at;
  await expect(t.save(4)).rejects.toThrow('no longer a draft');
  expect(JSON.stringify(t.state())).toBe(before);
});
