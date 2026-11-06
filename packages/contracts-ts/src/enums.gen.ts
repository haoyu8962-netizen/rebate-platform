// GENERATED FILE. Do not edit by hand.
// Source: contracts/enums/*.yaml
// Regenerate: pnpm contracts:codegen (drift is checked by pnpm contracts:check)

/**
 * 权限点 key；标 step-up 的权限点每次操作都须二次验证，只有部分操作要的在该项写明（见 04 §11 与 specs/permissions.yaml）
 * Source: 规划/04 §11（拍板第二批 §8 ADD-04、ADD-05） (contracts/enums/admin.yaml).
 */
export const admin_permission = [
  "dashboard.view", // 工作台：待办与概览（04 §11.1、01 F-ADM-26；每张卡另按其权限点裁剪）
  "user.list", // 用户列表浏览、筛选（非敏感字段）
  "user.lookup", // 按 UID、完整手机号或订单号逐个查询
  "pii.reveal_phone", // 查看完整手机号（step-up）
  "pii.reveal_identity", // 查看完整身份证号、收款账号（step-up）
  "fund.view", // 单个用户流水、提现单、对账明细；资金看板
  "audit.view_all", // 全部审计日志只读
  "export", // 导出
  "feedback.view", // 商品反馈查看（只读；列表只给运营核对价格、返利与商品信息，不含手机号与设备标识）
  "content.page", // 首页配置发布 / 回滚、草稿预览二维码
  "content.pool", // 商品池、淘礼金池
  "content.article", // 帮助中心、返利规则、公告、消息模板（资金类消息模板除外，归 content.fund_terms）
  "content.agreement", // 协议发布与提高最低版本 / 标记重签；修改隐私与权限文案键（BR-TEXT-14 表 D），要填法务确认人（step-up）
  "content.poster", // 海报背景图上传、审核
  "content.app_version", // 版本管理（按端与渠道）：最新版本、推荐版本、更新文案、商店登记与默认商店、最低支持版本；只有提高最低支持版本时要二次验证（step-up）
  "content.fund_terms", // 修改资金术语键与资金类消息模板（清单见 BR-TEXT-12 细则「资金术语键」与 specs/fund-term-keys.yaml）（step-up）
  "content.platform_icon", // 平台标识上传、发布、回滚、恢复内置（BR-TEXT-24）
  "notify.channels", // 通知渠道开关（推送、短信）、短信签名与模板 CODE 登记与测试发送；资金类编码改短信登记另需 content.fund_terms（04 §11.2、BR-TEXT-20 细则「短信渠道登记与后台渠道开关」）（step-up）
  "config.general", // 普通配置（不含 BR-TEXT-14 表 D 的隐私与权限文案键与 BR-TEXT-12 细则所列的资金术语键）
  "config.risk", // 风控规则与阈值（step-up）
  "config.business", // 返利规则版本、费率、提现规则与限额、自动到账设置（step-up）
  "switch.all", // 全部紧急开关（step-up）
  "switch.payout", // 仅打款类开关：withdraw.enabled、payout.enabled、payout.queue_paused、payout.channel_enabled.<channel>、payout.channel_paused.<channel>（step-up）
  "switch.pay", // 仅收款类开关：pay.enabled、pay.channel_enabled.<pay_channel>；与 switch.payout 互不包含（step-up）
  "risk.freeze", // 冻结 / 解冻（step-up）
  "risk.ban", // 封禁 / 解封（step-up）
  "risk.blocklist", // 黑名单增删（step-up）
  "risk.appeal", // 申诉处理（维持 / 撤销）；客服代为登记未登录或注册被拦截者的申诉
  "union.binding_reset", // 用户联盟授权重置（step-up）
  "union.binding_disable", // 用户联盟授权停用返利 / 恢复（step-up）
  "union.account_auth", // 站长联盟授权管理（step-up）
  "union.pid", // 推广位登记、启用（pending → active）、停用（active → retired），不可删除（step-up）
  "user.level", // 调等级（step-up）
  "user.inviter", // 改上级（step-up）
  "user.realname_fix", // 实名更正（用户经企业微信联系客服，客服人工审核后在用户详情页操作）（step-up）
  "user.phone_change", // 编辑会员信息：改手机号与昵称；实名信息归 user.realname_fix，余额归 fund.adjust（step-up）
  "user.data_export", // 个人信息副本导出（用户详情页）（step-up）
  "order.view", // 订单查询、手动同步
  "order.claim", // 找回、维权处理
  "order.assign", // 订单归属变更（step-up）
  "order.hold", // 订单 hold / unhold
  "order.restore", // 订单平台恢复、申诉恢复差错单（step-up）
  "withdraw.review", // 提现审核、驳回（step-up）
  "payout.execute", // 执行打款、needs_manual 处置、W11 凭通道成功证据核销原单（可为本单审核人）（step-up）
  "pay.view", // 支付单、退款单、收款对账明细
  "pay.refund", // 发起原路退款（不设二次验证）
  "pay.resolve", // needs_manual 支付单的处置（step-up）
  "payout.manual_entry", // 线下打款补录（W8，含银行卡线下转账）与批量手动打款（step-up）
  "settle.bill", // 月结账单确认、撤销定时、驳回、继续执行、补充批次（step-up）
  "settle.statement_upload", // 联盟结算明细上传
  "fund.adjust", // 人工调账（step-up）
  "fund.writeoff", // 坏账核销（step-up）
  "fund.settle_adjust", // 补差批次（step-up）
  "fund.recon", // 对账与差错单处理（含以「已关闭（不处理）」结案，必填原因）
  "fund.cash_entry", // 平台资金台账录入：联盟回款、企业支付宝余额 W（step-up）
  "tax.export_full", // 涉税全量导出（step-up）
  "agent.trace", // Agent trace 查询（含 AI 举报列表的查看）
  "agent.report", // AI 举报处理：标记已处理、填写处理说明
] as const;
export type AdminPermission = (typeof admin_permission)[number];

/**
 * 后台 step-up 的档位；step_up_token 记档位，动态码档的 token 不能用于短信档操作；10003 的 data.tier 取本枚举
 * Source: 规划/08 BR-ID-34（二次验证分两档）；规划/04 §6.6 auth、§11 step-up 列（CT-02f） (contracts/enums/admin.yaml).
 */
export const admin_step_up_tier = [
  "totp", // 动态码档（身份验证器 TOTP）
  "sms", // 短信档（向账号登记的验证手机号发验证码）
] as const;
export type AdminStepUpTier = (typeof admin_step_up_tier)[number];

/**
 * 后台登录第一步通过后的下一步，凭中间凭证 login_ticket 完成；两步都完成才签发 admin_token
 * Source: 规划/08 BR-ID-34 细则「首次绑定身份验证器」、BR-ID-43「首次登录强制改密码」；规划/04 §6.6 auth（CT-02f） (contracts/enums/admin.yaml).
 */
export const admin_login_step = [
  "totp", // 已绑定身份验证器，输入动态码
  "change_password", // 仍在用初始密码，先改密码
  "bind_totp", // 未绑定身份验证器，先绑定
] as const;
export type AdminLoginStep = (typeof admin_login_step)[number];

/**
 * 后台账号状态；停用的账号名仍占用，不再分配给新账号
 * Source: 规划/04 §3.2 admin_users.status；规划/08 BR-ID-43「停用后台账号」（CT-02f） (contracts/enums/admin.yaml).
 */
export const admin_account_status = [
  "active", // 正常
  "disabled", // 已停用
] as const;
export type AdminAccountStatus = (typeof admin_account_status)[number];

/**
 * /admin/v1 接口的鉴权级别；中间凭证 login_ticket 放请求体，不是鉴权级别
 * Source: 规划/04 §6.6 auth、§11（CT-02f；/admin/v1 接口的 x-auth） (contracts/enums/admin.yaml).
 */
export const admin_auth_level = [
  "none", // 不需要 admin_token（登录各步，来源 IP 仍须在白名单内）
  "admin", // 需要 admin_token（Authorization Bearer）
  "super", // 需要超级管理员的 admin_token（后台账号与权限，只限超管、不可授予）
] as const;
export type AdminAuthLevel = (typeof admin_auth_level)[number];

/**
 * GET /admin/v1/dashboard 的 todo[].key；每张卡只在账号持有括号里的权限点、且对应模块已上线时返回（count 为 0 也返回）；编码独立于权限点，不复用权限点字符串；卡标题与副文案取 BR-TEXT-25 admin_dict
 * Source: 规划/01 F-ADM-26 ① 待办计数；规划/04 §6.6 dashboard、§11.1 dashboard.view（CT-24a） (contracts/enums/admin.yaml).
 */
export const admin_dashboard_todo_key = [
  "withdraw_review_pending", // 待审提现（withdraw.review；BR-WDR-10 人工审核队列）
  "claim_review_pending", // 待审找回（order.claim；BR-ATTR-18）
  "settle_bill_pending", // 待确认月结账单（settle.bill；BR-FUND-04）
  "recon_diff_open", // 未关闭差错单（fund.recon；BR-FUND-22）
  "appeal_pending", // 待处理申诉（risk.appeal；BR-ID-36）
  "agent_report_overdue", // AI 举报超 48 小时未处理（agent.report；BR-ID-15）
  "beneficiary_held_overdue", // 受益人份额 held 满 30 天（risk.freeze；BR-CALC-13）
  "union_auth_expiring", // 站长联盟授权即将到期或探测失效（union.account_auth；BR-ID-24）
] as const;
export type AdminDashboardTodoKey = (typeof admin_dashboard_todo_key)[number];

/**
 * GET /admin/v1/search 的 items[].type；每类只返回给持有括号里权限点的账号，无权限与无命中同样不出现；类型名取 BR-TEXT-25 admin_dict
 * Source: 规划/01 F-ADM-04 顶栏「一框搜」；规划/04 §6.6 search、§11.1；规划/08 BR-ID-34 细则「一框搜」（CT-24b） (contracts/enums/admin.yaml).
 */
export const admin_search_hit_type = [
  "order", // 订单（order.view；按完整订单号命中）
  "user", // 用户（user.lookup；按 UID 或完整手机号命中，或作为命中单号的所属用户附带）
  "withdrawal", // 提现单（fund.view；按完整提现单号命中；提现模块上线前不产生命中）
] as const;
export type AdminSearchHitType = (typeof admin_search_hit_type)[number];

/**
 * 后台导出任务（/admin/v1/exports）的状态；迁移只有 pending→running→done 或 failed、done→expired（生成后 24 小时）、pending 或 running→cancelled（创建人账号停用）、failed→pending（创建人重试）；没有取消接口；中文名取 BR-TEXT-25 admin_dict
 * Source: 规划/04 §6.6 exports；规划/08 BR-ID-34 细则「后台导出任务」、BR-ID-30 ⑨；中文名 BR-TEXT-25 admin_dict.export_status（CT-24k） (contracts/enums/admin.yaml).
 */
export const export_status = [
  "pending", // 排队中（已创建或重试后等待生成）
  "running", // 生成中
  "done", // 已完成（文件可由创建人下载，直到 expires_at）
  "failed", // 失败（只有本状态可重试）
  "expired", // 已过期（文件已由对象存储生命周期规则删除，不可下载、不可重试）
  "cancelled", // 已取消（创建人账号停用时取消，不可下载、不可重试）
] as const;
export type ExportStatus = (typeof export_status)[number];

/**
 * 后台导出任务的来源列表；创建时须持有该列表本身的权限点（括号内），filters 与该列表的查询参数同形；其他列表随各自的契约追加
 * Source: 规划/04 §6.6 exports（filters 同该列表的查询参数）；规划/01 F-ADM-03（CT-24k） (contracts/enums/admin.yaml).
 */
export const export_resource = [
  "users", // 用户列表 GET /admin/v1/users（user.list；filters 为 risk_state）
  "audit_logs", // 审计日志 GET /admin/v1/audit-logs（登录即可，未持 audit.view_all 时只导出本人记录；filters 为 actor_id、target_type、target_id、permission、from、to）
  "tax_withdrawals", // 涉税季度导出 BR-WDR-21，没有对应列表（脱敏版 export + fund.view；全量版 unmasked 只要 tax.export_full 与 step-up，不被 fund.* 隐含；filters 为 quarter）
] as const;
export type ExportResource = (typeof export_resource)[number];

/**
 * GET /admin/v1/audit-logs 列表、详情的 actor_kind；只在系统行出现（值 system），后台账号的行不带本字段
 * Source: 规划/04 §3.2 audit_logs；编排裁定 D10-552（CT-24zj） (contracts/enums/admin.yaml).
 */
export const audit_actor_kind = [
  "admin", // 后台账号
  "system", // 系统
] as const;
export type AuditActorKind = (typeof audit_actor_kind)[number];

/**
 * 审计日志系统行的 system_actor，值的格式是 ^system:[a-z_]+$，以后追加；中文名就是系统行的 actor_name 与导出的「操作者」列
 * Source: 规划/04 §3.2 audit_logs；编排裁定 D10-552（CT-24zj） (contracts/enums/admin.yaml).
 */
export const audit_system_actor = [
  "system:risk", // 系统（风控）
  "system:payout", // 系统（打款）
  "system:ledger", // 系统（账务）
] as const;
export type AuditSystemActor = (typeof audit_system_actor)[number];

/**
 * GET /admin/v1/claims/{claim_id} 的 items[].matches[].field，证据视图逐项比对用户填写与联盟回传的字段；预售单的联盟侧付款日期取定金支付日
 * Source: 规划/01 F-ADM-06；规划/04 §6.6 claims；规划/08 BR-ATTR-17、BR-ATTR-18；design/specs/admin-claims.md 证据视图（CT-24d） (contracts/enums/admin.yaml).
 */
export const admin_claim_match_field = [
  "order_no", // 订单号（用户填写的单号与该子订单的子单号或主单号）
  "paid_date", // 付款日期（+08:00 自然日）
] as const;
export type AdminClaimMatchField = (typeof admin_claim_match_field)[number];

/**
 * GET /admin/v1/orders 的 flag 筛选与列表项 flags 的键；locked 即 orders.locked（后台界面叫「归属已锁定」），status_locked 由 rebate_status 推导、不入库（后台界面叫「已锁定」）；中文名取 BR-TEXT-25 admin_dict，本契约不补文案
 * Source: 规划/01 F-ADM-05；规划/04 §2.3、§3.2 orders；规划/08 BR-FUND-01 细则「订单锁定（展示标记）」、BR-ATTR-20、BR-FUND-06；design/specs/admin-orders.md 筛选「订单标记」（CT-24m） (contracts/enums/admin.yaml).
 */
