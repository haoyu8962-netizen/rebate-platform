// 「上级与直推」卡（design-hifi AdmUserDetail）：当前上级来自 adminGetUser 的 inviter_user_id
// （无上级如实显示）；契约没有的绑定方式、绑定时间、直推人数不显示。【改上级】只对持 user.inviter
// 的账号显示，【查看直推名单】对持 user.lookup 或 user.list 的账号显示。对话框与抽屉关闭后焦点回
// 触发按钮。
import { SafetyOutlined } from '@ant-design/icons';
import { Button, Card, Descriptions, Flex, theme } from 'antd';
import { useRef, useState, type ReactElement } from 'react';
import { plannedButtonProps, usePlanned } from '../../../components/planned/index.ts';
import { usersTexts } from '../../../texts/users.ts';
import { InviteesDrawer } from './InviteesDrawer.tsx';
import { InviterChangeDialog } from './InviterChangeDialog.tsx';
import { useDialogSwitch } from './useDialogSwitch.ts';
import type { UserRelationsCardProps } from './types.ts';

const t = usersTexts.relations;

export function UserRelationsCard({
  user,
  access,
  onOpenUser,
  onUserChange,
}: UserRelationsCardProps): ReactElement {
  const { token } = theme.useToken();
  const canChange = access.can('user.inviter');
  const canList = access.can('user.lookup') || access.can('user.list');
  // 改上级 / 直推名单接口还没上线（planned，D10-284）：入口置灰并标「功能开发中」，不开对话框与抽屉。
  const changePlanned = usePlanned('adminChangeInviter');
  const listPlanned = usePlanned('adminListInvitees');
  const [listing, setListing] = useState(false);
  const changeTrigger = useRef<HTMLButtonElement>(null);
  // 【改上级】是卸载式对话框（DSX-107）：只在打开时渲染，关闭后由代码把焦点还给触发按钮。
  const change = useDialogSwitch(changeTrigger);
  // 30409 是目标用户自身的状态，按用户保存：对话框卸载后再开仍只给说明。
  const [lockedUser, setLockedUser] = useState<string>();
  const listTrigger = useRef<HTMLButtonElement>(null);
  const inviter = user.inviter_user_id;
  const code = { fontFamily: token.fontFamilyCode } as const;

  const actions =
    canChange || canList ? (
      <Flex gap={12} wrap>
        {canChange ? (
          <Button
            ref={changeTrigger}
            type="link"
            size="small"
            icon={<SafetyOutlined aria-hidden />}
            style={{ paddingInline: 0 }}
            onClick={change.show}
            {...plannedButtonProps(changePlanned)}
          >
            {t.changeInviter}
          </Button>
        ) : null}
        {canList ? (
          <Button
            ref={listTrigger}
            type="link"
            size="small"
            style={{ paddingInline: 0 }}
            onClick={() => setListing(true)}
            {...plannedButtonProps(listPlanned)}
          >
            {t.viewInvitees}
          </Button>
        ) : null}
      </Flex>
    ) : null;

  return (
    <Card title={t.title} extra={actions}>
      <Descriptions
        layout="vertical"
        colon={false}
        column={4}
        items={[
          {
            key: 'inviter',
            label: t.currentInviter,
            children:
              inviter === null ? (
                t.noInviter
              ) : (
                <Button
                  type="link"
                  size="small"
                  style={{
                    paddingInline: 0,
                    height: 'auto',
                    whiteSpace: 'normal',
                    wordBreak: 'break-all',
                    textAlign: 'start',
                    textDecoration: 'underline',
                    ...code,
                  }}
                  onClick={() => onOpenUser(inviter)}
                >
                  {inviter}
                </Button>
              ),
          },
        ]}
      />
      {canChange && !changePlanned && change.open ? (
        <InviterChangeDialog
          user={user}
          onClose={change.close}
          onUserChange={onUserChange}
          locked={lockedUser === user.user_id}
          onLocked={() => setLockedUser(user.user_id)}
        />
      ) : null}
      {canList && !listPlanned ? (
        <InviteesDrawer
          userId={user.user_id}
          open={listing}
          onClose={() => setListing(false)}
          onOpenUser={onOpenUser}
          afterClose={() => listTrigger.current?.focus()}
        />
      ) : null}
    </Card>
  );
}
