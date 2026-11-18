import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createAdminShell } from '../../App.tsx';
import { createDataProvider } from '../../providers/data/index.ts';
import { exportsTexts as t } from '../../texts/exports.ts';
import { nextExpiry, POLL_MS, type ExportRow } from './model.ts';

vi.setConfig({ testTimeout: 60_000 });
// The first mount loads antd and the shell; a cold start takes longer than the 1 s default.
configure({ asyncUtilTimeout: 10_000 });

const LIST = '/admin/v1/exports';
const START = Date.parse('2026-10-20T02:00:00Z');
const DONE_ID = 'exp_Dn3Qw8Rt5Ym1Zx7N';
const MASKED_ID = 'exp_Fa3Qw8Rt5Ym1Zx7N';
const UNMASKED_ID = 'exp_Fb3Qw8Rt5Ym1Zx7N';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function task(id: string, patch: Partial<ExportRow> = {}): ExportRow {
  return {
    id,
    resource: 'audit_logs',
    filters_summary: `审计记录 ${id}`,
    masked: true,
    created_by: 'adm_0000000000000001',
    created_by_name: '运营甲',
    created_at: '2026-10-19T01:20:00Z',
    status: 'done',
    progress: null,
    failure_reason: null,
    file_name: 'audit-logs.csv',
    row_count: 12,
    expires_at: new Date(START + 60 * 60 * 1000).toISOString(),
    ...patch,
  };
}

function failed(id: string, masked: boolean): ExportRow {
  return task(id, {
    status: 'failed',
    masked,
    failure_reason: '超过导出行数上限',
    file_name: null,
    row_count: null,
    expires_at: null,
  });
}

function ok(data: unknown): Response {
  return Response.json({ code: 0, msg: '', data, trace_id: 't' });
}

interface Call {
  readonly method: string;
  readonly path: string;
}

function mount(
  clock: { now(): number },
  reply: (call: Call) => Promise<Response>,
): { readonly calls: Call[]; readonly searches: string[] } {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  }));
  const calls: Call[] = [];
  const searches: string[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    const call = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
    };
    calls.push(call);
    searches.push(url.search);
    return reply(call);
  };
  render(
    createAdminShell({
      router: 'memory',
      permissionsProvider: async () => ({ isSuper: true, permissions: [] }),
      account: { username: 'ops-yi', displayName: 'ops-yi' },
      environment: 'test',
      onLogout: () => {},
      initialRoute: { menuId: 'exports' },
      clock,
      dataProvider: createDataProvider({
        baseUrl: 'https://admin.example.test',
        fetch,
        getToken: () => 'admin-token',
        onError: () => {},
      }),
    }),
  );
  return { calls, searches };
}

function page(items: readonly ExportRow[]): Promise<Response> {
  return Promise.resolve(ok({ items, page: 1, page_size: 20, total: items.length }));
}

function rowOf(id: string): HTMLElement {
  const row = screen.getByText(id).closest('tr');
  if (row === null) throw new Error(`row ${id} missing`);
  return row;
}

it('nextExpiry picks the earliest expires_at still ahead among done tasks', () => {
  const soon = new Date(START + 1000).toISOString();
  const later = new Date(START + 5000).toISOString();
  const items = [
    task('a', { expires_at: later }),
    task('b', { expires_at: soon }),
    task('c', { expires_at: new Date(START).toISOString() }),
    failed('d', true),
  ];
  expect(nextExpiry(items, START)).toBe(START + 1000);
  expect(nextExpiry(items, START + 1000)).toBe(START + 5000);
  expect(nextExpiry(items, START + 5000)).toBeUndefined();
});

/**
 * The expiry timer runs on faked setTimeout / clearTimeout (installed before the mount), so the
 * re-render at expires_at never waits on the real event loop. Testing Library drives the faked
 * timers while it waits when it sees a `jest` global with `advanceTimersByTime`.
 */
