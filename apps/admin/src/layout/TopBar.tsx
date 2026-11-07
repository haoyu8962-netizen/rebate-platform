import { MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons';
import { Breadcrumb, Button, Flex, Layout, Tag, Typography, theme } from 'antd';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { AdminSearch } from '../components/search/index.ts';
import type { AdminEnvironment } from '../shell-options.ts';
import { shellTexts } from '../texts/shell.ts';
import { SIDEBAR_ID, setSidebarOpen, sidebarOpen, useSidebarState } from './sidebar-state.ts';
import { useAdminTier } from './viewport.ts';

export interface TopBarProps {
  readonly crumbs: readonly string[];
  readonly environment: AdminEnvironment;
  readonly displayName: string;
  /** A returned promise keeps 【退出】 disabled until the request ends (success, failure, timeout). */
  readonly onLogout: () => void | Promise<unknown>;
  /** Shows the top-bar search (pages with permission keys only); opens a user hit's detail. */
  readonly onOpenUser?: ((userId: string) => void) | undefined;
}

/**
 * Sidebar toggle and breadcrumb on the left; search, environment tag, account and logout on the
 * right (antd Layout.Header).
 */
export function TopBar({ crumbs, environment, displayName, onLogout, onOpenUser }: TopBarProps) {
  const [loggingOut, setLoggingOut] = useState(false);
  // The click handler reads this, so a second click in the same frame is ignored too.
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const tier = useAdminTier();
  const sidebar = useSidebarState();
  const open = sidebarOpen(sidebar, tier);
  const narrow = tier === 'narrow';
  const { token } = theme.useToken();
  // Narrow tier: the bar grows instead of pushing its controls off screen (both groups may wrap).
  const narrowHeader: CSSProperties = {
    height: 'auto',
    lineHeight: 'normal',
    paddingBlock: token.paddingSM,
    paddingInline: token.padding,
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function logout(): void {
    if (inFlight.current) return;
    const request = onLogout();
    if (request === undefined) return;
    inFlight.current = true;
    setLoggingOut(true);
    const settle = (): void => {
      inFlight.current = false;
      if (mounted.current) setLoggingOut(false);
    };
    void request.then(settle, settle);
  }

  return (
    <Layout.Header role="banner" className="admin-header" style={narrow ? narrowHeader : undefined}>
      <Flex
        align="center"
        justify="space-between"
        gap="small"
        wrap={narrow}
        style={narrow ? undefined : { height: '100%' }}
      >
        <Flex align="center" gap="small" style={{ minWidth: 0 }}>
          <Button
            type="text"
            icon={open ? <MenuFoldOutlined aria-hidden /> : <MenuUnfoldOutlined aria-hidden />}
            aria-label={open ? shellTexts.collapseSidebar : shellTexts.expandSidebar}
            aria-expanded={open}
            aria-controls={SIDEBAR_ID}
            onClick={() => setSidebarOpen(tier, !open)}
          />
          <Breadcrumb
            aria-label={shellTexts.breadcrumb}
            items={crumbs.map((crumb, index) => ({ key: index, title: crumb }))}
          />
        </Flex>
        <Flex align="center" gap="small" wrap={narrow}>
          {onOpenUser === undefined ? null : <AdminSearch onOpenUser={onOpenUser} />}
          {environment === 'production' ? null : (
            <Tag color="warning" bordered={false}>
              {shellTexts.nonProductionEnvironment}
            </Tag>
          )}
          <Typography.Text>{displayName}</Typography.Text>
          <Button
            type="link"
            autoInsertSpace={false}
            disabled={loggingOut}
            aria-busy={loggingOut || undefined}
            onClick={logout}
          >
            {shellTexts.logout}
          </Button>
        </Flex>
      </Flex>
    </Layout.Header>
  );
}