export const admin_order_flag = [
  "locked", // 归属已锁定（orders.locked，BR-ATTR-20）
  "status_locked", // 已锁定（rebate_status ∈ VOID、CREDITED、CLAWED_BACK，BR-FUND-01 细则「订单锁定（展示标记）」）
  "rights_pending", // 维权中（orders.rights_pending，BR-FUND-06）
  "hold", // 暂停（orders.hold，BR-FUND-06）
] as const;
export type AdminOrderFlag = (typeof admin_order_flag)[number];

/**
 * GET /admin/v1/orders/{order_id} 的 status_history[].field，这一行记的是哪个状态字段
 * Source: 规划/04 §3.2 order_status_history.field（CT-24m） (contracts/enums/admin.yaml).
 */
export const admin_order_history_field = [
  "platform", // 平台状态 platform_status
  "rebate", // 返利状态 rebate_status
] as const;
export type AdminOrderHistoryField = (typeof admin_order_history_field)[number];

/**
 * GET /admin/v1/orders/{order_id} 的 status_history[].source，状态变化的来源
 * Source: 规划/04 §3.2 order_status_history.source（CT-24m） (contracts/enums/admin.yaml).
 */
export const admin_order_history_source = [
  "sync", // 订单同步
  "admin", // 后台操作
  "claim", // 找回
  "system", // 系统
] as const;
export type AdminOrderHistorySource = (typeof admin_order_history_source)[number];

/**
 * GET /admin/v1/risk-rules 列表项的 status；启停经 POST /admin/v1/risk-rules/{rule_id}/enable、…/disable；中文名取 BR-TEXT-25 admin_dict，本契约不补文案
 * Source: 规划/04 §3.2 risk_rules.status、§6.6 risk-rules；规划/08 BR-ID-36 细则「规则清单的启停」（CT-24f，代理补全的默认） (contracts/enums/admin.yaml).
 */
export const risk_rule_status = [
  "enabled", // 启用（参与判定）
  "disabled", // 停用（不参与判定、不写 risk_hits；已写的命中记录与申诉不受影响）
] as const;
export type RiskRuleStatus = (typeof risk_rule_status)[number];

/**
 * 风控规则命中后的动作，GET /admin/v1/risk-rules 列表项的 risk_action；取值与 risk_rules、risk_hits 的 CHECK 约束一致；中文名取 BR-TEXT-25 admin_dict（admin_dict.risk_action.*）
 * Source: 规划/08 BR-ID-36；规划/04 §3.2 risk_rules / risk_hits.risk_action（CT-24f） (contracts/enums/admin.yaml).
 */
export const risk_action = [
  "pass", // 通过（只记命中）
  "manual_review", // 转人工
  "block", // 拦截
  "void_commission", // 作废佣金
] as const;
export type RiskAction = (typeof risk_action)[number];

/**
 * 站长联盟授权状态；GET /admin/v1/union-accounts 的 auth_status；提醒节点 alert_stage 不对外返回；中文名取 BR-TEXT-25 admin_dict.union_accounts.auth_status
 * Source: 规划/04 §3.2 union_accounts.auth_status；规划/08 BR-ID-24（CT-24h） (contracts/enums/admin.yaml).
 */
export const union_auth_status = [
  "active", // 有效
  "expiring", // 即将到期（已到 union.auth_alert_days 的提醒节点）
  "expired", // 已过期或探测 / 调用返回授权失效（BR-ID-24 ④）
] as const;
export type UnionAuthStatus = (typeof union_auth_status)[number];

/**
 * 该联盟账号站长凭据的更新方式，由服务端按平台登记表派生（不入库）；前端据此显示入口
 * Source: 规划/04 §6.6 union-accounts；规划/08 BR-ID-24 细则「后台告警手机号与重新授权会话」（编排裁定 D10-159 及其补充，CT-24h） (contracts/enums/admin.yaml).
 */
export const union_reauth_mode = [
  "oauth", // 走后台授权会话（POST …/reauthorize，回调后轮询结果）
  "manual", // 站长凭据不是 OAuth、可在联盟后台重新取得（如京东推客授权 Key，CAP-JD-12），在后台录入新凭据（PUT …/credential）
  "none", // 没有站长凭据可更新（按 规划/09 CAP-*-12 实测登记），不提供更新入口
] as const;
export type UnionReauthMode = (typeof union_reauth_mode)[number];

/**
 * 后台站长重新授权会话的状态；state 单次使用、10 分钟有效
 * Source: 规划/04 §3.2 admin_union_auth_sessions.status；规划/08 BR-ID-24 细则（CT-24h） (contracts/enums/admin.yaml).
 */
export const admin_union_auth_session_status = [
  "pending", // 已发起、回调未到
  "succeeded", // 回调成功，凭据与到期时间已更新
  "failed", // 回调失败（原因记在 error）
  "expired", // 过期未用
] as const;
export type AdminUnionAuthSessionStatus = (typeof admin_union_auth_session_status)[number];

/**
 * 推广位状态；只有 pending→active（启用，须花卷云忽略确认与截图）、active→retired（停用）；三种状态都在白名单里，不可删除
 * Source: 规划/04 §3.2 union_pids.status；规划/08 BR-ATTR-02 细则「后台登记与启停」（CT-24h） (contracts/enums/admin.yaml).
 */
export const union_pid_status = [
  "pending", // 已登记、未启用（只有本状态可修改）
  "active", // 启用中，可用于转链；同一 app × platform × pid_scene 至多一条
  "retired", // 已停用，停止新转链，仍留在白名单
] as const;
export type UnionPidStatus = (typeof union_pid_status)[number];

/**
 * 商品池状态
 * Source: 规划/04 §3.2 product_pools；规划/01 F-ADM-10（CT-07d，取值是编排者默认） (contracts/enums/admin.yaml).
 */
export const product_pool_status = [
  "active", // 启用中
  "disabled", // 已停用，读取时按空池处理
] as const;
export type ProductPoolStatus = (typeof product_pool_status)[number];

/**
 * 商品池条目的上下架状态
 * Source: 规划/04 §3.2 pool_items.status；规划/08 BR-PROD-08 ③（CT-07d） (contracts/enums/admin.yaml).
 */
export const pool_item_status = [
  "online", // 上架，在有效期内可下发
  "offline", // 下架（运营下架或联盟复核不通过，原因记在 invalid_reason）
] as const;
export type PoolItemStatus = (typeof pool_item_status)[number];

/**
 * 通知的发送渠道；后台只能开关 push 与 sms，inbox 不能由后台增删
 * Source: 规划/04 §3 notify_templates 渠道列、notify_logs.channel；规划/08 BR-TEXT-09 细则模板表渠道列、BR-TEXT-20 细则「短信渠道登记与后台渠道开关」（CT-24t） (contracts/enums/admin.yaml).
 */
export const notify_channel = [
  "inbox", // 站内信
  "push", // 推送
  "sms", // 短信
] as const;
export type NotifyChannel = (typeof notify_channel)[number];

/**
 * 短信服务商的模板类型；营销短信为 P1，不列入
 * Source: 规划/04 §3 notify_templates 短信渠道列（模板类型 verify / notice）；规划/08 BR-TEXT-20 细则「短信渠道登记与后台渠道开关」（CT-24t） (contracts/enums/admin.yaml).
 */
export const sms_template_type = [
  "verify", // 验证码
  "notice", // 通知
] as const;
export type SmsTemplateType = (typeof sms_template_type)[number];

/**
 * GET /admin/v1/notify-channels 的 sms_state：该编码的短信现在怎样发
 * Source: 规划/08 BR-TEXT-20 细则「短信渠道登记与后台渠道开关」（短信就绪条件，编排裁定 D10-337 ②、D10-339 ⑥）；规划/04 §3 notify_templates（CT-24t） (contracts/enums/admin.yaml).
 */
export const notify_sms_state = [
  "disabled", // 关（短信不在当前渠道里）
  "enabled", // 开，且已就绪（各变体都有在用登记）或 SMS_CODE 用部署配置兜底：照发
  "enabled_not_ready", // 开（未就绪）：默认渠道含短信、变体未全登记启用，服务端不发短信、只记录未发送，推送与站内信照发
] as const;
export type NotifySmsState = (typeof notify_sms_state)[number];

/**
 * 待测试登记最近一次测试发送的结果
 * Source: 规划/08 BR-TEXT-20 细则「短信渠道登记与后台渠道开关」（「待测试」登记与测试发送，编排裁定 D10-337 ①、D10-339 ①⑤）；规划/04 §3 notify_templates（CT-24t） (contracts/enums/admin.yaml).
 */
export const notify_sms_test_status = [
  "accepted", // 已受理（受理不等于送达），可启用新配置；选「稍后再启用」后仍是此值
  "failed", // 测试失败（服务商拒收、出错或超时），原配置继续生效
  "not_sent_no_verify_phone", // 未发送：保存时操作人没有登记验证手机号
] as const;
export type NotifySmsTestStatus = (typeof notify_sms_test_status)[number];

/**
 * GET /admin/v1/withdrawals 列表项与详情的 display_status 及同名筛选；由 status + review_mode + hold_reason 推导、不入库，不是新的提现状态（withdrawal_status 不变）；中文名取 BR-TEXT-25 admin_dict，本契约不补文案
 * Source: 规划/08 BR-WDR-08 细则「与花卷云『会员提现管理』状态的映射」与「快捷筛选」；规划/01 F-ADM-07；design/specs/admin-withdrawals.md §2、§7 ⑤（CT-24y） (contracts/enums/admin.yaml).
 */
export const admin_withdrawal_display_status = [
  "pending_review", // 等待审核（PENDING_REVIEW，以及 hold_reason 不是 payer_side_after_transfer 的 APPROVED：人工审核通过待执行、判 auto 后执行受阻、发出转账前经 W9 退回）
  "pending_handle", // 等待处理（APPROVED 且 hold_reason=payer_side_after_transfer：已发出转账、付款方侧失败后经 W9 退回，不可再次执行，BR-WDR-17）
  "rejected", // 审核驳回（REJECTED）
  "paid_manual", // 手动成功（PAID_MANUAL）
  "paid_auto_system", // 自动成功 · 系统自动（PAID_API 且 review_mode=auto）
  "paid_auto_review", // 自动成功 · 审核自动（PAID_API 且 review_mode 不是 auto）
  "paying", // 打款中（PAYING，含 needs_manual=true）
  "failed", // 提现失败（FAILED）
] as const;
export type AdminWithdrawalDisplayStatus = (typeof admin_withdrawal_display_status)[number];

/**
 * POST /admin/v1/settle-bills/{bill_id}/supplement-batches 响应的 outcome；无可纳入数据不是错误，outcome 仍为 generated、batch_ids 为空，不生成空批次
 * Source: 规划/08 BR-FUND-04 ⑧⑫；规划/01 F-ADM-08；design/specs/admin-settle-bills.md §4（CT-24zd） (contracts/enums/admin.yaml).
 */
export const admin_settle_supplement_outcome = [
  "generated", // 已执行补充校验（本次新生成的批次在 batch_ids，可为空）
  "duplicate", // 同一名义时刻已被认领（settle_jobs 唯一键），本次未生成，batch_ids 为空
] as const;
export type AdminSettleSupplementOutcome = (typeof admin_settle_supplement_outcome)[number];

/**
 * POST /admin/v1/recon-diffs/{recon_diff_id}/close 的可选 outcome，B2-09h 起写入 recon_diffs.resolution.outcome；只对 type=settle_amount_mismatch（source R1）有意义，B2-09h 起其他差错单带它是 20001 data.fields=[outcome]；不传 = 无结构化结论，月结按需比金额；closed 状态本身不算结论，自由文本 reason 不解析
 * Source: 规划/08 BR-FUND-04 ④、校验结果表与例 2；编排裁定 D10-447 ②、D10-506（CT-24zf） (contracts/enums/admin.yaml).
 */
export const admin_recon_diff_outcome = [
  "union", // 以联盟为准（账单金额不一致差错单；当前基数与结算额都等于结案金额时月结校验算相符，后续进补充批次）
  "ours", // 以我方为准（月结校验不算相符）
] as const;
export type AdminReconDiffOutcome = (typeof admin_recon_diff_outcome)[number];

/**
 * GET /admin/v1/settle-bills 列表项与详情的 status 及同名筛选；读时由账单最近一轮批次（首轮 = 该账单全部 kind=main 批次；每次补充发起一轮 = kind=supplement 且 (platform, created_at) 相同的批次；轮时刻取其批次 created_at 最大值，最近一轮 = 轮时刻最大者，并列取含最大 batch_id 的轮；驳回的 CANCELLED 不参与）派生、不另存状态（settle_bills 无状态列）；撤销定时回到 DRAFT 的批次可能不在最近一轮，不影响本状态，却仍由确认接口覆盖，此时账单状态可与待确认批次不一致，待确认以批次 status=DRAFT 为准（编排裁定 D10-444）；按下列顺序取第一条成立的；中文名取 BR-TEXT-25 admin_dict
 * Source: 规划/08 BR-FUND-04 细则「月结账单状态」；规划/04 §2.5（月结账单状态由批次派生、不入库）；规划/01 F-ADM-08；design/specs/admin-settle-bills.md §1、§4（CT-24z） (contracts/enums/admin.yaml).
 */
export const admin_settle_bill_status = [
  "generating", // 出账中（generated_at 为空：账单日任务校验与批次尚未全部生成）
  "issued", // 已出账（已生成，最近一轮无非 CANCELLED 批次——无候选、平台 credit.enabled 为 off 只留校验结果或本轮全被驳回——或本轮有 DRAFT 批次）
  "settled", // 已结算（本轮批次全部 DONE）
  "settling", // 结算中（本轮有 EXECUTING / PARTIAL，或 CONFIRMED 且立即执行或 scheduled_at 已到）
  "scheduled", // 待结算（其余：本轮未完成的批次都是 CONFIRMED 且 scheduled_at 未到）
] as const;
export type AdminSettleBillStatus = (typeof admin_settle_bill_status)[number];

/**
 * 余额流水类型，共 13 种，细分只用 sub_type；用户侧名称见 BR-TEXT-19
 * Source: 规划/04 §2.4；BR-FUND-15；08 §13.4 (contracts/enums/fund.yaml).
 */
