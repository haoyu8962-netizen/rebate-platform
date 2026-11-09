import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { inviteTexts } from '../../../../texts/invite.ts';
import { CodeCard } from './invite-page.tsx';

// 单元测试：原生桥是内存假实现，只记下预览调用。
const calls = vi.hoisted(() => [] as { method: unknown; params: unknown }[]);
vi.mock('@couli/bridge-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@couli/bridge-sdk')>()),
  has: (method: string) => (method === 'media.previewImage' ? method : null),
  call: (method: unknown, params: unknown) => {
    calls.push({ method, params });
    return Promise.resolve({});
  },
}));

afterEach(() => {
  cleanup();
  calls.length = 0;
});

const A = 'https://media.example.invalid/posters/a.png';
const B = 'https://media.example.invalid/posters/b.png';

function card(poster: string) {
  return (
    <CodeCard code="K7M2QX" link="https://example.invalid/i" poster={poster} notify={() => {}} />
  );
}

function poster(): HTMLElement {
  return screen.getByRole('button', { name: inviteTexts.posterPreview });
}

function img(url: string): HTMLImageElement {
  const found = Array.from(document.querySelectorAll('img')).find((item) => item.src === url);
  expect(found, url).toBeDefined();
  return found!;
}

it('海报 A 加载失败时卡片 aria-disabled，点了不开预览', async () => {
  render(card(A));
  fireEvent.error(img(A));
  expect(poster().getAttribute('aria-disabled')).toBe('true');
  await userEvent.click(poster());
  expect(calls).toEqual([]);
});

it('海报 A 失败 → 换 B → 换回 A 且这次加载成功：卡片可点，预览 A', async () => {
  const view = render(card(A));
  fireEvent.error(img(A));
  expect(poster().getAttribute('aria-disabled')).toBe('true');
  view.rerender(card(B));
  view.rerender(card(A));
  fireEvent.load(img(A));
  expect(poster().getAttribute('aria-disabled')).not.toBe('true');
  await userEvent.click(poster());
  expect(calls).toEqual([{ method: 'media.previewImage', params: { urls: [A] } }]);
});

it('海报 A 失败 → 换 B → 换回 A 仍失败：卡片仍不可点', async () => {
  const view = render(card(A));
  fireEvent.error(img(A));
  view.rerender(card(B));
  fireEvent.load(img(B));
  expect(poster().getAttribute('aria-disabled')).not.toBe('true');
  view.rerender(card(A));
  fireEvent.error(img(A));
  expect(poster().getAttribute('aria-disabled')).toBe('true');
  await userEvent.click(poster());
  expect(calls).toEqual([]);
});
