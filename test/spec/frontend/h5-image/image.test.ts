// @vitest-environment jsdom
// DSX-48c (手感方案 ④): the H5 image component's four states, its accessibility and its img
// attributes, driven through the img's `load` / `error` events. Visual fade, reduced motion and
// layout are checked in a real Chromium (image.browser.test.ts).
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { t } from '../../../../apps/h5/src/shared/texts.ts';
import {
  PAGE_BUSY,
  frameOf,
  imageComponent,
  onlyFrame,
  readable,
  shownImgs,
  squash,
  stateOf,
  type AsyncImageProps,
} from './kit.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PHOTO = 'https://media.example.invalid/items/photo-a.png';
const OTHER = 'https://media.example.invalid/items/photo-b.png';
const THIRD = 'https://media.example.invalid/items/photo-c.png';
const ALT = '商品主图';
const FAILED = '图片没有加载出来';

function mount(props: AsyncImageProps) {
  const AsyncImage = imageComponent();
  const view = render(createElement(AsyncImage, props));
  return {
    ...view,
    update: (next: AsyncImageProps) => view.rerender(createElement(AsyncImage, next)),
  };
}

/** The one img named `name`; it is the only img role with that name. */
function namedImg(name: string): HTMLImageElement {
  const found = screen.getAllByRole('img', { name });
  expect(found, `one img named ${name}`).toHaveLength(1);
  expect(found[0]!.tagName).toBe('IMG');
  return found[0] as HTMLImageElement;
}

it('[AC-DSX-48c-IMAGE#1] 加载中：占位框 data-state=loading、无文字，img 已在 DOM（lazy、async、src、alt 即可访问名称），不带 aria-busy 与骨架块', () => {
  const view = mount({ src: PHOTO, alt: ALT, aspectRatio: '3 / 2' });
  const img = namedImg(ALT);
  expect(img.getAttribute('src')).toBe(PHOTO);
  expect(img.getAttribute('loading')).toBe('lazy');
  expect(img.getAttribute('decoding')).toBe('async');
  expect(view.container.querySelectorAll('img')).toHaveLength(1);
  const frame = frameOf(img);
  expect(onlyFrame(view.container)).toBe(frame);
  expect(stateOf(frame)).toBe('loading');
  expect(squash(view.container.textContent), 'no loading text').toBe('');
  expect(view.container.querySelector(PAGE_BUSY), PAGE_BUSY).toBeNull();
  expect(screen.queryByText(t('state.load_failed.title'))).toBeNull();
});

it('[AC-DSX-48c-IMAGE#2] img 触发 load 后 data-state=loaded，img 与可访问名称不变，无失败文字', async () => {
  const view = mount({ src: PHOTO, alt: ALT, aspectRatio: '3 / 2' });
  const img = namedImg(ALT);
  expect(stateOf(frameOf(img))).toBe('loading');
  fireEvent.load(img);
  await waitFor(() => expect(stateOf(onlyFrame(view.container))).toBe('loaded'));
  const frame = onlyFrame(view.container);
  expect(namedImg(ALT).getAttribute('src')).toBe(PHOTO);
  expect(shownImgs(frame)).toHaveLength(1);
  expect(squash(view.container.textContent)).toBe('');
  expect(view.container.querySelector(PAGE_BUSY), PAGE_BUSY).toBeNull();
});

it('[AC-DSX-48c-IMAGE#3] img 触发 error 后 data-state=error：不显示破图（img 移除或 hidden），显示字典 state.load_failed.title 失败文字且读屏可读', async () => {
  const failed = t('state.load_failed.title');
  expect(failed, 'dictionary text of state.load_failed.title').not.toBe('');
  const view = mount({ src: PHOTO, alt: ALT, aspectRatio: '3 / 2' });
  const img = namedImg(ALT);
  expect(stateOf(frameOf(img))).toBe('loading');
  fireEvent.error(img);
  await waitFor(() => expect(stateOf(onlyFrame(view.container))).toBe('error'));
  const frame = onlyFrame(view.container);
  expect(shownImgs(frame), 'no broken image shown').toEqual([]);
  const text = screen.getByText(failed);
  expect(frame.contains(text), 'failure text inside the frame').toBe(true);
  expect(readable(text, view.container), 'failure text not aria-hidden / hidden').toBe(true);
  expect(view.container.querySelector(PAGE_BUSY), PAGE_BUSY).toBeNull();
});

