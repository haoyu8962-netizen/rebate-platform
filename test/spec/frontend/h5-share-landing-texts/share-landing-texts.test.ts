// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  bodyText,
  BROWSER_UA,
  cardShown,
  failure,
  firstPageRequest,
  installApi,
  LINK_ID,
  ok,
  openLanding,
  resetLanding,
  settle,
  sharePage,
  text,
  type Answer,
  type CardFixture,
} from '../h5-share-landing/share-landing-kit.ts';

// F1-11c: the share page uses its own dictionary entries (contracts/texts.default.json, F1-11b):
// share_page.invalid for the invalid empty state and share_page.quote_time for a degraded quote,
// instead of the borrowed link_landing.invalid and earnings.as_of. Texts are read from the
// dictionary, never written here.

afterEach(resetLanding);

const SHARER_AUTH_INVALID = { reason: 'sharer_auth_invalid' } as const;

/** Default fixture quoted_at 2026-11-10T01:30:00Z is 09:30 in +08:00 (BR-PRICE-11). */
const QUOTED_CLOCK = '09:30';
/** BR-PRICE-11 quote time: `HH:mm`, or `MM-DD HH:mm` on another +08:00 day. */
const ANY_QUOTE_TIME = String.raw`(?:\d{2}-\d{2} )?\d{2}:\d{2}`;
/** The fixture's quote time in either BR-PRICE-11 form (the run date decides which one). */
const QUOTED_TIME = String.raw`(?:\d{2}-\d{2} )?${QUOTED_CLOCK}`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The dictionary sentence with `{time}` filled by a time matching `timePattern`. */
function sentencePattern(name: string, timePattern: string, anchored: boolean): RegExp {
  const body = text(name).split('{time}').map(escapeRegExp).join(timePattern);
  return new RegExp(anchored ? `^${body}$` : body);
}

/** Fixed words of a dictionary sentence around its `{time}` placeholder. */
function fixedFragments(name: string): string[] {
  return text(name)
    .split('{time}')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Trimmed text of every element on the page. */
function elementTexts(): string[] {
  return [...document.body.querySelectorAll('*')].map((node) => (node.textContent ?? '').trim());
}

/** Opens the page with one scripted answer and waits until it is no longer loading. */
async function openWith(answer: Answer): Promise<void> {
  const api = installApi({ page: () => answer });
  await openLanding(`/${LINK_ID}`, BROWSER_UA);
  await firstPageRequest(api);
  await settle();
  await vi.waitFor(() => {
    expect(bodyText()).not.toContain(text('state.loading'));
  });
}

/** The invalid empty state says exactly share_page.invalid, and not the borrowed sentence. */
async function expectShareInvalidSentence(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(bodyText().trim(), 'share_page.invalid').toBe(text('share_page.invalid'));
    },
    { timeout: 2000 },
  );
  expect(elementTexts(), 'link_landing.invalid').not.toContain(text('link_landing.invalid'));
}

/** Opens a successful share page whose card carries the given quote state. */
async function openCard(card: Partial<CardFixture>): Promise<void> {
  const api = installApi({ page: () => ok(sharePage({}, card)) });
  await openLanding(`/${LINK_ID}`, BROWSER_UA);
  await cardShown(api);
  await settle();
}

it.each([
  [30144, 404, undefined],
  [30102, 422, SHARER_AUTH_INVALID],
  [30111, 422, SHARER_AUTH_INVALID],
] as const)(
  '[AC-F1-11c-INVALID#1] %s 的失效空态文字等于字典 share_page.invalid 全文，不再用 link_landing.invalid',
  async (code, status, data) => {
    await openWith(failure(status, code, data));
    await expectShareInvalidSentence();
  },
);

it('[AC-F1-11c-INVALID#2] 地址里没有 link_id 时的失效空态同样是 share_page.invalid 全文', async () => {
  installApi({ page: () => ok(sharePage()) });
  await openLanding('/', BROWSER_UA);
  await settle();
  await expectShareInvalidSentence();
});

it.each([
  ['stale=true', { stale: true, age_sec: 2160 }],
  ['age_sec=301', { stale: false, age_sec: 301 }],
] as const)(
  '[AC-F1-11c-QUOTE#1] 报价降级（%s）时显示 share_page.quote_time 套入取价时间的整句，不再用 earnings.as_of',
  async (label, card) => {
    await openCard(card);
    const whole = sentencePattern('share_page.quote_time', QUOTED_TIME, true);
    expect(
      elementTexts().some((shown) => whole.test(shown)),
      `${label}: an element whose text is share_page.quote_time with ${QUOTED_CLOCK}`,
    ).toBe(true);
    for (const fragment of fixedFragments('earnings.as_of')) {
      expect(bodyText(), `${label}: earnings.as_of`).not.toContain(fragment);
    }
  },
);

it('[AC-F1-11c-QUOTE#2] 未降级（stale=false、age_sec=300）不显示取价句，越过阈值（301）才显示', async () => {
  const anyQuote = sentencePattern('share_page.quote_time', ANY_QUOTE_TIME, false);
  await openCard({ stale: false, age_sec: 300 });
  expect(bodyText(), 'no quote sentence at age_sec=300').not.toMatch(anyQuote);
  resetLanding();
  await openCard({ stale: false, age_sec: 301 });
  expect(bodyText(), 'quote sentence at age_sec=301').toMatch(anyQuote);
});
