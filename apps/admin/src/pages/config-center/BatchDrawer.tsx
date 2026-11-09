// Batch change of one group (POST /admin/v1/config-items/batch): the editable items of one
// permission point, each left as it is unless a new value is entered, with one shared reason.
// The whole batch takes effect or nothing does; saving only hands the request to the page.
import { SafetyOutlined } from '@ant-design/icons';
import { Alert, Button, Drawer, Flex, Form, Input, Select, Typography, theme } from 'antd';
import { useState, type ReactElement, type ReactNode } from 'react';
import { codePointLength } from '../../text-length.ts';
import { configCenterTexts as t } from '../../texts/config-center.ts';
import {
  REASON_MAX,
  collectBatch,
  initialInput,
  nameOf,
  needsStepUp,
  valueLabel,
  type ConfigPermission,
  type ConfigRow,
  type FieldValue,
  type GroupId,
} from './model.ts';
import { ValueField } from './ValueField.tsx';
import type { BatchEntry } from './write.ts';

export interface BatchDrawerProps {
  readonly group: GroupId;
  /** Items of the group the account may change. */
  readonly rows: readonly ConfigRow[];
  readonly busy: boolean;
  readonly notice: ReactNode;
  readonly onClose: () => void;
  readonly onSave: (
    permission: ConfigPermission,
    entries: readonly BatchEntry[],
    reason: string,
  ) => void;
}

interface FormValues {
  values: Record<string, FieldValue>;
  reason: string;
}

export function BatchDrawer({
  group,
  rows,
  busy,
  notice,
  onClose,
  onSave,
}: BatchDrawerProps): ReactElement {
  const { token } = theme.useToken();
  const [form] = Form.useForm<FormValues>();
  const permissions = [...new Set(rows.map((row) => row.permission))];
  const [chosen, setChosen] = useState<ConfigPermission | undefined>(permissions[0]);
  const permission = chosen !== undefined && permissions.includes(chosen) ? chosen : permissions[0];
  const listed = rows.filter((row) => row.permission === permission);
  const [empty, setEmpty] = useState(false);
  const stepUp = permission !== undefined && needsStepUp(permission);

  const save = () => {
    if (busy || permission === undefined) return;
    form.validateFields().then(
      (values) => {
        const collected = collectBatch(listed, values.values, (key) =>
          form.isFieldTouched(['values', key]),
        );
        if (!collected.ok) return;
        const entries: readonly BatchEntry[] = collected.entries;
        if (entries.length === 0) {
          setEmpty(true);
          return;
        }
        setEmpty(false);
        onSave(permission, entries, values.reason.trim());
      },
      () => undefined,
    );
  };

  const code = { fontFamily: token.fontFamilyCode, fontSize: 12 } as const;
  return (
    <Drawer
      open
      width={640}
      destroyOnHidden
      maskClosable={!busy}
      keyboard={!busy}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={t.batchDrawer.title(t.groups[group])}
      footer={
        <Flex justify="end" gap={8}>
          <Button disabled={busy} onClick={onClose}>
            {t.batchDrawer.cancel}
          </Button>
          <Button
            type="primary"
            icon={stepUp ? <SafetyOutlined aria-hidden /> : undefined}
            disabled={busy || listed.length === 0}
            aria-busy={busy ? true : undefined}
            onClick={save}
          >
            {stepUp ? t.batchDrawer.saveStepUp : t.batchDrawer.save}
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap={16}>
        {notice}
        <Typography.Text type="secondary">{t.batchDrawer.intro}</Typography.Text>
        {permissions.length > 1 ? (
          <Flex align="center" gap={8}>
            <Typography.Text>{t.batchDrawer.permission}</Typography.Text>
            <Select<ConfigPermission>
              aria-label={t.batchDrawer.permission}
              value={permission ?? null}
              disabled={busy}
              style={{ width: 200 }}
              options={permissions.map((value) => ({ value, label: value }))}
              onChange={(value) => {
                setChosen(value);
                setEmpty(false);
              }}
            />
          </Flex>
        ) : null}
        {empty ? <Alert type="warning" showIcon message={t.validation.batchNone} /> : null}
        <Form<FormValues>
          form={form}
          name="config-batch"
          layout="vertical"
          requiredMark={false}
          disabled={busy}
          initialValues={{
            values: Object.fromEntries(rows.map((row) => [row.key, initialInput(row)])),
            reason: '',
          }}
        >
          {listed.map((row) => (
            <ValueField
              key={row.key}
              row={row}
              name={['values', row.key]}
              optional
              hint={false}
              label={
                <Flex vertical gap={0}>
                  <Typography.Text strong>{nameOf(row.key) ?? row.key}</Typography.Text>
                  <Typography.Text type="secondary" style={code}>
                    {row.key}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t.batchDrawer.current(valueLabel(row, row.value))}
                  </Typography.Text>
                </Flex>
              }
            />
          ))}
          <Form.Item
            name="reason"
            label={t.drawer.reason}
            rules={[
              {
                validator: (_, value: unknown) => {
                  const text = typeof value === 'string' ? value.trim() : '';
                  if (text === '') return Promise.reject(new Error(t.validation.reason));
                  if (codePointLength(text) > REASON_MAX)
                    return Promise.reject(new Error(t.validation.reasonMax));
                  return Promise.resolve();
                },
              },
            ]}
          >
            <Input.TextArea rows={3} placeholder={t.drawer.reasonPlaceholder} />
          </Form.Item>
        </Form>
      </Flex>
    </Drawer>
  );
}
