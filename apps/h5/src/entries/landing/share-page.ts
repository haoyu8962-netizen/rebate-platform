// H5 share page (F1-11a, 规划/05 F1-11 first part) in plain DOM: the landing first screen does not
// depend on React (blocked B-6, default A). Download entry, download guide and domain checks are
// not part of this page (编排 D10-1225): no download link is ever rendered here.
import { formatYuan } from '@couli/money';
import { FOCUS_RING, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../components/base/styles.ts';
import { t } from '../../shared/texts.ts';
import {
  ShareApiError,
  type ShareApi,
  type SharedProductCard,
  type SharePageData,
} from './share-api.ts';
import { formatQuoteTime, isAllowedMedia, isWebUrl, isWeChat } from './share-format.ts';

export interface SharePageDeps {
  api: ShareApi;
  linkId: string | null;
  userAgent: string;
  mediaOrigins: readonly string[];
  now: () => number;
  clipboard: { writeText(value: string): Promise<void> };
}

const PAGE = 'mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-couli-4 p-couli-4';
const CENTERED =
  'flex min-h-dvh flex-col items-center justify-center gap-couli-3 p-couli-6 text-center';
const CARD =
  'flex flex-col gap-couli-3 rounded-couli-card bg-couli-background-surface p-couli-4 shadow-couli-card';
const SECONDARY_TEXT = 'text-couli-footnote leading-couli-footnote text-couli-text-secondary';
const ACTION =
  'inline-flex w-full items-center justify-center text-center no-underline disabled:cursor-default';

type El = HTMLElementTagNameMap;

function el<K extends keyof El>(doc: Document, tag: K, className: string, text?: string): El[K] {
  const node = doc.createElement(tag);
  if (className.length > 0) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Codes that end the page: no retry, no buying, no authorization prompt (BR-ATTR-05 细则). */
function isTransient(error: unknown): boolean {
  if (!(error instanceof ShareApiError)) return true;
  return error.status >= 500 || error.status === 429;
}

/** 20001 with data.fields containing `ticket`: the tpwd ticket is invalid, expired or used up. */
export function isTicketRejected(error: unknown): boolean {
  if (!(error instanceof ShareApiError) || error.code !== 20001) return false;
  const data = error.data;
  if (typeof data !== 'object' || data === null) return false;
  const fields = (data as { fields?: unknown }).fields;
  return Array.isArray(fields) && fields.includes('ticket');
}

/** Price shown on the card: coupon price when known, else the list price (BR-TEXT-10). */
function priceText(card: SharedProductCard): string | null {
  const fen = card.final_price_fen ?? card.price_fen;
  if (typeof fen !== 'number' || !Number.isSafeInteger(fen) || fen < 0) return null;
  return formatYuan(BigInt(fen));
}

/** Disclaimer keys are dictionary keys; only the ones this page knows are rendered. */
function disclaimerText(key: string): string {
  switch (key) {
    case 'price_basis':
      return t('price_basis');
    case 'price_basis.general':
      return t('price_basis.general');
    default:
      return '';
  }
}

/** BR-PRICE-11: the quote time is shown only for a degraded quote (stale or older than 300 s). */
function quoteLine(page: SharePageData, now: number): string | null {
  const card = page.product_card;
  const degraded = card.stale || (typeof card.age_sec === 'number' && card.age_sec > 300);
  if (!degraded || page.quoted_at === null) return null;
  const time = formatQuoteTime(page.quoted_at, now);
  // TODO(规划/11 §7.1): dedicated share-page quote key — blocked on content adding it to 08.
  return time === null ? null : t('earnings.as_of', { time });
}

export function mountSharePage(container: HTMLElement, deps: SharePageDeps): void {
  const doc = container.ownerDocument;
  const inWeChat = isWeChat(deps.userAgent);

  function show(...nodes: HTMLElement[]): void {
    container.replaceChildren(...nodes);
  }

  function showInvalid(): void {
    const main = el(doc, 'main', CENTERED);
    // TODO(规划/11 §7.1): share-page invalid sentence (error-codes 30102 action) — blocked on
    // content adding a key; link_landing.invalid is the closest existing text.
    main.append(el(doc, 'p', 'text-couli-body leading-couli-body', t('link_landing.invalid')));
    show(main);
  }

  function showLoading(): void {
    const main = el(doc, 'main', CENTERED);
    main.setAttribute('aria-busy', 'true');
    main.append(el(doc, 'p', SECONDARY_TEXT, t('state.loading')));
    show(main);
  }

  function showRetry(): void {
    const main = el(doc, 'main', CENTERED);
    main.append(
      el(
        doc,
        'p',
        'text-couli-body leading-couli-body font-couli-semibold',
        t('state.load_failed.title'),
      ),
      el(doc, 'p', SECONDARY_TEXT, t('state.load_failed.desc')),
    );
    const retry = el(doc, 'button', `${SECONDARY_BUTTON} ${FOCUS_RING}`, t('state.retry'));
    retry.type = 'button';
    retry.addEventListener('click', () => void load());
    main.append(retry);
    show(main);
  }

  /**
   * Exchanges the ticket for the token. A rejected ticket (it lives 600 s) is renewed once through
   * getSharePage and the exchange retried once; any further failure is the caller's to show.
   */
  async function exchangeTicket(
    api: ShareApi,
    linkId: string,
    ticket: string,
    renew: (fresh: string) => void,
  ): Promise<string> {
    try {
      return await api.getShareTpwd(linkId, ticket);
    } catch (error) {
      if (!isTicketRejected(error)) throw error;
    }
    const fresh = (await api.getSharePage(linkId)).tpwd_ticket;
    if (fresh === null || fresh.length === 0) throw new Error('share page gave no new ticket');
    renew(fresh);
    return api.getShareTpwd(linkId, fresh);
  }

  function copyTokenBlock(api: ShareApi, linkId: string, firstTicket: string): HTMLElement {
    const block = el(doc, 'div', 'flex flex-col gap-couli-2');
    const button = el(doc, 'button', `${SECONDARY_BUTTON} ${ACTION}`, t('share_page.copy_tpwd'));
    button.type = 'button';
    const status = el(doc, 'p', `${SECONDARY_TEXT} text-center`);
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    // The token is fetched only on tap, then kept in memory so later taps do not spend the
    // ticket's limited exchanges (BR-ATTR-10 细则).
    let token: string | null = null;
    let ticket = firstTicket;
    button.addEventListener('click', () => {
      if (button.disabled) return;
      button.disabled = true;
      status.replaceChildren();
      void (async () => {
        try {
          token ??= await exchangeTicket(api, linkId, ticket, (fresh) => {
            ticket = fresh;
          });
        } catch {
          status.textContent = t('state.load_failed.desc');
          button.disabled = false;
          return;
        }
        const value = token;
        let copied: boolean;
        try {
          await deps.clipboard.writeText(value);
          copied = true;
        } catch {
          copied = false;
        }
        if (copied) {
          status.textContent = t('share_page.copy_tpwd.done');
        } else {
          // Clipboard refused: show the token for manual copying.
          const manual = el(
            doc,
            'output',
            'block select-all break-all text-couli-body leading-couli-body text-couli-text-primary',
            value,
          );
          status.replaceChildren(manual);
        }
        button.disabled = false;
      })();
    });
    block.append(button, status);
    return block;
  }

  function showPage(api: ShareApi, linkId: string, page: SharePageData): void {
    const card = page.product_card;
    const main = el(doc, 'main', PAGE);

    const article = el(doc, 'article', CARD);
    if (isAllowedMedia(card.image, deps.mediaOrigins)) {
      const image = el(doc, 'img', 'aspect-square w-full rounded-couli-card object-cover');
      image.src = card.image;
      image.alt = '';
      image.decoding = 'async';
      article.append(image);
    }
    if (card.title !== null) {
      article.append(
        el(
          doc,
          'h1',
          'text-couli-headline leading-couli-headline font-couli-semibold text-couli-text-primary',
          card.title,
        ),
      );
    }
    if (card.shop_name !== null && card.shop_name !== undefined) {
      article.append(el(doc, 'p', SECONDARY_TEXT, card.shop_name));
    }
    const price = priceText(card);
    if (price !== null) {
      article.append(
        el(
          doc,
          'p',
          'text-couli-title-2 leading-couli-title-2 font-couli-semibold text-couli-brand-emphasis',
          price,
        ),
      );
    }
    const quote = quoteLine(page, deps.now());
    if (quote !== null) article.append(el(doc, 'p', SECONDARY_TEXT, quote));
    for (const key of card.disclaimer_keys) {
      const text = disclaimerText(key);
      if (text.length > 0) article.append(el(doc, 'p', SECONDARY_TEXT, text));
    }
    main.append(article);

    const actions = el(doc, 'div', 'flex flex-col gap-couli-3');
    if (isWebUrl(page.jump_url)) {
      const buy = el(doc, 'a', `${PRIMARY_BUTTON} ${ACTION}`, t('btn.buy'));
      buy.href = page.jump_url;
      actions.append(buy);
    }
    if (inWeChat) {
      // Inside WeChat neither the token nor the App entry is offered (BR-TEXT-14 表 C, BR-ATTR-05).
      actions.append(
        el(doc, 'p', `${SECONDARY_TEXT} text-center`, t('share_page.open_in_browser_hint')),
      );
    } else {
      if (page.tpwd_ticket !== null && page.tpwd_ticket.length > 0) {
        actions.append(copyTokenBlock(api, linkId, page.tpwd_ticket));
      }
      // Only when the server gives the deep link; it may not open the App (no promise made).
      if (isWebUrl(page.open_in_app_url)) {
        const open = el(doc, 'a', `${SECONDARY_BUTTON} ${ACTION}`, t('share_page.open_in_app'));
        open.href = page.open_in_app_url;
        actions.append(open);
      }
    }
    main.append(actions);
    show(main);
  }

  let generation = 0;
  async function load(): Promise<void> {
    const { api, linkId } = deps;
    if (linkId === null) {
      showInvalid();
      return;
    }
    const current = ++generation;
    showLoading();
    let page: SharePageData;
    try {
      page = await api.getSharePage(linkId);
    } catch (error) {
      if (current !== generation) return;
      if (isTransient(error)) showRetry();
      else showInvalid();
      return;
    }
    if (current !== generation) return;
    showPage(api, linkId, page);
  }

  void load();
}
