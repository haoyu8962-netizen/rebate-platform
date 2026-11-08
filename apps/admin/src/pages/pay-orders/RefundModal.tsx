// 原路退款对话框（画板 AdmPayRefund / AdmPayRefundInvalid；支付单与异常收款共用）：金额按元输入、
// 经 @couli/money 转成整数分（最多两位小数，不用浮点），必选原因码（pay_refund_reason，中文名取
// 后台字典），选填备注（≤200 字）。可退金额前端先查，超出在金额旁提示、不发请求；服务端 20001
// [amount_fen] 也提示在金额旁。不弹动态码。请求由 useRefund 发出，这里只收输入、显示错误。
import { Alert, Button, Flex, Form, Input, Modal, Select, Typography } from 'antd';
import { useEffect, useRef, type ReactElement } from 'react';
import { payOrdersTexts } from '../../texts/pay-orders.ts';
import {
  REFUND_NOTE_MAX,
  REFUND_REASONS,
  fenToNumber,
  moneyOf,
  parseRefundAmount,
  refundReasonLabel,
  type PayRefundCreateRequest,
  type PayRefundReason,
} from './model.ts';

const t = payOrdersTexts.refund;

interface RefundValues {
  readonly amount?: string;
  readonly reason?: PayRefundReason;
  readonly note?: string;
}

export interface RefundModalProps {
  /** What is refunded (支付单 / 异常收款 and its number). */
  readonly target: string;
  /** Refundable fen as the page knows it (the server checks again). */
  readonly refundable: bigint;
  /** How the refundable amount is computed. */
  readonly refundableNote: string;
  readonly sending: boolean;
  /** Bumped each time the server refuses the amount (20001 [amount_fen]). */
  readonly amountRejected: number;
  /** Outcome of the last submit that keeps the dialog open (20901, 40901, network, …). */
  readonly error: string | undefined;
  /** False after an answer that must not be resent from this dialog (20901, 10403). */
  readonly canSubmit: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (body: PayRefundCreateRequest) => void;
}

export function RefundModal({
  target,
  refundable,
  refundableNote,
  sending,
  amountRejected,
  error,
  canSubmit,
  onCancel,
  onSubmit,
}: RefundModalProps): ReactElement {
  const [form] = Form.useForm<RefundValues>();
  // A double click must not validate (and send) twice before the page marks the dialog sending.
  const lock = useRef(false);

  useEffect(() => {
    if (amountRejected > 0) form.setFields([{ name: 'amount', errors: [t.amountRejected] }]);
  }, [amountRejected, form]);

  const checkAmount = (_: unknown, value: string | undefined): Promise<void> => {
    const fen = parseRefundAmount(value ?? '');
    if (fen === 'empty') return Promise.reject(new Error(t.amountRequired));
    if (fen === 'invalid') return Promise.reject(new Error(t.amountInvalid));
    if (fen > refundable) return Promise.reject(new Error(t.amountOver(moneyOf(refundable))));
    return Promise.resolve();
  };

  const submit = () => {
    if (lock.current || sending || !canSubmit) return;
    lock.current = true;
    form.validateFields().then(
      (values) => {
        lock.current = false;
        const fen = parseRefundAmount(values.amount ?? '');
        if (typeof fen !== 'bigint' || values.reason === undefined) return;
        const note = (values.note ?? '').trim();
        onSubmit({
          amount_fen: fenToNumber(fen),
          reason_code: values.reason,
          ...(note === '' ? {} : { note }),
        });
      },
      () => {
        lock.current = false;
      },
    );
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
          <Button onClick={onCancel} disabled={sending}>
            {t.cancel}
          </Button>
          <Button type="primary" danger loading={sending} disabled={!canSubmit} onClick={submit}>
            {t.submit}
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap={12} style={{ paddingTop: 8 }}>
        <Alert role="note" type="warning" showIcon message={t.note} />
        <Typography.Text style={{ wordBreak: 'break-all' }}>{target}</Typography.Text>
        <Flex vertical gap={2}>
          <Typography.Text strong>{t.refundable(moneyOf(refundable))}</Typography.Text>
          <Typography.Text type="secondary">{refundableNote}</Typography.Text>
        </Flex>
        <Form<RefundValues> form={form} layout="vertical" disabled={sending} requiredMark>
          <Form.Item
            name="amount"
            label={t.amount}
            required
            validateFirst
            rules={[{ validator: checkAmount }]}
          >
            <Input inputMode="decimal" autoComplete="off" placeholder={t.amountPlaceholder} />
          </Form.Item>
          <Form.Item
            name="reason"
            label={t.reason}
            rules={[{ required: true, message: t.reasonRequired }]}
          >
            <Select<PayRefundReason>
              virtual={false}
              placeholder={t.reasonPlaceholder}
              options={REFUND_REASONS.map((code) => ({
                value: code,
                label: refundReasonLabel(code),
              }))}
            />
          </Form.Item>
          <Form.Item
            name="note"
            label={t.noteLabel}
            rules={[{ max: REFUND_NOTE_MAX, message: t.noteTooLong }]}
            style={{ marginBottom: 0 }}
          >
            <Input.TextArea
              rows={3}
              maxLength={REFUND_NOTE_MAX}
              showCount
              placeholder={t.notePlaceholder}
            />
          </Form.Item>
        </Form>
        {error === undefined ? null : <Alert type="error" showIcon message={error} />}
      </Flex>
    </Modal>
  );
}
