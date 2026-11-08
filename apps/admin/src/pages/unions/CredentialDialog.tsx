// 【录入新凭据】（manual 账号，如京东推客授权 Key）：密码框输入凭据、选填到期时间（北京时间）与原因
// → 动态码 → PUT …/{union_account_id}/credential。凭据在发出请求时就从输入框清空，任何地方都不
// 回显；只有 10003 重新验证后的那一次重发还会用到它。成功后用响应里的账号行更新列表。
import { useDataProvider } from '@refinedev/core';
import { Alert, Button, Flex, Form, Input, Modal, Typography } from 'antd';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import type { Schema } from '@couli/contracts-ts';
import { unionsTexts as t } from '../../texts/unions.ts';
import {
  CREDENTIAL_MAX,
  REASON_MAX,
  beijingInputToIso,
  codeOf,
  credentialUrl,
  fieldsOf,
  isNetwork,
  type UnionAccount,
  fieldStatus,
} from './model.ts';
import type { StepUp } from './useStepUp.tsx';

type Field = 'credential' | 'expires_at' | 'reason';
type Errors = Partial<Record<Field, string>>;

export interface CredentialDialogProps {
  readonly account: UnionAccount;
  readonly stepUp: StepUp;
  readonly onClose: () => void;
  readonly onSaved: (account: UnionAccount) => void;
}

export function CredentialDialog({
  account,
  stepUp,
  onClose,
  onSaved,
}: CredentialDialogProps): ReactElement | null {
  const getProvider = useDataProvider();
  const credentialId = useId();
  const expiresId = useId();
  const reasonId = useId();
  const [credential, setCredential] = useState('');
  const [expires, setExpires] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const put = async (payload: Schema<'AdminUnionCredentialRequest'>, stepUpToken: string) => {
    if (!alive.current) return;
    // 提交即清空：凭据不留在输入框里。
    setCredential('');
    setBusy(true);
    setMessage(undefined);
    setErrors({});
    const call = getProvider().custom;
    try {
      if (call === undefined) throw new Error('Missing custom data provider');
      const response = await call<UnionAccount>({
        url: credentialUrl(account.union_account_id),
        method: 'put',
        payload,
        meta: { stepUpToken },
      });
      if (!alive.current) return;
      setBusy(false);
      onSaved(response.data);
    } catch (cause) {
      if (!alive.current) return;
      const code = codeOf(cause);
      if (code === 10003) {
        stepUp.ask({
          operation: t.credential.operation(account.account_name),
          again: true,
          run: (token) => void put(payload, token),
          onCancel: () => setBusy(false),
        });
        return;
      }
      setBusy(false);
      if (code === 20001) {
        const fields = fieldsOf(cause);
        const next: Errors = {};
        if (fields.includes('credential')) next.credential = t.credential.invalid;
        if (fields.includes('expires_at')) next.expires_at = t.credential.expiresInvalid;
        if (fields.includes('reason')) next.reason = t.reasonInvalid;
        setErrors(next);
        if (Object.keys(next).length === 0) setMessage(t.credential.notAllowed);
        return;
      }
      if (code === 10403) setMessage(t.noPermissionAction);
      else if (isNetwork(cause)) setMessage(t.networkUnknown);
      else setMessage(t.failed);
    }
  };

  const submit = () => {
    if (busy) return;
    const next: Errors = {};
    if (credential === '') next.credential = t.credential.required;
    else if (credential.length > CREDENTIAL_MAX) next.credential = t.credential.invalid;
    const expiresAt = beijingInputToIso(expires);
    if (expiresAt === null) next.expires_at = t.credential.expiresInvalid;
    const note = reason.trim();
    if (note.length > REASON_MAX) next.reason = t.reasonInvalid;
    setErrors(next);
    setMessage(undefined);
    if (Object.keys(next).length > 0) return;
    const payload: Schema<'AdminUnionCredentialRequest'> = {
      credential,
      ...(expiresAt === undefined || expiresAt === null ? {} : { expires_at: expiresAt }),
      ...(note === '' ? {} : { reason: note }),
    };
    stepUp.ask({
      operation: t.credential.operation(account.account_name),
      run: (token) => void put(payload, token),
    });
  };

  const item = (field: Field) => fieldStatus(errors[field]);

  // 动态码对话框打开时先收起（见 StepUp.open）。
  if (stepUp.open) return null;
  return (
    <Modal
      open
      centered
      width={520}
      title={t.credential.title(account.account_name)}
      destroyOnHidden
      maskClosable={false}
      onCancel={onClose}
      footer={[
        <Button key="cancel" onClick={onClose}>
          {t.cancel}
        </Button>,
        <Button
          key="submit"
          type="primary"
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={submit}
        >
          {t.credential.submit}
        </Button>,
      ]}
    >
      <Flex vertical gap={12}>
        <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
          {t.credential.intro}
        </Typography.Paragraph>
        {message === undefined ? null : <Alert type="error" showIcon message={message} />}
        <Form layout="vertical" component={false}>
          <Form.Item label={t.credential.label} htmlFor={credentialId} {...item('credential')}>
            <Input.Password
              id={credentialId}
              value={credential}
              visibilityToggle={false}
              autoComplete="off"
              placeholder={t.credential.placeholder}
              onChange={(event) => setCredential(event.target.value)}
            />
          </Form.Item>
          <Form.Item
            label={t.credential.expiresLabel}
            htmlFor={expiresId}
            extra={t.credential.expiresHint}
            {...item('expires_at')}
          >
            <Input
              id={expiresId}
              type="datetime-local"
              step={1}
              value={expires}
              onChange={(event) => setExpires(event.target.value)}
            />
          </Form.Item>
          <Form.Item
            label={t.reasonLabel}
            htmlFor={reasonId}
            {...item('reason')}
            style={{ marginBottom: 0 }}
          >
            <Input.TextArea
              id={reasonId}
              value={reason}
              rows={2}
              maxLength={REASON_MAX}
              placeholder={t.reasonPlaceholder}
              onChange={(event) => setReason(event.target.value)}
            />
          </Form.Item>
        </Form>
      </Flex>
    </Modal>
  );
}