export const ledger_type = [
  "REBATE_CREDIT", // 自购返利入账（+）
  "SHARE_CREDIT", // 分享收益入账（+）
  "REFERRAL_CREDIT", // 邀请分佣入账（+，直推 / 间推）
  "CLAWBACK", // 订单扣回（−，含入账后部分退款）
  "SETTLE_ADJUST", // 结算补差（±）
  "WITHDRAW_FREEZE", // 提现冻结（可用 → 冻结）
  "WITHDRAW_PAID", // 提现出金（冻结 −）
  "WITHDRAW_RETURN", // 提现退回（冻结 → 可用）
  "WITHDRAW_FEE", // 提现手续费（冻结 −，MVP 为 0）
  "TAX_WITHHOLD", // 代扣个税（冻结 −）
  "REWARD", // 活动奖励（+；invite 随邀请奖励活动启用（BR-INV-24，2026-10-19），newbie、checkin 仍 P1）
  "ADMIN_ADJUST", // 人工调账（±）
  "BAD_DEBT_WRITEOFF", // 负余额核销（+）
] as const;
export type LedgerType = (typeof ledger_type)[number];

/**
 * REFERRAL_CREDIT 的 sub_type；INDIRECT 只在间推开关开启的规则版本下产生
 * Source: 规划/04 §2.4；BR-CALC-05 (contracts/enums/fund.yaml).
 */
export const referral_credit_sub_type = [
  "DIRECT", // 直推
  "INDIRECT", // 间推
] as const;
export type ReferralCreditSubType = (typeof referral_credit_sub_type)[number];

/**
 * 按逆向事件来源取值，映射只在 BR-FUND-08 细则维护
 * Source: 规划/04 §2.4；BR-FUND-08 (contracts/enums/fund.yaml).
 */
export const clawback_sub_type = [
  "FULL", // 全额扣回
  "PART_REFUND", // 入账后部分退款
  "RIGHTS", // 维权
  "PUNISH", // 处罚
] as const;
export type ClawbackSubType = (typeof clawback_sub_type)[number];

/**
 * settle_adjust_sub_type
 * Source: 规划/04 §2.4；BR-CALC-14 (contracts/enums/fund.yaml).
 */
export const settle_adjust_sub_type = [
  "SETTLE_DIFF", // 结算差异
  "PRICE_COMPARE", // 比价
  "PRICE_PROTECT", // 价保
] as const;
export type SettleAdjustSubType = (typeof settle_adjust_sub_type)[number];

/**
 * REWARD 的 sub_type；invite 随邀请奖励活动启用，邀请人与被邀请人都用 invite，两方由 invite_rewards 区分；newbie、checkin 仍 P1
 * Source: 规划/04 §2.4；BR-INV-24（invite，2026-10-19）、BR-INV-22（newbie、checkin 仍 P1） (contracts/enums/fund.yaml).
 */
export const reward_sub_type = [
  "newbie", // 新人
  "checkin", // 签到
  "invite", // 邀请
] as const;
export type RewardSubType = (typeof reward_sub_type)[number];

/**
 * 人工调账原因码，含义与流程只在 BR-FUND-24 维护
 * Source: 规划/04 §2.4；BR-FUND-24 (contracts/enums/fund.yaml).
 */
export const admin_adjust_sub_type = [
  "RESTORE", // 订单恢复与申诉恢复（BR-FUND-22）
  "RECON_FIX", // 对账修正
  "PAYOUT_RECOVERY", // 打款追回
  "ACCOUNT_CLOSED", // 注销放弃余额转平台收入
  "OTHER", // 其他
] as const;
export type AdminAdjustSubType = (typeof admin_adjust_sub_type)[number];

/**
 * admin_adjustments.status；人工单一步生效为 APPROVED，PENDING 只剩系统预填单；已红冲是标记不是状态
 * Source: 规划/04 §3.2 admin_adjustments；BR-FUND-24 ①；BR-TEXT-25 (contracts/enums/fund.yaml).
 */
export const admin_adjustment_status = [
  "PENDING", // 待批准
  "APPROVED", // 已生效
  "REJECTED", // 已驳回
  "CANCELLED", // 已撤回
] as const;
export type AdminAdjustmentStatus = (typeof admin_adjustment_status)[number];

/**
 * admin_adjustments.direction，对 available 的方向
 * Source: 规划/04 §3.2 admin_adjustments；BR-FUND-24 ① (contracts/enums/fund.yaml).
 */
export const admin_adjustment_direction = [
  "increase", // 调增
  "decrease", // 调减
] as const;
export type AdminAdjustmentDirection = (typeof admin_adjustment_direction)[number];

/**
 * 调账单关联单据类型；order 的 ref_id 是子订单 order_key
 * Source: BR-FUND-24 ③（值名代理补全） (contracts/enums/fund.yaml).
 */
export const admin_adjustment_ref_type = [
  "recon_diff", // 差错单
  "withdrawal", // 提现单
  "order", // 子订单
  "account_deletion", // 注销单
] as const;
export type AdminAdjustmentRefType = (typeof admin_adjustment_ref_type)[number];

/**
 * 调账对方科目；RECON_FIX、OTHER 由发起人从前四个选，PAYOUT_RECOVERY 按提现通道取现金科目，ACCOUNT_CLOSED 固定 COMMISSION_REVENUE
 * Source: BR-FUND-24 ⑥；specs/ledger-rules.md §2、§6（白名单待财务确认） (contracts/enums/fund.yaml).
 */
export const admin_adjustment_contra_subject = [
  "COMMISSION_REVENUE", // 佣金收入
  "UNION_RECEIVABLE", // 联盟应收
  "BAD_DEBT", // 坏账
  "MKT_EXPENSE", // 营销费用
  "CASH_ALIPAY", // 支付宝现金
  "CASH_WECHAT", // 微信现金
  "CASH_BANK", // 银行现金
] as const;
export type AdminAdjustmentContraSubject = (typeof admin_adjustment_contra_subject)[number];

/**
 * 受益角色；indirect 只在所选规则版本 indirect_enabled=true 时出现；客户端遇未知值按通用收入显示
 * Source: 规划/04 §2.5；BR-CALC-04、BR-CALC-05 (contracts/enums/fund.yaml).
 */
export const beneficiary_role = [
  "self", // 本人自购
  "share", // 分享者
  "direct", // 直推上级
  "indirect", // 间推上级
] as const;
export type BeneficiaryRole = (typeof beneficiary_role)[number];

/**
 * commission_splits.beneficiaries[].forfeit_reason，受益人份额被剥夺的原因
 * Source: 08 §13.2；BR-CALC-13 (contracts/enums/fund.yaml).
 */
export const forfeit_reason = [
  "banned", // 封禁
  "deleted", // 注销
  "minor", // 已识别未满 18 周岁
] as const;
export type ForfeitReason = (typeof forfeit_reason)[number];

/**
 * commission_rule_status
 * Source: 规划/04 §2.5；BR-CALC-11、BR-CALC-22 (contracts/enums/fund.yaml).
 */
export const commission_rule_status = [
  "draft", // 草稿
  "published", // 已发布
  "revoked", // 已撤销（只能撤销未生效版本）
] as const;
export type CommissionRuleStatus = (typeof commission_rule_status)[number];

/**
 * 所得类型；SELF_REBATE 停用，编码保留不复用，不列入
 * Source: 规划/04 §2.4；BR-WDR-20；拍板第二批 FUND-04 (contracts/enums/fund.yaml).
 */
export const income_type = [
  "SERVICE_FEE", // 全部佣金收入（劳务报酬，合并累计计税）
  "INCIDENTAL", // 活动奖励（偶然所得，P1）
] as const;
export type IncomeType = (typeof income_type)[number];

/**
 * 终态 REJECTED、PAID_API、PAID_MANUAL、FAILED；迁移 W1–W11，W11 事件 CHANNEL_SUCCESS_PROVEN（付款方侧失败而通道已成功时核销原单，BR-WDR-17）；用户文案见 BR-TEXT-06
 * Source: 规划/04 §2.4；BR-WDR-08 (contracts/enums/fund.yaml).
 */
export const withdrawal_status = [
  "PENDING_REVIEW", // 审核中
  "APPROVED", // 已审核待执行
  "REJECTED", // 已驳回
  "PAYING", // 打款中或结果未知
  "PAID_API", // 接口确认成功
  "PAID_MANUAL", // 人工打款成功
  "FAILED", // 打款失败
] as const;
export type WithdrawalStatus = (typeof withdrawal_status)[number];

/**
 * withdrawals.reject_reason_code；前 5 个人工可选，NEGATIVE_BALANCE 系统专用
 * Source: 规划/04 §2.4；BR-WDR-10、BR-WDR-05 (contracts/enums/fund.yaml).
 */
export const withdraw_reject_reason = [
  "RISK_SUSPECT", // 风险嫌疑
  "ORDER_ABNORMAL", // 订单异常
  "PAYEE_INFO_INVALID", // 收款信息无效
  "USER_REQUEST", // 用户申请撤销
  "OTHER", // 其他
  "NEGATIVE_BALANCE", // 余额为负（系统专用）
] as const;
export type WithdrawRejectReason = (typeof withdraw_reject_reason)[number];

/**
 * withdrawals.hold_reason，W9 回到 APPROVED 的原因
 * Source: 规划/04 §2.4；BR-WDR-13、BR-WDR-17 (contracts/enums/fund.yaml).
 */
export const withdrawal_hold_reason = [
  "payout_disabled", // 打款开关关闭
  "queue_paused", // 打款队列暂停
  "channel_disabled", // 该收款方式的打款通道关闭或暂停（BR-WDR-33 ①）
  "member_blocked", // 用户受限
  "single_cap", // 单笔上限
  "daily_cap", // 单日上限
  "payer_side_after_transfer", // 转账后付款方问题
] as const;
export type WithdrawalHoldReason = (typeof withdrawal_hold_reason)[number];

/**
 * NEGATIVE_BALANCE_OTHER 随单一余额停用，编码不复用，不列入
 * Source: 规划/04 §2.4；BR-WDR-05；拍板第二批 §8 ADD-06 (contracts/enums/fund.yaml).
 */
export const withdrawal_blocked_reason = [
  "NEGATIVE_BALANCE", // 用户余额为负
] as const;
export type WithdrawalBlockedReason = (typeof withdrawal_blocked_reason)[number];

/**
 * withdrawal_manual_resolution
 * Source: 规划/04 §2.4；BR-WDR-15 (contracts/enums/fund.yaml).
 */
export const withdrawal_manual_resolution = [
  "paid", // 已打款（→ PAID_API）
  "failed", // 失败（→ FAILED）
] as const;
export type WithdrawalManualResolution = (typeof withdrawal_manual_resolution)[number];

/**
 * withdraw_holds.reason
 * Source: 规划/04 §2.4；BR-WDR-05、BR-WDR-15、BR-FUND-19 (contracts/enums/fund.yaml).
 */
export const withdraw_hold_kind = [
  "manual", // 人工冻结
  "recon_diff", // 对账差异
  "ledger_mismatch", // 账务差异
  "manual_failed_watch", // 人工失败观察
] as const;
export type WithdrawHoldKind = (typeof withdraw_hold_kind)[number];

/**
 * withdrawal_review_mode
 * Source: 规划/04 §2.4；BR-WDR-30 (contracts/enums/fund.yaml).
 */
export const withdrawal_review_mode = [
  "auto", // 系统按规则组审核并打款
  "manual", // 人工审核
] as const;
export type WithdrawalReviewMode = (typeof withdrawal_review_mode)[number];

/**
 * payout_accounts.payout_method 与 withdrawals.payout_channel
 * Source: 规划/04 §2.4；BR-WDR-02、BR-WDR-32、BR-WDR-33 (contracts/enums/fund.yaml).
 */
export const payout_method = [
  "alipay", // 支付宝
  "bank_card", // 本人银行卡
  "wechat", // 微信零钱（BR-WDR-33；通道开关默认关）
] as const;
export type PayoutMethod = (typeof payout_method)[number];

/**
 * withdrawals.channel_state，可空，只有微信零钱单在 PAYING 期间有值；不是提现状态（withdrawal_status 不变）
 * Source: 规划/04 §2.4；BR-WDR-33 ⑤ (contracts/enums/fund.yaml).
 */
export const withdrawal_channel_state = [
  "processing", // 通道处理中
  "wait_user_confirm", // 等用户在微信里确认收款
  "canceling", // 撤销中
] as const;
export type WithdrawalChannelState = (typeof withdrawal_channel_state)[number];

/**
 * 提现单副文案分支 key，由服务端按 BR-WDR-25 分支表自上而下取第一条匹配的行算出，取该行 sub_text_branch 列的值；本枚举与该列的取值逐一对应，分支条件与措辞只在 BR-WDR-25 与 /v1/dict 维护，这里只列 key、不按行号引用；客户端遇未知值按 processing 显示
 * Source: 规划/08 BR-WDR-25 细则「用户侧状态文案」分支表的 sub_text_branch 列；CT-20b（rejected_offset：编排裁定 D10-233 ②） (contracts/enums/fund.yaml).
 */
