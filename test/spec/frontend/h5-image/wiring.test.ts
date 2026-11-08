// @vitest-environment jsdom
// DSX-48c: the article body's images and the invite poster use the H5 image component. Article
// images keep their alt, `no-referrer`, lazy loading and async decoding; a failed poster shows the
// failure state inside the poster card instead of hiding the whole card (feel plan ④: "图片有占位 +
// 渐显 + 缓存 + 失败态", design/ui-rules §3.6), and the card keeps its accessible name.
import { createElement } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ArticleBody } from '../../../../apps/h5/src/components/article-body/index.ts';
import { inviteTexts } from '../../../../apps/h5/src/texts/invite.ts';
import { CDN, doc, paragraph } from '../h5-rules/fixtures.ts';
import {
  inviteCode,
  inviteServer,
  myInvite,
  posterUrl,
  reply,
} from '../h5-invite/invite-fixtures.ts';
import { mount as mountInvite } from '../h5-invite/invite-helpers.ts';
import {
  FRAME,
  PAGE_BUSY,
  frameOf,
  imageComponent,
  onlyFrame,
  readable,
  shownImgs,
  squash,
  stateOf,
} from './kit.ts';

const BODY = '规则正文第一段';
const FIRST = `${CDN}/rules/first.png`;
const SECOND = `${CDN}/rules/second.png`;

function articleWithImages() {
  return render(
    createElement(ArticleBody, {
      mediaCdnOrigin: CDN,
      body: doc(
        paragraph(BODY),
        { type: 'image', attrs: { src: FIRST, alt: '规则示意图一' } },
        { type: 'image', attrs: { src: SECOND, alt: '规则示意图二' } },
      ),
    }),
  );
}

function namedImg(name: string): HTMLImageElement {
  const found = screen.getAllByRole('img', { name });
  expect(found, `one img named ${name}`).toHaveLength(1);
  expect(found[0]!.tagName).toBe('IMG');
  return found[0] as HTMLImageElement;
}

function frames(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FRAME));
}

/** The poster card: one button named 预览邀请海报 (its name stays the same in every state). */
function posterCard(): HTMLElement {
  return screen.getByRole('button', { name: inviteTexts.posterPreview });
}

/** The aspect-ratio the poster frame keeps: inline style or the Tailwind arbitrary class. */
function keepsPosterRatio(frame: HTMLElement): boolean {
  const inline = frame.style.aspectRatio.replace(/\s+/g, '');
  return inline === '750/1334' || /(?:^|\s)aspect-\[750\/1334\](?:\s|$)/.test(frame.className);
}

it('[AC-DSX-48c-WIRING#1] 正文图经图片件渲染：每张图在占位框里（加载中），alt 即可访问名称、no-referrer、lazy、async 照旧，不带 aria-busy', () => {
  imageComponent();
  const view = articleWithImages();
  expect(view.container.querySelectorAll('img')).toHaveLength(2);
  for (const [name, src] of [
    ['规则示意图一', FIRST],
    ['规则示意图二', SECOND],
  ] as const) {
    const img = namedImg(name);
    expect(img.getAttribute('src')).toBe(src);
    expect(img.getAttribute('referrerpolicy'), `${name} referrerpolicy`).toBe('no-referrer');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('decoding')).toBe('async');
    const frame = frameOf(img);
    expect(view.container.contains(frame)).toBe(true);
    expect(stateOf(frame), `${name} state`).toBe('loading');
  }
  expect(view.container.querySelector(PAGE_BUSY), PAGE_BUSY).toBeNull();
  expect(squash(view.container.textContent)).toBe(squash(BODY));
});

