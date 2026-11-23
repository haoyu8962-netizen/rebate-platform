// Copy of the shared admin list components (F1-07ec, 订单管理标准化 A 段): data table, filter bar,
// stat cards, copy text, help tip, product / member cells and the detail drawer. 08 has no keys
// for these: agent default wording, registered as admin.components.*.
export const componentsTexts = {
  /** Shown for a missing value (null amount, null detail field). */
  placeholder: '—',
  dataTable: {
    columnSettings: '列设置',
    moveUp: (title: string): string => `上移 ${title}`,
    moveDown: (title: string): string => `下移 ${title}`,
    loadFailed: '加载失败',
    retry: '重试',
    empty: '暂无数据',
    total: (total: number): string => `共 ${total} 条`,
  },
  filterBar: {
    submit: '查询',
    reset: '重置',
    more: '更多条件',
    collapse: '收起',
    rangeSeparator: '至',
  },
  statCards: {
    expand: '展开',
    collapse: '收起',
  },
  copyText: {
    copy: '复制',
    copied: '已复制',
    failed: '复制失败',
  },
  helpTip: {
    label: '说明',
  },
  productCell: {
    amount: '付款金额',
    commissionRate: '佣金比例',
    estimatedCommission: '预估佣金',
    shop: '店铺',
    paidAt: '付款时间',
  },
  memberCell: {
    unattributed: '未归因',
  },
} as const;
