// 联盟授权表的行操作（design-hifi AdmUserUnionReset / AdmUserUnionDisable；契约
// adminResetUserUnionBinding / adminDisableUserUnionBinding / adminEnableUserUnionBinding）：
// 确认框（后果说明 + 必填原因）→ 动态码 → 一次 POST …/union-bindings/{platform}/{action}，
// 带 X-Step-Up-Token，body 只有去首尾空白的原因与该行 row_version，不带 Idempotency-Key。
// 成功、20902、30154 之后重新拉详情；其余失败提示后保留已填原因，不自动重发。
import type { Schema } from '@couli/contracts-ts';
import { useDataProvider } from '@refinedev/core';
import { Alert, Button, Flex, Form, Modal, Typography, message, theme } from 'antd';
import { useId, useState, type ReactElement, type ReactNode } from 'react';
import { StepUpModal } from '../../components/step-up/index.ts';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { codePointLength } from '../../text-length.ts';
import { usersTexts } from '../../texts/users.ts';
import { REASON_MAX, platformLabel, type UnionBinding, type UserDetail } from './model.ts';
import { DialogFooter, ReasonField, fieldsOf } from './relations/parts.tsx';
import { useVerifiedWrite } from './relations/useVerifiedWrite.ts';

const t = usersTexts.unionBindings;
const USERS_URL = '/admin/v1/users';
const RESET_PERMISSION = 'union.binding_reset';
const DISABLE_PERMISSION = 'union.binding_disable';

export type BindingAction = 'reset' | 'disable' | 'enable';

type ActionPayload = Schema<'AdminUserUnionBindingActionRequest'>;

interface Target {
  readonly platform: string;
  readonly action: BindingAction;
  readonly rowVersion: number;
}

interface Entry {
  readonly action: BindingAction;
  /** 置灰时的说明（只有用户已封禁时的【恢复】）。 */
  readonly blockedBy?: string;
}

/** 契约的状态规则：reset / disable 只对 active、invalid；enable 只对后台停用且用户未封禁。 */
function entriesOf(
  binding: UnionBinding,
  user: UserDetail,
  canReset: boolean,
  canDisable: boolean,
): Entry[] {
  const changeable = binding.status === 'active' || binding.status === 'invalid';
  const entries: Entry[] = [];
  if (canReset && changeable && binding.platform === 'taobao') entries.push({ action: 'reset' });
  if (canDisable && changeable) entries.push({ action: 'disable' });
  if (canDisable && binding.status === 'blocked' && binding.blocked_reason === 'admin_disable')
    entries.push(
      user.risk.state === 'banned'
        ? { action: 'enable', blockedBy: t.enableBanned }
        : { action: 'enable' },
    );
  return entries;
}

function consequenceOf(target: Target, platform: string): string {
  if (target.action === 'reset') return t.consequences.reset(platform);
  if (target.action === 'disable') return t.consequences.disable(platform);
  return target.platform === 'taobao'
    ? t.consequences.enableTaobao(platform)
    : t.consequences.enableOther(platform);
}

/** 原因：去首尾空白后 1–200 字（AdminUserReason）；不合规时的提示写明规则。 */
function reasonProblem(reason: string): string | undefined {
  const trimmed = reason.trim();
  if (trimmed === '') return t.reasonEmpty;
  if (codePointLength(trimmed) > REASON_MAX) return t.reasonTooLong;
  return undefined;
}

function failureNotice(cause: unknown): string {
  if (!(cause instanceof AdminApiError)) return t.failed;
  if (cause.kind === 'network') return t.network;
  if (cause.code === 10403) return t.forbidden;
  if (cause.code === 20001) {
    const fields = fieldsOf(cause);
    if (fields.includes('platform')) return t.platformUnsupported;
    if (fields.includes('user_id')) return t.userMissing;
    return t.invalid;
  }
  return t.failed;
}

/**
 * 重新拉一次详情：成功交给 apply；失败（网络或 5xx）调用 onFail，不吞掉，
 * 免得页面停在旧 row_version 而管理员以为已刷新。不自动重试。
 */
export function refreshDetail(
  load: () => Promise<UserDetail>,
  apply: (user: UserDetail) => void,
  onFail: () => void,
): Promise<void> {
  return load().then(apply, onFail);
}

export interface UnionBindingActions {
  /** 「操作」列；不持 union.binding_* 时为 undefined（不出现该列）。 */
  readonly render: ((binding: UnionBinding) => ReactNode) | undefined;
  /** 确认框、动态码与提示的挂载点。 */
  readonly element: ReactElement;
}

export interface UnionBindingActionsOptions {
  readonly user: UserDetail;
  readonly access: AccessControl;
  readonly onUserChange: (user: UserDetail) => void;
}

