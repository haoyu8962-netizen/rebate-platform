// New-value control of one configuration item, chosen by the row's value_type: InputNumber
// (string mode: the text is checked as typed, never rounded), Switch, Select over the server's
// options only, Input, or a JSON TextArea. Validation uses the same parser as the save.
import { Form, Input, InputNumber, Select, Switch, Typography, theme } from 'antd';
import { useState, type ReactElement, type ReactNode } from 'react';
import type { SelectProps } from 'antd';
import { configCenterTexts as t } from '../../texts/config-center.ts';
import {
  unchangedInput,
  fenLabel,
  isMoney,
  parseInput,
  sameValue,
  unitOf,
  valueLabel,
  type ConfigRow,
  type FieldValue,
} from './model.ts';

export interface ValueFieldProps {
  readonly row: ConfigRow;
  /** Form field path of the control. */
  readonly name: string | readonly string[];
  readonly label: ReactNode;
  /** Batch rows: an empty control leaves the item as it is; a single edit needs a new value. */
  readonly optional?: boolean;
  readonly disabled?: boolean;
  readonly hint?: boolean;
}

function hintOf(row: ConfigRow, raw: FieldValue): string {
  if (isMoney(row)) {
    const parsed = parseInput(row, raw);
    return t.hints.money(parsed.ok ? fenLabel(parsed.value) : null);
  }
  return t.hints[row.value_type];
}

/**
 * A refused value: antd lists field errors without a role, so the message is rendered as an
 * alert element (the form shows an element message as is) and screen readers announce it.
 */
function refusal(text: string): Error {
  const error = new Error(text);
  Object.defineProperty(error, 'message', { value: <span role="alert">{text}</span> });
  return error;
}

/**
 * Select over the registered options only: typed text never filters, adds or keeps a value, and
 * the arrow keys open the list (as the mouse does).
 */
function EnumSelect(props: SelectProps<string>): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <Select<string>
      {...props}
      open={open}
      filterOption={false}
      onOpenChange={setOpen}
      onKeyDown={(event) => {
        if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) setOpen(true);
      }}
    />
  );
}

export function ValueField({
  row,
  name,
  label,
  optional = false,
  disabled = false,
  hint = true,
}: ValueFieldProps): ReactElement {
  const { token } = theme.useToken();
  const path = typeof name === 'string' ? name : [...name];
  const rules = [
    {
      validator: (_: unknown, raw: FieldValue): Promise<void> => {
        if (optional && unchangedInput(row, raw)) return Promise.resolve();
        const parsed = parseInput(row, raw);
        if (!parsed.ok) return Promise.reject(refusal(parsed.message));
        if (!optional && sameValue(parsed.value, row.value))
          return Promise.reject(refusal(t.validation.same));
        return Promise.resolve();
      },
    },
  ];
  const form = Form.useFormInstance();
  const current = Form.useWatch(path, form) as FieldValue;
  const extra = hint ? (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {hintOf(row, current)}
    </Typography.Text>
  ) : undefined;
  const common = { name: path, label, rules, extra } as const;
  switch (row.value_type) {
    case 'number': {
      if (isMoney(row))
        // Amounts keep the exact typed text (an InputNumber would normalise 12.340 to 12.34);
        // parseYuan checks it and @couli/money converts it to whole fen.
        return (
          <Form.Item {...common}>
            <Input
              role="spinbutton"
              inputMode="decimal"
              autoComplete="off"
              disabled={disabled}
              placeholder={valueLabel(row, row.value)}
              suffix={t.drawer.yuan}
            />
          </Form.Item>
        );
      const unit = unitOf(row.key);
      return (
        <Form.Item {...common}>
          <InputNumber<string>
            stringMode
            controls={false}
            keyboard={false}
            disabled={disabled}
            placeholder={valueLabel(row, row.value)}
            {...(unit === '' ? {} : { suffix: unit })}
            style={{ width: '100%' }}
          />
        </Form.Item>
      );
    }
    case 'boolean':
      return (
        <Form.Item {...common} valuePropName="checked">
          <Switch disabled={disabled} />
        </Form.Item>
      );
    case 'enum':
      return (
        <Form.Item {...common}>
          <EnumSelect
            disabled={disabled}
            options={(row.options ?? []).map((option) => ({ value: option, label: option }))}
          />
        </Form.Item>
      );
    case 'string':
      return (
        <Form.Item {...common}>
          <Input disabled={disabled} />
        </Form.Item>
      );
    case 'object':
      return (
        <Form.Item {...common}>
          <Input.TextArea
            disabled={disabled}
            autoSize={{ minRows: 3, maxRows: 10 }}
            style={{ fontFamily: token.fontFamilyCode, fontSize: 12 }}
          />
        </Form.Item>
      );
  }
}
