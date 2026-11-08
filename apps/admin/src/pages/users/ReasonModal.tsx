// Reason step of 【查看完整手机号】: the operator states why (1–200 characters, sent with the
// reveal and kept in the audit log). Nothing is sent here; 【验证并查看】 hands over to the totp
// step-up.
import { SafetyOutlined } from '@ant-design/icons';
import { Alert, Button, Flex, Input, Modal, Typography } from 'antd';
import { useId, useState, type ReactElement } from 'react';
import { usersTexts } from '../../texts/users.ts';
import { REASON_MAX, validReason } from './model.ts';

const t = usersTexts.reveal;

export interface ReasonModalProps {
  readonly initialReason: string;
  readonly onCancel: () => void;
  readonly onConfirm: (reason: string) => void;
}

export function ReasonModal({
  initialReason,
  onCancel,
  onConfirm,
}: ReasonModalProps): ReactElement {
  const errorId = useId();
  const [reason, setReason] = useState(initialReason);
  const [invalid, setInvalid] = useState(false);
  const confirm = () => {
    if (!validReason(reason)) {
      setInvalid(true);
      return;
    }
    onConfirm(reason);
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
          <Button type="primary" icon={<SafetyOutlined aria-hidden />} onClick={confirm}>
            {t.submit}
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap={12} style={{ paddingTop: 8 }}>
        <Alert role="note" type="info" showIcon message={t.note} />
        <Input.TextArea
          aria-label={t.reasonLabel}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={invalid ? errorId : undefined}
          aria-required
          value={reason}
          rows={3}
          showCount
          count={{ max: REASON_MAX }}
          status={invalid ? 'error' : ''}
          placeholder={t.reasonPlaceholder}
          onChange={(event) => {
            setReason(event.target.value);
            if (invalid) setInvalid(!validReason(event.target.value));
          }}
        />
        {invalid ? (
          <Typography.Text id={errorId} type="danger">
            {t.reasonInvalid}
          </Typography.Text>
        ) : null}
      </Flex>
    </Modal>
  );
}
