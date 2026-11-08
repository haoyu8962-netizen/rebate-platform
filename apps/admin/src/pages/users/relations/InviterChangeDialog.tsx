// 【改上级】对话框（design-hifi AdmUserInviterChangeOk / AdmUserInviterChange；adminChangeInviter，
// 权限点 user.inviter）：改为新上级（填 UID）或解绑（inviter_user_id = null），填原因 → 动态码 →
// 一次 POST /admin/v1/users/{user_id}/inviter；成功后用返回的用户详情刷新页面并关闭。
// 卸载式（DSX-107）：父组件只在打开时渲染，每次打开都是一张空白表单。
// 30409：对话框只给不可改的说明、没有提交按钮，关闭再开仍是说明（父组件保存）；30401 / 30403 提示在新上级输入
// 旁并保留输入；网络 / 服务异常用 message.error 并保留输入。
import { Alert, Flex, Form, Input, Modal, Button, Radio, Typography, message, theme } from 'antd';
import { useId, useState, type ReactElement, type ReactNode } from 'react';
import { StepUpModal } from '../../../components/step-up/index.ts';
import { AdminApiError } from '../../../providers/data/index.ts';
import { usersTexts } from '../../../texts/users.ts';
import {
  DialogFooter,
  ReasonField,
  Summary,
  failureText,
  fieldsOf,
  reasonError,
} from './parts.tsx';
import type { InviterChangeDialogProps } from './types.ts';
import { useVerifiedWrite } from './useVerifiedWrite.ts';

const t = usersTexts.relations;
const USERS_URL = '/admin/v1/users';
const PERMISSION = 'user.inviter';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LOCKED = 30409;
const UNAVAILABLE = 30401;
const CONFLICT = 30403;

type Mode = 'set' | 'remove';

interface InviterPayload {
  readonly inviter_user_id: string | null;
  readonly reason: string;
}

