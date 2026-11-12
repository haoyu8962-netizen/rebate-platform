// 【标记已处理】对话框：必填处理说明（去首尾空白后 1–500 个码点，按 text-length.ts 计，前端先查，
// 不合格不发请求、不截断）。请求由页面发出（请求体只有 note 与 expected_row_version），这里只收说明、
// 显示说明旁错误与本次提交的结果提示。
import { Alert, Button, Flex, Input, Modal, Typography, theme } from 'antd';
import { useId, useState, type ReactElement } from 'react';
import { agentTracesTexts } from '../../texts/agent-traces.ts';
import { codePointLength } from '../../text-length.ts';
import { NOTE_MAX, validNote, type Report } from './model.ts';

const t = agentTracesTexts.handleDialog;

export interface HandleModalProps {
  readonly report: Report;
  readonly sending: boolean;
  /** Error next to the note (server 20001 [note]). */
  readonly fieldError: string | undefined;
  /** Outcome of the last submit that keeps the dialog open (network, 10403, …). */
  readonly error: string | undefined;
  readonly onCancel: () => void;
  /** The note, trimmed. */
  readonly onSubmit: (note: string) => void;
}

export function HandleModal({
  report,
  sending,
  fieldError,
  error,
  onCancel,
  onSubmit,
}: HandleModalProps): ReactElement {
  const { token } = theme.useToken();
  const errorId = useId();
  const [note, setNote] = useState('');
  const [invalid, setInvalid] = useState(false);
  const shownError = invalid ? t.invalid : fieldError;

  const submit = () => {
    if (sending) return;
    if (!validNote(note)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onSubmit(note.trim());
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
          <Button type="primary" loading={sending} onClick={submit}>
            {t.submit}
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap={12} style={{ paddingTop: token.paddingXS }}>
        <Typography.Text type="secondary" style={{ wordBreak: 'break-all' }}>
          {t.target(report.session_id)}
        </Typography.Text>
        {report.report_reason === null ? null : (
          <Typography.Text>{t.reason(report.report_reason)}</Typography.Text>
        )}
        <Input.TextArea
          aria-label={t.label}
          aria-invalid={shownError === undefined ? undefined : true}
          aria-describedby={shownError === undefined ? undefined : errorId}
          aria-required
          value={note}
          rows={4}
          showCount
          count={{ max: NOTE_MAX, strategy: codePointLength }}
          status={shownError === undefined ? '' : 'error'}
          placeholder={t.placeholder}
          disabled={sending}
          onChange={(event) => {
            setNote(event.target.value);
            if (invalid) setInvalid(!validNote(event.target.value));
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
