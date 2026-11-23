// F1-07ec: the filter bar above a list: exact and fuzzy text, a select, a date range and a number
// range, the advanced ones behind 「更多条件」. Values start from the URL (./query.ts, invalid ones
// ignored); 「查询」 writes the checked values to the URL's own parameters and hands them to the
// caller, 「重置」 clears them. The bar sends no request and keeps no state outside the URL and
// itself.
import { Button, Flex, Input, Select, Typography } from 'antd';
import { useId, useState, type ReactElement, type ReactNode } from 'react';
import { componentsTexts } from '../../texts/components.ts';
import {
  paramNames,
  readQueryValues,
  sanitize,
  writeQueryValues,
  type FilterField,
  type FilterValues,
} from './query.ts';

export interface FilterBarProps {
  readonly fields: readonly FilterField[];
  readonly onSubmit?: (values: Readonly<Record<string, string>>) => void;
}

const t = componentsTexts.filterBar;

function hasAdvancedValue(fields: readonly FilterField[], values: FilterValues): boolean {
  return fields.some(
    (field) =>
      field.advanced === true && paramNames(field).some((name) => Object.hasOwn(values, name)),
  );
}

function Labelled({
  id,
  label,
  children,
}: {
  readonly id?: string;
  readonly label: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <Flex align="center" gap="small">
      {id === undefined ? (
        <Typography.Text>{label}</Typography.Text>
      ) : (
        <label htmlFor={id}>{label}</label>
      )}
      {children}
    </Flex>
  );
}

export function FilterBar({ fields, onSubmit }: FilterBarProps): ReactElement {
  const baseId = useId();
  const [draft, setDraft] = useState<FilterValues>(() => readQueryValues(fields));
  const [advancedOpen, setAdvancedOpen] = useState(() => hasAdvancedValue(fields, draft));
  const hasAdvanced = fields.some((field) => field.advanced === true);

  const valueOf = (name: string): string => (Object.hasOwn(draft, name) ? (draft[name] ?? '') : '');
  const set = (name: string, value: string): void =>
    setDraft((previous) => ({ ...previous, [name]: value }));

  const submit = (): void => {
    const values = sanitize(fields, draft);
    writeQueryValues(fields, values);
    setDraft(values);
    onSubmit?.(values);
  };
  const reset = (): void => {
    writeQueryValues(fields, {});
    setDraft({});
    onSubmit?.({});
  };

  const control = (field: FilterField, index: number): ReactElement => {
    const id = `${baseId}-${String(index)}`;
    switch (field.kind) {
      case 'exact-text':
      case 'fuzzy-text':
        return (
          <Labelled key={id} id={id} label={field.label}>
            <Input
              id={id}
              allowClear
              value={valueOf(field.name)}
              onChange={(event) => set(field.name, event.target.value)}
              onPressEnter={submit}
            />
          </Labelled>
        );
      case 'select': {
        const value = valueOf(field.name);
        return (
          <Labelled key={id} id={id} label={field.label}>
            <Select
              id={id}
              aria-label={field.label}
              allowClear
              virtual={false}
              popupMatchSelectWidth={false}
              value={value === '' ? undefined : value}
              options={field.options.map((option) => ({
                value: option.value,
                label: option.label,
              }))}
              onChange={(next: string | undefined) => set(field.name, next ?? '')}
            />
          </Labelled>
        );
      }
      case 'date-range':
        return (
          <Labelled key={id} label={field.label}>
            <Input
              type="date"
              aria-label={field.start.label}
              value={valueOf(field.start.name)}
              onChange={(event) => set(field.start.name, event.target.value)}
            />
            <Typography.Text type="secondary">{t.rangeSeparator}</Typography.Text>
            <Input
              type="date"
              aria-label={field.end.label}
              value={valueOf(field.end.name)}
              onChange={(event) => set(field.end.name, event.target.value)}
            />
          </Labelled>
        );
      case 'number-range':
        return (
          <Labelled key={id} label={field.label}>
            <Input
              inputMode="decimal"
              aria-label={field.min.label}
              value={valueOf(field.min.name)}
              onChange={(event) => set(field.min.name, event.target.value)}
              onPressEnter={submit}
            />
            <Typography.Text type="secondary">{t.rangeSeparator}</Typography.Text>
            <Input
              inputMode="decimal"
              aria-label={field.max.label}
              value={valueOf(field.max.name)}
              onChange={(event) => set(field.max.name, event.target.value)}
              onPressEnter={submit}
            />
          </Labelled>
        );
    }
  };

  return (
    <Flex wrap align="center" gap="middle">
      {fields.map((field, index) =>
        field.advanced === true && !advancedOpen ? null : control(field, index),
      )}
      <Flex gap="small">
        <Button type="primary" onClick={submit}>
          {t.submit}
        </Button>
        <Button onClick={reset}>{t.reset}</Button>
        {hasAdvanced ? (
          <Button
            type="link"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((open) => !open)}
          >
            {advancedOpen ? t.collapse : t.more}
          </Button>
        ) : null}
      </Flex>
    </Flex>
  );
}