function fakeTimeouts(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('jest', { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) });
}

it('a done task turns 已过期 without 【下载】 once the injected clock reaches its expires_at', async () => {
  fakeTimeouts();
  let now = START;
  const expiresAt = START + 300;
  const { calls } = mount({ now: () => now }, (call) =>
    call.path === LIST
      ? page([task(DONE_ID, { expires_at: new Date(expiresAt).toISOString() })])
      : Promise.reject(new Error(`unexpected ${call.path}`)),
  );
  await waitFor(() =>
    expect(within(rowOf(DONE_ID)).queryByRole('button', { name: t.download })).not.toBeNull(),
  );
  // The clock is still before expires_at however long the wait took: the row stays 已完成.
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(within(rowOf(DONE_ID)).queryByRole('button', { name: t.download })).not.toBeNull();
  now = expiresAt;
  act(() => {
    vi.advanceTimersByTime(300);
  });
  expect(within(rowOf(DONE_ID)).queryByRole('button', { name: t.download })).toBeNull();
  expect(within(rowOf(DONE_ID)).getByText(t.status.expired)).toBeTruthy();
  expect(calls).toEqual([{ method: 'GET', path: LIST }]);
});

it('a done task still turns 已过期 when the clock passes expires_at between the render and its effect', async () => {
  // Real timers here: the gap is the one between React's commit and its passive effects.
  let now = START;
  const expiresAt = START + 300;
  // A DOM mutation callback (a microtask right after the commit that shows the row) runs before
  // React's passive effects (a later scheduler task): the clock passes expires_at in that gap.
  const observer = new MutationObserver(() => {
    if (screen.queryByText(DONE_ID) !== null) now = expiresAt;
  });
  observer.observe(document.body, { childList: true, subtree: true });
  try {
    const { calls } = mount({ now: () => now }, (call) =>
      call.path === LIST
        ? page([task(DONE_ID, { expires_at: new Date(expiresAt).toISOString() })])
        : Promise.reject(new Error(`unexpected ${call.path}`)),
    );
    // Judged again at once (a timer due now), never left as 已完成 with 【下载】.
    await waitFor(() => {
      expect(within(rowOf(DONE_ID)).queryByRole('button', { name: t.download })).toBeNull();
      expect(within(rowOf(DONE_ID)).getByText(t.status.expired)).toBeTruthy();
    });
    expect(calls).toEqual([{ method: 'GET', path: LIST }]);
  } finally {
    observer.disconnect();
  }
});

it('a click on 【下载】 after the expiry sends no download, tells 已过期 and reads the list again', async () => {
  let now = START;
  const { calls } = mount({ now: () => now }, (call) =>
    call.path === LIST
      ? page([task(DONE_ID)])
      : Promise.reject(new Error(`unexpected ${call.path}`)),
  );
  const download = await waitFor(() =>
    within(rowOf(DONE_ID)).getByRole('button', { name: t.download }),
  );
  // Expired between the render and the click (the timer is still an hour away).
  now = START + 2 * 60 * 60 * 1000;
  await act(async () => {
    fireEvent.click(download);
  });
  await waitFor(() => expect(screen.getByText(t.downloadExpired)).toBeTruthy());
  await waitFor(() =>
    expect(calls).toEqual([
      { method: 'GET', path: LIST },
      { method: 'GET', path: LIST },
    ]),
  );
  await waitFor(() => expect(within(rowOf(DONE_ID)).getByText(t.status.expired)).toBeTruthy());
  expect(calls.some((call) => call.path.endsWith('/download'))).toBe(false);
});

