// @vitest-environment jsdom
// DSX-47a (FU-H5-RETRY-BUNDLE): the 【重试】 control of the H5 load-failure page is the base Button
// (components/base, primary variant: the design's main button), so it renders exactly the markup
// the base Button renders for the same label, with or without `fullWidth`. Accessible name, text
// and click behaviour stay as in the frozen h5-whitescreen/retry-page.test.ts.
import { createElement } from 'react';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Button } from '../../../../apps/h5/src/components/base/index.ts';
import { RetryPage } from '../../../../apps/h5/src/components/retry/index.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Markup of the base primary Button labelled 重试 (React does not render handlers as attributes). */
function basePrimaryButtons(): string[] {
  return [false, true].map((fullWidth) => {
    const view = render(createElement(Button, { fullWidth, onClick: vi.fn() }, '重试'));
    const html = within(view.container).getByRole('button', { name: '重试' }).outerHTML;
    view.unmount();
    return html;
  });
}

it('[AC-DSX-47a-RENDER#1] 重试按钮渲染为基础件 Button 的主按钮（与 Button 同标签渲染的 DOM 一致），点击仍只调用一次 onRetry', () => {
  const expected = basePrimaryButtons();
  const onRetry = vi.fn();
  const view = render(createElement(RetryPage, { onRetry }));
  const button = within(view.container).getByRole('button', { name: '重试' });
  expect(expected, 'RetryPage button markup equals the base primary Button').toContain(
    button.outerHTML,
  );
  fireEvent.click(button);
  expect(onRetry).toHaveBeenCalledTimes(1);
});