export function useUnionBindingActions({
  user,
  access,
  onUserChange,
}: UnionBindingActionsOptions): UnionBindingActions {
  const getProvider = useDataProvider();
  const [notice, contextHolder] = message.useMessage();
  const [target, setTarget] = useState<Target>();
  const canReset = access.can(RESET_PERMISSION);
  const canDisable = access.can(DISABLE_PERMISSION);

  /** 静默重新拉详情（不切到加载态，页面与提示都留着）；拉取失败时提示手动刷新页面。 */
  const refresh = () => {
    void refreshDetail(
      () =>
        getProvider()
          .getOne<UserDetail>({ resource: 'users', id: user.user_id })
          .then((response) => response.data),
      onUserChange,
      () => void notice.error(t.refreshFailed),
    );
  };

  const onSaved = (row: UnionBinding) => {
    onUserChange({
      ...user,
      union_bindings: user.union_bindings.map((one) => (one.platform === row.platform ? row : one)),
    });
    refresh();
  };

  const render =
    canReset || canDisable
      ? (binding: UnionBinding) => (
          <EntryButtons
            entries={entriesOf(binding, user, canReset, canDisable)}
            platform={binding.platform}
            onOpen={(action) => {
              if (target !== undefined) return;
              setTarget({ platform: binding.platform, action, rowVersion: binding.row_version });
            }}
          />
        )
      : undefined;

  const element = (
    <>
      {contextHolder}
      {target === undefined ? null : (
        <ActionDialog
          key={`${target.platform}/${target.action}`}
          user={user}
          target={target}
          notify={notice}
          onClose={() => setTarget(undefined)}
          onSaved={onSaved}
          onRefresh={refresh}
        />
      )}
    </>
  );
  return { render, element };
}

interface EntryButtonsProps {
  readonly entries: readonly Entry[];
  readonly platform: string;
  readonly onOpen: (action: BindingAction) => void;
}

function EntryButtons({ entries, platform, onOpen }: EntryButtonsProps): ReactElement {
  const { token } = theme.useToken();
  const hintId = useId();
  if (entries.length === 0) return <>{usersTexts.dash}</>;
  const name = platformLabel(platform);
  return (
    <Flex vertical gap={2}>
      <Flex gap={12} wrap>
        {entries.map((entry) => (
          <Button
            key={entry.action}
            type="link"
            size="small"
            autoInsertSpace={false}
            style={{ paddingInline: 0 }}
            danger={entry.action !== 'enable'}
            disabled={entry.blockedBy !== undefined}
            aria-label={t.actionName(t.actions[entry.action], name)}
            aria-describedby={entry.blockedBy === undefined ? undefined : hintId}
            onClick={() => onOpen(entry.action)}
          >
            {t.actions[entry.action]}
          </Button>
        ))}
      </Flex>
      {entries.map((entry) =>
        entry.blockedBy === undefined ? null : (
          <Typography.Text
            key={entry.action}
            id={hintId}
            type="secondary"
            style={{ fontSize: token.fontSizeSM }}
          >
            {entry.blockedBy}
          </Typography.Text>
        ),
      )}
    </Flex>
  );
}

type Notify = ReturnType<typeof message.useMessage>[0];

interface ActionDialogProps {
  readonly user: UserDetail;
  readonly target: Target;
  readonly notify: Notify;
  readonly onClose: () => void;
  readonly onSaved: (row: UnionBinding) => void;
  readonly onRefresh: () => void;
}

function ActionDialog({
  user,
  target,
  notify,
  onClose,
  onSaved,
  onRefresh,
}: ActionDialogProps): ReactElement {
  const { token } = theme.useToken();
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string>();
  const platform = platformLabel(target.platform);
  const actionName = t.actions[target.action];

  const write = useVerifiedWrite<ActionPayload, UnionBinding>({
    url: `${USERS_URL}/${encodeURIComponent(user.user_id)}/union-bindings/${encodeURIComponent(target.platform)}/${target.action}`,
    onSaved: (row) => {
      void notify.success(t.success[target.action](platform));
      onClose();
      onSaved(row);
    },
    onFailed: (cause) => {
      if (cause instanceof AdminApiError && (cause.code === 20902 || cause.code === 30154)) {
        void notify.warning(cause.code === 20902 ? t.changed : t.notAllowed);
        onClose();
        onRefresh();
        return;
      }
      if (
        cause instanceof AdminApiError &&
        cause.code === 20001 &&
        fieldsOf(cause).includes('reason')
      ) {
        setReasonError(t.reasonRefused);
        return;
      }
      void notify.error(failureNotice(cause));
    },
  });

  const busy = write.phase !== 'idle';

  const submit = () => {
    if (busy) return;
    const problem = reasonProblem(reason);
    setReasonError(problem);
    if (problem !== undefined) return;
    write.start({ reason: reason.trim(), expected_row_version: target.rowVersion });
  };

  const cancel = () => {
    if (write.phase === 'sending') return;
    onClose();
  };

  return (
    <>
      {/* 动态码与发送期间确认框先收起（原因保留），验证取消或写入失败后再回来；两层对话框同时
          挂着时，antd 在测试环境给两个标题同一个 id，动态码对话框的名字会被读成确认框的。 */}
      {busy ? null : (
        <Modal
          open
          width={520}
          title={t.title(actionName, platform)}
          destroyOnHidden
          maskClosable={false}
          keyboard={!busy}
          closable={!busy}
          onCancel={cancel}
          footer={
            <DialogFooter
              permission={target.action === 'reset' ? RESET_PERMISSION : DISABLE_PERMISSION}
              busy={busy}
              onCancel={cancel}
              onSubmit={submit}
            />
          }
        >
          <Form layout="vertical" component={false}>
            <div style={{ paddingTop: token.paddingXS, marginBottom: token.marginMD }}>
              <Alert
                type={target.action === 'enable' ? 'info' : 'warning'}
                showIcon
                message={consequenceOf(target, platform)}
              />
            </div>
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
        operation={t.operations[target.action]}
        details={[t.stepUpTarget(user.user_id, platform), ...(write.again ? [t.stepUpAgain] : [])]}
        onSubmit={write.verify}
        onClose={write.cancel}
        onVerified={write.onVerified}
      />
    </>
  );
}
