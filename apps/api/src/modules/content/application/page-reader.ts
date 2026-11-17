// GET /v1/pages/{page_key} (task F1-09d; 规划/04 §6.2, §3.2; 08 BR-ID-11 细则「首页人群与灰度」;
// 03 §6.1). Reads the page pointer and the chosen version through per-process TTL caches keyed by
// (app_id, page_key[, version]) on the injected Clock; the version is picked and the sections are
// filtered on every request (F1-09b's pure functions), so nothing that depends on the caller is
// ever cached.
import type { Schema } from '@couli/contracts-ts';
import type { Clock } from '../../platform/index.ts';
import { CONTENT_CACHE_TTL_MS } from '../domain/cache-policy.ts';
import { effectivePage, slotOf } from '../domain/pages/schedule.ts';
import {
  neededAudienceFacts,
  passesVersionGate,
  pickPageVersion,
  selectSections,
  type AudienceFacts,
  type PagePointer,
  type PageViewer,
} from '../domain/pages/select/index.ts';
import { GUEST_AUDIENCE, UNKNOWN_AUDIENCE, type PageAudienceFacts } from './page-audience.ts';
import { TtlCache } from './ttl-cache.ts';

/** Server constant of the response's ttl_sec (03 §6.1 example; 编排者默认 R8, contract getPage). */
export const PAGE_TTL_SEC = 300;

const PUBLISHED = 'published';
const DRAFT = 'draft';

export interface PageVersion {
  readonly status: string;
  readonly sections: readonly Record<string, unknown>[];
}

export interface PageStore {
  pointer(appId: string, pageKey: string): Promise<PagePointer | null>;
  version(appId: string, pageKey: string, version: number): Promise<PageVersion | null>;
}

interface ServedVersion {
  readonly version: number;
  readonly sections: PageVersion['sections'];
}

function cacheKey(...parts: readonly (string | number)[]): string {
  return JSON.stringify(parts);
}

export class PageReader {
  readonly #store: PageStore | null;
  readonly #pointers: TtlCache<PagePointer | null>;
  readonly #versions: TtlCache<PageVersion | null>;
  readonly #audience: PageAudienceFacts | null;
  readonly #clock: Clock;

  /** `audience` null: a logged-in viewer's facts are unknown (only `any` matches them). */
  constructor(store: PageStore | null, clock: Clock, audience: PageAudienceFacts | null = null) {
    this.#store = store;
    this.#audience = audience;
    this.#clock = clock;
    this.#pointers = new TtlCache(clock, CONTENT_CACHE_TTL_MS);
    this.#versions = new TtlCache(clock, CONTENT_CACHE_TTL_MS);
  }

  /**
   * The page as served to this request, or null when it is not deliverable (no page row, no
   * pointer for this device, or the chosen version missing or not published; the caller answers
   * 30701). A device id that is null or empty gets the full version. Rejects without a database.
   * `userId` is the token's user (F1-09g): a guest's audience facts are all false; a logged-in
   * user's are read once per request, only when a section filters on them, and never cached.
   */
  async read(
    appId: string,
    pageKey: string,
    deviceId: string | null,
    viewer: PageViewer,
    userId: string | null = null,
  ): Promise<Schema<'Page'> | null> {
    const served = await this.#served(appId, pageKey, deviceId);
    if (served === null) return null;
    const audience = await this.#audienceOf(appId, userId, viewer, served.sections);
    return {
      page_key: pageKey,
      version: served.version,
      ttl_sec: PAGE_TTL_SEC,
      sections: selectSections(
        served.sections,
        audience === undefined ? viewer : { ...viewer, audience },
      ) as Record<string, unknown>[],
    };
  }

  /**
   * One section of the version `read` would serve this device (B1-05o, contract
   * listPageSectionItems), or null when the page is not deliverable, the version has no such
   * section, or its min_app_version filters it out. `condition` is not evaluated: the caller got
   * the section from getPage, which has evaluated it.
   */
  async section(
    appId: string,
    pageKey: string,
    sectionId: string,
    deviceId: string | null,
    viewer: Pick<PageViewer, 'platform' | 'appVersion'>,
  ): Promise<Record<string, unknown> | null> {
    const served = await this.#served(appId, pageKey, deviceId);
    const section = served?.sections.find((entry) => entry['id'] === sectionId);
    if (section === undefined) return null;
    return passesVersionGate(section, { ...viewer, loggedIn: false }) ? section : null;
  }

  /** The version served to this device with its stored sections; null when not deliverable. */
  async #served(
    appId: string,
    pageKey: string,
    deviceId: string | null,
  ): Promise<ServedVersion | null> {
    const store = this.#available();
    const pointer = await this.#pointers.get(cacheKey(appId, pageKey), () =>
      store.pointer(appId, pageKey),
    );
    if (pointer === null) return null;
    // F1-09p Y6: the cached row is the stored one; a due schedule is applied on every request with
    // the injected Clock, so it takes effect at its instant whether or not the due job has run.
    const page = effectivePage(
      {
        currentVersion: pointer.currentVersion,
        grayVersion: pointer.grayVersion,
        grayPercent: pointer.grayPercent,
        revision: 0,
        updatedBy: null,
        updatedAt: null,
        slot: slotOf({
          version: pointer.scheduledVersion,
          grayPercent: pointer.scheduledGrayPercent,
          at: pointer.scheduledAt,
          by: pointer.scheduledByAdminId,
        }),
      },
      this.#clock.now(),
    );
    const chosen = pickPageVersion({
      appId,
      deviceId: deviceId === '' ? null : deviceId,
      page: {
        currentVersion: page.currentVersion,
        grayVersion: page.grayVersion,
        grayPercent: page.grayPercent,
      },
    });
    if (chosen === null) return null;
    const dueVersion = page.applied === null ? null : page.applied.version;
    const key = cacheKey(appId, pageKey, chosen);
    const load = () => store.version(appId, pageKey, chosen);
    let version = await this.#versions.get(key, load);
    // F1-09p: a draft cached while a due schedule named it (before the job published it) is stale
    // once the pointer itself names the version: reload it once instead of serving nothing until
    // the version entry expires. Only a draft is reloaded; what may be served is unchanged.
    if (version !== null && version.status === DRAFT && dueVersion !== chosen) {
      this.#versions.forget(key);
      version = await this.#versions.get(key, load);
    }
    // Never fall back to another version: a pointer at a draft or rolled-back version serves none,
    // except the draft a due schedule names (published by time, the job may not have run yet).
    if (version === null || !Array.isArray(version.sections)) return null;
    const dueDraft = version.status === DRAFT && dueVersion === chosen;
    if (version.status !== PUBLISHED && !dueDraft) return null;
    return { version: chosen, sections: version.sections };
  }

  async #audienceOf(
    appId: string,
    userId: string | null,
    viewer: PageViewer,
    sections: readonly unknown[],
  ): Promise<AudienceFacts | undefined> {
    if (viewer.audience !== undefined) return viewer.audience;
    if (!viewer.loggedIn) return GUEST_AUDIENCE;
    if (userId === null) return undefined;
    const needed = neededAudienceFacts(sections);
    if (needed.size === 0) return undefined;
    if (this.#audience === null) return UNKNOWN_AUDIENCE;
    return this.#audience.facts(appId, userId, needed);
  }

  #available(): PageStore {
    if (this.#store === null) throw new Error('content: page reads need the database');
    return this.#store;
  }
}
