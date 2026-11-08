// 【核销】的确认对话框（R2 迟到成功 → 提现 W11）：说明会凭账单行把原提现单记为接口打款成功、
// 不会重复打款，并解除以本差错单为来源的提现冻结；备注选填（去首尾空白后最多 200 字，前端先查）。
// 动态码与请求由页面处理（同一对话框内重试与 10003 重放沿用同一个 Idempotency-Key），这里只收
// 备注、显示字段旁错误与本次提交的结果提示。
import { Alert, Button, Flex, Input, Modal, Typography } from 'antd';
import { useId, useState, type ReactElement } from 'react';
import { reconTexts } from '../../texts/recon.ts';
import { NOTE_MAX } from './model.ts';

const t = reconTexts.writeOff;

export interface WriteOffModalProps {
  /** The difference being written off (shown in the dialog). */
  readonly reconDiffId: string;
  /** Its withdrawal reference (ref_id). */
  readonly withdrawalRef: string;
  /** A step-up or the request is under way. */
  readonly busy: boolean;
  /**
   * The step-up dialog is open above: no antd title meanwhile (this dialog is inert then). Under
   * NODE_ENV=test antd gives every title the same id, so a title here would name that dialog.
   */
  readonly covered: boolean;
  /** The note can no longer change (a sent request's outcome is unknown: a retry resends it). */
  readonly locked: boolean;
  /** Error next to the note field (server 20001 [note]). */
  readonly fieldError: string | undefined;
  /** Outcome of the last submit that keeps the dialog open (20901, 40901, network, …). */
  readonly error: string | undefined;
  /** False after an answer that must not be resent from this dialog (20901, 10403). */
  readonly canSubmit: boolean;
  readonly onCancel: () => void;
  /** The trimmed note, or undefined when none was typed. */
  readonly onSubmit: (note: string | undefined) => void;
}

const noteTooLong = (note: string): boolean => note.trim().length > NOTE_MAX;

export function WriteOffModal({
  reconDiffId,
  withdrawalRef,
  busy,
  covered,
  locked,
  fieldError,
  error,
  canSubmit,
  onCancel,
  onSubmit,
}: WriteOffModalProps): ReactElement {
  const errorId = useId();
  const [note, setNote] = useState('');
  const [invalid, setInvalid] = useState(false);
  const shownError = invalid ? t.invalid : fieldError;

  const submit = () => {
    if (busy || !canSubmit) return;
    if (noteTooLong(note)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const trimmed = note.trim();
    onSubmit(trimmed === '' ? undefined : trimmed);
  };

  return (
    <Modal
      open
      centered
      width={520}
      title={covered ? undefined : t.title}
      destroyOnHidden
      maskClosable={false}
      onCancel={onCancel}
      footer={
        <Flex justify="end" gap={8}>
          <Button onClick={onCancel}>{t.cancel}</Button>
          <Button type="primary" danger loading={busy} disabled={!canSubmit} onClick={submit}>
            {t.submit}
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap={12} style={{ paddingTop: 8 }}>
        <Alert role="note" type="warning" showIcon message={t.note} />
        <Flex vertical gap={4}>
          <Typography.Text type="secondary" style={{ wordBreak: 'break-all' }}>
            {t.target(reconDiffId)}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ wordBreak: 'break-all' }}>
            {t.withdrawal(withdrawalRef)}
          </Typography.Text>
        </Flex>
        <Input.TextArea
          aria-label={t.label}
          aria-invalid={shownError === undefined ? undefined : true}
          aria-describedby={shownError === undefined ? undefined : errorId}
          value={note}
          rows={3}
          showCount
          count={{ max: NOTE_MAX }}
          status={shownError === undefined ? '' : 'error'}
          placeholder={t.placeholder}
          disabled={busy || locked}
          onChange={(event) => {
            setNote(event.target.value);
            if (invalid) setInvalid(noteTooLong(event.target.value));
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
