// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createElement } from 'react';
import { expect, it } from 'vitest';
import { HelpTip } from '../../../../apps/admin/src/components/help-tip/index.ts';
import { helpText } from './kit.ts';

it('[AC-F1-07ec-HELP-TIP#1] 悬停说明入口时显示说明文字', async () => {
  const user = userEvent.setup();
  render(createElement(HelpTip, { text: helpText }));
  const trigger = screen.getByLabelText('说明');
  expect(screen.queryByText(helpText)).toBeNull();

  await user.hover(trigger);
  expect(await screen.findByText(helpText)).toBeTruthy();
});

it('[AC-F1-07ec-HELP-TIP#2] 键盘聚焦同一入口也能查看说明', async () => {
  const user = userEvent.setup();
  render(createElement(HelpTip, { text: helpText }));

  await user.tab();
  expect(document.activeElement).toBe(screen.getByLabelText('说明'));
  expect(await screen.findByText(helpText)).toBeTruthy();
});
