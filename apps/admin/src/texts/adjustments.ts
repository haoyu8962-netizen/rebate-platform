// 调账与核销页文案（资源 adjustments，菜单 资金 / 调账与核销；F1-08ca 只读：调账单列表与详情、坏账核销
// 候选单）。调账单状态、原因码、候选单状态的中文名只从后台字典读（BR-TEXT-25
// admin_dict.admin_adjustments.*、admin_dict.bad_debt_writeoff.*，contracts/texts.admin.default.json），
// 缺键显示编码，所以这里不写这些名字。方向、关联单据类型、对方科目按 contracts/enums/fund.yaml 的值名。
export const adjustmentsTexts = {
  title: '调账与核销',
  dash: '—',
  /** created_by null: a form the system prefilled. */
  system: '系统',
  readOnlyNotice:
    '新建调账、红冲、批准与驳回系统预填单、批准坏账核销等操作尚未接入，接口定稿后开放；本页先提供只读查看。',
  forbidden: '无权限查看调账与核销',
  forbiddenDescription:
    '当前账号缺少资金权限点（fund.adjust、fund.writeoff 或 fund.view），请联系超管勾选。',
  retry: '重试',
  query: '查询',
  reset: '重置',
  all: '全部',
  total: (total: number): string => `共 ${total} 张`,
  tabs: {
    adjustments: '调账单',
    writeoffs: '坏账核销',
  },
  adjustments: {
    loading: '正在加载调账单…',
    empty: '暂无调账单',
    failed: '调账单加载失败',
    failedDescription: '网络错误或服务异常，点【重试】重新请求。',
    reversed: '已红冲',
    detailEntry: '详情',
    filter: {
      status: '状态',
      reason: '原因',
      user: '用户 ID',
    },
    columns: {
      id: '调账单号',
      user: '用户',
      direction: '方向',
      amount: '金额',
      reason: '原因',
      status: '状态',
      reversal: '红冲',
      creator: '创建人',
      created: '创建时间',
      actions: '操作',
    },
  },
  writeoffs: {
    loading: '正在加载核销候选单…',
    empty: '暂无核销候选单',
    failed: '核销候选单加载失败',
    failedDescription: '网络错误或服务异常，点【重试】重新请求。',
    columns: {
      id: '候选单号',
      user: '用户',
      since: '负余额起始日',
      days: '负余额天数',
      candidate: '生成时金额',
      available: '当前可用余额',
      frozen: '冻结',
      status: '状态',
      created: '生成时间',
    },
  },
  detail: {
    title: '调账单详情',
    loading: '正在读取调账单…',
    missing: '调账单不存在或已不可见',
    failed: '调账单读取失败',
    forbidden: '无权限查看该调账单',
    refsTitle: '关联单据',
    noRefs: '无关联单据',
    fields: {
      id: '调账单号',
      user: '用户',
      direction: '方向',
      amount: '金额',
      reason: '原因',
      status: '状态',
      subject: '对方科目',
      note: '说明',
      voucher: '凭证',
      reverses: '原调账单',
      reversedBy: '红冲单',
      creator: '创建人',
      created: '创建时间',
      reviewer: '审核人',
      reviewed: '审核时间',
      rejectNote: '驳回原因',
    },
    refColumns: {
      type: '单据类型',
      id: '单据号',
    },
  },
  /** contracts/enums/fund.yaml admin_adjustment_direction. */
  direction: {
    increase: '调增',
    decrease: '调减',
  },
  /** contracts/enums/fund.yaml admin_adjustment_ref_type. */
  refType: {
    recon_diff: '差错单',
    withdrawal: '提现单',
    order: '子订单',
    account_deletion: '注销单',
  },
  /** contracts/enums/fund.yaml admin_adjustment_contra_subject. */
  subject: {
    COMMISSION_REVENUE: '佣金收入',
    UNION_RECEIVABLE: '联盟应收',
    BAD_DEBT: '坏账',
    MKT_EXPENSE: '营销费用',
    CASH_ALIPAY: '支付宝现金',
    CASH_WECHAT: '微信现金',
    CASH_BANK: '银行现金',
  },
  /** 对方科目连同平台（contra_platform，只 UNION_RECEIVABLE 有）。 */
  subjectWithPlatform: (subject: string, platform: string): string => `${subject}（${platform}）`,
} as const;
