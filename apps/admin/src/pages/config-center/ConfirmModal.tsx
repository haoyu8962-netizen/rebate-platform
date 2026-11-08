// Confirmation of a configuration write (change, rollback or batch): what changes, from → to, the
// reason that goes with it, and whether a totp step-up follows. Nothing is written here.
import { SafetyOutlined } from '@ant-design/icons';
import { Button, Flex, Modal, Typography, theme } from 'antd';
import type { ReactElement } from 'react';
import { configCenterTexts as t } from '../../texts/config-center.ts';
import { displayName, nameOf, needsStepUp, valueLabel, type ConfigRow } from './model.ts';
import { permissionOf, type WriteRequest } from './write.ts';

export interface ConfirmModalProps {
  readonly request: WriteRequest;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

function titleOf(request: WriteRequest): string {
  if (request.kind === 'edit') return t.confirm.editTitle(displayName(request.row.key));
  if (request.kind === 'rollback') return t.confirm.rollbackTitle(displayName(request.row.key));
  return t.confirm.batchTitle(t.groups[request.group]);
}

function submitOf(request: WriteRequest, stepUp: boolean): string {
  if (request.kind === 'rollback') return stepUp ? t.confirm.rollbackStepUp : t.confirm.rollback;
  return stepUp ? t.confirm.submitStepUp : t.confirm.submit;
}

export function ConfirmModal({ request, onCancel, onConfirm }: ConfirmModalProps): ReactElement {
  const { token } = theme.useToken();
  const stepUp = needsStepUp(permissionOf(request));
  const small = { fontSize: 12 } as const;
  const code = { fontFamily: token.fontFamilyCode, fontSize: 12 } as const;
  const label = (text: string) => (
    <Typography.Text type="secondary" style={small}>
      {text}
    </Typography.Text>
  );
  const change = (row: ConfigRow, to: unknown, extra?: string) => (
    <Flex
      key={row.key}
      vertical
      gap={4}
      style={{
        padding: 16,
        borderRadius: token.borderRadius,
        background: token.colorInfoBg,
      }}
    >
      {label(t.confirm.item)}
      {nameOf(row.key) === null ? null : (
        <Typography.Text strong>{nameOf(row.key)}</Typography.Text>
      )}
      <Typography.Text style={code}>{row.key}</Typography.Text>
      {label(t.confirm.change)}
      {extra === undefined ? null : <Typography.Text>{extra}</Typography.Text>}
      <Typography.Text strong>
        {t.confirm.arrow(valueLabel(row, row.value), valueLabel(row, to))}
      </Typography.Text>
    </Flex>
  );
  return (
    <Modal
      open
      centered
      width={560}
      title={titleOf(request)}
      destroyOnHidden
      maskClosable={false}
      onCancel={onCancel}
      footer={
        <Flex justify="end" gap={8}>
          <Button onClick={onCancel}>{t.confirm.cancel}</Button>
          <Button
            type="primary"
            icon={stepUp ? <SafetyOutlined aria-hidden /> : undefined}
            onClick={onConfirm}
          >
            {submitOf(request, stepUp)}
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap={12} style={{ paddingTop: 8 }}>
        {request.kind === 'edit' ? change(request.row, request.value) : null}
        {request.kind === 'rollback'
          ? change(
              request.row,
              request.toValue,
              t.confirm.rollbackLine(request.row.version, request.toVersion),
            )
          : null}
        {request.kind === 'batch'
          ? request.entries.map((entry) => change(entry.row, entry.value))
          : null}
        <Flex vertical gap={2}>
          {label(t.confirm.reason)}
          <Typography.Text>{request.reason}</Typography.Text>
        </Flex>
        <Typography.Text type="secondary" style={small}>
          {t.confirm.newVersion}
        </Typography.Text>
        {stepUp ? (
          <Typography.Text type="secondary" style={small}>
            <SafetyOutlined aria-hidden /> {t.confirm.stepUp}
          </Typography.Text>
        ) : null}
      </Flex>
    </Modal>
  );
}
