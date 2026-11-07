// @vitest-environment jsdom
// DSX-46: behaviour and accessibility of the clickable H5 base components. The pressed look and
// the focus ring are checked in a real browser (base-press.browser.test.ts).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement, useState, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import * as Styles from '../../../../apps/h5/src/components/base/styles.ts';
import {
  BASE_COMPONENT_NAMES,
  baseExport,
  type ButtonProps,
  type ButtonVariant,
  type CardProps,
  type ChipProps,
  type ListRowProps,
  type SegmentedProps,
} from './base-api.ts';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const SEGMENT_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '待返现' },
  { value: 'done', label: '已返现' },
] as const;

function isDisabled(element: HTMLElement): boolean {
  return (
    (element instanceof HTMLButtonElement && element.disabled) ||
    element.getAttribute('aria-disabled') === 'true'
  );
}

function interactiveIn(container: HTMLElement): Element | null {
  return container.querySelector('button, a[href], input, [role="button"], [tabindex]');
}

function cardContent(): ReactNode {
  return createElement(
    'div',
    null,
    createElement('span', null, '订单 A123'),
    createElement('span', null, '已返现 ¥3.20'),
  );
}

it('[AC-DSX-46-EXPORTS#1] base/index.ts 导出 Button、Chip、Segmented、Card、ListRow，styles.ts 旧导出保留', () => {
  for (const name of BASE_COMPONENT_NAMES) baseExport(name);
  const legacy = [
    Styles.FOCUS_RING,
    Styles.PRIMARY_BUTTON,
    Styles.SECONDARY_BUTTON,
    Styles.ACTION_ROW,
    Styles.ACTION_IN_ROW,
    Styles.LAYER,
    Styles.TOAST_LAYER,
  ];
  for (const classes of legacy) {
    expect(typeof classes).toBe('string');
    expect(classes.length).toBeGreaterThan(0);
  }
});

