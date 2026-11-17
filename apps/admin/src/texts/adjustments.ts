// 调账与核销页文案（资源 adjustments，菜单 资金 / 调账与核销；F1-08ca 只读：调账单列表与详情、坏账核销
// 候选单；F1-08cb 新建调账与红冲，一步提交并生效；F1-08cc 批准 / 驳回系统预填单；F1-08cd 批准坏账核销）。调账单状态、原因码、候选单状态的中文名只从后台字典读（BR-TEXT-25
// admin_dict.admin_adjustments.*、admin_dict.bad_debt_writeoff.*，contracts/texts.admin.default.json），
// 缺键显示编码，所以这里不写这些名字。方向、关联单据类型、对方科目按 contracts/enums/fund.yaml 的值名。
export const adjustmentsTexts = {
  title: '调账与核销',
  dash: '—',
  /** created_by null: a form the system prefilled. */
  system: '系统',
  readOnlyNotice:
    '新建调账与红冲一步提交并生效；系统预填的待批准单经【批准】批准或驳回；待批准的坏账核销候选单经【批准核销】短信验证后核销。',
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
    reverseEntry: '红冲',
    approveEntry: '批准',
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
      actions: '操作',
    },
    approveEntry: '批准核销',
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
  /** contracts/enums/platform.yaml platform（后台平台名）。 */
  platform: {
    taobao: '淘宝',
    jd: '京东',
    pdd: '拼多多',
    meituan: '美团',
    vip: '唯品会',
    douyin: '抖音',
    eleme: '饿了么',
    kuaishou: '快手',
    suning: '苏宁',
  },
  /** 新建调账抽屉与红冲对话框（adminCreateAdjustment，fund.adjust，短信档二次验证）。 */
  write: {
    createEntry: '新建调账',
    createTitle: '新建调账',
    oneStep:
      '一步提交并生效：短信验证通过后立即记账，不保存待批、不可撤回；已生效的调账只能整笔红冲后另开新单。',
    submit: '提交并短信验证',
    cancel: '取消',
    addRef: '添加单据',
    removeRef: '移除',
    noRefs: '尚未添加关联单据',
    otherRefsHint: '原因码为「其他」且没有可关联单据时，在原因说明里写明客服处理说明代替。',
    payoutSubjectHint: '打款追回的对方科目由服务端按提现通道取现金科目，不需选择。',
    preview: (user: string, direction: string, amount: string, reason: string): string =>
      `预览：用户 ${user} ${direction} ${amount}，原因：${reason}`,
    created: (adjustId: string): string => `调账已生效，调账单号 ${adjustId}`,
    reversed: (adjustId: string): string => `红冲已生效，红冲单号 ${adjustId}`,
    /** 成功提示的余额两行（AdminAdjustmentExecuted 的 available_before_fen / available_after_fen）。 */
    createdBefore: (amount: string): string => `调账前可用余额：${amount}`,
    createdAfter: (amount: string): string => `调账后可用余额：${amount}`,
    reversedBefore: (amount: string): string => `红冲前可用余额：${amount}`,
    reversedAfter: (amount: string): string => `红冲后可用余额：${amount}`,
    /** 提交没拿到带统一外壳的回答（网络错误、无法解析）：结果未知，只能原样重试或去列表核对。 */
    unknown:
      '上次提交结果未知：可能已经生效。请按【重试】用原内容原样重新提交（不会重复记账），或按【去列表核对】查看是否已生效。',
    retry: '重试',
    check: '去列表核对',
    /** StepUpModal 的「本次操作」。 */
    createOperation: '新建调账（一步提交并生效）',
    reverseOperation: '红冲调账单（整笔冲回）',
    /** 短信发往的号码（权限快照没有掩码号码时的说法）。 */
    verifyPhone: '本账号登记的验证手机号',
    labels: {
      user: '用户 ID',
      direction: '方向',
      amount: '金额（元）',
      reason: '原因码',
      refType: '单据类型',
      refId: '单据号',
      note: '原因说明',
      subject: '对方科目',
      platform: '平台',
    },
    refColumns: {
      type: '单据类型',
      id: '单据号',
      actions: '操作',
    },
    reverse: {
      title: '红冲调账单',
      notice:
        '红冲按原调账单整笔冲回：方向相反、金额等于原单，不能部分红冲；要改金额请红冲后另开新单。',
      noteLabel: '红冲原因',
      balanceLoading: '正在读取余额…',
      balanceFailed: '余额读取失败',
      summary: {
        id: '原调账单',
        user: '用户',
        direction: '方向',
        amount: '金额',
        reason: '原因',
        newDirection: '红冲方向',
        newAmount: '红冲金额',
        before: '红冲前可用余额',
        after: '红冲后可用余额',
      },
    },
    errors: {
      userRequired: '请输入用户 ID',
      directionRequired: '请选择方向',
      amountInvalid: '请输入大于 0、最多两位小数的金额',
      reasonRequired: '请选择原因码',
      subjectRequired: '请选择对方科目',
      platformRequired: '请选择平台',
      noteRequired: '请填写原因说明',
      noteTooLong: '原因说明最多 500 字',
      reconFixRefs: '对账修正须关联至少 1 张差错单',
      payoutRefs: '打款追回须关联恰好 1 张提现单和至少 1 张差错单',
      refTypeRequired: '请选择单据类型',
      refIdRequired: '请输入单据号',
      refIdTooLong: '单据号最多 128 个字符',
      refDuplicate: '该单据已添加',
      refLimit: '关联单据最多 10 张',
      reverseNoteRequired: '请填写红冲原因',
      reverseNoteTooLong: '红冲原因最多 500 字',
      userUnknown: '用户不存在，请核对用户 ID',
      refInvalid: '关联单据不存在、不属于该用户或不能用于调账，请核对',
      userDeleted: '该用户已注销或正在注销，不能调账',
      reverseNotAllowed: '该调账单不能红冲：未生效或本身是红冲单',
      originalMissing: '原调账单不存在或已不可见，请刷新后重试',
      invalid: '提交内容未通过服务端校验，请核对后重试',
      alreadyReversed: '该调账单已被红冲，已刷新',
      forbidden: '无权限执行调账',
      failed: '提交失败，请稍后重试',
    },
  },
  /**
   * 批准对话框（系统预填的 ACCOUNT_CLOSED 待批准单，fund.adjust）：adminApproveAdjustment（短信档二次验证，
   * 请求体 {}，金额由服务端按批准时可用余额取）与 adminRejectAdjustment（不验证，只有驳回原因）。
   */
  approve: {
    title: '批准调账单',
    approve: '批准并短信验证',
    reject: '驳回',
    cancel: '取消',
    consequence:
      '批准后按批准时的可用余额整笔调减，转入平台佣金收入并立即记账，不可撤回；驳回不记账，注销仍待处理，系统次日重新预填。',
    actualAmount: '实际调减金额以批准时的可用余额为准，可能与预览不同。',
    reasonLabel: '驳回原因',
    balanceLoading: '正在读取余额…',
    /** 读单（含余额预览）失败：前后余额显示前【批准并短信验证】不可用（BR-FUND-24 ④）。 */
    readFailed: '调账单读取失败',
    reread: '重新读取',
    /** 结果未定后正在重新读取该单（读回前两个决定都不可用）。 */
    rechecking: '上次提交结果未定，正在重新读取该调账单，读取完成前不能再次提交。',
    /** 决定没拿到带统一外壳的回答（网络错误、无法解析）：结果未知，只能原样重试或去列表核对。 */
    unknown:
      '上次提交结果未知：可能已经生效。重新读取后仍待批准时，再按同一个决定用原内容原样重新提交（不会重复执行），或按【去列表核对】查看是否已处理。',
    /** StepUpModal 的「本次操作」。 */
    operation: '批准系统预填调账单（注销放弃余额）',
    approved: (adjustId: string, amount: string): string =>
      `已批准，调账单号 ${adjustId}，实际调减 ${amount}`,
    rejected: (adjustId: string): string => `已驳回，调账单号 ${adjustId}`,
    summary: {
      id: '调账单号',
      user: '用户',
      direction: '方向',
      reason: '原因',
      subject: '对方科目',
      creator: '创建人',
      created: '创建时间',
    },
    balance: {
      before: '批准前可用余额',
      amount: '预计调减金额',
      after: '批准后可用余额',
    },
    errors: {
      reasonRequired: '请填写驳回原因',
      reasonTooLong: '驳回原因最多 200 字',
      reasonInvalid: '驳回原因须为 1–200 字，请修改后重试',
      noBalance: '可用余额不大于 0，不能批准，请驳回',
      missing: '调账单不存在或已不可见，请刷新后重试',
      stale: '该调账单已不是待批准状态，已刷新',
    },
  },
  /**
   * 批准坏账核销对话框（adminApproveBadDebtWriteoff，fund.writeoff，短信档二次验证，请求体 {}；BR-FUND-12：
   * 金额 = −批准时可用余额，余额已不小于 0 时候选单改为已取消）。
   */
  writeoffApprove: {
    title: '批准坏账核销',
    approve: '批准核销',
    cancel: '取消',
    amountNotice:
      '核销金额按批准时重新读取的可用余额计算，不用生成时金额；批准时可用余额已不小于 0 的，候选单改为已取消，不记坏账。',
    consequence:
      '批准后立即记坏账（借 坏账 / 贷 用户可用余额），用户可用余额回到 0，不可撤回，之后的入账照常计入余额；关联账户将被打上风控标记，只留痕，不改变提现判定。',
    frozenPending:
      '该用户有冻结中的提现金额（提现单未到终态），暂不能核销：请先把提现单处理到终态，候选单保持待批准。',
    checking: '正在重新读取候选单…',
    checkFailed: '候选单读取失败',
    /** 批准没拿到带统一外壳的回答（网络错误、无法解析）：结果未知，只能原样重试或去列表核对。 */
    unknown:
      '上次提交结果未知：可能已经生效。重新读取后仍待批准时，再按【批准核销】用原内容原样重新提交（不会重复核销），或按【去列表核对】查看是否已处理。',
    /** StepUpModal 的「本次操作」。 */
    operation: '批准坏账核销（按批准时余额记坏账）',
    approved: (id: string, amount: string): string => `已核销，候选单号 ${id}，核销金额 ${amount}`,
    cancelled: (id: string): string => `可用余额已回正，候选单已取消，未记坏账，候选单号 ${id}`,
    summary: {
      id: '候选单号',
      user: '用户',
      since: '负余额起始日',
      days: '负余额天数',
      candidate: '生成时金额',
      available: '当前可用余额',
      frozen: '冻结',
    },
    errors: {
      missing: '核销候选单不存在或已不可见，请刷新后重试',
      stale: '该核销候选单已不是待批准状态，已刷新',
      forbidden: '无权限执行坏账核销',
    },
  },
  /** 对方科目连同平台（contra_platform，只 UNION_RECEIVABLE 有）。 */
  subjectWithPlatform: (subject: string, platform: string): string => `${subject}（${platform}）`,
} as const;