it('one task finishing its retry never closes another task’s reason dialog or keeps it busy', async () => {
  let answerMasked: (response: Response) => void = () => {};
  const { calls } = mount({ now: () => START }, (call) => {
    if (call.path === LIST) return page([failed(MASKED_ID, true), failed(UNMASKED_ID, false)]);
    if (call.method === 'POST' && call.path === `${LIST}/${MASKED_ID}/retry`)
      return new Promise<Response>((resolve) => {
        answerMasked = resolve;
      });
    return Promise.reject(new Error(`unexpected ${call.path}`));
  });
  const retryMasked = await waitFor(() =>
    within(rowOf(MASKED_ID)).getByRole('button', { name: t.retry }),
  );
  await act(async () => {
    fireEvent.click(retryMasked);
  });
  await act(async () => {
    fireEvent.click(within(rowOf(UNMASKED_ID)).getByRole('button', { name: t.retry }));
  });
  const dialog = await screen.findByRole('dialog', { name: t.reason.title });
  // The masked task's answer arrives while the other task's reason dialog is open.
  await act(async () => {
    answerMasked(ok(task(MASKED_ID, { status: 'pending', expires_at: null })));
  });
  await waitFor(() => expect(within(rowOf(MASKED_ID)).getByText(t.status.pending)).toBeTruthy());
  expect(screen.getByRole('dialog', { name: t.reason.title })).toBe(dialog);
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: t.reason.cancel }));
  });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: t.reason.title })).toBeNull());
  const retryUnmasked = within(rowOf(UNMASKED_ID)).getByRole('button', { name: t.retry });
  expect((retryUnmasked as HTMLButtonElement).disabled).toBe(false);
  expect(calls.filter((call) => call.method === 'POST')).toEqual([
    { method: 'POST', path: `${LIST}/${MASKED_ID}/retry` },
  ]);
});

it('a reread that finds page 2 emptied goes back to the last page with rows and keeps polling it', async () => {
  fakeTimeouts();
  const running = (id: string): ExportRow =>
    task(id, {
      status: 'running',
      progress: 40,
      file_name: null,
      row_count: null,
      expires_at: null,
    });
  const first = Array.from({ length: 20 }, (_, i) =>
    running(`exp_P1${String(i).padStart(2, '0')}w8Rt5Ym1Zx7N`),
  );
  const lone = running('exp_P2zzw8Rt5Ym1Zx7N');
  let loneDone = false;
  const { searches } = mount({ now: () => START }, (call) => {
    if (call.path !== LIST) return Promise.reject(new Error(`unexpected ${call.path}`));
    const asked = new URLSearchParams(searches[searches.length - 1]).get('page');
    if (asked === '2') {
      return Promise.resolve(
        ok(
          loneDone
            ? { items: [], page: 2, page_size: 20, total: 20 }
            : { items: [lone], page: 2, page_size: 20, total: 21 },
        ),
      );
    }
    return Promise.resolve(ok({ items: first, page: 1, page_size: 20, total: loneDone ? 20 : 21 }));
  });
  await waitFor(() => expect(screen.getByText(first[0]!.id)).toBeTruthy());
  fireEvent.click(screen.getByTitle('2'));
  await waitFor(() => expect(screen.getByText(lone.id)).toBeTruthy());
  loneDone = true;
  const before = searches.length;
  act(() => {
    vi.advanceTimersByTime(POLL_MS);
  });
  // The emptied page 2 is never shown: page 1 is read with the same filters and shown instead.
  await waitFor(() => expect(screen.getByText(first[0]!.id)).toBeTruthy());
  expect(screen.queryByText(lone.id)).toBeNull();
  expect(screen.queryByText(t.empty)).toBeNull();
  const after = searches.slice(before).map((search) => new URLSearchParams(search).get('page'));
  expect(after.slice(0, 2)).toEqual(['2', '1']);
  // Page 1 still has running rows: the silent rereads go on, now for page 1.
  const reads = searches.length;
  act(() => {
    vi.advanceTimersByTime(POLL_MS);
  });
  await waitFor(() => expect(searches.length).toBeGreaterThan(reads));
  expect(new URLSearchParams(searches[searches.length - 1]).get('page')).toBe('1');
});
