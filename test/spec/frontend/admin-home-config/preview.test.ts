// @vitest-environment jsdom
import { act, cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HOME, TOKEN, createServer, noGray } from './fixtures.ts';
import {
  action,
  button,
  click,
  editor,
  enabled,
  expectSinglePreviewQr,
  input,
  loaded,
  mainElement,
  message,
  mount,
  noStepUp,
  PREVIEW_LINK,
  QR_PLACEHOLDER,
  qrPlaceholderPending,
  settled,
  FLOW_TIMEOUT,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it(
  '[AC-F1-09l-PREVIEW#1] 当前草稿 token 签发双击一次，只传 version；显示页键、token、北京时间且不造二维码',
  async () => {
    const server = createServer([noGray()]);
    await mount(server);
    await loaded();
    // Select the newly saved draft, not the initial latest version or unsaved text.
    await input(editor(), '[]');
    await click(button(mainElement(), /保存草稿/));
    await message(/草稿\s*v9|v9\s*草稿/);
    await settled(server);
    const path = `${HOME}/preview-tokens`;
    const release = server.hold('POST', path);
    try {
      await action(button(mainElement(), /草稿预览/), true);
      await waitFor(() => expect(server.requests('POST', path)).toHaveLength(1));
      expect(server.requests('POST', path)[0]!.body).toEqual({ version: 9 });
      expect(
        within(mainElement())
          .queryAllByRole('button', { name: /草稿预览/ })
          .every((node) => !enabled(node)),
      ).toBe(true);
    } finally {
      await act(async () => release());
    }
    await message(new RegExp(TOKEN));
    await settled(server);
    // Transition (F1-09ut): the dictionary placeholder picks the branch; the page must agree with it.
    const pending = qrPlaceholderPending();
    const raw = document.body.textContent ?? '';
    // New branch: the only allowed `://` is the exact HomePreview deep link for this token.
    const text = pending ? raw : raw.split(PREVIEW_LINK).join(' ');
    expect(raw).toContain('home');
    if (pending) expect(raw).toContain('二维码待深链定稿');
    else expect(raw).not.toContain(QR_PLACEHOLDER);
    expect(raw).toMatch(/2026[-/]10[-/]18/);
    expect(raw).toMatch(/10:40/);
    expect(raw).toMatch(/北京时间|UTC\+8|GMT\+8/);
    expect(text).not.toMatch(
      /:\/\/|(?:localhost|127\.0\.0\.1|[a-z0-9-]+\.(?:com|cn|net|invalid))\b/i,
    );
    for (const node of document.querySelectorAll(
      'main [href], main [src], [role="dialog"] [href], [role="dialog"] [src]',
    )) {
      expect(node.getAttribute('href') ?? node.getAttribute('src') ?? '').not.toMatch(
        /:\/\/|^\/\//,
      );
    }
    if (pending)
      expect(document.querySelector('canvas, .ant-qrcode, img[alt*="二维码"]')).toBeNull();
    else expectSinglePreviewQr();
    expect(server.requests('POST', path)).toHaveLength(1);
    noStepUp(server);
  },
  FLOW_TIMEOUT,
);
