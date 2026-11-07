// @vitest-environment jsdom
// F1-09-qr ①: after a token is issued the preview result shows one antd QRCode whose content is
// exactly couli://r/HomePreview?page_key=<page key>&token=<this token> (contracts/routes.json
// HomePreview: native, no host, params page_key and token only). The QR is read back module by
// module (qr-reader.ts), so a wrong page key or a stale token is red, not just a missing QR.
import { cleanup, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  HOME,
  LIST,
  TOKEN,
  config,
  createServer,
  failure,
  noGray,
  ok,
} from '../admin-home-config/fixtures.ts';
import {
  action,
  button,
  choosePage,
  click,
  editor,
  input,
  loaded,
  mainElement,
  message,
  mount,
  settled,
  FLOW_TIMEOUT,
  QR_PLACEHOLDER,
} from '../admin-home-config/helpers.ts';
import { expectQrName, expectQrText, previewQr, qrRoots } from './helpers.ts';

const PREVIEW = `${HOME}/preview-tokens`;
const SECOND_TOKEN = 'pv_second_token_1111111111111111';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it(
  '[AC-F1-09u-QR#1] 保存草稿后草稿预览：预览区恰一个有可访问名称的二维码，内容恰为 couli://r/HomePreview?page_key=home&token=<本次 token>，页键 / token / 北京时间照旧',
  async () => {
    const server = createServer([noGray()]);
    await mount(server);
    await loaded();
    await input(editor(), '[]');
    await click(button(mainElement(), /保存草稿/));
    await message(/草稿\s*v9|v9\s*草稿/);
    await settled(server);
    await action(button(mainElement(), /草稿预览/));
    await message(new RegExp(TOKEN));
    await settled(server);
    expect(server.requests('POST', PREVIEW).map((entry) => entry.body)).toEqual([{ version: 9 }]);
    const root = previewQr(TOKEN);
    expectQrText(root, `couli://r/HomePreview?page_key=home&token=${TOKEN}`);
    expectQrName(root);
    const text = document.body.textContent ?? '';
    expect(text).not.toContain(QR_PLACEHOLDER);
    expect(text).toMatch(/2026[-/]10[-/]18/);
    expect(text).toMatch(/10:40/);
    expect(text).toMatch(/北京时间|UTC\+8|GMT\+8/);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-09u-QR#2] 非 home 页：二维码的 page_key 取所选页并按 URL 查询串编码（custom:activity_618 → custom%3Aactivity_618）',
  async () => {
    const server = createServer([
      noGray(),
      config({ page_key: 'custom:activity_618', gray_version: null, gray_percent: 0 }),
    ]);
    await mount(server);
    await loaded();
    await settled(server);
    await choosePage('custom:activity_618');
    await waitFor(() =>
      expect(
        server.log.some(
          (entry) =>
            entry.method === 'GET' &&
            decodeURIComponent(entry.path) === `${LIST}/custom:activity_618`,
        ),
      ).toBe(true),
    );
    await settled(server);
    await action(button(mainElement(), /草稿预览/));
    await waitFor(() => expect(server.requests('POST')).toHaveLength(1));
    await settled(server);
    await message(new RegExp(TOKEN));
    expect(decodeURIComponent(server.requests('POST')[0]!.path)).toBe(
      `${LIST}/custom:activity_618/preview-tokens`,
    );
    expectQrText(
      previewQr(TOKEN),
      `couli://r/HomePreview?page_key=custom%3Aactivity_618&token=${TOKEN}`,
    );
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-09u-QR#3] 签发失败不显示二维码；重新签发换了 token 后二维码内容随之更新；再签发失败时不再显示二维码',
  async () => {
    const server = createServer([noGray()]);
    await mount(server);
    await loaded();
    await settled(server);
    async function issue(count: number): Promise<void> {
      await action(button(mainElement(), /草稿预览/));
      await waitFor(() => expect(server.requests('POST', PREVIEW)).toHaveLength(count));
      await settled(server);
    }

    server.once('POST', PREVIEW, () => failure(42901, null, '操作太频繁'));
    await issue(1);
    expect(qrRoots(), 'no QR code when the token was refused').toEqual([]);

    await issue(2);
    await message(new RegExp(TOKEN));
    expectQrText(previewQr(TOKEN), `couli://r/HomePreview?page_key=home&token=${TOKEN}`);

    server.once('POST', PREVIEW, (request) =>
      ok({
        token: SECOND_TOKEN,
        page_key: 'home',
        version: (request.body as { version: number }).version,
        expire_at: '2026-10-18T02:50:00Z',
      }),
    );
    await issue(3);
    await message(new RegExp(SECOND_TOKEN));
    expectQrText(
      previewQr(SECOND_TOKEN),
      `couli://r/HomePreview?page_key=home&token=${SECOND_TOKEN}`,
    );

    server.once('POST', PREVIEW, () => failure(42901, null, '操作太频繁'));
    await issue(4);
    expect(qrRoots(), 'no QR code when the re-issue was refused').toEqual([]);
  },
  FLOW_TIMEOUT,
);