export const withdrawal_sub_text_branch = [
  "processing", // 分支表 sub_text_branch 列为 processing 的各行（自动判定尚未完成的 PENDING_REVIEW、APPROVED 通用行），也是没有命中任何行时的兜底
  "wechat_wait_confirm", // 分支表 sub_text_branch 列为 wechat_wait_confirm 的行（微信零钱等用户确认且未过确认截止时间；唯一显示去微信确认收款入口的行）
  "wechat_confirm_expired", // 分支表 sub_text_branch 列为 wechat_confirm_expired 的行（微信零钱等用户确认且已过确认截止时间）
  "wechat_canceling", // 分支表 sub_text_branch 列为 wechat_canceling 的行（微信零钱撤销中）
  "wechat_processing", // 分支表 sub_text_branch 列为 wechat_processing 的行（微信零钱其余情况）
  "auto_expected_soon", // 分支表 sub_text_branch 列为 auto_expected_soon 的各行（非微信零钱单在自动到账路径上，PENDING_REVIEW 已判自动到账与 APPROVED / PAYING 两种情形）
  "manual_review_pending", // 分支表 sub_text_branch 列为 manual_review_pending 的行（人工审核且未到审核期限）
  "manual_review_overdue", // 分支表 sub_text_branch 列为 manual_review_overdue 的行（人工审核且已过审核期限）
  "channel_processing", // 分支表 sub_text_branch 列为 channel_processing 的行（PAYING 未到延迟时点；通道名取该单收款渠道）
  "paying_delayed", // 分支表 sub_text_branch 列为 paying_delayed 的行（PAYING 已到延迟时点或 needs_manual）
  "paid_api", // 分支表 PAID_API / PAID_MANUAL 行按状态分开后的 PAID_API（副文案按 BR-TEXT-06 分句）
  "paid_manual", // 分支表 PAID_API / PAID_MANUAL 行按状态分开后的 PAID_MANUAL（副文案按 BR-TEXT-06 分句）
  "rejected_offset", // 分支表 sub_text_branch 列为 rejected_offset 的行（REJECTED 且驳回原因码为 NEGATIVE_BALANCE；先于 rejected 行判定，编排裁定 D10-233 ②）
  "rejected", // 分支表 sub_text_branch 列为 rejected 的行（REJECTED，驳回原因码为 NEGATIVE_BALANCE 的不在此列）
  "failed_account", // 分支表 sub_text_branch 列为 failed_account 的行（FAILED，W6 账号类失败码）
  "failed_other", // 分支表 sub_text_branch 列为 failed_other 的行（FAILED，W6 其他失败码）
  "failed_manual", // 分支表 sub_text_branch 列为 failed_manual 的两行（FAILED，W10，有冻结与无冻结）；两行共用此值，按响应的 hold_days 是否为空选文案（编排裁定 D10-228）
] as const;
export type WithdrawalSubTextBranch = (typeof withdrawal_sub_text_branch)[number];

/**
 * payout_attempts.kind；cancel 只用于微信零钱单的撤销
 * Source: 规划/04 §2.4；BR-WDR-13、BR-WDR-33 ⑥ (contracts/enums/fund.yaml).
 */
export const payout_attempt_kind = [
  "transfer", // 转账
  "query", // 查询
  "cancel", // 撤销
] as const;
export type PayoutAttemptKind = (typeof payout_attempt_kind)[number];

/**
 * 30303 的 data.reason（文案键 error.30303.<reason>，BR-TEXT-14）；编码由契约任务定（contract-delta b2-24）
 * Source: 规划/08 §13.11 30303；BR-WDR-02、BR-WDR-03 细则、BR-WDR-04、BR-WDR-05、BR-FUND-19 (contracts/enums/fund.yaml).
 */
export const withdraw_condition_reason = [
  "account_frozen", // 账户冻结（含账务差异冻结，冻结来源只在后台可见）
  "below_min", // 低于单笔最低金额
  "not_multiple", // 不是规定的整数倍
  "above_max", // 超过单笔最高金额
  "above_method_max", // 超过当前收款方式的单笔上限（withdraw.method_max_amount_fen.<payout_method>，BR-WDR-33 ④）
  "net_too_small", // 扣除手续费与税后到账金额过小
  "daily_count", // 超过每日提现次数
  "monthly_count", // 超过每月提现次数
  "payee_daily_count", // 同一收款账号当日次数已满
  "payee_daily_users", // 同一收款账号当日关联用户数已满
  "self_purchase_required", // 需要先有自购订单
  "payout_account_change_limit", // 本月收款账号变更次数已满（BR-WDR-02 ④）
  "payout_account_verify_limit", // 收款账号付费核验当日次数已满（BR-WDR-02 ⑦）
] as const;
export type WithdrawConditionReason = (typeof withdraw_condition_reason)[number];

/**
 * payout_batch_kind
 * Source: 规划/04 §2.4；BR-WDR-30 (contracts/enums/fund.yaml).
 */
export const payout_batch_kind = [
  "manual", // 人工批次
  "auto", // 自动批次
] as const;
export type PayoutBatchKind = (typeof payout_batch_kind)[number];

/**
 * bad_debt_writeoff_status
 * Source: 规划/04 §2.5；BR-FUND-12 (contracts/enums/fund.yaml).
 */
export const bad_debt_writeoff_status = [
  "PENDING", // 待批准
  "APPROVED", // 已批准
  "CANCELLED", // 已取消
] as const;
export type BadDebtWriteoffStatus = (typeof bad_debt_writeoff_status)[number];

/**
 * 月结账单状态由批次派生、不入库
 * Source: 规划/04 §2.5；BR-FUND-04 (contracts/enums/fund.yaml).
 */
export const settle_batch_status = [
  "DRAFT", // 草稿
  "CONFIRMED", // 已确认
  "EXECUTING", // 执行中
  "PARTIAL", // 部分执行
  "DONE", // 已完成
  "CANCELLED", // 已取消
] as const;
export type SettleBatchStatus = (typeof settle_batch_status)[number];

/**
 * settle_mode
 * Source: 规划/04 §2.5；BR-FUND-04 (contracts/enums/fund.yaml).
 */
export const settle_mode = [
  "IMMEDIATE", // 立即执行
  "SCHEDULED", // 定时执行
] as const;
export type SettleMode = (typeof settle_mode)[number];

/**
 * settle_batch_item_result
 * Source: 规划/04 §2.5；BR-FUND-04 (contracts/enums/fund.yaml).
 */
export const settle_batch_item_result = [
  "credited", // 已入账
  "skipped", // 已跳过
  "deferred", // 受益人补记项的受益人仍在暂缓（BR-FUND-04 ⑫）
] as const;
export type SettleBatchItemResult = (typeof settle_batch_item_result)[number];

/**
 * settle_batch_items.item_type
 * Source: 规划/04 §2.5；BR-FUND-04 (contracts/enums/fund.yaml).
 */
export const settle_batch_item_type = [
  "order", // 子订单行
  "beneficiary", // 受益人补记项
] as const;
export type SettleBatchItemType = (typeof settle_batch_item_type)[number];

/**
 * settle_adjustments.status
 * Source: 规划/04 §2.5；BR-FUND-09、BR-CALC-23 (contracts/enums/fund.yaml).
 */
export const settle_adjustment_status = [
  "pending", // 待审批
  "approved", // 已批准
  "rejected", // 已驳回
  "voided_stale_seq", // 已作废（候选行 seq 已不是当前 seq）
  "voided_by_clawback", // 已作废（扣回发生时作废，BR-FUND-09 ②）
] as const;
export type SettleAdjustmentStatus = (typeof settle_adjustment_status)[number];

/**
 * beneficiary_credits.kind
 * Source: 规划/04 §2.5；BR-FUND-04 ⑫ (contracts/enums/fund.yaml).
 */
export const beneficiary_credit_kind = [
  "first_credit", // 入账时暂缓（迁移 R5 开立）
  "reassign_credit", // 改派重记时新受益人暂缓（R14 开立）
  "deferred", // 正差被延后
] as const;
export type BeneficiaryCreditKind = (typeof beneficiary_credit_kind)[number];

/**
 * beneficiary_credits.status
 * Source: 规划/04 §2.5；BR-FUND-04 ⑫ (contracts/enums/fund.yaml).
 */
export const beneficiary_credit_status = [
  "open", // 待补记
  "done", // 已补记，或执行时金额为 0、不写凭证，或份额已由迁移 R9、R10 同事务补给受益人
  "forfeited", // 已没收，或份额已由迁移 R9、R10 同事务归平台
  "voided", // 订单转 CLAWED_BACK 或改派时作废
] as const;
export type BeneficiaryCreditStatus = (typeof beneficiary_credit_status)[number];

/**
 * recon_diff_type
 * Source: 规划/04 §2.5；BR-FUND-01、BR-FUND-04、BR-FUND-19、BR-FUND-22、BR-FUND-23、BR-PAY-07 (contracts/enums/fund.yaml).
 */
export const recon_diff_type = [
  "union_mismatch", // 联盟对账差异（R1）
  "channel_mismatch", // 通道对账差异（R2）
  "ledger_mismatch", // 内部日终差异（R3）
  "platform_restore", // 已作废订单被平台恢复
  "month_end_unbalanced", // 月末三项不平
  "settle_amount_mismatch", // 月结账单金额不一致
  "settle_missing", // 应结未结
  "appeal_restore", // 申诉撤销后恢复订单
  "estimate_changed_after_credit", // 入账后只有预估佣金变化（BR-FUND-01 R9b；开关关闭时不生成）
  "pay_mismatch", // 收款对账不一致（R4）
  "pay_anomaly", // 收款异常（R4）
] as const;
export type ReconDiffType = (typeof recon_diff_type)[number];

/**
 * payout_batch_items.result；只插入不改，改挂到别的批次时原批次记一行 moved_out
 * Source: 规划/04 §2.4；BR-WDR-11、BR-WDR-12 (contracts/enums/fund.yaml).
 */
export const payout_batch_item_result = [
  "paying", // 进入打款
  "skipped", // 已跳过
  "blocked", // 受阻，留在 APPROVED
  "moved_out", // 已移出，改挂到别的批次
] as const;
export type PayoutBatchItemResult = (typeof payout_batch_item_result)[number];

/**
 * recon_diff_status
 * Source: 规划/04 §2.5；08 §13.6 (contracts/enums/fund.yaml).
 */
export const recon_diff_status = [
  "open", // 待处理
  "processing", // 处理中
  "adjusted", // 已调账
  "written_off", // 已核销
  "closed", // 已关闭（不处理）
] as const;
export type ReconDiffStatus = (typeof recon_diff_status)[number];

/**
 * 联盟回款记录的登记方式；同一笔回款只登记一条
 * Source: BR-FUND-20 及细则「联盟回款凭证」；design/specs/admin-fund-dashboard.md §2 (contracts/enums/fund.yaml).
 */
export const union_receipt_method = [
  "ADMIN_ENTRY", // 后台录入
  "R1_RECON", // R1 对账确认
] as const;
export type UnionReceiptMethod = (typeof union_receipt_method)[number];

/**
 * 联盟回款借记的现金科目；银行卡通道未开通时不接受 CASH_BANK
 * Source: BR-FUND-20 细则「联盟回款凭证」 (contracts/enums/fund.yaml).
 */
export const union_receipt_cash_account = [
  "CASH_ALIPAY", // 企业支付宝
  "CASH_BANK", // 企业对公银行账户
] as const;
export type UnionReceiptCashAccount = (typeof union_receipt_cash_account)[number];

/**
 * 资金台账概览的水位结论；W 或 P 没有、或 W 已过期时不下结论（字段为 null），未回款超告警线不在此枚举
 * Source: BR-WDR-18；design/specs/admin-fund-dashboard.md §2、§3 (contracts/enums/fund.yaml).
 */
export const admin_fund_water_level = [
  "normal", // 正常
  "low", // 水位低
] as const;
export type AdminFundWaterLevel = (typeof admin_fund_water_level)[number];

/**
 * GET /v1/me 返回的身份等级
 * Source: 规划/04 §2.5；BR-ID-01 (contracts/enums/identity.yaml).
 */
export const identity_level = [
  "basic", // 基本模式
  "guest", // 游客
  "member", // 已登录
  "phone", // 已绑手机号
  "realname", // 已实名
] as const;
export type IdentityLevel = (typeof identity_level)[number];

/**
 * 第三方登录身份来源（user_oauth.provider）；手机号验证码登录不属于此列
 * Source: 规划/04 §6.1；BR-ID-04 (contracts/enums/identity.yaml).
 */
export const login_provider = [
  "wechat", // 微信（unionid）
  "apple", // Sign in with Apple（sub）
  "huawei", // 华为账号（unionID，M-公开）
] as const;
export type LoginProvider = (typeof login_provider)[number];

/**
 * 设备标识哈希的来源（devices.id_source）
 * Source: 规划/04 §3.2 devices、§6.1；BR-ID-09 (contracts/enums/identity.yaml).
 */
export const device_id_source = [
  "idfv", // iOS IDFV
  "android_id", // Android ANDROID_ID（MVP Android 只用它）
  "oaid", // Android OAID（MVP 不集成获取方式，预留）
  "odid", // 鸿蒙 ODID
] as const;
export type DeviceIdSource = (typeof device_id_source)[number];

/**
 * 第三方授权尝试的用途（POST /v1/auth/oauth-attempts）
 * Source: 规划/04 §6.1；BR-ID-04、BR-ID-08、BR-WDR-33 ② (contracts/enums/identity.yaml).
 */
export const oauth_attempt_purpose = [
  "login", // 登录
  "step_up", // 二次验证
  "payout_bind", // 收款授权（只用于绑定微信零钱收款账号；不登录、不签发令牌，BR-ID-04 细则「收款授权」）
  "reverify", // 旧号加验（须登录、不带 action，绑定 uid、device_id 与 provider，只能被 POST /v1/me/reverify/oauth 消费，不签发令牌，BR-WDR-01 细则）
] as const;
export type OauthAttemptPurpose = (typeof oauth_attempt_purpose)[number];

/**
 * 旧号加验（核实身份）的方式，按优先级只给一种（BR-WDR-01 细则「旧手机号被二次放号时的提现加验」）
 * Source: 规划/04 §2.5；BR-WDR-01 (contracts/enums/identity.yaml).
 */
export const reverify_method = [
  "id_number", // 身份证号核对（可信身份含实名）
  "oauth", // 第三方重新授权（可信身份不含实名、含第三方身份）
  "manual", // 人工处理（可信身份都没有，或连续失败已达上限、当天锁定；只提示联系客服）
] as const;
export type ReverifyMethod = (typeof reverify_method)[number];

/**
 * access_token 的 scp；登录与刷新按这次请求的客户端版本判定，含义与可调用的接口见 BR-ID-01 细则「受限会话」
 * Source: 规划/04 §2.5、§5；BR-ID-01 (contracts/enums/identity.yaml).
 */
export const session_scope = [
  "full", // 正常作用域
  "deletion_only", // 受限作用域（低于最低支持版本，只能调用注销相关的接口）
] as const;
export type SessionScope = (typeof session_scope)[number];

/**
 * h5_token 的作用域；取值含义与缺省见 BR-ID-32 细则「只读作用域」
 * Source: 规划/04 §2.5、§6.1；BR-ID-32 (contracts/enums/identity.yaml).
 */
export const h5_token_scope = [
  "standard", // 标准
  "read_only", // 只读（GET 以外的接口返回 10403 data.reason=h5_read_only）
] as const;
export type H5TokenScope = (typeof h5_token_scope)[number];

/**
 * sms_purpose
 * Source: 规划/04 §6.1；BR-ID-05 (contracts/enums/identity.yaml).
 */
export const sms_purpose = [
  "login", // 登录
  "bind", // 绑定手机号
  "step_up", // 二次验证
] as const;
export type SmsPurpose = (typeof sms_purpose)[number];

