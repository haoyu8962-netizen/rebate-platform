import type { AccessControl } from '../../../providers/access-control/index.ts';
import type { UserDetail } from '../model.ts';

export interface UserRelationsCardProps {
  readonly user: UserDetail;
  readonly access: AccessControl;
  readonly onOpenUser: (userId: string) => void;
  readonly onUserChange: (user: UserDetail) => void;
}

/** 卸载式：父组件只在打开时渲染对话框，关闭即卸载，焦点由父组件还给触发按钮。 */
export interface RelationChangeDialogProps {
  readonly user: UserDetail;
  readonly onClose: () => void;
  readonly onUserChange: (user: UserDetail) => void;
}

/** 【改上级】：30409 的说明由父组件保存，对话框卸载后再开仍只给说明。 */
export interface InviterChangeDialogProps extends RelationChangeDialogProps {
  readonly locked: boolean;
  readonly onLocked: () => void;
}

export interface InviteesDrawerProps {
  readonly userId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onOpenUser: (userId: string) => void;
  /** 关闭动画结束后调用（触发按钮据此取回焦点）。 */
  readonly afterClose?: () => void;
}
