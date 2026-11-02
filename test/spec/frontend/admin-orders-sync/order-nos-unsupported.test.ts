// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { PLATFORM_NAME, createServer, limits, type SyncLimit } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  MODE,
  ORDER_NOS,
  START,
  assertPlainWrite,
  assertWindowBody,
  chooseMode,
  choosePlatform,
  fill,
  fillWindow,
  isDisabled,
  mountList,
  openSyncDialog,
  prepareOrderNos,
  settle,
  settled,
  submit,
  syncDialog,
  textFields,
  textbox,
} from './helpers.ts';

// B1-04zu: GET limits reports max_order_nos 0 for a platform without sync by order number (jd: its
// order API only queries by time window). The dialog then keeps 按订单号 on show but greyed out,
// and never sends order numbers for such a platform.
const NUMBER = '231008-7770000201';

/** The limits with jd reported as unsupported; pdd and taobao keep their ceiling. */
function jdWithoutNumbers(): SyncLimit[] {
  return limits().map((one) => (one.platform === 'jd' ? { ...one, max_order_nos: 0 } : one));
}

/** The 按订单号 option of the mode switch, in any of the forms the helpers accept. */
function orderNosOption(dialog: HTMLElement): HTMLElement {
  const found = (['radio', 'tab', 'button'] as const).flatMap((role) =>
    within(dialog).queryAllByRole(role, { name: MODE.order_nos }),
  );
  expect(found.length, 'one 按订单号 option in the mode switch').toBe(1);
  return found[0]!;
}

it(
  '[AC-B1-04zu#3] 选中 max_order_nos 为 0 的 jd：按订单号选项置灰，点了也留在按时间窗，单号框不出现',
  async () => {
    const server = createServer({ limits: jdWithoutNumbers() });
    await mountList(server);
    const dialog = await openSyncDialog();
    await settled(server);
    await choosePlatform(dialog, PLATFORM_NAME.jd);
    expect(isDisabled(orderNosOption(syncDialog())), 'greyed out for jd').toBe(true);
    await chooseMode(syncDialog(), 'order_nos');
    expect(textFields(syncDialog(), ORDER_NOS).length, 'no order number field').toBe(0);
    expect(textFields(syncDialog(), START).length, 'the time window stays').toBe(1);
    expect(server.posts()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-B1-04zu#4] limits 把 jd 排第一（接口的实际顺序）：打开对话框默认就是 jd，按订单号一开始就置灰',
  async () => {
    const server = createServer({ limits: jdWithoutNumbers().toReversed() });
    await mountList(server);
    const dialog = await openSyncDialog();
    await settled(server);
    expect(isDisabled(orderNosOption(dialog)), 'greyed out from the start').toBe(true);
    expect(textFields(dialog, START).length, 'opens on the time window').toBe(1);
    expect(server.posts()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-B1-04zu#5] 先选 pdd 按单号再切 jd：自动回到按时间窗，填好的单号不会发出去，提交体恰为时间窗',
  async () => {
    const server = createServer({ limits: jdWithoutNumbers() });
    await mountList(server);
    await prepareOrderNos(server, PLATFORM_NAME.pdd, [NUMBER]);
    await choosePlatform(syncDialog(), PLATFORM_NAME.jd);
    expect(textFields(syncDialog(), ORDER_NOS).length, 'the order number form is gone').toBe(0);
    expect(textFields(syncDialog(), START).length, 'back on the time window').toBe(1);

    await submit(syncDialog());
    await settled(server);
    expect(server.posts(), 'an empty window sends nothing, the typed numbers neither').toEqual([]);

    await fillWindow(syncDialog(), '2026-10-19 00:30', '2026-10-20 12:00');
    await submit(syncDialog());
    await waitFor(() => expect(server.posts()).toHaveLength(1));
    await settled(server);
    const sent = server.posts()[0]!;
    assertPlainWrite(sent);
    assertWindowBody(sent, 'jd', '2026-10-19T00:30:00+08:00', '2026-10-20T12:00:00+08:00');
    expect(server.created()).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-B1-04zu#6] jd 置灰不连累 pdd：切回 pdd 后按订单号可选，提交体恰为 platform + order_nos',
  async () => {
    const server = createServer({ limits: jdWithoutNumbers() });
    await mountList(server);
    const dialog = await openSyncDialog();
    await settled(server);
    await choosePlatform(dialog, PLATFORM_NAME.jd);
    expect(isDisabled(orderNosOption(syncDialog())), 'greyed out for jd').toBe(true);

    await choosePlatform(syncDialog(), PLATFORM_NAME.pdd);
    expect(isDisabled(orderNosOption(syncDialog())), 'open again for pdd').toBe(false);
    await chooseMode(syncDialog(), 'order_nos');
    await fill(textbox(syncDialog(), ORDER_NOS), NUMBER);
    await settle();
    await submit(syncDialog());
    await waitFor(() => expect(server.posts()).toHaveLength(1));
    await settled(server);
    expect(server.posts()[0]!.body).toEqual({ platform: 'pdd', order_nos: [NUMBER] });
    expect(server.created()).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);