/**
 * step_up_token 的 action，须与所调接口一致
 * Source: 规划/04 §2.5、§5；BR-ID-08 (contracts/enums/identity.yaml).
 */
export const step_up_action = [
  "withdraw", // POST /v1/withdrawals
  "payout_account_change", // PUT /v1/me/payout-account
  "phone_change", // POST /v1/me/phone（更换）
  "account_deletion", // POST /v1/me/deletion
] as const;
export type StepUpAction = (typeof step_up_action)[number];

/**
 * POST /v1/idempotency-keys/abandon 的 outcome
 * Source: 规划/04 §6.1；BR-ID-10 (contracts/enums/identity.yaml).
 */
export const idempotency_abandon_outcome = [
  "abandoned", // 该键已作废（本次写入作废记录，或此前已作废）
  "completed", // 该键已有完成的结果，随响应原样返回，不作废
] as const;
export type IdempotencyAbandonOutcome = (typeof idempotency_abandon_outcome)[number];

/**
 * consent_type
 * Source: 08 §13.2；BR-ID-12、BR-WDR-31、BR-ID-16 (contracts/enums/identity.yaml).
 */
export const consent_type = [
  "privacy", // 隐私政策
  "agreement", // 用户协议
  "ai_third_party", // AI 第三方处理
  "id_verification", // 实名授权
  "personalization", // 个性化推荐
  "labor_agreement", // 劳务协议
  "clipboard_auto_import", // 剪贴板自动识别功能用途同意
] as const;
export type ConsentType = (typeof consent_type)[number];

/**
 * consent_records.channel，同意发生的入口；login_merge、h5_landing、withdraw_flow 只由服务端写入（登录合并、落地页注册、劳务协议签署），不经 POST /v1/consents 提交
 * Source: 规划/04 §3.2 consent_records；BR-ID-12 细则 (contracts/enums/identity.yaml).
 */
export const consent_channel = [
  "first_launch", // 首启隐私弹窗
  "login_page", // 登录页协议勾选
  "h5_landing", // 邀请落地页注册
  "agent_sheet", // Agent 同意半屏
  "realname_sheet", // 实名授权半屏
  "privacy_center", // 隐私中心
  "login_merge", // 登录时设备级记录并入用户级
  "withdraw_flow", // 提现流程中签署劳务协议（BR-WDR-31）
] as const;
export type ConsentChannel = (typeof consent_channel)[number];

/**
 * 淘宝授权方式（auth-url 的 auth_methods、bindings 的 auth_method）；按端由服务端配置下发
 * Source: 规划/04 §6.3；BR-ID-17 (contracts/enums/identity.yaml).
 */
export const auth_method = [
  "web_code", // 网页授权码
  "sdk_token", // 淘宝 SDK 换得的访问令牌
] as const;
export type AuthMethod = (typeof auth_method)[number];

/**
 * 不设 cooling，释放后冷却用 released + cooldown_until；无用户自助换绑
 * Source: 规划/04 §2.5；BR-ID-19、BR-ID-20 (contracts/enums/identity.yaml).
 */
export const union_binding_status = [
  "unbound", // 未绑定
  "pending_auth", // 授权中
  "active", // 有效
  "invalid", // 已失效，需重新授权
  "released", // 已释放
  "blocked", // 已停用
] as const;
export type UnionBindingStatus = (typeof union_binding_status)[number];

/**
 * union_binding_blocked_reason
 * Source: 规划/04 §2.5；BR-ID-20；拍板第二批 OPS-11 (contracts/enums/identity.yaml).
 */
export const union_binding_blocked_reason = [
  "ban", // 封禁
  "admin_disable", // 后台停用返利（可恢复）
  "deletion", // 注销
] as const;
export type UnionBindingBlockedReason = (typeof union_binding_blocked_reason)[number];

/**
 * user_risk_state.state，risk 模块唯一写者
 * Source: 规划/04 §2.5；BR-ID-31 (contracts/enums/identity.yaml).
 */
export const risk_state = [
  "normal", // 正常
  "frozen", // 冻结（可设期限 frozen_until）
  "appealing", // 申诉中
  "banned", // 封禁（永久）
] as const;
export type RiskState = (typeof risk_state)[number];

/**
 * user_risk_state.reason_category，用户可见的原因类别（用户文案取字典 risk_reason.<category>）；state 不为 normal 时必填；后台封禁与冻结时必选一项（PUT /admin/v1/users/{user_id}/risk-state，CT-02j）
 * Source: 规划/04 §3.2 user_risk_state；BR-TEXT-23 细则「原因类别」；BR-ID-31 (contracts/enums/identity.yaml).
 */
export const risk_reason_category = [
  "malicious_rights", // 异常售后维权
  "fraud_invite", // 异常邀请行为
  "abnormal_trade", // 异常交易
  "account_security", // 账户安全核验
  "other", // 违反用户协议
] as const;
export type RiskReasonCategory = (typeof risk_reason_category)[number];

/**
 * realname_status
 * Source: 规划/04 §2.5 (contracts/enums/identity.yaml).
 */
export const realname_status = [
  "none", // 未实名
  "verified", // 已实名
  "failed", // 核验失败
] as const;
export type RealnameStatus = (typeof realname_status)[number];

/**
 * deletion_status
 * Source: 规划/04 §2.5；BR-ID-27 (contracts/enums/identity.yaml).
 */
export const deletion_status = [
  "cooling", // 冷静期
  "processing", // 处理中
  "done", // 已注销
  "cancelled", // 已撤回
] as const;
export type DeletionStatus = (typeof deletion_status)[number];

/**
 * deletion_cancel_reason
 * Source: 规划/04 §3.2 deletion_requests；BR-ID-27 (contracts/enums/identity.yaml).
 */
export const deletion_cancel_reason = [
  "user", // 用户撤回
  "negative_balance", // 冷静期满时余额为负，系统撤销（拍板第二批 §8 ADD-07）
] as const;
export type DeletionCancelReason = (typeof deletion_cancel_reason)[number];

/**
 * tip_key
 * Source: 规划/04 §6.1 /v1/me/tips；BR-ATTR-21、BR-INV-03 细则 (contracts/enums/identity.yaml).
 */
export const tip_key = [
  "jump_tip", // 下单须知（按平台记已读）
  "inviter_before_buy", // 首次购买前的邀请码提示（不分平台）；2026-10-19 作废（BR-INV-03 细则、BR-INV-21）：不再写入与读取，已有行保留，取值不复用；契约里保留不删
] as const;
export type TipKey = (typeof tip_key)[number];

/**
 * appeal_status
 * Source: 规划/04 §2.5；BR-ID-36 (contracts/enums/identity.yaml).
 */
export const appeal_status = [
  "processing", // 处理中
  "upheld", // 维持
  "revoked", // 撤销
] as const;
export type AppealStatus = (typeof appeal_status)[number];

/**
 * appeals.target_type；用户侧申诉接口（POST / GET /v1/me/appeals）只用 account、order，接口里的 AppealTargetType 是本枚举的子集（04 §6.1）
 * Source: 规划/04 §3.2 appeals、§6.1；BR-ID-36（含细则「被拦截请求申诉」） (contracts/enums/identity.yaml).
 */
export const appeal_target_type = [
  "account", // 账号
  "order", // 订单
  "blocked_request", // 被拦截的请求（被 risk_action=block 拦下、返回 44001 的那一次写请求，类型见 blocked_request_type）；只由后台客服代为登记，用户侧申诉接口不接受
] as const;
export type AppealTargetType = (typeof appeal_target_type)[number];

/**
 * appeals.request_type 与 risk_hits 的请求类型；仅 target_type=blocked_request（其余为空）；编码由契约线定稿（规划/06 第 22 项 ⑤，照 08 暂定编码）；以后新增会返回 44001 的写操作，上线前在此加值
 * Source: 规划/04 §3.2 appeals、risk_hits；BR-ID-36 细则「被拦截请求申诉」；编码由契约线定稿（规划/06 第 22 项 ⑤） (contracts/enums/identity.yaml).
 */
export const blocked_request_type = [
  "register", // 注册：用手机号注册或登录时被拦（发验证码、验证码登录即注册、落地页发码与注册，BR-ID-05、BR-ID-32），没有登录态与账号，user_id 为空
  "withdraw", // 提现提交：POST /v1/withdrawals 被拦、没有建单（BR-WDR-03 ③a、BR-ID-31），另记申请金额（整数分）
  "phone_change", // 换手机号：绑定或更换手机号时新号码被拦（BR-ID-06）
  "payout_account", // 收款账号：绑定或更换收款账号时被拦（支付宝、银行卡、微信零钱，BR-WDR-02 ⓪、BR-WDR-33）
] as const;
export type BlockedRequestType = (typeof blocked_request_type)[number];

/**
 * 申诉的来源，后台申诉详情（GET /admin/v1/appeals/{appeal_id}）的 source；编码由契约线定（代理补全的默认），列名由 db / risk 任务定
 * Source: 规划/04 §3.2 appeals「来源（App 内提交 / 后台代为登记）与登记人」、§6.6 appeals；BR-ID-36（CT-24r） (contracts/enums/identity.yaml).
 */
export const appeal_source = [
  "app", // App 内由本人提交（POST /v1/me/appeals），登记人为空
  "admin", // 后台客服代为登记（POST /admin/v1/appeals），登记人为该后台账号
] as const;
export type AppealSource = (typeof appeal_source)[number];

/**
 * 被拦请求的拦截原因类别，后台被拦请求查找与申诉详情的 cause；决定撤销时是移出名单条目（另需 risk.blocklist 与动态码）还是一次性放行（只需 risk.appeal）；编码由契约线定（代理补全的默认）
 * Source: 规划/04 §6.6 appeals「原因类别」、§11.2 risk.appeal；BR-ID-36 细则「被拦截请求申诉」结案；编排裁定 D10-154（CT-24r） (contracts/enums/identity.yaml).
 */
export const blocked_request_cause = [
  "blocklist", // 名单：命中 BR-ID-31 黑名单条目（维度见 blocklist_dimension），撤销时在结案同一操作里移出造成拦截的名单条目
  "rule", // 其他拦截规则：同设备注册上限、落地页同 IP 注册上限等 risk_action=block 的规则（BR-ID-05、BR-ID-32），撤销时一次性放行
] as const;
export type BlockedRequestCause = (typeof blocked_request_cause)[number];

/**
 * blocklist.dimension，取值与 blocklist 表的 CHECK 约束一致；后台被拦请求查找与申诉详情用它显示「黑名单 · 维度」；order_no_suffix、channel 是订单侧维度，不会造成 44001 拦截
 * Source: 规划/04 §3.2 blocklist 维度；BR-ID-31、BR-ATTR-26（CT-24r） (contracts/enums/identity.yaml).
 */
export const blocklist_dimension = [
  "phone", // 手机号（HMAC）
  "id_no", // 身份证号（HMAC）
  "alipay", // 支付宝收款账号（HMAC）
  "bank_card", // 银行卡收款账号（HMAC）
  "wechat_openid", // 微信零钱收款 openid（HMAC）
  "device", // 设备哈希
  "relation_id", // 联盟 relation_id
  "order_no_suffix", // 淘宝订单号后 6 位（订单侧，BR-ATTR-26）
  "channel", // 渠道（订单侧，BR-ATTR-26）
] as const;
export type BlocklistDimension = (typeof blocklist_dimension)[number];

/**
 * risk_hits.ref_type，命中记录关联对象的类型；取值与 risk_hits 表的 CHECK 约束一致；后台申诉详情的命中记录 ref_type
 * Source: 规划/04 §3.2 risk_hits.ref_type；BR-ID-36（CT-24r） (contracts/enums/identity.yaml).
 */
export const risk_hit_ref_type = [
  "order", // 订单
  "withdrawal", // 提现单
  "blocked_request", // 被拦截的请求（返回 44001 的那一次写请求，ref_id 即拦截请求编号）
  "invite_relation", // 邀请关系
  "invite_reward", // 邀请奖励
] as const;
export type RiskHitRefType = (typeof risk_hit_ref_type)[number];

/**
 * invite_rewards.status，邀请奖励活动资格与发放记录的状态；编码由契约线定，含义只在 BR-INV-24；不发与作废的原因只在后台可查，用户端不展示；budget_exhausted 2026-10-20 取消（无路径，BR-INV-24 有效期）
 * Source: 规划/04 §3.2 invite_rewards；BR-INV-24 细则「资格记录与状态」「有效期」 (contracts/enums/identity.yaml).
 */
export const invite_reward_status = [
  "qualified", // 已取得资格（等触发）
  "deferred", // 顺延（已触发，当日预算不够或暂停发放，次日起按触发先后补发）
  "processed", // 已处理（两方各自已发或不发）
  "voided", // 作废（终态，原因见 invite_reward_void_reason）
  "expired", // 已过期（终态：有效期内没有可触发的自购子订单，到期由每日任务判定，释放总预算占用；取代 2026-10-20 前的预算用尽）
] as const;
export type InviteRewardStatus = (typeof invite_reward_status)[number];

/**
 * invite_rewards.inviter_result、invitee_result，一方的发放结果；处理前为空
 * Source: 规划/04 §3.2 invite_rewards；BR-INV-24 细则「资格记录与状态」 (contracts/enums/identity.yaml).
 */
export const invite_reward_party_result = [
  "granted", // 已发
  "skipped", // 不发（原因见 invite_reward_skip_reason）
] as const;
export type InviteRewardPartyResult = (typeof invite_reward_party_result)[number];

/**
 * invite_rewards 两方各一的不发原因（可空）；前三个双方都不发，后四个只命中的一方不发、另一方照发；编码由契约线定，含义只在 BR-INV-24
 * Source: 规划/04 §3.2 invite_rewards；BR-INV-24 ③、细则「判定顺序」第 4、5 步 (contracts/enums/identity.yaml).
 */
export const invite_reward_skip_reason = [
  "same_device", // 同设备：两人的设备集合相交（BR-INV-08 ③ 口径），双方都不发
  "same_ip", // 同 IP：被邀请人绑定时的 IP 与邀请人绑定前一段时间内的登录 IP 相同，双方都不发
  "deleted_phone_retained", // 被邀请人手机号命中未过期的注销留存记录（BR-ID-28、BR-ID-06），双方都不发
  "multi_account", // 该方被 BR-ID-37 标为同设备多账号，只该方不发
  "risk_restricted", // 该方处于封禁、申诉中或冻结（risk_state ∈ {banned, appealing, frozen}），只该方不发
  "deleting", // 该方处于注销流程（cooling、processing、done），只该方不发
  "minor", // 该方为已识别未满 18 周岁（BR-ID-26），只该方不发
] as const;
export type InviteRewardSkipReason = (typeof invite_reward_skip_reason)[number];

