import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../../../shared/api/app-api.ts';
import { ApiError, type H5ApiClient } from '../../../../shared/api/index.ts';
import { createQueryClient, createQueryProvider } from '../../../../shared/query.ts';
import { t } from '../../../../shared/texts.ts';
import { earningsText } from '../../../../texts/earnings.ts';
import { MemoryRouter } from '../help/router.ts';
import { EarningsPage } from './earnings-page.tsx';
import type { EarningsSummary } from './model.ts';

// 单元测试：原生桥与 API 客户端都是内存假实现（不联网、不 listen）。
vi.mock('@couli/bridge-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@couli/bridge-sdk')>()),
  has: (method: string) => (method === 'app.getConfig' ? method : null),
  call: () =>
    Promise.resolve({ values: { features: { platform_status: { taobao: 'on', jd: 'on' } } } }),
}));

const clients: ReturnType<typeof createQueryClient>[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

const period = { paid_count: 1, est_fen: 100, credited_fen: 0 };
const summary: EarningsSummary = {
  as_of: '2026-11-01T10:00:00+08:00',
  self: { today: period, yesterday: period, this_month: period, last_month: period },
  share: { today: period, yesterday: period, this_month: period, last_month: period },
  referral: {
    this_month: { est_fen: 0, credited_fen: 0 },
    last_month: { est_fen: 0, credited_fen: 0 },
  },
};

type Reply = (platform: string | undefined, count: number) => Promise<unknown>;

function mount(reply: Reply) {
  let count = 0;
  const request = vi.fn((_method: string, _path: string, options: unknown) => {
    count += 1;
    const query = (options as { params: { query: { platform?: string } } }).params.query;
    return reply(query.platform, count);
  });
  const api = { request } as unknown as H5ApiClient;
  const client = createQueryClient();
  clients.push(client);
  render(
    createQueryProvider(
      <ApiProvider api={api}>
        <MemoryRouter initialEntries={['/earnings']}>
          <EarningsPage />
        </MemoryRouter>
      </ApiProvider>,
      client,
    ),
  );
  return request;
}

const SELF = earningsText('earnings.section.self');
const pill = (name: string) => screen.getByRole('button', { name });

it('[AC-F1-12a-UNIT#5] 切回取过的平台时重取返回 30701：整页换成看板关闭提示，不留旧数字', async () => {
  mount((platform, count) =>
    count === 3 ? Promise.reject(new ApiError(30701, '')) : Promise.resolve(summary),
  );
  await screen.findByText(SELF);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '淘宝' }));
  await waitFor(() => expect(pill('淘宝').getAttribute('aria-pressed')).toBe('true'));
  await screen.findByText(SELF);
  await user.click(pill(earningsText('earnings.platform.all')));
  expect((await screen.findByRole('alert')).textContent).toContain(t('error.30701'));
  expect(screen.queryByText(SELF)).toBeNull();
  expect(screen.queryByText(t('h5.load_failed'))).toBeNull();
});

it('[AC-F1-12a-UNIT#6] 「全部」已加载后切平台失败：胶囊与期间仍在，可切回「全部」', async () => {
  const request = mount((platform) =>
    platform === 'jd' ? Promise.reject(new ApiError(50001, '')) : Promise.resolve(summary),
  );
  await screen.findByText(SELF);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '京东' }));
  expect((await screen.findByRole('alert')).textContent).toContain(t('h5.load_failed'));
  expect(screen.getByRole('button', { name: t('h5.retry') })).not.toBeNull();
  expect(
    screen.getByRole('radiogroup', { name: earningsText('earnings.period.label') }),
  ).not.toBeNull();
  await user.click(pill(earningsText('earnings.platform.all')));
  await screen.findByText(SELF);
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(request.mock.calls.length).toBeGreaterThanOrEqual(3);
});