export function InviterChangeDialog({
  user,
  onClose,
  onUserChange,
  locked,
  onLocked,
}: InviterChangeDialogProps): ReactElement {
  const { token } = theme.useToken();
  const [notice, contextHolder] = message.useMessage();
  const inviterId = useId();
  const reasonId = useId();
  const [mode, setMode] = useState<Mode>('set');
  const [inviter, setInviter] = useState('');
  const [reason, setReason] = useState('');
  const [inviterError, setInviterError] = useState<string>();
  const [reasonFieldError, setReasonFieldError] = useState<string>();
  const [pending, setPending] = useState<InviterPayload>();

  const write = useVerifiedWrite<InviterPayload>({
    url: `${USERS_URL}/${encodeURIComponent(user.user_id)}/inviter`,
    onSaved: (next) => {
      onUserChange(next);
      onClose();
    },
    onFailed: (cause) => {
      const code = cause instanceof AdminApiError ? cause.code : undefined;
      if (code === LOCKED) {
        // 30409 是目标用户自身的状态：由父组件保存，本次详情里关闭再开仍只给说明。
        onLocked();
        return;
      }
      if (code === UNAVAILABLE) {
        setInviterError(t.errors.inviterUnavailable);
        return;
      }
      if (code === CONFLICT) {
        setInviterError(t.errors.inviterConflict);
        return;
      }
      const fields = fieldsOf(cause);
      if (fields.includes('reason')) {
        setReasonFieldError(t.errors.invalid);
        return;
      }
      if (fields.includes('inviter_user_id')) {
        setInviterError(t.errors.invalid);
        return;
      }
      void notice.error(failureText(cause));
    },
  });

  const busy = write.phase !== 'idle';

  const submit = () => {
    if (busy || locked) return;
    const value = inviter.trim();
    let nextInviterError: string | undefined;
    if (mode === 'set')
      nextInviterError =
        value === '' ? t.inviter.empty : UUID.test(value) ? undefined : t.inviter.malformed;
    const nextReasonError = reasonError(reason);
    setInviterError(nextInviterError);
    setReasonFieldError(nextReasonError);
    if (nextInviterError !== undefined || nextReasonError !== undefined) return;
    const payload: InviterPayload = {
      inviter_user_id: mode === 'set' ? value : null,
      reason,
    };
    setPending(payload);
    write.start(payload);
  };

  const cancel = () => {
    if (write.phase === 'sending') return;
    onClose();
  };

  const current = user.inviter_user_id;
  const code = { fontFamily: token.fontFamilyCode } as const;
  const summary = (
    <Summary
      items={[
        {
          key: 'inviter',
          label: t.currentInviter,
          value: <span style={code}>{current ?? t.noInviter}</span>,
        },
      ]}
    />
  );

  let body: ReactNode;
  let footer: ReactNode;
  if (locked) {
    body = (
      <Flex vertical gap={16} style={{ paddingTop: token.paddingXS }}>
        {summary}
        <Alert
          type="error"
          showIcon
          message={t.inviter.lockedTitle(t.errors.inviterLocked)}
          description={t.inviter.lockedDetail}
        />
        <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          {t.inviter.lockedNote}
        </Typography.Text>
      </Flex>
    );
    footer = (
      <Flex justify="end">
        <Button onClick={cancel}>{t.close}</Button>
      </Flex>
    );
  } else {
    const option = (value: Mode, label: string, hint?: string) => {
      const checked = mode === value;
      return (
        <div
          style={{
            flex: 1,
            padding: `${token.paddingSM}px ${token.padding}px`,
            borderRadius: token.borderRadiusLG,
            border: `${token.lineWidth}px ${token.lineType} ${checked ? token.colorPrimary : token.colorBorderSecondary}`,
            background: checked ? token.colorPrimaryBg : token.colorBgContainer,
          }}
        >
          <Radio value={value}>
            <Flex vertical gap={2}>
              <span>{label}</span>
              {hint === undefined ? null : (
                <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                  {hint}
                </Typography.Text>
              )}
            </Flex>
          </Radio>
        </div>
      );
    };
    body = (
      <Form layout="vertical" component={false}>
        <Flex vertical gap={16} style={{ paddingTop: token.paddingXS }}>
          {summary}
          <Radio.Group
            value={mode}
            disabled={busy}
            style={{ width: '100%' }}
            onChange={(event) => {
              setMode(event.target.value as Mode);
              setInviterError(undefined);
            }}
          >
            <Flex gap={12}>
              {option('set', t.inviter.modeSet)}
              {option('remove', t.inviter.modeRemove, t.inviter.modeRemoveHint)}
            </Flex>
          </Radio.Group>
        </Flex>
        {mode === 'set' ? (
          <Form.Item
            label={t.inviter.label}
            htmlFor={inviterId}
            required
            validateStatus={inviterError === undefined ? '' : 'error'}
            help={inviterError}
            style={{ marginTop: token.marginMD }}
          >
            <Input
              id={inviterId}
              value={inviter}
              disabled={busy}
              aria-required
              autoComplete="off"
              spellCheck={false}
              placeholder={t.inviter.placeholder}
              style={code}
              onChange={(event) => {
                setInviter(event.target.value);
                setInviterError(undefined);
              }}
            />
          </Form.Item>
        ) : (
          <div style={{ height: token.marginMD }} />
        )}
        <ReasonField
          id={reasonId}
          value={reason}
          error={reasonFieldError}
          extra={t.inviter.reasonExtra}
          disabled={busy}
          onChange={(value) => {
            setReason(value);
            if (reasonFieldError !== undefined) setReasonFieldError(reasonError(value));
          }}
        />
        <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          {t.inviter.note}
        </Typography.Text>
      </Form>
    );
    footer = (
      <DialogFooter permission={PERMISSION} busy={busy} onCancel={cancel} onSubmit={submit} />
    );
  }

  const target = pending?.inviter_user_id;
  return (
    <>
      {contextHolder}
      <Modal
        open
        width={560}
        title={t.inviter.title(user.user_id)}
        maskClosable={false}
        keyboard={!busy}
        closable={!busy}
        onCancel={cancel}
        footer={footer}
      >
        {body}
      </Modal>
      <StepUpModal
        open={write.phase === 'verify'}
        tier="totp"
        operation={t.inviter.operation}
        details={[
          t.stepUpUser(user.user_id),
          ...(pending === undefined
            ? []
            : [t.inviter.change(current ?? t.noInviter, target ?? t.inviter.removed)]),
          ...(write.again ? [t.stepUpAgain] : []),
        ]}
        onSubmit={write.verify}
        onClose={write.cancel}
        onVerified={write.onVerified}
      />
    </>
  );
}