/**
 * invite_rewards.void_reason，资格作废的原因（可空，仅 status=voided）；编码由契约线定，含义只在 BR-INV-24
 * Source: 规划/04 §3.2 invite_rewards；BR-INV-24 ③ ⑥、细则「判定顺序」第 2、3 步 (contracts/enums/identity.yaml).
 */
export const invite_reward_void_reason = [
  "relation_changed", // 关系已变：发放时被邀请人的上级已不是资格记录里的邀请人
  "order_clawed_back", // 触发之后、发放之前触发订单被扣回（CLAWED_BACK，含部分退款扣回）
  "order_rights", // 触发之后、发放之前触发订单进入维权
] as const;
export type InviteRewardVoidReason = (typeof invite_reward_void_reason)[number];

/**
 * invite_rewards.bind_source，取得资格时的绑定渠道；后台改上级（admin）不取得资格，不在此列
 * Source: 规划/04 §3.2 invite_rewards；BR-INV-24 ① (contracts/enums/identity.yaml).
 */
export const invite_reward_bind_source = [
  "landing", // 邀请落地页注册绑定
  "register", // 注册时随登录绑定
  "backfill", // 注册后补填邀请码
] as const;
export type InviteRewardBindSource = (typeof invite_reward_bind_source)[number];

/**
 * personal_data_copies.delivery，个人信息副本的交付方式；登记时由两项通道情况判定（app_login_ok 与 phone_sms_ok 都为真 → in_app_sms，都为假 → wecom_session，只有一项为真时待法务确认、不受理）
 * Source: 规划/04 §3.2 personal_data_copies、§6.6 users/{id}/data-exports；BR-ID-40 细则（CT-24q） (contracts/enums/identity.yaml).
 */
export const personal_data_copy_delivery = [
  "in_app_sms", // 站内信与短信：站内信只带进入 App 内副本页（路由 DataCopy）的入口、不带链接，提取码短信发到绑定手机号，用户经 GET /v1/me/data-copies/{id}/download 下载
  "wecom_session", // 企业微信会话：登记人经 POST /admin/v1/users/{user_id}/data-exports/{export_id}/download 取文件与一次性口令，在企业微信会话里发给用户，口令另行告知
] as const;
export type PersonalDataCopyDelivery = (typeof personal_data_copy_delivery)[number];

/**
 * personal_data_copies.status；未结束的是 pending、running、ready（同一用户同时最多 1 条）；迁移 pending→running→ready（文件已生成）→delivered（in_app_sms 发出提取码短信时，wecom_session 登记人第一次下载时）；生成失败或登记人失去下载权限（后台账号停用，或重新登记时发现已不同时持 user.data_export 与 pii.reveal_phone）且未交付→failed；文件生成后 24 小时→expired；账号进入注销 processing 时未结束的→cancelled
 * Source: 规划/04 §3.2 personal_data_copies；BR-ID-40 细则、BR-ID-30 ⑨（CT-24q） (contracts/enums/identity.yaml).
 */
export const personal_data_copy_status = [
  "pending", // 已登记，等待生成
  "running", // 生成中
  "ready", // 文件已生成，尚未交付
  "delivered", // 已交付（文件在 expires_at 前仍可下载）
  "failed", // 失败（重新登记的新请求记 retry_of 并沿用截止时刻）
  "expired", // 已过期（生成后 24 小时，文件已删除）
  "cancelled", // 已取消（账号进入注销处理，文件一并删除）
] as const;
export type PersonalDataCopyStatus = (typeof personal_data_copy_status)[number];

/**
 * 消息模板编码；UNION_AUTH_EXPIRING、UNION_AUTH_EXPIRED 只发站长手机号，不属于用户通知分类
 * Source: 规划/04 §2.5；BR-TEXT-09、BR-TEXT-20 (contracts/enums/ops.yaml).
 */
export const notify_template_code = [
  "ORDER_TRACKED", // 订单已跟单
  "ORDER_INVALID", // 订单失效
  "CREDITED", // 月结批次入账（按受益人汇总）
  "CLAWBACK", // 扣回
  "WD_SUCCESS", // 提现成功
  "WD_REJECTED", // 提现驳回
  "WD_FAILED", // 提现失败
  "WD_OVERDUE", // 提现审核超时
  "CLAIM_RESULT", // 找回结果
  "RISK_STATE_CHANGED", // 风控状态变化（只发站内信）
  "APPEAL_RESULT", // 申诉结果（只发站内信）
  "DELETION_PROGRESS", // 注销进度（只发站内信）
  "BALANCE_ADJUSTED", // 人工调账调减（只发站内信）
  "SMS_CODE", // 短信验证码
  "UNION_AUTH_EXPIRING", // 站长授权即将到期（短信）
  "UNION_AUTH_EXPIRED", // 站长授权已过期（短信）
  "DATA_COPY_READY", // 个人信息副本已生成（推送 + 站内信）
  "DATA_COPY_CODE", // 个人信息副本提取码（短信，发到绑定手机号）
] as const;
export type NotifyTemplateCode = (typeof notify_template_code)[number];

/**
 * 用户通知分类；交易与提现模板都归 service，MVP 只开放 service 开关，subscription、marketing 预埋不展示（待负责人确认）
 * Source: 规划/04 §2.5；拍板第二批 OPS-16；BR-WATCH-19 (contracts/enums/ops.yaml).
 */
export const notify_category = [
  "service", // 服务类
  "subscription", // 订阅类（预埋）
  "marketing", // 营销类（预埋）
] as const;
export type NotifyCategory = (typeof notify_category)[number];

/**
 * 分销等级，晋升只看本人推广订单；用户端不展示（拍板第二批 OPS-20）
 * Source: 规划/04 §2.5 (contracts/enums/ops.yaml).
 */
export const user_level = [
  "L1", // 一级
  "L2", // 二级
  "L3", // 三级
] as const;
export type UserLevel = (typeof user_level)[number];

/**
 * agent_intent
 * Source: 规划/04 §2.5 (contracts/enums/ops.yaml).
 */
export const agent_intent = [
  "find_by_link", // 按链接找货
  "search", // 搜索
  "refine", // 追加条件
  "order_query", // 查订单
  "rule_qa", // 规则问答
  "handoff", // 转人工
  "clarify", // 澄清
  "out_of_scope", // 范围外
  "page_guide", // 页面引导（不是工具，输出带 guide_route；BR-AI-01 细则「页面引导」，D31）
  "earnings_query", // 查收益（由 get_my_earnings 工具名推出；BR-AI-01 细则「收益查询」，D32）
] as const;
export type AgentIntent = (typeof agent_intent)[number];

/**
 * Agent 卡片类型；watch_confirm、watch_list 为 P1，MVP 不注册，不列入
 * Source: 规划/04 §8.3；08 §13.2 (contracts/enums/ops.yaml).
 */
export const agent_card_type = [
  "product_list", // 商品列表
  "rebate_quote", // 查返利
  "order_status", // 订单状态
  "claim_draft", // 找回草稿
  "handoff", // 转人工
  "auth_required", // 需要授权
  "notice", // 提示
  "rule_ref", // 规则引用
  "page_guide", // 页面引导（D31）
  "earnings_summary", // 收益摘要（只读，D32）
] as const;
export type AgentCardType = (typeof agent_card_type)[number];

/**
 * agent_runs.page_guide_reject_reason，页面引导意图不出卡的原因（BR-AI-01 细则「页面引导」）
 * Source: 规划/04 §3.2 (contracts/enums/ops.yaml).
 */
export const page_guide_reject_reason = [
  "not_allowed", // 不在 agent.page_guide.routes 内（含其他路由名、URL、空值）
  "extra_fields", // 带了 agent_intent、guide_route 以外的字段
  "disabled", // 开关 agent.page_guide.enabled 为 off
  "untrusted_input", // 本条消息含不可信文本或链接
  "params_requested", // 用户要求带参数打开
] as const;
export type PageGuideRejectReason = (typeof page_guide_reject_reason)[number];

/**
 * SSE done 事件的 finish_reason
 * Source: 规划/04 §8.2；BR-AI-01、BR-AI-14、BR-AI-16、BR-AI-18 (contracts/enums/ops.yaml).
 */
export const agent_finish_reason = [
  "stop", // 正常结束
  "cancelled", // 已取消
  "limit", // 达到上限
  "budget", // 预算用完
  "error", // 出错
  "auth_required", // 需要授权
  "safety", // 安全拦截
  "fallback", // 无模型降级出卡
  "timeout", // 单轮时限到
] as const;
export type AgentFinishReason = (typeof agent_finish_reason)[number];

/**
 * watch_status
 * Source: 规划/04 §2.5；BR-WATCH-10（P1） (contracts/enums/ops.yaml).
 */
export const watch_status = [
  "active", // 生效中
  "paused", // 已暂停
  "unavailable", // 不可用
  "expired", // 已过期
  "cancelled", // 已取消
] as const;
export type WatchStatus = (typeof watch_status)[number];

/**
 * watch_event_status
 * Source: 规划/04 §2.5；BR-WATCH-11（P1） (contracts/enums/ops.yaml).
 */
export const watch_event_status = [
  "pending", // 待发送
  "suppressed", // 已抑制
  "sent", // 已发送
] as const;
export type WatchEventStatus = (typeof watch_event_status)[number];

/**
 * 联盟订单状态，唯一写者 order-sync；SETTLED 只表示联盟结算，不表示回款或我方入账
 * Source: 规划/04 §2.3；BR-FUND-02 (contracts/enums/order.yaml).
 */
export const platform_status = [
  "DEPOSIT_PAID", // 预售已付定金
  "PAID", // 已付款
  "RECEIVED", // 已确认收货
  "SETTLED", // 联盟已结算
  "INVALID", // 已失效
] as const;
export type PlatformStatus = (typeof platform_status)[number];

/**
 * 返利状态，唯一写者 settlement；VOID、CLAWED_BACK 为终态——自动事件不得离开，只有人工恢复 R12、R13 可以离开，R3b 在 VOID 上只写归属（BR-FUND-01）
 * Source: 规划/04 §2.3；BR-FUND-01 (contracts/enums/order.yaml).
 */
export const rebate_status = [
  "UNATTRIBUTED", // 未归因（不对用户展示）
  "ESTIMATED", // 预估
  "WAITING", // 等待月结入账
  "CREDITED", // 已入账
  "VOID", // 已作废（终态）
  "CLAWED_BACK", // 已扣回（终态）
] as const;
export type RebateStatus = (typeof rebate_status)[number];

/**
 * 用户可见状态，接口按 BR-FUND-17 派生表派生、不入库；文案取字典 order_status.<值>（BR-TEXT-02）；WAITING_SETTLE 在月结口径下停用，不进契约
 * Source: 规划/04 §2.3；BR-FUND-17 (contracts/enums/order.yaml).
 */
export const display_status = [
  "PAID", // 见 BR-FUND-17 派生表
  "DEPOSIT_PAID", // 见 BR-FUND-17 派生表
  "WAITING", // 见 BR-FUND-17 派生表
  "CREDITING", // 见 BR-FUND-17 派生表
  "REVIEWING", // 见 BR-FUND-17 派生表
  "RIGHTS_PENDING", // 见 BR-FUND-17 派生表
  "CREDITED", // 见 BR-FUND-17 派生表
  "CREDITED_PART_CLAWED", // 见 BR-FUND-17 派生表
  "NO_REBATE", // 见 BR-FUND-17 派生表
  "INVALID", // 见 BR-FUND-17 派生表
  "CLAWED_BACK", // 见 BR-FUND-17 派生表
] as const;
export type DisplayStatus = (typeof display_status)[number];

/**
 * orders.hold_reason，不改 rebate_status
 * Source: 规划/04 §2.3；08 §13.6；BR-FUND-06、BR-FUND-02 (contracts/enums/order.yaml).
 */
export const order_hold_reason = [
  "RISK", // 风控暂停入账
  "CS", // 客服暂停入账
  "UNMAPPED_STATUS", // 映射表之外的平台状态码出现时由系统置（BR-FUND-02）
] as const;
export type OrderHoldReason = (typeof order_hold_reason)[number];

/**
 * GET /v1/orders 的 status_group；各组包含哪些 display_status 只在 BR-TEXT-02 细则
 * Source: 规划/04 §6.4；BR-TEXT-02 细则「订单列表的状态分组与查找」 (contracts/enums/order.yaml).
 */
export const order_status_group = [
  "all", // 全部（含未知编码）
  "estimating", // 预估中
  "credited", // 已结算
  "no_rebate", // 无返利
] as const;
export type OrderStatusGroup = (typeof order_status_group)[number];

/**
 * 订单详情时间线节点（编码代理自定；04 只点名 deposit_paid，final_paid 与 08 12_TEXT 文案表的键 order_timeline.final_paid 对齐（BR-TEXT-02 细则「时间线」））；未发生的节点 at 为空
 * Source: 规划/04 §6.4；BR-TEXT-02 细则「时间线」 (contracts/enums/order.yaml).
 */
export const order_timeline_node = [
  "deposit_paid", // 付定金（只有预售单，在最前面；文案键 order_timeline.deposit_paid）
  "paid", // 付款（非预售单）
  "final_paid", // 付尾款（预售单用它代替 paid；文案键 order_timeline.final_paid）
  "received", // 收货
  "credit_expected", // 预计结算月份（period）
  "credited", // 已结算
  "invalid", // 失效
  "clawed_back", // 扣回
  "part_clawed_back", // 部分扣回
] as const;
export type OrderTimelineNode = (typeof order_timeline_node)[number];

/**
 * 订单原因码；NOT_TRACKED、EXPIRED_CLICK、OTHER_TLJ、RELATION_INVALID 不写入 orders.reason。CANCELLED 待 09 实测，启用前不写入。rebate_status=CLAWED_BACK 同样写 orders.reason（迁移 R8 同事务写，取值按 BR-FUND-08 细则的映射表）
 * Source: 规划/04 §2.3；BR-TEXT-05；08 §13.2 (contracts/enums/order.yaml).
 */
