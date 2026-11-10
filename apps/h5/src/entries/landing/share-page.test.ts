import { expect, it, vi } from 'vitest';
import { ShareApiError, type ShareApi, type SharePageData } from './share-api.ts';
import { isTicketRejected, mountSharePage } from './share-page.ts';

const LINK = 'link-1';

function page(ticket: string | null): SharePageData {
  return {
    product_card: {
      title: '商品',
      image: null,
      shop_name: null,
      price_fen: 1000,
      final_price_fen: null,
      stale: false,
      age_sec: 0,
      disclaimer_keys: [],
    },
    quoted_at: null,
    jump_url: 'https://item.example.test/1',
    tpwd_ticket: ticket,
    open_in_app_url: null,
  } as unknown as SharePageData;
}

const ticketRejected = () => new ShareApiError(20001, 400, { fields: ['ticket'] });

async function mount(api: ShareApi) {
  const container = document.createElement('div');
  document.body.replaceChildren(container);
  const writeText = vi.fn(async () => {});
  mountSharePage(container, {
    api,
    linkId: LINK,
    userAgent: 'Mozilla/5.0',
    mediaOrigins: [],
    now: () => 0,
    clipboard: { writeText },
  });
  await vi.waitFor(() => expect(container.querySelector('h1')).not.toBeNull());
  const button = [...container.querySelectorAll('button')].find(
    (node) => node.textContent !== '' && node.closest('main') !== null,
  );
  expect(button).toBeDefined();
  return { container, button: button!, writeText };
}

async function settled(button: HTMLButtonElement) {
  await vi.waitFor(() => expect(button.disabled).toBe(false));
}

it('[AC-F1-11a-UNIT#7] isTicketRejected 只认 20001 且 fields 含 ticket', () => {
  expect(isTicketRejected(ticketRejected())).toBe(true);
  expect(isTicketRejected(new ShareApiError(20001, 400, { fields: ['link_id'] }))).toBe(false);
  expect(isTicketRejected(new ShareApiError(20001, 400, null))).toBe(false);
  expect(isTicketRejected(new ShareApiError(42901, 429, { fields: ['ticket'] }))).toBe(false);
  expect(isTicketRejected(new Error('x'))).toBe(false);
});

it('[AC-F1-11a-UNIT#8] 票据过期时重取分享页拿新票据重试一次，之后点按沿用新票据', async () => {
  const getSharePage = vi
    .fn<ShareApi['getSharePage']>()
    .mockResolvedValueOnce(page('old'))
    .mockResolvedValueOnce(page('new'));
  const getShareTpwd = vi
    .fn<ShareApi['getShareTpwd']>()
    .mockRejectedValueOnce(ticketRejected())
    .mockResolvedValueOnce('￥TOKEN1￥');
  const { button, writeText } = await mount({ getSharePage, getShareTpwd });
  button.click();
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('￥TOKEN1￥'));
  await settled(button);
  expect(getShareTpwd.mock.calls).toEqual([
    [LINK, 'old'],
    [LINK, 'new'],
  ]);
  expect(getSharePage).toHaveBeenCalledTimes(2);
});

it('[AC-F1-11a-UNIT#9] 新票据为 null 时显示失败，不再换口令', async () => {
  const getSharePage = vi
    .fn<ShareApi['getSharePage']>()
    .mockResolvedValueOnce(page('old'))
    .mockResolvedValueOnce(page(null));
  const getShareTpwd = vi.fn<ShareApi['getShareTpwd']>().mockRejectedValue(ticketRejected());
  const { container, button, writeText } = await mount({ getSharePage, getShareTpwd });
  button.click();
  await vi.waitFor(() => expect(getSharePage).toHaveBeenCalledTimes(2));
  await settled(button);
  expect(getShareTpwd).toHaveBeenCalledTimes(1);
  expect(writeText).not.toHaveBeenCalled();
  expect(container.querySelector('[role="status"]')?.textContent).not.toBe('');
});

it('[AC-F1-11a-UNIT#10] 新票据再次被拒只重试一次后显示失败；其他错误不重取分享页', async () => {
  const getSharePage = vi
    .fn<ShareApi['getSharePage']>()
    .mockResolvedValueOnce(page('old'))
    .mockResolvedValueOnce(page('new'));
  const getShareTpwd = vi.fn<ShareApi['getShareTpwd']>().mockRejectedValue(ticketRejected());
  const { container, button, writeText } = await mount({ getSharePage, getShareTpwd });
  button.click();
  await vi.waitFor(() => expect(getShareTpwd).toHaveBeenCalledTimes(2));
  await settled(button);
  expect(getSharePage).toHaveBeenCalledTimes(2);
  expect(writeText).not.toHaveBeenCalled();
  expect(container.querySelector('[role="status"]')?.textContent).not.toBe('');

  getShareTpwd.mockReset().mockRejectedValue(new ShareApiError(42901, 429, null));
  button.click();
  await vi.waitFor(() => expect(getShareTpwd).toHaveBeenCalledTimes(1));
  await settled(button);
  expect(getShareTpwd.mock.calls[0]).toEqual([LINK, 'new']);
  expect(getSharePage).toHaveBeenCalledTimes(2);
});
