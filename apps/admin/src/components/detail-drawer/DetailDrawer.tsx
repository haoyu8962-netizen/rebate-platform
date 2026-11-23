// F1-07ec: a detail panel sliding in from the right (antd Drawer). Fields are shown group by
// group; a null or missing value shows the placeholder. `open` is controlled: closing only tells
// the caller, which decides whether the drawer goes away (open=false renders nothing).
import { Descriptions, Drawer } from 'antd';
import type { ReactElement, ReactNode } from 'react';
import { componentsTexts } from '../../texts/components.ts';

export interface DetailDrawerProps {
  readonly open: boolean;
  readonly title: string;
  readonly groups: readonly {
    readonly key: string;
    readonly title: string;
    readonly fields: readonly {
      readonly key: string;
      readonly label: string;
      readonly value: ReactNode;
    }[];
  }[];
  readonly onClose: () => void;
}

function shown(value: ReactNode): ReactNode {
  return value === null || value === undefined || value === ''
    ? componentsTexts.placeholder
    : value;
}

export function DetailDrawer({
  open,
  title,
  groups,
  onClose,
}: DetailDrawerProps): ReactElement | null {
  // Closed means gone at once (as StepUpModal): no leave animation keeps a stale dialog around.
  if (!open) return null;
  return (
    <Drawer open title={title} placement="right" onClose={onClose} destroyOnHidden>
      {groups.map((group) => (
        <Descriptions
          key={group.key}
          title={group.title}
          column={1}
          size="small"
          items={group.fields.map((field) => ({
            key: field.key,
            label: field.label,
            children: shown(field.value),
          }))}
        />
      ))}
    </Drawer>
  );
}