it('[AC-DSX-46-BUTTON#1] Button 四种变体都是原生 button，默认 type="button"，点击回调一次', async () => {
  const Button = baseExport<ButtonProps>('Button');
  const user = userEvent.setup();
  const variants: readonly ButtonVariant[] = ['primary', 'secondary', 'text'];
  for (const variant of variants) {
    const onClick = vi.fn();
    render(createElement(Button, { variant, onClick, children: '提交订单' }));
    const button = screen.getByRole('button', { name: '提交订单' });
    expect(button.tagName, variant).toBe('BUTTON');
    expect(button.getAttribute('type'), variant).toBe('button');
    expect(button.getAttribute('aria-busy'), variant).not.toBe('true');
    await user.click(button);
    expect(onClick, variant).toHaveBeenCalledTimes(1);
    cleanup();
  }
  const onClose = vi.fn();
  render(
    createElement(Button, {
      variant: 'icon',
      'aria-label': '关闭',
      onClick: onClose,
      children: createElement(
        'svg',
        { viewBox: '0 0 24 24', 'aria-hidden': true },
        createElement('path', { d: 'M6 6l12 12M18 6L6 18' }),
      ),
    }),
  );
  const icon = screen.getByRole('button', { name: '关闭' });
  expect(icon.tagName).toBe('BUTTON');
  expect(icon.getAttribute('type')).toBe('button');
  await user.click(icon);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('[AC-DSX-46-BUTTON#2] Button 在表单里默认不提交，type="submit" 时提交', async () => {
  const Button = baseExport<ButtonProps>('Button');
  const user = userEvent.setup();
  const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
  render(
    createElement(
      'form',
      { onSubmit },
      createElement(Button, { variant: 'secondary', children: '换一张' }),
      createElement(Button, { variant: 'primary', type: 'submit', children: '提交订单' }),
    ),
  );
  await user.click(screen.getByRole('button', { name: '换一张' }));
  expect(onSubmit).not.toHaveBeenCalled();
  const submit = screen.getByRole('button', { name: '提交订单' });
  expect(submit.getAttribute('type')).toBe('submit');
  await user.click(submit);
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

it('[AC-DSX-46-BUTTON#3] Button loading：按钮内加载指示、aria-busy，连点不回调也不提交，结束后恢复', () => {
  const Button = baseExport<ButtonProps>('Button');
  const onClick = vi.fn();
  const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
  const view = render(
    createElement(
      'form',
      { onSubmit },
      createElement(Button, { type: 'submit', loading: true, onClick, children: '提交订单' }),
    ),
  );
  const button = screen.getByRole('button', { name: '提交订单' });
  expect(button.tagName).toBe('BUTTON');
  expect(button.getAttribute('aria-busy')).toBe('true');
  expect(button.querySelector('[data-slot="button-loading"]')).not.toBeNull();
  for (let i = 0; i < 3; i += 1) fireEvent.click(button);
  expect(onClick).not.toHaveBeenCalled();
  expect(onSubmit).not.toHaveBeenCalled();
  view.rerender(
    createElement(
      'form',
      { onSubmit },
      createElement(Button, { type: 'submit', loading: false, onClick, children: '提交订单' }),
    ),
  );
  const ready = screen.getByRole('button', { name: '提交订单' });
  expect(ready.getAttribute('aria-busy')).not.toBe('true');
  expect(ready.querySelector('[data-slot="button-loading"]')).toBeNull();
  fireEvent.click(ready);
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

it('[AC-DSX-46-BUTTON#4] Button disabled 时标为禁用且不回调', () => {
  const Button = baseExport<ButtonProps>('Button');
  const onClick = vi.fn();
  render(
    createElement(Button, { variant: 'primary', disabled: true, onClick, children: '提交订单' }),
  );
  const button = screen.getByRole('button', { name: '提交订单' });
  expect(isDisabled(button)).toBe(true);
  fireEvent.click(button);
  expect(onClick).not.toHaveBeenCalled();
});

it('[AC-DSX-46-CHIP#1] Chip 选中态用 aria-pressed，点击、Enter、空格切换并回调，禁用时不回调', async () => {
  const Chip = baseExport<ChipProps>('Chip');
  const user = userEvent.setup();
  const onSelectedChange = vi.fn<(selected: boolean) => void>();
  function Harness(): ReactNode {
    const [selected, setSelected] = useState(false);
    return createElement(Chip, {
      selected,
      children: '待返现',
      onSelectedChange: (next: boolean) => {
        onSelectedChange(next);
        setSelected(next);
      },
    });
  }
  render(createElement(Harness));
  const chip = (): HTMLElement => screen.getByRole('button', { name: '待返现' });
  expect(chip().getAttribute('aria-pressed')).toBe('false');
  await user.click(chip());
  expect(onSelectedChange).toHaveBeenLastCalledWith(true);
  expect(chip().getAttribute('aria-pressed')).toBe('true');
  await user.click(chip());
  expect(onSelectedChange).toHaveBeenLastCalledWith(false);
  expect(chip().getAttribute('aria-pressed')).toBe('false');
  chip().blur();
  await user.tab();
  expect(document.activeElement).toBe(chip());
  await user.keyboard('{Enter}');
  expect(onSelectedChange).toHaveBeenLastCalledWith(true);
  expect(chip().getAttribute('aria-pressed')).toBe('true');
  await user.keyboard(' ');
  expect(onSelectedChange).toHaveBeenLastCalledWith(false);
  expect(onSelectedChange).toHaveBeenCalledTimes(4);
  cleanup();

  const onDisabled = vi.fn<(selected: boolean) => void>();
  render(
    createElement(Chip, {
      selected: true,
      disabled: true,
      onSelectedChange: onDisabled,
      children: '已返现',
    }),
  );
  const disabled = screen.getByRole('button', { name: '已返现' });
  expect(disabled.getAttribute('aria-pressed')).toBe('true');
  expect(isDisabled(disabled)).toBe(true);
  fireEvent.click(disabled);
  expect(onDisabled).not.toHaveBeenCalled();
});

it('[AC-DSX-46-SEGMENTED#1] Segmented 是命名的 radiogroup，选中项 aria-checked，点击回调新值', async () => {
  const Segmented = baseExport<SegmentedProps>('Segmented');
  const user = userEvent.setup();
  const onChange = vi.fn<(value: string) => void>();
  function Harness(): ReactNode {
    const [value, setValue] = useState('pending');
    return createElement(Segmented, {
      'aria-label': '订单状态',
      options: SEGMENT_OPTIONS,
      value,
      onChange: (next: string) => {
        onChange(next);
        setValue(next);
      },
    });
  }
  render(createElement(Harness));
  const group = screen.getByRole('radiogroup', { name: '订单状态' });
  const radios = within(group).getAllByRole('radio');
  expect(radios).toHaveLength(3);
  for (const [i, name] of ['全部', '待返现', '已返现'].entries()) {
    expect(radios[i], name).toBe(within(group).getByRole('radio', { name }));
  }
  expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual([
    'false',
    'true',
    'false',
  ]);
  await user.click(within(group).getByRole('radio', { name: '全部' }));
  expect(onChange).toHaveBeenLastCalledWith('all');
  expect(
    within(group)
      .getAllByRole('radio')
      .map((radio) => radio.getAttribute('aria-checked')),
  ).toEqual(['true', 'false', 'false']);
});

it('[AC-DSX-46-SEGMENTED#2] Segmented 只有选中项可 Tab 到，左右方向键循环切换并移动焦点', async () => {
  const Segmented = baseExport<SegmentedProps>('Segmented');
  const user = userEvent.setup();
  const onChange = vi.fn<(value: string) => void>();
  function Harness(): ReactNode {
    const [value, setValue] = useState('pending');
    return createElement(Segmented, {
      'aria-label': '订单状态',
      options: SEGMENT_OPTIONS,
      value,
      onChange: (next: string) => {
        onChange(next);
        setValue(next);
      },
    });
  }
  render(createElement(Harness));
  const radio = (name: string): HTMLElement => screen.getByRole('radio', { name });
  expect([radio('全部').tabIndex, radio('待返现').tabIndex, radio('已返现').tabIndex]).toEqual([
    -1, 0, -1,
  ]);
  await user.tab();
  expect(document.activeElement).toBe(radio('待返现'));
  const steps = [
    { key: '{ArrowRight}', value: 'done', label: '已返现' },
    { key: '{ArrowRight}', value: 'all', label: '全部' },
    { key: '{ArrowLeft}', value: 'done', label: '已返现' },
    { key: '{ArrowLeft}', value: 'pending', label: '待返现' },
  ] as const;
  for (const step of steps) {
    await user.keyboard(step.key);
    expect(onChange, step.key).toHaveBeenLastCalledWith(step.value);
    expect(radio(step.label).getAttribute('aria-checked'), step.label).toBe('true');
    expect(document.activeElement, step.label).toBe(radio(step.label));
    expect(radio(step.label).tabIndex, step.label).toBe(0);
  }
  expect(onChange).toHaveBeenCalledTimes(4);
});

it('[AC-DSX-46-CARD#1] Card 不传 onClick 时是普通容器，没有按钮、链接或 tab 停靠点', async () => {
  const Card = baseExport<CardProps>('Card');
  const user = userEvent.setup();
  const view = render(createElement(Card, { children: cardContent() }));
  expect(view.container.textContent).toContain('订单 A123');
  expect(view.container.textContent).toContain('已返现 ¥3.20');
  expect(interactiveIn(view.container)).toBeNull();
  await user.tab();
  expect(document.activeElement).toBe(document.body);
});

it('[AC-DSX-46-CARD#2] Card 传 onClick 时整卡是一个有名字的按钮，点击、Enter、空格都触发', async () => {
  const Card = baseExport<CardProps>('Card');
  const user = userEvent.setup();
  const onClick = vi.fn();
  render(createElement(Card, { onClick, children: cardContent() }));
  const card = screen.getByRole('button', { name: /订单 A123/ });
  expect(card.textContent).toContain('已返现 ¥3.20');
  await user.click(screen.getByText('已返现 ¥3.20'));
  expect(onClick).toHaveBeenCalledTimes(1);
  card.blur();
  await user.tab();
  expect(document.activeElement).toBe(card);
  await user.keyboard('{Enter}');
  expect(onClick).toHaveBeenCalledTimes(2);
  await user.keyboard(' ');
  expect(onClick).toHaveBeenCalledTimes(3);
  cleanup();

  render(
    createElement(Card, { onClick, 'aria-label': '查看订单 A123 详情', children: cardContent() }),
  );
  expect(screen.getByRole('button', { name: '查看订单 A123 详情' }).textContent).toContain(
    '已返现 ¥3.20',
  );
});

it('[AC-DSX-46-LISTROW#1] ListRow 依次显示标题、副标题、右侧附件，不可点时没有交互元素', async () => {
  const ListRow = baseExport<ListRowProps>('ListRow');
  const user = userEvent.setup();
  const view = render(
    createElement(ListRow, {
      title: '收款账户',
      subtitle: '支付宝 138****0000',
      trailing: createElement('span', null, '已绑定'),
    }),
  );
  const title = screen.getByText('收款账户');
  const subtitle = screen.getByText('支付宝 138****0000');
  const trailing = screen.getByText('已绑定');
  const follows = (a: Node, b: Node): boolean =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  expect(follows(title, subtitle), 'subtitle after title').toBe(true);
  expect(follows(subtitle, trailing), 'trailing after subtitle').toBe(true);
  expect(interactiveIn(view.container)).toBeNull();
  await user.tab();
  expect(document.activeElement).toBe(document.body);
});

it('[AC-DSX-46-LISTROW#2] ListRow 传 onClick 时整行是一个有名字的按钮，点击、Enter、空格都触发', async () => {
  const ListRow = baseExport<ListRowProps>('ListRow');
  const user = userEvent.setup();
  const onClick = vi.fn();
  render(
    createElement(ListRow, {
      title: '收款账户',
      subtitle: '支付宝 138****0000',
      trailing: createElement(
        'svg',
        { viewBox: '0 0 24 24', 'aria-hidden': true },
        createElement('path', { d: 'M9 6l6 6-6 6' }),
      ),
      onClick,
    }),
  );
  const row = screen.getByRole('button', { name: /收款账户/ });
  expect(row.textContent).toContain('支付宝 138****0000');
  expect(row.querySelector('svg')).not.toBeNull();
  await user.click(screen.getByText('支付宝 138****0000'));
  expect(onClick).toHaveBeenCalledTimes(1);
  row.blur();
  await user.tab();
  expect(document.activeElement).toBe(row);
  await user.keyboard('{Enter}');
  expect(onClick).toHaveBeenCalledTimes(2);
  await user.keyboard(' ');
  expect(onClick).toHaveBeenCalledTimes(3);
});

it('[AC-DSX-46-TAP#1] H5 全局样式把 -webkit-tap-highlight-color 设为透明', () => {
  const path = resolve(import.meta.dirname, '../../../../apps/h5/src/shared/styles/index.css');
  const css = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const transparent = String.raw`(?:transparent|rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\))`;
  const declaration = new RegExp(
    String.raw`-webkit-tap-highlight-color\s*:\s*${transparent}\s*(?:!important\s*)?[;}]`,
    'i',
  );
  expect(css).toMatch(declaration);
});
