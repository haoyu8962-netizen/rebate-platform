// 【已关闭（不处理）】的对话框：必填原因（去首尾空白后 1–200 字，前端先查），提示会随单解除提现
// 冻结；不走动态码。请求由页面发出（同一对话框内重试沿用同一个 Idempotency-Key），这里只收原因、
// 显示字段旁错误与本次提交的结果提示。
import { Alert, Button, Flex, Input, Modal, Typography } from 'antd';
import { useId, useState, type ReactElement } from 'react';
import { reconTexts } from '../../texts/recon.ts';
import { REASON_MAX } from './model.ts';

const t = reconTexts.close;

export interface CloseModalProps {
  /** The difference being closed (shown in the dialog). */
  readonly reconDiffId: string;
  readonly sending: boolean;
  /** Error next to the reason field (server 20001 [reason]). */
  readonly fieldError: string | undefined;
  /** Outcome of the last submit that keeps the dialog open (20901, 40901, network, …). */
  readonly error: string | undefined;
  /** False after an answer that must not be resent from this dialog (20901). */
  readonly canSubmit: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (reason: string) => void;
}

function validReason(reason: string): boolean {
  const trimmed = reason.trim();
  return trimmed.length >= 1 && trimmed.length <= REASON_MAX;
}

export function CloseModal({
  reconDiffId,
  sending,
  fieldError,
  error,
  canSubmit,
  onCancel,
  onSubmit,
}: CloseModalProps): ReactElement {
  const errorId = useId();
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  const shownError = invalid ? t.invalid : fieldError;

  const submit = () => {
    if (sending || !canSubmit) return;
    if (!validReason(reason)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onSubmit(reason.trim());
  };

  return (
    <Modal
      open
      centered
      width={520}
      title={t.title}
      destroyOnHidden
      maskClosable={false}
      onCancel={onCancel}
      footer={
        <Flex justify="end" gap={8}>
          <Button onClick={onCancel}>{t.cancel}</Button>
          <Button type="primary" danger loading={sending} disabled={!canSubmit} onClick={submit}>
            {t.submit}
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap={12} style={{ paddingTop: 8 }}>
        <Alert role="note" type="warning" showIcon message={t.note} />
        <Typography.Text type="secondary" style={{ wordBreak: 'break-all' }}>
          {t.target(reconDiffId)}
        </Typography.Text>
        <Input.TextArea
          aria-label={t.label}
          aria-invalid={shownError === undefined ? undefined : true}
          aria-describedby={shownError === undefined ? undefined : errorId}
          aria-required
          value={reason}
          rows={3}
          showCount
          count={{ max: REASON_MAX }}
          status={shownError === undefined ? '' : 'error'}
          placeholder={t.placeholder}
          disabled={sending}
          onChange={(event) => {
            setReason(event.target.value);
            if (invalid) setInvalid(!validReason(event.target.value));
          }}
        />
        {shownError === undefined ? null : (
          <Typography.Text id={errorId} type="danger">
            {shownError}
          </Typography.Text>
        )}
        {error === undefined ? null : <Alert type="error" showIcon message={error} />}
      </Flex>
    </Modal>
  );
}
