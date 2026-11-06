// Ant Design theme mapped onto the @couli/ui-tokens CSS variables. antd derives hover and active
// shades in JavaScript, so colour tokens need resolved values: they are read from the variables
// at runtime and left at antd's defaults when the variables are absent (no stylesheet loaded).
// Dark mode follows the CSS that is in effect (the tokens' dark blocks set `color-scheme: dark`):
// antd then derives its own shades (overlays, fills, splits) with darkAlgorithm, while every colour
// token still comes from the same variables.
import { tokenValues } from '@couli/ui-tokens';
import { theme as antdTheme, type ThemeConfig } from 'antd';

type ColorToken =
  | 'colorPrimary'
  | 'colorLink'
  | 'colorText'
  | 'colorTextSecondary'
  | 'colorBorder'
  | 'colorBorderSecondary'
  | 'colorBgLayout'
  | 'colorBgContainer'
  | 'colorSuccess'
  | 'colorWarning'
  | 'colorError'
  | 'colorInfo'
  | 'colorInfoHover'
  | 'colorInfoText'
  | 'colorInfoBg'
  | 'colorInfoBorder'
  | 'colorInfoBorderHover';

const COLOR_VARIABLES: readonly (readonly [ColorToken, string])[] = [
  ['colorPrimary', '--color-brand-primary'],
  ['colorLink', '--color-text-link'],
  ['colorText', '--color-text-primary'],
  ['colorTextSecondary', '--color-text-secondary'],
  ['colorBorder', '--color-border-control'],
  ['colorBorderSecondary', '--color-border-subtle'],
  ['colorBgLayout', '--color-background-admin-canvas'],
  ['colorBgContainer', '--color-background-surface'],
  ['colorSuccess', '--color-status-success-text'],
  ['colorWarning', '--color-status-warning-text'],
  ['colorError', '--color-status-error-text'],
  // Info is neutral on the boards (muted panel, no border, secondary icon), not antd blue.
  ['colorInfo', '--color-text-secondary'],
  ['colorInfoHover', '--color-text-secondary'],
  ['colorInfoText', '--color-text-secondary'],
  ['colorInfoBg', '--color-background-muted'],
  ['colorInfoBorder', '--color-background-muted'],
  ['colorInfoBorderHover', '--color-background-muted'],
];

/** CSS pixels per rem: the admin root font size is the browser default. */
const ROOT_FONT_PX = 16;

/** A ui-tokens dimension (`14px`, `0.875rem`) in CSS pixels, the unit antd's numeric tokens use. */
function tokenPx(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(px|rem)$/.exec(value);
  if (match === null) throw new Error(`Unsupported ui-tokens dimension: ${value}`);
  const amount = Number(match[1]);
  return match[2] === 'rem' ? amount * ROOT_FONT_PX : amount;
}

// Dimensions are the same in light and dark, so the light values are read.
const FONT_SIZE = tokenPx(tokenValues.light.font.size.footnote);
const RADIUS = tokenPx(tokenValues.light.radius.small);
const MENU_ITEM_MARGIN_INLINE = tokenPx(tokenValues.light.space['2']);
const BUTTON_PADDING_INLINE = tokenPx(tokenValues.light.space['4']);

/** True when the computed `color-scheme` of `root` is dark only (the dark token blocks). */
export function isDarkScheme(root: Element = document.documentElement): boolean {
  const words = getComputedStyle(root).getPropertyValue('color-scheme').trim().split(/\s+/);
  return words.includes('dark') && !words.includes('light');
}

/** Compares two themes from createAntdTheme: same scheme and same token values. */
export function sameAntdTheme(a: ThemeConfig, b: ThemeConfig): boolean {
  return (
    (a.algorithm === undefined) === (b.algorithm === undefined) &&
    JSON.stringify(a.token) === JSON.stringify(b.token) &&
    JSON.stringify(a.components) === JSON.stringify(b.components)
  );
}

export function createAntdTheme(root: Element = document.documentElement): ThemeConfig {
  const style = getComputedStyle(root);
  // Light mode keeps antd's default algorithm (no `algorithm` key), exactly as before.
  const dark = isDarkScheme(root) ? { algorithm: antdTheme.darkAlgorithm } : {};
  const colors: Partial<Record<ColorToken, string>> = {};
  for (const [token, variable] of COLOR_VARIABLES) {
    const value = style.getPropertyValue(variable).trim();
    if (value !== '') colors[token] = value;
  }
  const menuSelectedBg = style.getPropertyValue('--color-brand-subtle').trim();
  const menuSelectedColor = style.getPropertyValue('--color-brand-primary').trim();
  return {
    ...dark,
    token: {
      ...colors,
      fontFamily: 'var(--font-family-system)',
      fontSize: FONT_SIZE,
      borderRadius: RADIUS,
    },
    components: {
      Button: {
        // TODO(规划/11 §7.1): 按钮高 36 改读 admin.* 令牌 — blocked on DSX-105
        controlHeight: 36,
        fontWeight: 600,
        paddingInline: BUTTON_PADDING_INLINE,
      },
      Input: { controlHeight: 40 },
      Form: { itemMarginBottom: 20, verticalLabelPadding: '0 0 6px' },
      // Shell (design-hifi Adm* boards): 220 wide light sider, 56 high header on the surface.
      Layout: {
        headerHeight: 56,
        headerPadding: '0 24px',
        ...(colors.colorBgContainer === undefined ? {} : { headerBg: colors.colorBgContainer }),
        ...(colors.colorBgLayout === undefined ? {} : { bodyBg: colors.colorBgLayout }),
      },
      // Sider menu: 32 high items, 4 apart; the selected item uses the brand tint tokens.
      Menu: {
        itemHeight: 32,
        itemMarginBlock: 4,
        itemMarginInline: MENU_ITEM_MARGIN_INLINE,
        groupTitleFontSize: 12,
        activeBarBorderWidth: 0,
        ...(menuSelectedBg === '' ? {} : { itemSelectedBg: menuSelectedBg }),
        ...(menuSelectedColor === '' ? {} : { itemSelectedColor: menuSelectedColor }),
      },
    },
  };
}
