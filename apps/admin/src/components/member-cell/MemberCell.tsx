// F1-07ec: the member of a row: nickname (opens that UID's detail through the caller) and the UID
// with its own copy button; copying never opens the detail. No member (not attributed) shows only
// the placeholder text, with nothing to click.
import { Button, Typography } from 'antd';
import type { ReactElement } from 'react';
import { componentsTexts } from '../../texts/components.ts';
import { CopyText } from '../copy-text/index.ts';

type Member = { readonly uid: string; readonly nickname: string };

export interface MemberCellProps {
  readonly member: Member | null;
  readonly onOpenDetail: (uid: string) => void;
}

export function MemberCell({ member, onOpenDetail }: MemberCellProps): ReactElement {
  if (member === null)
    return (
      <Typography.Text type="secondary">{componentsTexts.memberCell.unattributed}</Typography.Text>
    );
  const { uid, nickname } = member;
  return (
    <div>
      <div>
        <Button type="link" size="small" autoInsertSpace={false} onClick={() => onOpenDetail(uid)}>
          {nickname}
        </Button>
      </div>
      <div>
        <Typography.Text type="secondary">
          <CopyText text={uid} />
        </Typography.Text>
      </div>
    </div>
  );
}
