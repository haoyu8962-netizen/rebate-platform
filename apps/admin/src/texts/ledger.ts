// 余额流水页文案（资源 ledger，菜单 资金 / 余额流水；F1-08fa 只读：按 UID 查资金摘要与流水；
// F1-08fb 标题行【导出当前筛选】走 adminCreateExport resource=ledger；字段以契约
// adminGetUserFundSummary、adminListLedgerEntries、adminCreateExport 为准）。流水类型、子户、冻结种类的
// 中文名只从后台字典读（BR-TEXT-25 admin_dict.*，contracts/texts.admin.default.json），缺键显示
// 编码，所以这里不写这些名字。错误措辞按 contracts/error-codes.yaml。
export const ledgerTexts = {
  title: '余额流水',
  dash: '—',
  query: '查询',
  reset: '重置',
  retry: '重试',
  exportsEntry: '导出记录',
  /** F1-08fb: adminCreateExport resource=ledger with the applied user and filters. */
  export: {
    action: '导出当前筛选',
    created: (id: string): string => `已创建导出任务 ${id}，到导出记录下载`,
    /** 10403 */
    forbidden: '当前账号没有导出权限，未创建导出任务。',
    /** 20001 data.fields with accounting_date_from / accounting_date_to */
    dateRange: '会计日起不能晚于止，未创建导出任务。',
    /** Any other definite refusal (other 20001, 5xx with the unified envelope, …). */
    failed: '导出任务未能创建，请稍后再试。',
    /** No answer in the unified envelope: the task may exist. */
    unknown: '导出任务可能已创建，请先到【导出记录】核对，再决定是否重新导出。',
  },
  uid: {
    label: '用户 UID',
    placeholder: '输入用户 UID 后点【查询】',
    required: '请输入用户 UID',
    /** 20001 data.fields=[user_id]: unknown, malformed or of another app. */
    unknown: 'UID 不存在或格式不对',
  },
  forbiddenTitle: '无权限查看余额流水',
  forbiddenDescription: '当前账号没有资金查看权限点（fund.view 或 user.lookup），请联系超管勾选。',
  readOnlyNotice: '本页只读：查看单个用户的资金摘要与余额流水，不能在这里改动余额。',
  summary: {
    title: '资金摘要',
    loading: '资金摘要加载中…',
    failed: '资金摘要加载失败',
    failedHint: '网络错误或服务异常，点【重试】重新读取资金摘要。',
    userId: '用户 UID',
    available: '可用余额',
    frozen: '冻结金额',
    negativeSince: '负余额起始日',
    withdrawn: '已提现',
    block: '提现限制',
    noHold: '无',
    holdJoiner: '、',
  },
  list: {
    title: '流水明细',
    loading: '余额流水加载中…',
    failed: '余额流水加载失败',
    failedHint: '网络错误或服务异常，点【重试】按当前条件重新读取。',
    invalid: '查询条件不正确，请核对后再查。',
    empty: '暂无余额流水',
    total: (total: number): string => `共 ${total} 条`,
  },
  filter: {
    ledgerType: '流水类型',
    subType: '子类型',
    subAccount: '子户',
    dateFrom: '会计日起',
    dateTo: '会计日止',
    ref: '业务单号',
    all: '全部',
    subTypePlaceholder: '编码，如 INDIRECT',
    datePlaceholder: 'YYYY-MM-DD',
    refPlaceholder: '订单号或提现单号等',
    dateInvalid: '日期写成 YYYY-MM-DD',
    dateRange: '会计日起不能晚于会计日止',
  },
  columns: {
    bookedAt: '记账时间',
    accountingDate: '会计日',
    ledgerType: '流水类型',
    subType: '子类型',
    subAccount: '子户',
    amount: '金额',
    balanceAfter: '变动后余额',
    voucher: '凭证号',
    bizId: '业务单号',
  },
} as const;
