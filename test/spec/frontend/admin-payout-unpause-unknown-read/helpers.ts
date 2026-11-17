import { waitFor, within } from '@testing-library/react';
import { expect } from 'vitest';
import {
  OVERVIEW,
  SWITCHES,
  failedWith,
  type Action,
  type Overview,
  type SwitchUpdate,
} from '../admin-payout-unpause/fixtures.ts';
import {
  answerNormally,
  assertPut,
  closed,
  confirm,
  listReads,
  openAction,
  openPanel,
  overviewReads,
  pausedShown,
  puts,
  queueShown,
  reasonInput,
  scriptPut,
  serverFor,
  settled,
  stepDialogs,
  switchDialogs,
  typeReason,
  verifications,
  verify,
  versionOf,
} from '../admin-payout-unpause/helpers.ts';

export type Failure = 'network' | 'server';

export function fail(kind: Failure): Response {
  if (kind === 'network') throw new Error('simulated response lost');
  return failedWith(50001);
}

export function failureText(kind: Failure): string {
  return kind === 'network'
    ? '网络错误，请检查网络后重试；未确认前不会重复提交'
    : '提交失败，请稍后重试';
}

/** Keep the frozen server's request log, registry, pagination and PUT handling intact.
 * A failed GET loses/replaces its response after the server has recorded and handled it.
 * The script applies only to GET /admin/v1/kill-switches, never overview or verification.
 */
export async function prepare(action: Action, view: Overview, reason: string) {
  const server = serverFor({ overview: view, passes: 6 });
  const readFailures: Failure[] = [];
  const original = server.fetch;
  server.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const response = await original(input, init);
    if (method === 'GET' && url.pathname === SWITCHES) {
      const next = readFailures.shift();
      if (next !== undefined) return fail(next);
    }
    return response;
  };
  const panel = await openPanel(server);
  const { modal, mark } = await openAction(server, panel, action);
  await typeReason(modal, reason);
  expect(listReads(server)).toEqual([]);
  return {
    server,
    panel,
    modal,
    mark,
    action,
    reason,
    initialOverviewReads: overviewReads(server).length,
    failRead: (kind: Failure) => readFailures.push(kind),
  };
}

export type Flow = Awaited<ReturnType<typeof prepare>>;

/** Every attempt goes through a fresh TOTP verification and one registry GET (25 rows fit). */
export async function attempt(flow: Flow): Promise<void> {
  const { server, modal, action } = flow;
  const before = listReads(server).length;
  const checks = verifications(server).length;
  await confirm(server, modal, action);
  await verify();
  await waitFor(() => expect(listReads(server)).toHaveLength(before + 1));
  await settled(server);
  await waitFor(() => expect(stepDialogs()).toEqual([]));
  expect(verifications(server)).toHaveLength(checks + 1);
  expect(verifications(server)[checks]!.body).toEqual({ tier: 'totp', code: '123456' });
  const read = listReads(server)[before]!;
  expect(read.method).toBe('GET');
  expect(read.path).toBe('/admin/v1/kill-switches');
  expect(server.log.indexOf(read)).toBeGreaterThan(
    server.log.indexOf(verifications(server)[checks]!),
  );
}

/** Compare the entire visible notice, independently of application translations. */
export async function exactNotice(text: string): Promise<void> {
  await waitFor(() => {
    const notices = within(document.body).queryAllByText(text, { exact: true });
    expect(notices.length).toBeGreaterThan(0);
    for (const node of notices) expect(node.textContent).toBe(text);
  });
}

export async function kept(flow: Flow, count: number, text: string): Promise<void> {
  await exactNotice(text);
  await settled(flow.server);
  expect(puts(flow.server)).toHaveLength(count);
  expect(switchDialogs()).toEqual([flow.modal]);
  expect(stepDialogs()).toEqual([]);
  expect(reasonInput(flow.modal).value).toBe(flow.reason);
  expect(overviewReads(flow.server)).toHaveLength(flow.initialOverviewReads);
}

export async function refreshed(flow: Flow): Promise<void> {
  const { server, action, panel } = flow;
  await waitFor(() => expect(overviewReads(server)).toHaveLength(flow.initialOverviewReads + 1));
  await settled(server);
  const read = overviewReads(server).at(-1)!;
  expect(read.method).toBe('GET');
  expect(read.path).toBe(OVERVIEW);
  expect(server.log.indexOf(read)).toBeGreaterThan(server.log.indexOf(listReads(server).at(-1)!));
  if (action.channel === undefined) {
    expect(queueShown(panel)).toEqual([action.value ? '已暂停' : '运行中']);
  } else {
    expect(pausedShown(panel, action.channel)).toEqual(['未暂停']);
    expect(queueShown(panel), '解除通道不解除队列').toEqual(['已暂停']);
  }
}

export async function succeeded(flow: Flow, text: string): Promise<void> {
  await exactNotice(text);
  expect(
    within(document.body).queryAllByText('开关状态已被他人修改，已刷新为最新状态，请核对后重试', {
      exact: true,
    }),
  ).toEqual([]);
  await closed();
  await refreshed(flow);
}

/** The PUT really applies on the fake server, but its reply is lost or replaced with a 5xx.
 * Subsequent failed GETs must not erase that uncertainty. This is the red part of every it.
 */
export async function recover(
  flow: Flow,
  writeFailure: Failure,
  readFailures: readonly Failure[],
  body: SwitchUpdate,
  success: string,
): Promise<void> {
  const { server, action, mark } = flow;
  scriptPut(server, (request) => {
    expect(answerNormally(server, request).status).toBe(200);
    return fail(writeFailure);
  });
  await attempt(flow);
  assertPut(server, action, body, 1, 1, mark);
  expect(versionOf(server, action.name)).toBe(body.expected_version + 1);
  await kept(flow, 1, failureText(writeFailure));
  for (const kind of readFailures) {
    flow.failRead(kind);
    await attempt(flow);
    await kept(flow, 1, failureText(kind));
  }
  await attempt(flow);
  expect(listReads(server)).toHaveLength(readFailures.length + 2);
  expect(puts(server)).toHaveLength(1);
  // Baseline fails here: it displays the conflict notice instead of this whole success text.
  await succeeded(flow, success);
}
