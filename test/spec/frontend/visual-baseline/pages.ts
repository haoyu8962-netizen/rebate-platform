// DSX-50 (规划/05 §3.11.3, 编排 D10-724 ③): the key pages that have a screenshot baseline. Shared
// by the browser comparison cases (h5 / admin *.browser.test.ts) and the baseline file check
// (baselines.test.ts). Plain data only: no browser or Node imports.

export type Theme = 'light' | 'dark';
export type Surface = 'h5' | 'admin';

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface VisualPage {
  /** File stem of the baselines: __baselines__/<id>-<theme>.png. */
  readonly id: string;
  readonly surface: Surface;
  readonly title: string;
  readonly themes: readonly Theme[];
  readonly viewport: Viewport;
}

/** 11 §4.1: screenshot difference ≤ 1 %, report only for now (a larger one never fails a case). */
export const THRESHOLD_PERCENT = 1;
/** Two screenshots of the same page in one run must differ by less than this. */
export const STABLE_PERCENT = 0.1;

export const H5_VIEWPORT: Viewport = { width: 375, height: 844 };
export const ADMIN_VIEWPORT: Viewport = { width: 1440, height: 900 };

const BOTH: readonly Theme[] = ['light', 'dark'];
const LIGHT: readonly Theme[] = ['light'];

function h5(id: string, title: string): VisualPage {
  return { id, surface: 'h5', title, themes: BOTH, viewport: H5_VIEWPORT };
}

function admin(id: string, title: string): VisualPage {
  return { id, surface: 'admin', title, themes: LIGHT, viewport: ADMIN_VIEWPORT };
}

export const H5_RULES = h5('h5-rules', '规则');
export const H5_HELP = h5('h5-help', '帮助');
export const H5_NOTICES = h5('h5-notices', '公告');
export const H5_EARNINGS = h5('h5-earnings', '收益明细');
export const H5_FIND_ORDER = h5('h5-find-order', '订单找回');
export const H5_MESSAGES = h5('h5-messages', '消息');
export const H5_INVITE = h5('h5-invite', '邀请');

export const ADMIN_LOGIN = admin('admin-login', '登录');
export const ADMIN_DASHBOARD = admin('admin-dashboard', '工作台');
export const ADMIN_ORDERS = admin('admin-orders', '订单列表');
export const ADMIN_WITHDRAWALS = admin('admin-withdrawals', '提现审核');

export const H5_PAGES: readonly VisualPage[] = [
  H5_RULES,
  H5_HELP,
  H5_NOTICES,
  H5_EARNINGS,
  H5_FIND_ORDER,
  H5_MESSAGES,
  H5_INVITE,
];

export const ADMIN_PAGES: readonly VisualPage[] = [
  ADMIN_LOGIN,
  ADMIN_DASHBOARD,
  ADMIN_ORDERS,
  ADMIN_WITHDRAWALS,
];

export function baselineFile(page: VisualPage, theme: Theme): string {
  return `${page.id}-${theme}.png`;
}

export interface BaselineTarget {
  readonly page: VisualPage;
  readonly theme: Theme;
  readonly file: string;
}

/** H5 seven pages × light / dark, admin four pages × light: 18 baselines. */
export const BASELINES: readonly BaselineTarget[] = [...H5_PAGES, ...ADMIN_PAGES].flatMap((page) =>
  page.themes.map((theme) => ({ page, theme, file: baselineFile(page, theme) })),
);