it('[AC-DSX-48c-IMAGE#4] 调用方传入 failedText 时失败态显示该文字（不另写死文案）', async () => {
  const view = mount({ src: PHOTO, alt: ALT, failedText: FAILED });
  const img = namedImg(ALT);
  expect(stateOf(frameOf(img))).toBe('loading');
  fireEvent.error(img);
  await waitFor(() => expect(stateOf(onlyFrame(view.container))).toBe('error'));
  const frame = onlyFrame(view.container);
  const text = screen.getByText(FAILED);
  expect(frame.contains(text)).toBe(true);
  expect(readable(text, view.container)).toBe(true);
  expect(squash(frame.textContent)).toBe(squash(FAILED));
});

/** No-image state: no img element is created (so nothing is requested), an empty frame shows. */
function expectEmpty(src: AsyncImageProps['src']): void {
  // A spy without a mock implementation calls through to the real createElement.
  const createElementSpy = vi.spyOn(document, 'createElement');
  const view = mount({ src, alt: ALT, aspectRatio: '3 / 2' });
  const frame = onlyFrame(view.container);
  expect(stateOf(frame)).toBe('empty');
  expect(view.container.querySelectorAll('img')).toHaveLength(0);
  const imgs = createElementSpy.mock.calls.filter(([tag]) => String(tag).toLowerCase() === 'img');
  expect(imgs, 'no img element created').toEqual([]);
  expect(squash(view.container.textContent)).toBe('');
  expect(view.container.querySelector(PAGE_BUSY), PAGE_BUSY).toBeNull();
}

it('[AC-DSX-48c-IMAGE#5] src 为 null 时是无图态：不创建 img、不发请求，占位框 data-state=empty、无文字', () => {
  expectEmpty(null);
});

it('[AC-DSX-48c-IMAGE#6] src 为 undefined 时是无图态：不创建 img、不发请求，占位框 data-state=empty、无文字', () => {
  expectEmpty(undefined);
});

it('[AC-DSX-48c-IMAGE#7] src 为空串时是无图态：不创建 img、不发请求，占位框 data-state=empty、无文字', () => {
  expectEmpty('');
});

it('[AC-DSX-48c-IMAGE#8] 换 src 时回到加载中：已加载或已失败的状态不沿用到新图', async () => {
  const view = mount({ src: PHOTO, alt: ALT, aspectRatio: '3 / 2' });
  fireEvent.load(namedImg(ALT));
  await waitFor(() => expect(stateOf(onlyFrame(view.container))).toBe('loaded'));

  view.update({ src: OTHER, alt: ALT, aspectRatio: '3 / 2' });
  await waitFor(() => expect(namedImg(ALT).getAttribute('src')).toBe(OTHER));
  expect(stateOf(onlyFrame(view.container))).toBe('loading');
  fireEvent.error(namedImg(ALT));
  await waitFor(() => expect(stateOf(onlyFrame(view.container))).toBe('error'));

  view.update({ src: THIRD, alt: ALT, aspectRatio: '3 / 2' });
  await waitFor(() => expect(namedImg(ALT).getAttribute('src')).toBe(THIRD));
  const frame = onlyFrame(view.container);
  expect(stateOf(frame)).toBe('loading');
  expect(shownImgs(frame)).toHaveLength(1);
  expect(screen.queryByText(t('state.load_failed.title'))).toBeNull();
  fireEvent.load(namedImg(ALT));
  await waitFor(() => expect(stateOf(onlyFrame(view.container))).toBe('loaded'));
});

it('[AC-DSX-48c-IMAGE#9] referrerPolicy 由调用方传给 img（no-referrer 照写）', () => {
  mount({ src: PHOTO, alt: ALT, referrerPolicy: 'no-referrer' });
  expect(namedImg(ALT).getAttribute('referrerpolicy')).toBe('no-referrer');
});
