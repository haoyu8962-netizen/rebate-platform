// F1-07ec: a status value as an antd Tag. The caller's mapping decides the label and the antd
// colour (semantic values such as success / error); a value the mapping does not own (including
// inherited names such as `toString`) shows as is, in antd's default colour.
import { Tag } from 'antd';
import type { ReactElement } from 'react';

type StatusStyle = { readonly label: string; readonly color: string };

export interface StatusTagProps {
  readonly value: string;
  readonly mapping: Readonly<Partial<Record<string, StatusStyle>>>;
}

export function StatusTag({ value, mapping }: StatusTagProps): ReactElement {
  const style = Object.hasOwn(mapping, value) ? mapping[value] : undefined;
  if (style === undefined) return <Tag>{value}</Tag>;
  return <Tag color={style.color}>{style.label}</Tag>;
}
