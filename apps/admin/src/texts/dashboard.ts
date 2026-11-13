// Workbench copy (design-hifi AdmDashboard*, design/specs/admin-dashboard.md; 01 F-ADM-26). Admin
// copy stays here, not in contracts/texts.default.json (规划/03 §9). Card titles follow the boards
// until BR-TEXT-25 admin_dict.* has rows for the to-do keys; the claim breakdown labels repeat
// admin_dict.claim_status.auto_matched / manual_review.

export type DashboardTodoText = {
  /** Card title. */
  readonly title: string;
  /** Name of the page the card opens (「进入…」 and the link name). */
  readonly destination: string;
  /** Permission point printed on the card (the server trims cards by it). */
  readonly permission: string;
};

export const dashboardTexts = {
  menu: '工作台',
  title: '工作台',
  refresh: '刷新',
  retry: '重试',
  readOnly: '本页只读',
  headerNote: (asOf: string): string =>
    `待办为当前值 · 昨日概览按日聚合，更新于 ${asOf} · 本页只读`,
  loading: '正在读取工作台数据…',
  failedTitle: '工作台数据加载失败',
  failedDescription: '网络错误或服务异常，卡片不显示旧数据；左侧菜单仍可用，可直接进入各功能页。',
  todo: {
    heading: '待办',
    hint: '整卡可点，直达对应列表并带上筛选条件；只显示本账号有对应权限点的项',
    empty: '本账号暂无可显示的待办项',
    nothing: '暂无待办',
    oldest: (time: string): string => `最早 ${time}`,
    separator: ' · ',
    enter: (destination: string): string => `进入${destination}`,
    linkName: (title: string, count: string, destination: string): string =>
      `${title} ${count}，进入${destination}`,
    cards: {
      withdraw_review_pending: {
        title: '待审提现',
        destination: '提现审核',
        permission: 'withdraw.review',
      },
      claim_review_pending: {
        title: '待审找回',
        destination: '找回审核',
        permission: 'order.claim',
      },
      settle_bill_pending: {
        title: '待确认月结账单',
        destination: '月结账单',
        permission: 'settle.bill',
      },
      recon_diff_open: {
        title: '未关闭差错单',
        destination: '对账与差错',
        permission: 'fund.recon',
      },
      appeal_pending: {
        title: '待处理申诉',
        destination: '风控 · 申诉',
        permission: 'risk.appeal',
      },
      agent_report_overdue: {
        title: 'AI 举报超 48 小时',
        destination: 'AI 助手记录',
        permission: 'agent.report',
      },
      beneficiary_held_overdue: {
        title: '受益人份额 held 满 30 天',
        destination: '风控 · held 告警',
        permission: 'risk.freeze',
      },
      union_auth_expiring: {
        title: '站长授权到期或失效',
        destination: '联盟账号',
        permission: 'union.account_auth',
      },
    } satisfies Record<string, DashboardTodoText>,
    /** Known breakdown sub-keys per card; any other sub-key is ignored. */
    breakdown: {
      claim_review_pending: {
        auto_matched: '自动匹配待确认',
        manual_review: '人工审核中',
      },
    } as Readonly<Record<string, Readonly<Record<string, string>>>>,
  },
  yesterday: {
    heading: (date: string): string => `昨日概览（${date} 整日）`,
    hint: '与报表同口径、不实时；今日实时数看 Grafana 看板',
    /** No aggregate row at all yet (CT-24zzk, D10-1468). */
    empty: '暂无数据',
    /** The latest row is older than yesterday; same date writing as the heading (D10-1468). */
    asOfDay: (date: string): string => `数据截至 ${date}`,
    links: (day: string): string => `转链数（昨日 ${day}）`,
    linksHint: 'link_logs 创建时间落在昨日',
    orders: '成交订单数（昨日）',
    ordersHint: '按 paid_at 计子订单，不扣之后作废',
    rebate: '预估返利合计（昨日订单）',
    rebateHint: '聚合时刻仍为预估的用户份额',
    newUsers: '新增用户（昨日）',
    newUsersHint: '按注册时间',
  },
  status: {
    heading: '系统状态',
    hint: '资金类状态卡需 fund.view',
    permission: 'fund.view',
    linkName: (title: string, state: string, destination: string): string =>
      `${title} ${state}，进入${destination}`,
    queue: {
      title: '打款队列',
      destination: '打款队列',
      running: '正常，未暂停',
      paused: '已暂停',
      channels: (names: string): string => `通道暂停 ${names}`,
      noChannel: '无',
      channelSeparator: '、',
      hint: '队列暂停或按通道暂停时这里变色，解除在打款队列页',
    },
    channelNames: {
      alipay: '支付宝',
      bank_card: '银行卡',
      wechat: '微信',
    } as Readonly<Record<string, string>>,
    balance: {
      title: '企业支付宝余额 W',
      destination: '平台资金台账',
      fresh: '未过期',
      expired: '已过期',
      unknown: '未接入',
      hint: '金额与录入时间在平台资金台账页看；过期后打款前须重录',
    },
    settle: {
      title: '月结自动结算',
      destination: '紧急开关',
      enabled: '已开放',
      disabled: '已关闭',
      hint: 'settle.auto.enabled · 关闭时账单只能人工确认',
    },
  },
  notice: {
    title: '权限与裁剪',
    lines: [
      '打开本页需 dashboard.view；无该权限点的账号登录后落到第一个有权限的菜单，没有任何权限点的仍落「暂无权限」页。',
      '待办卡按卡对应的操作权限点裁剪（如待审提现需 withdraw.review），服务端只返回有权限的卡；无权限的卡不渲染，不是置灰。',
      '本页不做任何写操作；点卡进入对应列表后再操作。',
    ],
  },
} as const;

export type DashboardTodoKey = keyof typeof dashboardTexts.todo.cards;
