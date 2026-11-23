import type { ReactElement } from 'react';

type Member = { readonly uid: string; readonly nickname: string };

export interface MemberCellProps {
  readonly member: Member | null;
  readonly onOpenDetail: (uid: string) => void;
}

export function MemberCell(props: MemberCellProps): ReactElement {
  void props;
  throw new Error('NotImplemented: MemberCell');
}
