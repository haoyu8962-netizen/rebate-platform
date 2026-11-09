// 用户详情标题行的【冻结】【解冻】（risk.freeze）与【封禁】【解封】（risk.ban）（design-hifi
// AdmUserFreeze / AdmUserUnfreeze；封禁 / 解封照同款去掉期限；契约 adminUpdateUserRiskState）：
// 确认框 → 动态码 → 一次 PUT …/users/{user_id}/risk-state，带 X-Step-Up-Token，不带
// Idempotency-Key；body 照契约四种形态，expected_row_version 取详情 risk.row_version（无风控行
// 时为 null）。成功、20902、44004 之后重新拉详情；其余失败提示后保留已填内容，不自动重发。
import { risk_reason_category, type RiskReasonCategory, type Schema } from '@couli/contracts-ts';
import { useDataProvider } from '@refinedev/core';
import { Alert, Button, Flex, Form, Input, Modal, Radio, message, theme } from 'antd';
import { useId, useState, type ReactElement, type ReactNode } from 'react';
import { StepUpModal } from '../../components/step-up/index.ts';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { codePointLength } from '../../text-length.ts';
import { usersTexts } from '../../texts/users.ts';
import { REASON_MAX, riskLabel, type UserDetail } from './model.ts';
import { DialogFooter, ReasonField, Summary, fieldsOf } from './relations/parts.tsx';
import { useVerifiedWrite } from './relations/useVerifiedWrite.ts';
import { refreshDetail } from './UnionBindingActions.tsx';

const t = usersTexts.riskState;
const USERS_URL = '/admin/v1/users';
const FREEZE_PERMISSION = 'risk.freeze';
const BAN_PERMISSION = 'risk.ban';

export type RiskAction = Schema<'AdminUserRiskStateAction'>;
type RiskPayload = Schema<'AdminUserRiskStateUpdateRequest'>;
type RiskRow = Schema<'AdminUserRiskState'>;
type Period = 'none' | 'until';

/** 标题行的按钮顺序（画板：冻结 / 解冻 在前，封禁 / 解封 在后）。 */
const ENTRY_SEQUENCE: readonly RiskAction[] = ['freeze', 'unfreeze', 'ban', 'unban'];

const BEIJING_OFFSET = '+08:00';

/**
 * 契约的状态规则：freeze 从 normal（冻结中再冻结改期限本页不提供）、unfreeze 只从 frozen、
 * ban 从 normal / frozen、unban 只从 banned；申诉中的用户任何操作都不提供（申诉在风控申诉页办结）。
 */
export function riskEntries(
  state: string,
  canFreeze: boolean,
  canBan: boolean,
): readonly RiskAction[] {
  const entries: RiskAction[] = [];
  if (canFreeze && state === 'normal') entries.push('freeze');
  if (canFreeze && state === 'frozen') entries.push('unfreeze');
  if (canBan && (state === 'normal' || state === 'frozen')) entries.push('ban');
  if (canBan && state === 'banned') entries.push('unban');
  return ENTRY_SEQUENCE.filter((action) => entries.includes(action));
}

/** 原因：去首尾空白后 1–200 字（AdminUserReason）；不合规时的提示写明规则。 */
function reasonProblem(reason: string): string | undefined {
  const trimmed = reason.trim();
  if (trimmed === '') return t.reasonEmpty;
  if (codePointLength(trimmed) > REASON_MAX) return t.reasonTooLong;
  return undefined;
}

/** datetime-local 的值（YYYY-MM-DDTHH:mm）按北京时间解释，发出带 +08:00 的 ISO 时间。 */
export function beijingInstant(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined;
  const iso = `${value}:00${BEIJING_OFFSET}`;
  return Number.isNaN(Date.parse(iso)) ? undefined : iso;
}

function untilProblem(value: string, now: number): string | undefined {
  const iso = beijingInstant(value);
  if (iso === undefined) return t.untilEmpty;
  if (Date.parse(iso) <= now) return t.untilPast;
  return undefined;
}

function categoryName(code: string): string {
  return t.categories[code] ?? code;
}

function failureNotice(cause: unknown): string {
  if (!(cause instanceof AdminApiError)) return t.failed;
  if (cause.kind === 'network') return t.network;
  if (cause.code === 10403) return t.forbidden;
  if (cause.code === 20001) {
    if (fieldsOf(cause).includes('user_id')) return t.userMissing;
    return t.invalid;
  }
  return t.failed;
}

export interface RiskStateActions {
  /** 标题行的按钮组；没有可用操作时为 null。 */
  readonly buttons: ReactNode;
  /** 确认框、动态码与提示的挂载点。 */
  readonly element: ReactElement;
}