export const order_reason = [
  "REFUND", // 退款
  "RIGHTS", // 维权
  "PUNISH", // 处罚
  "PRESALE_UNPAID", // 预售尾款未付
  "COMMISSION_ZERO", // 佣金为 0
  "OTHER", // 其他
  "BLACKLIST", // 黑名单
  "PART_REFUND", // 部分退款（差额类）
  "PRICE_COMPARE", // 比价（差额类）
  "PRICE_PROTECT", // 价保（差额类）
  "SETTLE_DIFF", // 结算差异（差额类）
  "NOT_TRACKED", // 未跟单
  "EXPIRED_CLICK", // 点击已过期
  "OTHER_TLJ", // 他人淘礼金
  "RELATION_INVALID", // 渠道关系失效
  "CANCELLED", // 订单取消（待定，启用前不写入）
] as const;
export type OrderReason = (typeof order_reason)[number];

/**
 * orders.diff_reason_code，差额原因只用这 4 个
 * Source: 规划/04 §2.3；BR-CALC-14；08 §13.2（settle_diff_reason） (contracts/enums/order.yaml).
 */
export const diff_reason = [
  "PART_REFUND", // 部分退款
  "PRICE_COMPARE", // 比价
  "PRICE_PROTECT", // 价保
  "SETTLE_DIFF", // 结算差异
] as const;
export type DiffReason = (typeof diff_reason)[number];

/**
 * order_rights.status；PROCESSING、WAIT_COMMISSION 使 rights_pending=true
 * Source: 规划/04 §2.3；BR-FUND-06 (contracts/enums/order.yaml).
 */
export const order_rights_status = [
  "PROCESSING", // 处理中
  "WAIT_COMMISSION", // 待扣佣
  "SUCCEEDED", // 维权成功
  "FAILED", // 维权失败
] as const;
export type OrderRightsStatus = (typeof order_rights_status)[number];

/**
 * order_rights.type；处罚类平台码与处罚接口写 PUNISH；淘宝维权码到 order_rights.status 的映射待 CAP-TB-08
 * Source: 规划/04 §2.3；BR-FUND-02、BR-FUND-06 (contracts/enums/order.yaml).
 */
export const order_rights_type = [
  "RIGHTS", // 维权
  "PUNISH", // 处罚
  "INVALID_AFTER_SETTLE", // 结算后失效
  "REFUND_AFTER_SETTLE", // 结算后退款
] as const;
export type OrderRightsType = (typeof order_rights_type)[number];

/**
 * claim_status
 * Source: 规划/04 §2.5；BR-ATTR-16、BR-ATTR-18 (contracts/enums/order.yaml).
 */
export const claim_status = [
  "submitted", // 已提交
  "auto_matched", // 全部子项 strong，待客服确认
  "manual_review", // 人工审核
  "approved", // 已通过
  "rejected", // 已驳回
  "cancelled", // 同步已自动归因给申请人
] as const;
export type ClaimStatus = (typeof claim_status)[number];

/**
 * claim_evidence_level
 * Source: 规划/04 §2.3；BR-ATTR-16 (contracts/enums/order.yaml).
 */
export const claim_evidence_level = [
  "strong", // 强
  "weak", // 弱
  "none", // 无
] as const;
export type ClaimEvidenceLevel = (typeof claim_evidence_level)[number];

/**
 * claim_items.decision，待审为 null
 * Source: 规划/04 §2.3；BR-ATTR-18 (contracts/enums/order.yaml).
 */
export const claim_item_decision = [
  "approved", // 通过
  "rejected", // 驳回
  "cancelled", // 同步已自动归因给申请人
] as const;
export type ClaimItemDecision = (typeof claim_item_decision)[number];

/**
 * 前 6 个客服可选，NOT_IN_POOL、ORDER_INVALID 系统专用
 * Source: 规划/04 §2.3；BR-ATTR-18 (contracts/enums/order.yaml).
 */
export const claim_reject_reason = [
  "NO_EVIDENCE", // 缺少证据
  "EXPIRED_CLICK", // 点击已过期
  "NOT_TRACKED", // 未跟单
  "OTHER_TLJ", // 他人淘礼金
  "FRAUD", // 欺诈
  "OTHER", // 其他
  "NOT_IN_POOL", // 不在未归因池（系统专用）
  "ORDER_INVALID", // 订单已失效（系统专用）
] as const;
export type ClaimRejectReason = (typeof claim_reject_reason)[number];

/**
 * 后台手动同步的方式（order_sync_requests.mode）；POST /admin/v1/order-syncs 的请求体二选一
 * Source: 规划/04 §3.2 order_sync_requests、§6.6 order-syncs；规划/01 F-ORD-10；中文名 BR-TEXT-25 admin_dict.order_sync_requests.mode（CT-24n） (contracts/enums/order.yaml).
 */
export const order_sync_mode = [
  "window", // 按时间窗（platform、from、to，可选 status_filter）
  "order_nos", // 按订单号（platform、order_nos，1–50 个子订单号）
] as const;
export type OrderSyncMode = (typeof order_sync_mode)[number];

/**
 * 后台手动同步请求的状态（order_sync_requests.status）；同一筛选条件在 queued 或 running 期间再提交返回原请求
 * Source: 规划/04 §3.2 order_sync_requests、§6.6 order-syncs；中文名 BR-TEXT-25 admin_dict.order_sync_requests.status（CT-24n） (contracts/enums/order.yaml).
 */
export const order_sync_status = [
  "queued", // 排队中
  "running", // 同步中
  "done", // 已完成
  "failed", // 失败
] as const;
export type OrderSyncStatus = (typeof order_sync_status)[number];

/**
 * 后台 Excel 导入的类型（rights_imports.kind）；channel 另需 risk.blocklist 与动态码（BR-ATTR-26 细则「渠道单导入」）
 * Source: 规划/01 F-ORD-10；规划/04 §3.2 rights_imports、§6.6 rights-imports；中文名 BR-TEXT-25 admin_dict.rights_imports.kind（CT-24n） (contracts/enums/order.yaml).
 */
export const rights_import_kind = [
  "rights", // 维权单（按子订单号）
  "punish", // 违规单（按子订单号，写 order_rights.type=PUNISH）
  "channel", // 渠道单（按 relation_id，写黑名单）
] as const;
export type RightsImportKind = (typeof rights_import_kind)[number];

/**
 * 维权 / 违规单导入按哪个时间筛选行（rights_imports.time_basis）；渠道单恒为空
 * Source: 规划/01 F-ORD-10；BR-FUND-06 细则「维权导入任务」；中文名 BR-TEXT-25 admin_dict.rights_imports.time_basis（CT-24n） (contracts/enums/order.yaml).
 */
export const rights_import_time_basis = [
  "paid", // 付款时间
  "received", // 收货时间
] as const;
export type RightsImportTimeBasis = (typeof rights_import_time_basis)[number];

/**
 * 后台 Excel 导入任务的状态（rights_imports.status）
 * Source: 规划/04 §3.2 rights_imports、§6.6 rights-imports；中文名 BR-TEXT-25 admin_dict.rights_imports.status（CT-24n） (contracts/enums/order.yaml).
 */
export const rights_import_status = [
  "queued", // 排队中
  "running", // 导入中
  "done", // 已完成
  "failed", // 失败
] as const;
export type RightsImportStatus = (typeof rights_import_status)[number];

/**
 * 导入逐行失败的原因（rights_import_failures.reason），是行原因枚举，不是错误码
 * Source: BR-FUND-06 细则「维权导入任务」；规划/04 §3.2 rights_import_failures、§6.6 rights-imports；中文名 BR-TEXT-25 admin_dict.rights_import_failure_reason（CT-24n） (contracts/enums/order.yaml).
 */
export const rights_import_failure_reason = [
  "invalid_row", // 行格式不对
  "order_not_found", // 订单不在本系统
  "sub_order_no_missing", // 缺子订单号（只有主订单号的行不展开）
  "received_at_missing", // 无收货时间
  "platform_mismatch", // 平台不符
] as const;
export type RightsImportFailureReason = (typeof rights_import_failure_reason)[number];

/**
 * pay_orders.pay_channel 等；与 payout_channel 无关
 * Source: 规划/04 §2.4；BR-PAY-01 (contracts/enums/pay.yaml).
 */
export const pay_channel = [
  "wechat_pay", // 微信支付（APP 支付）
  "alipay", // 支付宝（App 支付）
] as const;
export type PayChannel = (typeof pay_channel)[number];

/**
 * pay_orders.status；PAID、CLOSED 为终态
 * Source: 规划/04 §2.4；BR-PAY-02 (contracts/enums/pay.yaml).
 */
export const pay_order_status = [
  "PENDING", // 待支付
  "PAID", // 已支付
  "CLOSED", // 已关闭
] as const;
export type PayOrderStatus = (typeof pay_order_status)[number];

/**
 * pay_refunds.status
 * Source: 规划/04 §2.4；BR-PAY-06 ① (contracts/enums/pay.yaml).
 */
export const pay_refund_status = [
  "PROCESSING", // 处理中
  "SUCCESS", // 成功
  "FAILED", // 失败
] as const;
export type PayRefundStatus = (typeof pay_refund_status)[number];

/**
 * pay_refunds.target_type；退款对象是一张 PAID 的支付单，或一条异常收款（BR-PAY-05 ④）
 * Source: 规划/04 §2.4；BR-PAY-06 ① (contracts/enums/pay.yaml).
 */
export const pay_refund_target_type = [
  "pay_order", // 支付单
  "pay_anomaly", // 异常收款
] as const;
export type PayRefundTargetType = (typeof pay_refund_target_type)[number];

/**
 * pay_query_attempts.kind
 * Source: 规划/04 §2.4；BR-PAY-04、BR-PAY-05、BR-PAY-06 (contracts/enums/pay.yaml).
 */
export const pay_query_attempt_kind = [
  "query", // 查询
  "close", // 关单
  "refund", // 退款
  "refund_query", // 退款查询
] as const;
export type PayQueryAttemptKind = (typeof pay_query_attempt_kind)[number];

/**
 * 收款凭证类型，只用于平台科目，不属于用户流水的 ledger_type，不出现在任何用户流水接口
 * Source: 规划/04 §2.4；BR-PAY-07 (contracts/enums/pay.yaml).
 */
export const pay_ledger_type = [
  "PAY_RECEIPT", // 收款
  "PAY_REFUND", // 退款
  "PAY_ANOMALY", // 异常收款
  "PAY_FEE", // 渠道手续费
] as const;
export type PayLedgerType = (typeof pay_ledger_type)[number];

/**
 * pay_refunds.reason_code；后台退款必须选原因码，中文名见 texts.admin 的 admin_dict.pay_refund_reason
 * Source: BR-PAY-06 细则默认值 (contracts/enums/pay.yaml).
 */
export const pay_refund_reason = [
  "USER_REQUEST", // 用户申请退款
  "DUPLICATE_PAYMENT", // 重复支付
  "ANOMALY_RECEIPT", // 异常收款退回
  "RECON_DIFF", // 对账差错
  "OTHER", // 其他
] as const;
export type PayRefundReason = (typeof pay_refund_reason)[number];

/**
 * 错误码 30901 的 data.reason；用户侧不区分原因，统一提示 error.30901
 * Source: BR-PAY-01 ④ (contracts/enums/pay.yaml).
 */
export const pay_unavailable_reason = [
  "pay_disabled", // 收款总开关关闭
  "channel_disabled", // 该渠道停止新下单
  "platform_not_allowed", // 该端不允许支付
  "biz_not_sellable", // 该业务对象不可购买
] as const;
export type PayUnavailableReason = (typeof pay_unavailable_reason)[number];

/**
 * 平台字符串编码，不使用数字；天猫是淘宝的 shop_type=tmall，不单独占编码。能力与阶段由平台字典表 platforms 记录，代码不按本列表判断能力
 * Source: 规划/04 §2.1；08 §13.2 (contracts/enums/platform.yaml).
 */
export const platform = [
  "taobao", // 淘宝 / 天猫（M-内测）
  "jd", // 京东（M-内测）
  "pdd", // 拼多多（M-内测）
  "meituan", // 美团（外卖、到店活动；P1，D15）
  "vip", // 唯品会（P1）
  "douyin", // 抖音（P1）
  "eleme", // 饿了么（P1，无商品形态）
  "kuaishou", // 快手（P2）
  "suning", // 苏宁（P2）
] as const;
export type Platform = (typeof platform)[number];

/**
 * platforms.key_stability，平台 product_key 派生的稳定性验证结论
 * Source: 规划/04 §2.1；BR-PROD-03 (contracts/enums/platform.yaml).
 */
export const key_stability = [
  "unverified", // 未验证
  "stable_24h", // 24 小时内稳定
  "stable_7d", // 7 天内稳定
  "unstable", // 不稳定
] as const;
export type KeyStability = (typeof key_stability)[number];

/**
 * 发起请求的客户端
 * Source: 规划/03 §4.2（请求头 X-Platform） (contracts/enums/platform.yaml).
 */
export const client_platform = [
  "ios", // iOS App
  "android", // Android App
  "harmony", // 鸿蒙 App
  "h5", // App 内或 App 外 H5
  "admin", // 管理后台
] as const;
export type ClientPlatform = (typeof client_platform)[number];

/**
 * contracts/routes.json 每条路由的 entry；入口类别看 route 的来源，不看请求里的标记
 * Source: 规划/04 §10.1 跳转段；BR-ID-10 细则「路由入口矩阵」「入口类别看 route 的来源」 (contracts/enums/platform.yaml).
 */
export const route_entry = [
  "in_app", // App 内发起（原生页面、首页卡片与弹窗、站内信、Agent 卡片、JSBridge nav.open）
  "push", // 服务端按消息编号回查返回的 route
  "deeplink", // 客户端从外部直接拿到的 route（通用链接、自定义 scheme、启动参数里直接带来的任何 route）
] as const;
export type RouteEntry = (typeof route_entry)[number];

/**
 * /v1/config.features.search_status 的值，由 search.enabled.<platform> 派生
 * Source: 规划/04 §2.5、§10.1；BR-PROD-10 (contracts/enums/platform.yaml).
 */
export const platform_search_status = [
  "on", // 可搜索
  "off", // 搜索关闭
] as const;
export type PlatformSearchStatus = (typeof platform_search_status)[number];

/**
 * 安装包渠道
 * Source: 规划/04 §5（请求头 X-Channel）；拍板第二批 TECH-18 (contracts/enums/platform.yaml).
 */
