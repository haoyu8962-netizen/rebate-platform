// Enable / disable confirmation of one risk rule: what changes, the optional reason (≤200
// characters, sent with the change and kept in the audit record) and the totp step-up that
// follows. Nothing is written here; 【确认…】 hands over to the step-up dialog, and this dialog
// is not rendered while that one is open (one dialog at a time; the reason is kept by the page).
import { SafetyOutlined } from '@ant-design/icons';
import { Button, Flex, Input, Modal, Typography, theme } from 'antd';
import { useId, useRef, useState, type ReactElement } from 'react';
import { riskTexts } from '../../texts/risk.ts';
import { REASON_MAX, statusLabel, targetOf, type RiskRule, type RiskRuleChange } from './model.ts';

const t = riskTexts.rules;

export interface ConfirmModalProps {
  readonly rule: RiskRule;
  readonly change: RiskRuleChange;
  /** The reason typed before (kept when the step-up dialog is cancelled back to here). */
  readonly reason: string;
  readonly onCancel: () => void;
  readonly onConfirm: (reason: string) => void;
}

export function ConfirmModal({
  rule,
  change,
  reason: initialReason,
  onCancel,
  onConfirm,
}: ConfirmModalProps): ReactElement {
  const { token } = theme.useToken();
  const reasonId = useId();
  const errorId = useId();
  const reason = useRef(initialReason);
  const [tooLong, setTooLong] = useState(false);
  const verb = change === 'enable' ? t.enable : t.disable;
  const stopping = change === 'disable';
  const label = (text: string) => (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {text}
    </Typography.Text>
  );
  const confirm = () => {
    // The TextArea already stops at 200 characters; this guards a pasted or scripted value.
    if (reason.current.length > REASON_MAX) {
      setTooLong(true);
      return;
    }
    onConfirm(reason.current);
  };
  return (
    <Modal
      open
      centered
      width={560}
      title={t.confirm.title(verb, rule.name)}
      destroyOnHidden
      maskClosable={false}
      onCancel={onCancel}
      footer={
        <Flex justify="end" gap={8}>
          <Button onClick={onCancel}>{t.confirm.cancel}</Button>
          <Button
            type={stopping ? 'default' : 'primary'}
            danger={stopping}
            icon={<SafetyOutlined aria-hidden />}
            onClick={confirm}
          >
            {t.confirm.submit(verb)}
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap={16} style={{ paddingTop: 8 }}>
        <Typography.Paragraph style={{ margin: 0 }}>{t.confirm.effect(verb)}</Typography.Paragraph>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 12,
            padding: 16,
            borderRadius: token.borderRadius,
            background: token.colorFillQuaternary,
          }}
        >
          <Flex vertical gap={2}>
            {label(t.confirm.rule)}
            <Typography.Text strong>{rule.name}</Typography.Text>
            <Typography.Text style={{ fontFamily: token.fontFamilyCode, fontSize: 12 }}>
              {rule.rule_id}
            </Typography.Text>
          </Flex>
          <Flex vertical gap={2}>
            {label(t.confirm.change)}
            <Typography.Text strong>
              {`${statusLabel(rule.status)} → ${statusLabel(targetOf(change))}`}
            </Typography.Text>
          </Flex>
        </div>
        <Flex vertical gap={6}>
          <Typography.Text id={reasonId} style={{ fontSize: 12 }}>
            {t.confirm.reasonLabel}
          </Typography.Text>
          <Input.TextArea
            aria-labelledby={reasonId}
            aria-describedby={tooLong ? errorId : undefined}
            aria-invalid={tooLong ? true : undefined}
            defaultValue={initialReason}
            maxLength={REASON_MAX}
            showCount
            rows={3}
            placeholder={t.confirm.reasonPlaceholder}
            onChange={(event) => {
              reason.current = event.target.value;
              if (event.target.value.length <= REASON_MAX) setTooLong(false);
            }}
          />
          {tooLong ? (
            <Typography.Text id={errorId} type="danger" style={{ fontSize: 12 }}>
              {t.confirm.reasonTooLong(REASON_MAX)}
            </Typography.Text>
          ) : null}
        </Flex>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          <SafetyOutlined aria-hidden /> {t.confirm.stepUpHint}
        </Typography.Text>
      </Flex>
    </Modal>
  );
}