it('[AC-DSX-48c-WIRING#2] 正文图 load 后渐显（loaded）；另一张 error 后显示读屏可读的失败态、不显示破图，正文文字不受影响', async () => {
  imageComponent();
  const view = articleWithImages();
  const first = namedImg('规则示意图一');
  const second = namedImg('规则示意图二');
  expect(frames(view.container)).toEqual([frameOf(first), frameOf(second)]);
  fireEvent.load(first);
  fireEvent.error(second);
  await waitFor(() => expect(frames(view.container).map(stateOf)).toEqual(['loaded', 'error']));
  const secondFrame = frames(view.container)[1]!;
  expect(namedImg('规则示意图一').getAttribute('src')).toBe(FIRST);
  expect(shownImgs(secondFrame), 'no broken image').toEqual([]);
  const failed = squash(secondFrame.textContent);
  expect(failed, 'failure text in the frame').not.toBe('');
  expect(failed, 'a text, not a dictionary key').not.toMatch(/^[a-z0-9_.]+$/);
  const textNodes = within(secondFrame).getAllByText(/\S/);
  expect(
    textNodes.some((node) => readable(node, view.container)),
    'failure text readable by screen readers',
  ).toBe(true);
  expect(screen.getByText(BODY).tagName).toBe('P');
});

it('[AC-DSX-48c-WIRING#3] 邀请海报经图片件渲染：在【预览邀请海报】卡里、保持 750/1334 占位比例；加载失败时卡片仍在、显示失败态而不整块隐藏，卡片可访问名称不变', async () => {
  imageComponent();
  const http = inviteServer({ invite: () => reply(myInvite()) });
  const view = mountInvite(http.api);
  await screen.findAllByText(inviteCode, { exact: false });
  const card = screen.getByRole('button', { name: inviteTexts.posterPreview });
  const img = Array.from(card.querySelectorAll('img')).find(
    (item) => item.getAttribute('src') === posterUrl,
  );
  expect(img, 'poster img inside the poster card').toBeDefined();
  expect(onlyFrame(card)).toBe(frameOf(img!));
  const loading = onlyFrame(card);
  expect(stateOf(loading)).toBe('loading');
  expect(keepsPosterRatio(loading), 'poster frame keeps 750/1334').toBe(true);
  expect(view.container.querySelector(PAGE_BUSY), PAGE_BUSY).toBeNull();

  fireEvent.error(img!);
  // The poster card stays (found again by its unchanged name) and holds the failure state.
  await waitFor(() => expect(stateOf(onlyFrame(posterCard()))).toBe('error'));
  const frame = onlyFrame(posterCard());
  expect(keepsPosterRatio(frame), 'failed poster frame keeps 750/1334').toBe(true);
  expect(shownImgs(frame), 'no broken poster').toEqual([]);
  const failed = squash(frame.textContent);
  expect(failed, 'failure text in the poster frame').not.toBe('');
  expect(failed, 'a text, not a dictionary key').not.toMatch(/^[a-z0-9_.]+$/);
  expect(
    within(frame)
      .getAllByText(/\S/)
      .some((node) => readable(node, view.container)),
    'failure text readable by screen readers',
  ).toBe(true);
});

it('[AC-DSX-48c-WIRING#4] 邀请海报 load 后为已加载态、卡片名称不变；poster_url 为空时仍不显示海报卡与图片', async () => {
  imageComponent();
  const http = inviteServer({ invite: () => reply(myInvite()) });
  const view = mountInvite(http.api);
  await screen.findAllByText(inviteCode, { exact: false });
  const card = screen.getByRole('button', { name: inviteTexts.posterPreview });
  const img = Array.from(card.querySelectorAll('img')).find(
    (item) => item.getAttribute('src') === posterUrl,
  );
  expect(img, 'poster img inside the poster card').toBeDefined();
  expect(stateOf(frameOf(img!))).toBe('loading');
  fireEvent.load(img!);
  await waitFor(() => expect(stateOf(onlyFrame(posterCard()))).toBe('loaded'));
  const frame = onlyFrame(posterCard());
  const shown = shownImgs(frame);
  expect(shown.map((item) => item.getAttribute('src'))).toEqual([posterUrl]);
  expect(squash(frame.textContent)).toBe('');
  view.unmount();

  const none = inviteServer({ invite: () => reply(myInvite({ poster_url: null })) });
  const empty = mountInvite(none.api);
  await screen.findAllByText(inviteCode, { exact: false });
  expect(screen.queryByRole('button', { name: inviteTexts.posterPreview })).toBeNull();
  expect(empty.container.querySelectorAll('img')).toHaveLength(0);
});
