import type { ReactElement } from 'react';

export interface HelpTipProps {
  readonly text: string;
}

export function HelpTip(props: HelpTipProps): ReactElement {
  void props;
  throw new Error('NotImplemented: HelpTip');
}
