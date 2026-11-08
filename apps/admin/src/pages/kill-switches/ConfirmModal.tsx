// Change confirmation (design-hifi AdmSwitchOff): what changes, its effect, the optional
// operation note (≤200 characters, sent with the change) and the step-up that follows. Nothing is
// written here; 【验证并…】 hands over to the totp step-up.
import { SafetyOutlined } from '@ant-design/icons';
import { Alert, Button, Flex, Input, Modal, Radio, Typography, theme } from 'antd';
import { useId, useRef, type ReactElement } from 'react';
import { killSwitchesTexts as t } from '../../texts/kill-switches.ts';
import {
  displayName,
  enumLabel,
  impactOf,
  isStopping,
  rawLabel,
  stateLabel,
  targetLabel,
  verbOf,
  currentOf,
  type SwitchRow,
  type SwitchValue,
} from './model.ts';

export const REASON_MAX = 200;

export interface ConfirmModalProps {
  readonly row: SwitchRow;
  readonly next: SwitchValue;
  /** Enum rows: another option picked in the dialog. */
  readonly onNext: (next: SwitchValue) => void;
  readonly onCancel: () => void;
  /** The operation note as typed (the TextArea owns its value and the 200 limit). */
  readonly onConfirm: (reason: string) => void;
}

export function ConfirmModal({
  row,
  next,
  onNext,
  onCancel,
  onConfirm,
}: ConfirmModalProps): ReactElement {
  const { token } = theme.useToken();
  const reasonId = useId();
  const optionsId = useId();
  // Uncontrolled: the note never round-trips through page state on every keystroke.
  const reason = useRef('');
  const name = displayName(row.key);
  const verb = verbOf(row, next);
  const current = currentOf(row);
  const from = stateLabel(row, current);
  const to = targetLabel(row, next);
  const impact = impactOf(row.key);
  const turningOff = isStopping(row, next);
  const label = (text: string) => (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {text}
    </Typography.Text>
  );
  return (
    <Modal
      open
      centered
      width={640}
      title={t.confirmTitle(verb, name)}
      destroyOnHidden
      maskClosable={false}
      onCancel={onCancel}
      footer={
        <Flex justify="end" gap={8}>
          <Button onClick={onCancel}>{t.cancel}</Button>
          <Button
            type={turningOff ? 'default' : 'primary'}
            danger={turningOff}
            icon={<SafetyOutlined aria-hidden />}
            onClick={() => onConfirm(reason.current)}
          >
            {t.submit(verb)}
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap={16} style={{ paddingTop: 8 }}>
        <Typography.Paragraph style={{ margin: 0 }}>
          {t.effect(verb, name)}
          {impact === null ? null : impact}
        </Typography.Paragraph>
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
            {label(t.feature)}
            <Typography.Text strong>{name}</Typography.Text>
            <Typography.Text style={{ fontFamily: token.fontFamilyCode, fontSize: 12 }}>
              {row.key}
            </Typography.Text>
          </Flex>
          <Flex vertical gap={2}>
            {label(t.change)}
            <Typography.Text strong>{`${from} → ${to}`}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t.valueChange(rawLabel(current), rawLabel(next))}
            </Typography.Text>
          </Flex>
        </div>
        {row.value_type === 'enum' ? (
          <Flex vertical gap={6}>
            <Typography.Text id={optionsId} strong>
              {t.newValue}
            </Typography.Text>
            <Radio.Group
              aria-labelledby={optionsId}
              value={typeof next === 'string' ? next : null}
              onChange={(event) => onNext(event.target.value as SwitchValue)}
            >
              <Flex vertical gap={8}>
                {(row.options ?? []).map((option) => (
                  <Radio key={option} value={option} disabled={option === current}>
                    {enumLabel(option)}
                  </Radio>
                ))}
              </Flex>
            </Radio.Group>
          </Flex>
        ) : null}
        <Flex vertical gap={6}>
          <Typography.Text id={reasonId} style={{ fontSize: 12 }}>
            {t.reasonLabel}
          </Typography.Text>
          <Input.TextArea
            aria-labelledby={reasonId}
            defaultValue=""
            maxLength={REASON_MAX}
            showCount
            rows={3}
            placeholder={t.reasonPlaceholder}
            onChange={(event) => {
              reason.current = event.target.value;
            }}
          />
        </Flex>
        <Alert
          role="note"
          type="warning"
          showIcon
          style={{
            border: 0,
            alignItems: 'flex-start',
            background: 'var(--color-status-warning-background)',
          }}
          message={
            <Flex vertical gap={4}>
              <Typography.Text strong style={{ color: token.colorWarning }}>
                {t.alertTitle}
              </Typography.Text>
              <Typography.Text>
                {t.alertBody(name, row.key, rawLabel(current), rawLabel(next))}
              </Typography.Text>
            </Flex>
          }
        />
        <Flex vertical gap={4}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            <SafetyOutlined aria-hidden /> {t.stepUpHint}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t.permissionLine(row.permissions.join(' / '))}
          </Typography.Text>
        </Flex>
      </Flex>
    </Modal>
  );
}