export interface RiskStateActionsOptions {
  readonly user: UserDetail | undefined;
  readonly access: AccessControl;
  readonly onUserChange: (user: UserDetail) => void;
}

export function useRiskStateActions({
  user,
  access,
  onUserChange,
}: RiskStateActionsOptions): RiskStateActions {
  const getProvider = useDataProvider();
  const [notice, contextHolder] = message.useMessage();
  const [target, setTarget] = useState<RiskAction>();
  // TODO(规划/11 §7.1): 注销中 / 已注销隐藏标题行按钮 — blocked on 契约补 deletion_status
  const entries =
    user === undefined
      ? []
      : riskEntries(user.risk.state, access.can(FREEZE_PERMISSION), access.can(BAN_PERMISSION));

  /** 静默重新拉详情（不切到加载态，提示留着）；拉取失败时提示手动刷新页面。 */
  const refresh = (userId: string): void => {
    void refreshDetail(
      () =>
        getProvider()
          .getOne<UserDetail>({ resource: 'users', id: userId })
          .then((response) => response.data),
      onUserChange,
      () => void notice.error(t.refreshFailed),
    );
  };

  const buttons =
    entries.length === 0 ? null : (
      <Flex gap={8} wrap>
        {entries.map((action) => (
          <Button
            key={action}
            autoInsertSpace={false}
            danger={action === 'freeze' || action === 'ban'}
            onClick={() => {
              if (target !== undefined) return;
              setTarget(action);
            }}
          >
            {t.actions[action]}
          </Button>
        ))}
      </Flex>
    );

  const element = (
    <>
      {contextHolder}
      {target === undefined || user === undefined ? null : (
        <RiskDialog
          key={target}
          user={user}
          action={target}
          notify={notice}
          onClose={() => setTarget(undefined)}
          onSaved={(risk) => {
            onUserChange({ ...user, risk });
            refresh(user.user_id);
          }}
          onRefresh={() => refresh(user.user_id)}
        />
      )}
    </>
  );

  return { buttons, element };
}

type Notify = ReturnType<typeof message.useMessage>[0];

interface RiskDialogProps {
  readonly user: UserDetail;
  readonly action: RiskAction;
  readonly notify: Notify;
  readonly onClose: () => void;
  readonly onSaved: (risk: RiskRow) => void;
  readonly onRefresh: () => void;
}

