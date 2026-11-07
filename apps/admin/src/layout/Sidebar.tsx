import { Layout, Menu, Typography, type MenuProps } from 'antd';
import { useLayoutEffect } from 'react';
import { Link } from 'react-router';
import type { AdminMenuGroup } from '../resources/index.ts';
import { shellTexts } from '../texts/shell.ts';
import { SIDEBAR_ID, resetSidebar, sidebarOpen, useSidebarState } from './sidebar-state.ts';
import { usePublishedAdminTier } from './viewport.ts';

export interface SidebarProps {
  readonly groups: readonly AdminMenuGroup[];
  readonly activeId: string | undefined;
}

const SIDER_WIDTH = 220;

/**
 * Brand plus the permitted menu groups, in catalogue order (antd Layout.Sider + Menu), docked
 * beside the content. The top bar's toggle hides it (the content then takes the full width) and
 * shows it again.
 */
export function Sidebar({ groups, activeId }: SidebarProps) {
  const tier = usePublishedAdminTier();
  const current = useSidebarState();
  const open = sidebarOpen(current, tier);

  // A newly mounted shell starts with the sidebar open.
  useLayoutEffect(() => {
    resetSidebar();
  }, []);

  const items: MenuProps['items'] = groups.map((group) => ({
    type: 'group',
    key: group.key,
    // Group titles stay headings (screen-reader navigation by heading).
    label: <h2 className="admin-nav-heading">{group.label}</h2>,
    children: group.items.map((item) => ({
      key: item.id,
      label: (
        <Link to={`/${item.id}`} aria-current={item.id === activeId ? 'page' : undefined}>
          {item.label}
        </Link>
      ),
    })),
  }));

  return (
    <Layout.Sider
      id={SIDEBAR_ID}
      theme="light"
      width={SIDER_WIDTH}
      className="admin-sider"
      style={open ? undefined : { display: 'none' }}
    >
      <div className="admin-brand">
        <span className="admin-brand-logo" aria-hidden="true">
          {shellTexts.brandLogo}
        </span>
        <Typography.Text strong>{shellTexts.brand}</Typography.Text>
      </div>
      <nav aria-label={shellTexts.mainNavigation}>
        <Menu
          mode="inline"
          items={items}
          selectedKeys={activeId === undefined ? [] : [activeId]}
          className="admin-nav-menu"
        />
      </nav>
    </Layout.Sider>
  );
}
