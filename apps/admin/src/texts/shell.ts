// Admin shell copy (design-hifi AdmHomeNoPerm, AdmStepUp). Admin copy stays here, not in
// contracts/texts.default.json (规划/03 §9).
export const shellTexts = {
  brand: '凑狸管理后台',
  brandLogo: '凑',
  mainNavigation: '主导航',
  breadcrumb: '面包屑',
  // The one sidebar toggle in the top bar; both names say what it acts on (侧栏).
  collapseSidebar: '收起侧栏',
  expandSidebar: '展开侧栏',
  nonProductionEnvironment: '测试环境',
  logout: '退出',
  welcomeCrumb: '欢迎',
  welcomeTitle: '欢迎使用凑狸管理后台',
  welcomeHint: '从左侧菜单选择要处理的业务。',
  loading: '正在加载权限…',
  loadFailedTitle: '权限加载失败',
  loadFailedDescription: '暂时取不到本账号的权限点，请稍后重试。',
  retry: '重试',
  pagePendingDescription: '该页面尚未接入，接入后在这里显示。',
} as const;

// 契约里仍标 planned 的接口（D10-284）：页面 / 页签占位与置灰按钮的标记。
export const plannedTexts = {
  title: '功能开发中',
  description: '这项功能的接口还在开发，上线后这里会自动恢复。',
} as const;

export const noPermissionTexts = {
  title: '还没有分配权限',
  description: (username: string): string =>
    `账号 ${username} 已经可以登录，但超级管理员还没有给它勾选任何权限点，所以左侧菜单里没有业务页面。请联系超管在「后台账号与权限」为你勾选需要的权限点，勾选后刷新本页即可看到对应菜单。`,
  refresh: '刷新权限',
  viewReports: '查看报表',
  availableTitle: '现在可以做的',
  reportsTitle: '报表',
  reportsDescription: '转链与成交漏斗、Agent 看板登录即可看；资金看板要 fund.view 权限点',
  auditLogsTitle: '操作日志',
  auditLogsDescription: '只能看本人的操作记录；看全部日志要 audit.view_all 权限点',
  accountInfo: (username: string, displayName: string, count: number): string =>
    `账号信息：${username} · ${displayName} · 普通账号 · ${count} 项权限点`,
} as const;

// Local preview accounts (main.tsx, development builds only).
export const previewTexts = {
  superName: '超管',
  noPermissionName: '客服小狸',
} as const;
