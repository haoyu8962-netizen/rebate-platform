// 【确认扣回】的二次确认对话框（黑名单复核确认扣回，CT-24zzf，F1-08ec）：显示订单（ref_id 的
// order_key 部分）、命中维度、差错单金额 expected_fen（后台金额格式，只作展示），并注明实扣以服务端
// 计算为准；备注选填（去首尾空白后最多 200 字，按 Unicode 码点计，前端先查）。动态码与请求由页面处理（同一对话框内
// 重试与 10003 重放沿用同一个 Idempotency-Key），这里只收备注、显示字段旁错误与本次提交的结果提示。
// 请求体只有可选 note，金额从不由控制台发送。
import { Alert, Button, Flex, Input, Modal, Typography, theme } from 'antd';
import { useId, useState, type ReactElement } from 'react';
import { reconTexts } from '../../texts/recon.ts';
import { NOTE_MAX, dimensionLabel, money, noteLength } from './model.ts';

const t = reconTexts.clawback;

export interface ClawbackModalProps {
  /** The difference being confirmed (shown in the dialog). */
  readonly reconDiffId: string;
  /** The order_key part of its ref_id. */
  readonly orderKey: string;
  /** The hit dimensions (codes). */
  readonly dimensions: readonly string[];
  /** expected_fen of the difference (display only; the server calculates what is taken back). */
  readonly expectedFen: number;
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

// Counted in code points after trimming, as the contract and the server count (not UTF-16 units).
const noteTooLong = (note: string): boolean => noteLength(note) > NOTE_MAX;

export function ClawbackModal({
  reconDiffId,
  orderKey,
  dimensions,
  expectedFen,
  busy,
  covered,
  locked,
  fieldError,
  error,
  canSubmit,
  onCancel,
  onSubmit,
}: ClawbackModalProps): ReactElement {
  const { token } = theme.useToken();
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

  const dimensionNames =
    dimensions.length === 0 ? reconTexts.dash : dimensions.map(dimensionLabel).join(t.separator);

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
      <Flex vertical gap={12} style={{ paddingTop: token.paddingXS }}>
        <Alert role="note" type="warning" showIcon message={t.note} />
        <Flex vertical gap={4}>
          <Typography.Text type="secondary" style={{ wordBreak: 'break-all' }}>
            {t.target(reconDiffId)}
          </Typography.Text>
          <Typography.Text style={{ wordBreak: 'break-all' }}>{t.order(orderKey)}</Typography.Text>
          <Typography.Text>{t.dimensions(dimensionNames)}</Typography.Text>
          <Typography.Text strong style={{ fontVariantNumeric: 'tabular-nums' }}>
            {t.expected(money(expectedFen))}
          </Typography.Text>
        </Flex>
        <Input.TextArea
          aria-label={t.label}
          aria-invalid={shownError === undefined ? undefined : true}
          aria-describedby={shownError === undefined ? undefined : errorId}
          value={note}
          rows={3}
          showCount
          count={{ max: NOTE_MAX, strategy: noteLength }}
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
