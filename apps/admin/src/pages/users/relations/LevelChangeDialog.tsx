// 【调等级】对话框（design-hifi AdmUserLevelChange；adminChangeUserLevel，权限点 user.level）：
// 选新等级、填原因 → 动态码 → 一次 POST /admin/v1/users/{user_id}/level；成功后用返回的用户详情
// 刷新页面并关闭。20001 [level]（当前等级或已停用等级）提示在等级选择旁；网络 / 服务异常用
// message.error，已选等级与原因保留。卸载式（DSX-107）：父组件只在打开时渲染，每次打开都是
// 一张空白表单。
import { user_level } from '@couli/contracts-ts';
import { Form, Modal, Select, Alert, message, theme } from 'antd';
import { useId, useState, type ReactElement } from 'react';
import { StepUpModal } from '../../../components/step-up/index.ts';
import { usersTexts } from '../../../texts/users.ts';
import type { UserDetail } from '../model.ts';
import {
  DialogFooter,
  ReasonField,
  Summary,
  failureText,
  fieldsOf,
  reasonError,
} from './parts.tsx';
import type { RelationChangeDialogProps } from './types.ts';
import { useVerifiedWrite } from './useVerifiedWrite.ts';

const t = usersTexts.relations;
const USERS_URL = '/admin/v1/users';
const PERMISSION = 'user.level';

type Level = UserDetail['level'];

interface LevelPayload {
  readonly level: Level;
  readonly reason: string;
}

export function LevelChangeDialog({
  user,
  onClose,
  onUserChange,
}: RelationChangeDialogProps): ReactElement {
  const { token } = theme.useToken();
  const [notice, contextHolder] = message.useMessage();
  const levelId = useId();
  const reasonId = useId();
  const [level, setLevel] = useState<Level>();
  const [reason, setReason] = useState('');
  const [levelError, setLevelError] = useState<string>();
  const [reasonFieldError, setReasonFieldError] = useState<string>();
  const [pending, setPending] = useState<LevelPayload>();

  const write = useVerifiedWrite<LevelPayload>({
    url: `${USERS_URL}/${encodeURIComponent(user.user_id)}/level`,
    onSaved: (next) => {
      onUserChange(next);
      onClose();
    },
    onFailed: (cause) => {
      const fields = fieldsOf(cause);
      if (fields.includes('level')) {
        setLevelError(t.level.invalid(t.errors.invalid));
        return;
      }
      if (fields.includes('reason')) {
        setReasonFieldError(t.errors.invalid);
        return;
      }
      void notice.error(failureText(cause));
    },
  });

  const busy = write.phase !== 'idle';

  const submit = () => {
    if (busy) return;
    const nextLevelError = level === undefined ? t.level.empty : undefined;
    const nextReasonError = reasonError(reason);
    setLevelError(nextLevelError);
    setReasonFieldError(nextReasonError);
    if (level === undefined || nextLevelError !== undefined || nextReasonError !== undefined)
      return;
    const payload: LevelPayload = { level, reason };
    setPending(payload);
    write.start(payload);
  };

  const cancel = () => {
    if (write.phase === 'sending') return;
    onClose();
  };

  const inviter = user.inviter_user_id;
  return (
    <>
      {contextHolder}
      <Modal
        open
        width={560}
        title={t.level.title(user.user_id)}
        maskClosable={false}
        keyboard={!busy}
        closable={!busy}
        onCancel={cancel}
        footer={
          <DialogFooter permission={PERMISSION} busy={busy} onCancel={cancel} onSubmit={submit} />
        }
      >
        <Form layout="vertical" component={false}>
          <div style={{ paddingTop: token.paddingXS }}>
            <Summary
              items={[
                { key: 'level', label: t.level.current, value: user.level },
                {
                  key: 'inviter',
                  label: t.level.inviter,
                  value: (
                    <span style={{ fontFamily: token.fontFamilyCode }}>
                      {inviter ?? t.noInviter}
                    </span>
                  ),
                },
              ]}
            />
          </div>
          <Form.Item
            label={t.level.label}
            htmlFor={levelId}
            required
            validateStatus={levelError === undefined ? '' : 'error'}
            help={levelError}
            style={{ marginTop: token.marginMD }}
          >
            <Select<Level>
              id={levelId}
              value={level ?? null}
              placeholder={t.level.placeholder}
              disabled={busy}
              options={user_level.map((value) => ({
                value,
                label: value,
                disabled: value === user.level,
              }))}
              onChange={(value) => {
                setLevel(value);
                setLevelError(undefined);
              }}
            />
          </Form.Item>
          <ReasonField
            id={reasonId}
            value={reason}
            error={reasonFieldError}
            extra={t.reasonExtra}
            disabled={busy}
            onChange={(value) => {
              setReason(value);
              if (reasonFieldError !== undefined) setReasonFieldError(reasonError(value));
            }}
          />
          <Alert type="info" showIcon message={t.level.note} />
        </Form>
      </Modal>
      <StepUpModal
        open={write.phase === 'verify'}
        tier="totp"
        operation={t.level.operation}
        details={[
          t.stepUpUser(user.user_id),
          ...(pending === undefined ? [] : [t.level.change(user.level, pending.level)]),
          ...(write.again ? [t.stepUpAgain] : []),
        ]}
        onSubmit={write.verify}
        onClose={write.cancel}
        onVerified={write.onVerified}
      />
    </>
  );
}
