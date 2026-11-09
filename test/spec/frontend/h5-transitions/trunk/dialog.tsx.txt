import type { ReactElement } from 'react';
import { ModalFrame } from './ModalFrame.tsx';
import type { ModalProps } from './types.ts';

/** Centred modal card (GUIDE §3, §6): title → close → scrolling body → fixed button row. */
export function Dialog(props: ModalProps): ReactElement | null {
  return <ModalFrame {...props} variant="dialog" />;
}
