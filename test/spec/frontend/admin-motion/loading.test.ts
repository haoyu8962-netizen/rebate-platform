// @vitest-environment jsdom
// DSX-51a (手感方案 ⑥, D10-1037): admin loading indicators wait for motion.skeleton.show-delay
// (@couli/ui-tokens motionSkeletonShowDelayMs) before they show, so short loads never flash a
// spinner. Measured on real pages with the read held: the moment the indicator's container is in
// the DOM versus the moment antd marks it spinning (.ant-spin-spinning).
import { motionSkeletonShowDelayMs } from '@couli/ui-tokens';
import { act, cleanup, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { mount as mountAdmins } from '../admin-admins/helpers.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { ADMIN_PAGE, jsonResponse } from '../admin-data/fixtures.ts';
import {
  LIST as CHANNELS,
  createServer as createMessagesServer,
} from '../admin-messages/fixtures.ts';
import { mount as mountMessages, settled } from '../admin-messages/helpers.ts';

const FLOW_TIMEOUT = 40_000;
/** Timer and clock granularity only; the indicator must not show before the token delay. */
const TOLERANCE_MS = 10;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface Timeline {
  /** performance.now() of the first time each selector matched. */
  readonly first: Map<string, number>;
  stop(): void;
}
function watch(selectors: readonly string[]): Timeline {
  const first = new Map<string, number>();
  const check = (): void => {
    const now = performance.now();
    for (const selector of selectors)
      if (!first.has(selector) && document.querySelector(selector) !== null)
        first.set(selector, now);
  };
  const observer = new MutationObserver(check);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class'],
  });
  check();
  return { first, stop: () => observer.disconnect() };
}
async function expectDelayed(timeline: Timeline, container: string, shown: string): Promise<void> {
  await waitFor(() =>
    expect(timeline.first.has(container), `loading indicator container ${container}`).toBe(true),
  );
  await waitFor(() =>
    expect(timeline.first.has(shown), 'indicator shows after show-delay').toBe(true),
  );
  const hiddenFor = timeline.first.get(shown)! - timeline.first.get(container)!;
  expect(
    hiddenFor,
    `indicator stays hidden for motion.skeleton.show-delay (${motionSkeletonShowDelayMs} ms)`,
  ).toBeGreaterThanOrEqual(motionSkeletonShowDelayMs - TOLERANCE_MS);
}

it(
  '[AC-DSX-51a-LOADING#1] 表格 loading 在短于 show-delay 时不显示，加载超过 show-delay 才出现',
  async () => {
    expect(motionSkeletonShowDelayMs).toBeGreaterThan(0);
    installMediaQuery();
    const pending = Promise.withResolvers<Response>();
    const timeline = watch([
      'main .ant-table-wrapper .ant-spin-nested-loading',
      'main .ant-table-wrapper .ant-spin-spinning',
    ]);
    try {
      const h = mountAdmins(() => pending.promise);
      await waitFor(() => expect(h.requests).toHaveLength(1));
      await expectDelayed(
        timeline,
        'main .ant-table-wrapper .ant-spin-nested-loading',
        'main .ant-table-wrapper .ant-spin-spinning',
      );
    } finally {
      timeline.stop();
      await act(async () => pending.resolve(jsonResponse(ADMIN_PAGE)));
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-DSX-51a-LOADING#2] 页面 Spin 在短于 show-delay 时不转，加载超过 show-delay 才出现',
  async () => {
    expect(motionSkeletonShowDelayMs).toBeGreaterThan(0);
    const server = createMessagesServer();
    const release = server.hold('GET', CHANNELS);
    const timeline = watch(['main .ant-spin', 'main .ant-spin-spinning']);
    try {
      await mountMessages(server);
      await waitFor(() => expect(server.requests('GET', CHANNELS)).toHaveLength(1));
      await expectDelayed(timeline, 'main .ant-spin', 'main .ant-spin-spinning');
    } finally {
      timeline.stop();
      release();
    }
    await settled(server);
  },
  FLOW_TIMEOUT,
);