function RiskDialog({
  user,
  action,
  notify,
  onClose,
  onSaved,
  onRefresh,
}: RiskDialogProps): ReactElement {
  const { token } = theme.useToken();
  const reasonId = useId();
  const untilId = useId();
  const categoryId = useId();
  const holds = action === 'freeze' || action === 'ban';
  const [category, setCategory] = useState<RiskReasonCategory>();
  const [categoryError, setCategoryError] = useState<string>();
  const [period, setPeriod] = useState<Period>('none');
  const [until, setUntil] = useState('');
  const [untilError, setUntilError] = useState<string>();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string>();
  const actionName = t.actions[action];

  const write = useVerifiedWrite<RiskPayload, RiskRow>({
    url: `${USERS_URL}/${encodeURIComponent(user.user_id)}/risk-state`,
    method: 'put',
    onSaved: (risk) => {
      void notify.success(t.success[action]);
      onClose();
      onSaved(risk);
    },
    onFailed: (cause) => {
      if (cause instanceof AdminApiError && (cause.code === 20902 || cause.code === 44004)) {
        void notify.warning(cause.code === 20902 ? t.changed : t.notAllowed);
        onClose();
        onRefresh();
        return;
      }
      if (cause instanceof AdminApiError && cause.code === 20001) {
        const fields = fieldsOf(cause);
        if (fields.includes('reason')) {
          setReasonError(t.reasonRefused);
          return;
        }
        if (fields.includes('reason_category') && holds) {
          setCategoryError(t.categoryRefused);
          return;
        }
        if (fields.includes('frozen_until') && action === 'freeze') {
          setPeriod('until');
          setUntilError(t.untilRefused);
          return;
        }
      }
      void notify.error(failureNotice(cause));
    },
  });

  const busy = write.phase !== 'idle';

  const payloadOf = (): RiskPayload | undefined => {
    const reasonIssue = reasonProblem(reason);
    const categoryIssue = holds && category === undefined ? t.categoryEmpty : undefined;
    const end = action === 'freeze' && period === 'until' ? beijingInstant(until) : undefined;
    const untilIssue =
      action === 'freeze' && period === 'until' ? untilProblem(until, Date.now()) : undefined;
    setReasonError(reasonIssue);
    setCategoryError(categoryIssue);
    setUntilError(untilIssue);
    if (reasonIssue !== undefined || categoryIssue !== undefined || untilIssue !== undefined)
      return undefined;
    const base = { reason: reason.trim(), expected_row_version: user.risk.row_version };
    if (action === 'unfreeze' || action === 'unban') return { action, ...base };
    if (category === undefined) return undefined;
    if (action === 'ban') return { action, reason_category: category, ...base };
    return { action, reason_category: category, ...base, frozen_until: end ?? null };
  };

  const submit = () => {
    if (busy) return;
    const payload = payloadOf();
    if (payload !== undefined) write.start(payload);
  };

  const cancel = () => {
    if (write.phase === 'sending') return;
    onClose();
  };

  return (
    <>
      {/* 动态码与发送期间确认框先收起（已填内容保留），验证取消或写入失败后再回来。 */}
      {busy ? null : (
        <Modal
          open
          width={560}
          title={t.title(actionName, user.user_id)}
          destroyOnHidden
          maskClosable={false}
          onCancel={cancel}
          footer={
            <DialogFooter
              permission={permissionOf(action)}
              busy={busy}
              onCancel={cancel}
              onSubmit={submit}
            />
          }
        >
          <Form layout="vertical" component={false}>
            <Flex vertical gap={token.marginSM} style={{ paddingTop: token.paddingXS }}>
              <Summary
                items={[
                  { key: 'uid', label: t.summary.uid, value: user.user_id },
                  { key: 'nickname', label: t.summary.nickname, value: user.nickname },
                  { key: 'state', label: t.summary.state, value: riskLabel(user.risk.state) },
                ]}
              />
              <Alert
                type={holds ? 'warning' : 'info'}
                showIcon
                message={t.consequences[action]}
                style={{ marginBottom: token.marginXS }}
              />
            </Flex>
            {holds ? (
              <Form.Item
                label={<span id={categoryId}>{t.categoryLabel}</span>}
                required
                validateStatus={categoryError === undefined ? '' : 'error'}
                help={categoryError}
                extra={t.categoryExtra}
              >
                <Radio.Group
                  aria-labelledby={categoryId}
                  value={category}
                  disabled={busy}
                  onChange={(event) => {
                    setCategory(event.target.value as RiskReasonCategory);
                    setCategoryError(undefined);
                  }}
                >
                  <Flex gap={8} wrap>
                    {risk_reason_category.map((code) => (
                      <Radio key={code} value={code}>
                        {categoryName(code)}
                      </Radio>
                    ))}
                  </Flex>
                </Radio.Group>
              </Form.Item>
            ) : null}
            {action === 'freeze' ? (
              <>
                <Form.Item label={t.periodLabel} required>
                  <Radio.Group
                    value={period}
                    disabled={busy}
                    onChange={(event) => {
                      setPeriod(event.target.value as Period);
                      setUntilError(undefined);
                    }}
                  >
                    <Radio value="none">{t.periodNone}</Radio>
                    <Radio value="until">{t.periodUntil}</Radio>
                  </Radio.Group>
                </Form.Item>
                {period === 'until' ? (
                  <Form.Item
                    label={t.untilLabel}
                    htmlFor={untilId}
                    required
                    validateStatus={untilError === undefined ? '' : 'error'}
                    help={untilError}
                  >
                    <Input
                      id={untilId}
                      type="datetime-local"
                      value={until}
                      disabled={busy}
                      onChange={(event) => {
                        setUntil(event.target.value);
                        if (untilError !== undefined)
                          setUntilError(untilProblem(event.target.value, Date.now()));
                      }}
                    />
                  </Form.Item>
                ) : null}
              </>
            ) : null}
            <ReasonField
              id={reasonId}
              value={reason}
              error={reasonError}
              extra={t.reasonExtra}
              disabled={busy}
              onChange={(value) => {
                setReason(value);
                if (reasonError !== undefined) setReasonError(reasonProblem(value));
              }}
            />
          </Form>
        </Modal>
      )}
      <StepUpModal
        open={write.phase === 'verify'}
        tier="totp"
        operation={t.operations[action]}
        details={[t.stepUpTarget(user.user_id), ...(write.again ? [t.stepUpAgain] : [])]}
        onSubmit={write.verify}
        onClose={write.cancel}
        onVerified={write.onVerified}
      />
    </>
  );
}

function permissionOf(action: RiskAction): string {
  return action === 'freeze' || action === 'unfreeze' ? FREEZE_PERMISSION : BAN_PERMISSION;
}
