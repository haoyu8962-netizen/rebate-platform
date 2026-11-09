import type { ReactElement } from 'react';
import { ModalFrame } from './ModalFrame.tsx';
import type { ModalProps } from './types.ts';

/** Bottom sheet (GUIDE §3, a11y spec §4): handle, title, close; only the body scrolls. */
export function Sheet(props: ModalProps): ReactElement | null {
  return <ModalFrame {...props} variant="sheet" />;
}
