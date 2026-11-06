/// <reference types="@vitest/browser-playwright" />
// F1-01x (规划/05 §3.11.3 F1-01-nav, 编排 D10-724 ①) in a real Chromium: the shared app shell calls
// ui.setNavBar once per route entry with a title taken only from dictionary keys. /earnings has
// the page-title key earnings.title; the other eight contract h5 routes have no page-title key
// yet, so for them the title is only required not to be hard-coded (see nav-kit.ts).
// Every wait is bounded by WAIT (nav-kit.ts), well below each test's own timeout.
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  callsAt,
  contractH5Paths,
  EARNINGS_TITLE,
  entered,
  expectEarningsTitle,
  expectNotHardCoded,
  mountShell,
  navigate,
  settled,
  TEST_TIMEOUT,
  unmountShell,
  WALK_TIMEOUT,
} from './nav-kit.ts';

let originalUrl: string;

beforeEach(() => {
  originalUrl = window.location.href;
});

afterEach(() => {
  unmountShell();
  window.history.replaceState(null, '', originalUrl);
});

async function enterOnly(path: string) {
  const harness = mountShell(path);
  await entered(harness, path);
  return callsAt(harness, path);
}

it(
  '[AC-F1-01x-NAV#1] 进入 /earnings：外壳调 ui.setNavBar，title 等于字典 earnings.title',
  async () => {
    expectEarningsTitle(await enterOnly('/earnings'));
  },
  TEST_TIMEOUT,
);

it(
  '[AC-F1-01x-NAV#2] 进入 /find-order：外壳调 ui.setNavBar，title 不写死',
  async () => {
    expectNotHardCoded(await enterOnly('/find-order'));
  },
  TEST_TIMEOUT,
);

it(
  '[AC-F1-01x-NAV#3] 进入 /ledger：外壳调 ui.setNavBar，title 不写死',
  async () => {
    expectNotHardCoded(await enterOnly('/ledger'));
  },
  TEST_TIMEOUT,
);

it(
  '[AC-F1-01x-NAV#4] 进入 /messages：外壳调 ui.setNavBar，title 不写死',
  async () => {
    expectNotHardCoded(await enterOnly('/messages'));
  },
  TEST_TIMEOUT,
);

it(
  '[AC-F1-01x-NAV#5] 进入 /invite：外壳调 ui.setNavBar，title 不写死',
  async () => {
    expectNotHardCoded(await enterOnly('/invite'));
  },
  TEST_TIMEOUT,
);

it(
  '[AC-F1-01x-NAV#6] 进入 /rules：外壳调 ui.setNavBar，title 不写死',
  async () => {
    expectNotHardCoded(await enterOnly('/rules'));
  },
  TEST_TIMEOUT,
);

it(
  '[AC-F1-01x-NAV#7] 进入 /help：外壳调 ui.setNavBar，title 不写死',
  async () => {
    expectNotHardCoded(await enterOnly('/help'));
  },
  TEST_TIMEOUT,
);

it(
  '[AC-F1-01x-NAV#8] 进入 /notice：外壳调 ui.setNavBar，title 不写死',
  async () => {
    expectNotHardCoded(await enterOnly('/notice'));
  },
  TEST_TIMEOUT,
);

it(
  '[AC-F1-01x-NAV#9] 进入 /agreement：外壳调 ui.setNavBar，title 不写死',
  async () => {
    expectNotHardCoded(await enterOnly('/agreement'));
  },
  TEST_TIMEOUT,
);

it(
  '[AC-F1-01x-NAV#10] 同一外壳依次进入 9 个 h5 路由：每次进入都调 ui.setNavBar，回到 /earnings 时 title 回到字典值',
  async () => {
    const sequence = [
      '/earnings',
      '/find-order',
      '/ledger',
      '/messages',
      '/invite',
      '/rules',
      '/help',
      '/notice',
      '/agreement',
    ];
    // The walk covers exactly the contract h5 routes (contracts/routes.json kind=h5).
    expect([...sequence].sort()).toEqual(contractH5Paths().sort());
    const harness = mountShell(sequence[0]!);
    await entered(harness, sequence[0]!);
    for (const path of [...sequence.slice(1), '/earnings']) {
      const before = harness.calls.length;
      navigate(path);
      await entered(harness, path);
      const fresh = harness.calls.slice(before);
      expect(fresh.length, `ui.setNavBar after entering ${path}`).toBeGreaterThan(0);
      expect(fresh.every((call) => call.path === path)).toBe(true);
      if (path === '/earnings') expectEarningsTitle(fresh);
      else expectNotHardCoded(fresh);
    }
    // Entered twice: the second entry calls again instead of relying on the first title.
    expect(callsAt(harness, '/earnings').length).toBeGreaterThanOrEqual(2);
    expect(harness.calls.at(-1)?.title).toBe(EARNINGS_TITLE);
  },
  WALK_TIMEOUT,
);

it(
  '[AC-F1-01x-NAV#11] 同一路由内只改查询参数：不再调用，或再调时 title 不变',
  async () => {
    const harness = mountShell('/earnings');
    await entered(harness, '/earnings');
    navigate('/earnings?fixture_state=changed');
    // Let the router commit the changed query (and send any repeat call); leaving for another
    // route afterwards bounds any repeat caused by the query change.
    await settled(harness);
    navigate('/rules');
    await entered(harness, '/rules');
    expectEarningsTitle(callsAt(harness, '/earnings'));
  },
  TEST_TIMEOUT,
);
