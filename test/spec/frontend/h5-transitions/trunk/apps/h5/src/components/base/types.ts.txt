import type { ReactNode } from 'react';

export interface ComponentAction {
  label: string;
  onClick: () => void;
}

export interface StateProps {
  title: string;
  description: string;
  icon: ReactNode;
  action?: ComponentAction;
  autoFocusAction?: boolean;
}

/**
 * Mount into a sibling of the caller's inert/aria-hidden application container.
 * The caller owns hiding/restoring the background; the component owns focus.
 * Parts: modal-backdrop, modal-body, modal-actions; Sheet also has sheet-handle.
 * dismissible=false disables Escape and backdrop dismissal. closeOnBackdrop=false
 * disables backdrop dismissal independently for financial/verification flows.
 * Explicit close and action buttons remain available in either mode.
 */
export interface ModalProps {
  open: boolean;
  title: string;
  description?: string;
  closeLabel: string;
  onClose: () => void;
  children?: ReactNode;
  primaryAction?: ComponentAction;
  secondaryAction?: ComponentAction;
  dismissible?: boolean;
  closeOnBackdrop?: boolean;
  portalContainer?: HTMLElement;
}
