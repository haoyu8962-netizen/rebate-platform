// F1-07ec: status tabs above a list. A tab with a positive count carries it as a badge; zero or
// no count shows the label only. The selected tab follows `activeKey`; a click only reports the
// tab's key to the caller.
import { Badge, Flex, Tabs } from 'antd';
import type { ReactElement } from 'react';

export interface StatusTabsProps {
  readonly items: readonly {
    readonly key: string;
    readonly label: string;
    readonly count?: number;
  }[];
  readonly activeKey: string;
  readonly onChange: (key: string) => void;
}

export function StatusTabs({ items, activeKey, onChange }: StatusTabsProps): ReactElement {
  return (
    <Tabs
      activeKey={activeKey}
      onChange={onChange}
      items={items.map((item) => ({
        key: item.key,
        label:
          item.count !== undefined && item.count > 0 ? (
            <Flex align="center" gap="small">
              <span>{item.label}</span>
              <Badge count={item.count} overflowCount={Number.MAX_SAFE_INTEGER} />
            </Flex>
          ) : (
            item.label
          ),
      }))}
    />
  );
}
