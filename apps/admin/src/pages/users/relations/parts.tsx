// 调等级 / 改上级 两个对话框共用的部件：顶部摘要、原因输入、底部（二次验证说明 + 按钮）与
// 写入失败的分类。文案都在 texts/users.ts。
import { SafetyOutlined } from '@ant-design/icons';
import { Button, Flex, Form, Input, Typography, theme } from 'antd';
import type { ReactElement, ReactNode } from 'react';
import { AdminApiError } from '../../../providers/data/index.ts';
import { usersTexts } from '../../../texts/users.ts';
import { rawCodePointLength } from '../../../text-length.ts';
import { REASON_MAX } from '../model.ts';

const t = usersTexts.relations;

/** 原因：去首尾空白后非空，按发送的原值计码点不超过契约上限（AdminUserReason）。 */
export function reasonError(reason: string): string | undefined {
  if (reason.trim() === '') return t.reasonEmpty;
  if (rawCodePointLength(reason) > REASON_MAX) return t.reasonTooLong(REASON_MAX);
  return undefined;
}

export function fieldsOf(cause: unknown): readonly unknown[] {
  if (!(cause instanceof AdminApiError)) return [];
  const data = cause.data;
  if (typeof data === 'object' && data !== null && 'fields' in data && Array.isArray(data.fields))
    return data.fields as unknown[];
  return [];
}

/** 不落在某个输入旁的失败：用 message.error 提示，已填内容保留，不自动重发。 */
export function failureText(cause: unknown): string {
  if (!(cause instanceof AdminApiError)) return t.failed;
  if (cause.kind === 'network') return t.network;
  if (cause.kind === 'parse' || cause.kind === 'http' || cause.httpStatus >= 500) return t.server;
  if (cause.code === 10403) return t.forbidden;
  return t.failed;
}

export interface SummaryItem {
  readonly key: string;
  readonly label: string;
  readonly value: ReactNode;
}

/** 对话框顶部的只读摘要（画板的浅底信息条）。 */
export function Summary({ items }: { readonly items: readonly SummaryItem[] }): ReactElement {
  const { token } = theme.useToken();
  return (
    <Flex
      gap={24}
      wrap
      style={{
        background: token.colorFillTertiary,
        borderRadius: token.borderRadiusLG,
        padding: `${token.paddingSM}px ${token.padding}px`,
      }}
    >
      {items.map((item) => (
        <Flex key={item.key} vertical gap={4} style={{ minWidth: 120 }}>
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            {item.label}
          </Typography.Text>
          <Typography.Text>{item.value}</Typography.Text>
        </Flex>
      ))}
    </Flex>
  );
}

export interface ReasonFieldProps {
  readonly id: string;
  readonly value: string;
  readonly error: string | undefined;
  readonly extra: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}

export function ReasonField({
  id,
  value,
  error,
  extra,
  disabled,
  onChange,
}: ReasonFieldProps): ReactElement {
  return (
    <Form.Item
      label={t.reasonLabel}
      htmlFor={id}
      required
      validateStatus={error === undefined ? '' : 'error'}
      help={error}
      extra={extra}
    >
      <Input.TextArea
        id={id}
        value={value}
        rows={3}
        aria-required
        disabled={disabled}
        showCount
        count={{ max: REASON_MAX, strategy: rawCodePointLength }}
        placeholder={t.reasonPlaceholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </Form.Item>
  );
}

export interface DialogFooterProps {
  readonly permission: string;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: () => void;
}

/** 底部：左侧「需动态码二次验证 · 所需权限」，右侧【取消】【验证并保存】。 */
export function DialogFooter({
  permission,
  busy,
  onCancel,
  onSubmit,
}: DialogFooterProps): ReactElement {
  const { token } = theme.useToken();
  return (
    <Flex vertical gap={12}>
      <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM, textAlign: 'start' }}>
        <SafetyOutlined aria-hidden style={{ marginInlineEnd: 6 }} />
        {t.stepUpNote(permission)}
      </Typography.Text>
      <Flex justify="end" gap={8}>
        <Button disabled={busy} onClick={onCancel}>
          {t.cancel}
        </Button>
        <Button
          type="primary"
          icon={<SafetyOutlined aria-hidden />}
          disabled={busy}
          onClick={onSubmit}
        >
          {t.submit}
        </Button>
      </Flex>
    </Flex>
  );
}