export const install_channel = [
  "appstore", // iOS App Store
  "official", // Android 通用包
  "huawei", // 华为渠道 Android 包
  "agc", // 鸿蒙 AGC
] as const;
export type InstallChannel = (typeof install_channel)[number];

/**
 * 接口的鉴权级别；optional = 带令牌按用户处理、不带按匿名处理
 * Source: 规划/04 §5（openapi 扩展 x-auth）；08 §13.6 (contracts/enums/platform.yaml).
 */
export const auth_level = [
  "none", // 不需要登录
  "optional", // 可选登录
  "login", // 需要登录
  "phone", // 需要已绑手机号
  "realname", // 需要已实名
] as const;
export type AuthLevel = (typeof auth_level)[number];

/**
 * 平台标识键，/v1/config.platform_icons 的键与后台「平台标识」接口的 {key} 同一份；新增平台按 BR-TEXT-24 同样规则补值
 * Source: 规划/04 §10.1（platform_icons）；08 BR-TEXT-24 细则标识键表 (contracts/enums/platform.yaml).
 */
export const platform_icon_key = [
  "taobao", // 淘宝
  "tmall", // 天猫
  "jd", // 京东
  "pdd", // 拼多多（内置文件名 pinduoduo）
  "wechat", // 微信
  "wechat_pay", // 微信支付（内置文件名 wechat-pay）
  "alipay", // 支付宝
  "wecom", // 企业微信
] as const;
export type PlatformIconKey = (typeof platform_icon_key)[number];

/**
 * 转链来源，转链请求必填，缺失或非法返回 20001。watch_alert 为 MVP 预埋（开关关闭，不对用户展示，BR-WATCH-19 待确认）；taolijin 在 tlj.enabled=off 期间服务端不接受；share_ext、wechat_bot、mcp 为 P1
 * Source: 规划/04 §2.2；BR-ATTR-08；08 §13.2 (contracts/enums/trade.yaml).
 */
export const scene = [
  "search", // 搜索结果
  "detail", // 商品详情
  "home_card", // 首页卡片
  "feed", // 信息流
  "clipboard", // 剪贴板识别
  "agent", // Agent
  "share", // 分享
  "h5", // H5（trade.convertAndOpen）
  "push", // 推送
  "taolijin", // 淘礼金（后续接入，D7）
  "watch_alert", // 提醒（MVP 预埋，关闭）
  "share_ext", // 分享扩展（P1）
  "wechat_bot", // 微信入口（P1）
  "mcp", // MCP（P1）
] as const;
export type Scene = (typeof scene)[number];

/**
 * 推广位场景，服务端由 scene 推出，不由客户端传入
 * Source: 规划/04 §2.2；BR-ATTR-08 (contracts/enums/trade.yaml).
 */
export const pid_scene = [
  "self_buy", // 自购
  "agent", // Agent
  "share", // 分享
  "taolijin", // 淘礼金（后续接入，首版不建）
  "fallback", // 兜底，不下发给用户
  "query", // 查价专用，不转链
] as const;
export type PidScene = (typeof pid_scene)[number];

/**
 * buy_type
 * Source: 规划/04 §2.3；BR-ATTR-08 (contracts/enums/trade.yaml).
 */
export const buy_type = [
  "self", // 自购
  "share", // 分享
] as const;
export type BuyType = (typeof buy_type)[number];

/**
 * buy_type 的判定依据
 * Source: 规划/04 §2.3；BR-ATTR-09 (contracts/enums/trade.yaml).
 */
export const scene_basis = [
  "pid", // 推广位
  "param", // 推广参数
  "fallback", // 兜底
] as const;
export type SceneBasis = (typeof scene_basis)[number];

/**
 * user_id 的来源，未归因为 null
 * Source: 规划/04 §2.3；BR-ATTR-09 (contracts/enums/trade.yaml).
 */
export const user_basis = [
  "param", // 推广参数
  "claim", // 找回
  "admin", // 管理员
] as const;
export type UserBasis = (typeof user_basis)[number];

/**
 * link_logs.event；只有 convert、open 且 result_code=0 算点击证据
 * Source: BR-ATTR-14 (contracts/enums/trade.yaml).
 */
export const link_event = [
  "convert", // 用户主动发起的 POST /v1/links/convert
  "precompute", // 保留取值，不再产生（出卡不预转链）
  "register", // 出卡登记 link_id
  "open", // POST /v1/links/{link_id}/open
] as const;
export type LinkEvent = (typeof link_event)[number];

/**
 * open 与 convert 请求体 installed，缺省 unknown；线上取值是字符串 "true" / "false" / "unknown"，不是 JSON 布尔
 * Source: BR-ATTR-27；规划/03 §4.5 (contracts/enums/trade.yaml).
 */
export const installed_state = [
  "true", // 已安装
  "false", // 未安装
  "unknown", // 未知（H5 固定为 unknown）
] as const;
export type InstalledState = (typeof installed_state)[number];

/**
 * open 的无返利原因；客户端只能传 auth_declined、auth_failed，relation_conflict、binding_blocked 由服务端判定
 * Source: 规划/04 §6.3；BR-ID-18 (contracts/enums/trade.yaml).
 */
export const no_rebate_reason = [
  "auth_declined", // 用户拒绝授权
  "auth_failed", // 授权失败
  "relation_conflict", // 渠道关系冲突
  "binding_blocked", // 绑定已停用
] as const;
export type NoRebateReason = (typeof no_rebate_reason)[number];

/**
 * 外跳方案 primary / fallbacks 每一项的类型
 * Source: 规划/03 §4.5；BR-ATTR-27 (contracts/enums/trade.yaml).
 */
export const jump_type = [
  "sdk", // 联盟 SDK；淘宝为百川打开指令，参数见 contracts/openapi.yaml JumpStep.sdk
  "scheme", // 自定义 scheme
  "universal_link", // Universal Link / App Link / App Linking
  "h5", // H5 页面
  "copy_tpwd", // 复制口令
] as const;
export type JumpType = (typeof jump_type)[number];

/**
 * parse_input 命中项的类型
 * Source: 规划/04 §8.5 (contracts/enums/trade.yaml).
 */
export const input_kind = [
  "tpwd", // 口令
  "url", // 链接
  "text", // 文本
] as const;
export type InputKind = (typeof input_kind)[number];

/**
 * rebate_basis
 * Source: 规划/04 §8.3；BR-PRICE-07、BR-PRICE-08、BR-PRICE-21；BR-AI-11 (contracts/enums/trade.yaml).
 */
export const rebate_basis = [
  "normal", // 正常返利
  "price_compare_risk", // 比价风险（返利可能为 0）
  "no_rebate", // 无返利
  "amount_unknown", // 可返利，金额以订单为准（拼多多直链）
  "login_required", // 登录查看返利（游客卡，按平台开关）
] as const;
export type RebateBasis = (typeof rebate_basis)[number];

/**
 * availability
 * Source: 规划/04 §8.3 (contracts/enums/trade.yaml).
 */
export const availability = [
  "ok", // 可购买
  "off_shelf", // 已下架
  "coupon_gone", // 券已失效
  "ref_expired", // 商品信息已失效
  "price_unavailable", // 暂无法取价
  "unknown", // 未知
] as const;
export type Availability = (typeof availability)[number];

/**
 * match_tag
 * Source: 规划/04 §2.5、§8.3；BR-AI-24 (contracts/enums/trade.yaml).
 */
export const match_tag = [
  "matched", // 符合
  "relaxed", // 已放宽
  "spec_unconfirmed", // 规格待确认
] as const;
export type MatchTag = (typeof match_tag)[number];

/**
 * benefit
 * Source: 规划/04 §2.5 (contracts/enums/trade.yaml).
 */
export const benefit = [
  "coupon", // 有券
  "big_coupon", // 大额券
  "taolijin", // 淘礼金
  "subsidy", // 补贴
  "high_rebate", // 高返利
] as const;
export type Benefit = (typeof benefit)[number];

/**
 * sort
 * Source: 规划/04 §2.5；拍板第二批 TRADE-20（券后价与返利排序只排当前页） (contracts/enums/trade.yaml).
 */
export const sort = [
  "relevance", // 综合
  "sales_desc", // 销量从高到低
  "final_price_asc", // 券后价从低到高
  "rebate_desc", // 返利从高到低
] as const;
export type Sort = (typeof sort)[number];

/**
 * 平台链接形态表的类别（specs/link-patterns.yaml）
 * Source: 规划/04 §10.1 link_patterns；BR-ATTR-29 (contracts/enums/trade.yaml).
 */
export const link_pattern_category = [
  "product", // 平台商品页
  "promo", // 推广短链与落地页
  "union_host", // 联盟平台网页（按注册域含子域）
] as const;
export type LinkPatternCategory = (typeof link_pattern_category)[number];

/**
 * App 内链接落地页（LinkLanding）取卡片时返回的 link 类别；share 即 pid_scene=share 的分享 link
 * Source: 规划/04 §6.3 GET /v1/links/{link_id}；BR-ATTR-05 细则「App 内打开链接的入口」 (contracts/enums/trade.yaml).
 */
export const link_kind = [
  "share", // 分享 link
  "other", // 非分享 link
] as const;
export type LinkKind = (typeof link_kind)[number];

/**
 * 商品卡与 open / convert 结果的无返利原因（可空，未知值按空处理）；取值规则见 BR-PRICE-08 细则「无返利原因」
 * Source: 规划/04 §8.3、§8.4；BR-PRICE-08 (contracts/enums/trade.yaml).
 */
export const no_rebate_cause = [
  "price_compare", // 比价预判为比价单
] as const;
export type NoRebateCause = (typeof no_rebate_cause)[number];

/**
 * 素材淘礼金出资方判定；unknown 不宣称已判定为 third_party
 * Source: 规划/04 §2.5；BR-TEXT-15 (contracts/enums/trade.yaml).
 */
export const tlj_kind = [
  "ours", // 我方（A）
  "brand_open", // 品牌开放（B）
  "third_party", // 第三方（C）
  "unknown", // 未判定
] as const;
export type TljKind = (typeof tlj_kind)[number];

/** Every enum of contracts/enums, by name. */
export const enums = {
  admin_permission,
  admin_step_up_tier,
  admin_login_step,
  admin_account_status,
  admin_auth_level,
  admin_dashboard_todo_key,
  admin_search_hit_type,
  export_status,
  export_resource,
  audit_actor_kind,
  audit_system_actor,
  admin_claim_match_field,
  admin_order_flag,
  admin_order_history_field,
  admin_order_history_source,
  risk_rule_status,
  risk_action,
  union_auth_status,
  union_reauth_mode,
  admin_union_auth_session_status,
  union_pid_status,
  product_pool_status,
  pool_item_status,
  notify_channel,
  sms_template_type,
  notify_sms_state,
  notify_sms_test_status,
  admin_withdrawal_display_status,
  admin_settle_supplement_outcome,
  admin_recon_diff_outcome,
  admin_settle_bill_status,
  ledger_type,
  referral_credit_sub_type,
  clawback_sub_type,
  settle_adjust_sub_type,
  reward_sub_type,
  admin_adjust_sub_type,
  admin_adjustment_status,
  admin_adjustment_direction,
  admin_adjustment_ref_type,
  admin_adjustment_contra_subject,
  beneficiary_role,
  forfeit_reason,
  commission_rule_status,
  income_type,
  withdrawal_status,
  withdraw_reject_reason,
  withdrawal_hold_reason,
  withdrawal_blocked_reason,
  withdrawal_manual_resolution,
  withdraw_hold_kind,
  withdrawal_review_mode,
  payout_method,
  withdrawal_channel_state,
  withdrawal_sub_text_branch,
  payout_attempt_kind,
  withdraw_condition_reason,
  payout_batch_kind,
  bad_debt_writeoff_status,
  settle_batch_status,
  settle_mode,
  settle_batch_item_result,
  settle_batch_item_type,
  settle_adjustment_status,
  beneficiary_credit_kind,
  beneficiary_credit_status,
  recon_diff_type,
  payout_batch_item_result,
  recon_diff_status,
  union_receipt_method,
  union_receipt_cash_account,
  admin_fund_water_level,
  identity_level,
  login_provider,
  device_id_source,
  oauth_attempt_purpose,
  reverify_method,
  session_scope,
  h5_token_scope,
  sms_purpose,
  step_up_action,
  idempotency_abandon_outcome,
  consent_type,
  consent_channel,
  auth_method,
  union_binding_status,
  union_binding_blocked_reason,
  risk_state,
  risk_reason_category,
  realname_status,
  deletion_status,
  deletion_cancel_reason,
  tip_key,
  appeal_status,
  appeal_target_type,
  blocked_request_type,
  appeal_source,
  blocked_request_cause,
  blocklist_dimension,
  risk_hit_ref_type,
  invite_reward_status,
  invite_reward_party_result,
  invite_reward_skip_reason,
  invite_reward_void_reason,
  invite_reward_bind_source,
  personal_data_copy_delivery,
  personal_data_copy_status,
  notify_template_code,
  notify_category,
  user_level,
  agent_intent,
  agent_card_type,
  page_guide_reject_reason,
  agent_finish_reason,
  watch_status,
  watch_event_status,
  platform_status,
  rebate_status,
  display_status,
  order_hold_reason,
  order_status_group,
  order_timeline_node,
  order_reason,
  diff_reason,
  order_rights_status,
  order_rights_type,
  claim_status,
  claim_evidence_level,
  claim_item_decision,
  claim_reject_reason,
  order_sync_mode,
  order_sync_status,
  rights_import_kind,
  rights_import_time_basis,
  rights_import_status,
  rights_import_failure_reason,
  pay_channel,
  pay_order_status,
  pay_refund_status,
  pay_refund_target_type,
  pay_query_attempt_kind,
  pay_ledger_type,
  pay_refund_reason,
  pay_unavailable_reason,
  platform,
  key_stability,
  client_platform,
  route_entry,
  platform_search_status,
  install_channel,
  auth_level,
  platform_icon_key,
  scene,
  pid_scene,
  buy_type,
  scene_basis,
  user_basis,
  link_event,
  installed_state,
  no_rebate_reason,
  jump_type,
  input_kind,
  rebate_basis,
  availability,
  match_tag,
  benefit,
  sort,
  link_pattern_category,
  link_kind,
  no_rebate_cause,
  tlj_kind,
} as const;
export type EnumName = keyof typeof enums;
export type EnumValue<Name extends EnumName> = (typeof enums)[Name][number];
