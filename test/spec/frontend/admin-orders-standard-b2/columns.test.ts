// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  FLOW_TIMEOUT,
  button,
  click,
  loaded,
  mainElement,
  mount,
} from '../admin-orders/orders-helpers.ts';
import { currentUrl } from '../admin-orders-standard/kit.ts';
import {
  DEFAULT_HEADINGS,
  OPTIONAL_HEADINGS,
  columnHeadings,
  createPageServer,
  saveHiddenCommission,
  toggleColumn,
} from './kit.ts';

afterEach(() => window.localStorage.clear());

it(
  '[AC-F1-07edb-COLUMNS#1] 干净地址默认八列与操作列，打开平台状态和标记后重开仍显示',
  async () => {
    window.localStorage.clear();
    const first = await mount(createPageServer());
    await loaded();
    expect(columnHeadings()).toEqual(DEFAULT_HEADINGS);

    await click(button(mainElement(), /^列设置$/));
    for (const name of OPTIONAL_HEADINGS) await toggleColumn(name, false);
    const allHeadings = [...DEFAULT_HEADINGS, ...OPTIONAL_HEADINGS].sort();
    expect(columnHeadings().sort()).toEqual(allHeadings);

    const address = currentUrl();
    first.unmount();
    await mount(createPageServer(), address);
    await loaded();
    expect(columnHeadings().sort()).toEqual(allHeadings);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07edb-COLUMNS#2] 保存后的列设置损坏时恢复八列与操作列',
  async () => {
    const first = await mount(createPageServer());
    await loaded();
    const key = await saveHiddenCommission();
    const address = currentUrl();
    first.unmount();

    window.localStorage.setItem(key, '{broken json');
    await mount(createPageServer(), address);
    await loaded();
    expect(columnHeadings()).toEqual(DEFAULT_HEADINGS);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07edb-COLUMNS#3] 本地存储拒绝读取列设置时仍显示八列与操作列',
  async () => {
    const first = await mount(createPageServer());
    await loaded();
    const key = await saveHiddenCommission();
    const address = currentUrl();
    first.unmount();

    const getItem = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, name) {
      if (name === key) throw new DOMException('Storage is unavailable', 'SecurityError');
      return getItem.call(this, name);
    });
    await mount(createPageServer(), address);
    await loaded();
    expect(columnHeadings()).toEqual(DEFAULT_HEADINGS);
  },
  FLOW_TIMEOUT,
);
