import type { ComponentType, ReactElement } from 'react';
import { PlatformBadge, type PlatformBadgeProps } from '../../../../components/platform/index.ts';
import { ClockIcon, ICON, InfoIcon, WarningIcon } from './icons.tsx';
import type { RecordState } from './records-model.ts';

// 记录行部件：平台标识（复用 components/platform 的 PlatformBadge）、状态标签与空态插图。
// 单独成块、不依赖页面块（只用共用图标），由页面与记录块一起取到后经 parts 传给记录列表。

function CheckIcon({ className }: { className: string }): ReactElement {
  return (
    <svg {...ICON} className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </svg>
  );
}

function SearchDocIcon(): ReactElement {
  return (
    <svg {...ICON} strokeWidth={1.6}>
      <path d="M14 20.5H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2V11" />
      <path d="M8.5 8h7M8.5 11.5h4" />
      <circle cx="16.5" cy="16.5" r="2.75" />
      <path d="m18.5 18.5 2 2" />
    </svg>
  );
}

const TAG: Record<RecordState, string> = {
  pending: 'bg-couli-status-pending-background text-couli-status-pending-text',
  auto_tracked: 'bg-couli-background-muted text-couli-text-secondary',
  approved: 'bg-couli-status-success-background text-couli-status-success-text',
  rejected: 'bg-couli-status-warning-background text-couli-status-warning-text',
};

function TagIcon({ state }: { state: RecordState }): ReactElement {
  const className = 'size-couli-3 flex-none';
  switch (state) {
    case 'pending':
      return <ClockIcon className={className} />;
    case 'approved':
      return <CheckIcon className={className} />;
    case 'rejected':
      return <WarningIcon className={className} />;
    default:
      return <InfoIcon className={className} />;
  }
}

/** 记录状态标签（画板 FindOrderRecords-v2：小图标 + 文字的胶囊）。 */
function StatusTag({ state, label }: { state: RecordState; label: string }): ReactElement {
  return (
    <span
      className={`inline-flex min-h-couli-component-tag-min-height flex-none items-center gap-couli-1 rounded-couli-pill px-couli-2 text-couli-caption leading-couli-caption ${TAG[state]}`}
    >
      <TagIcon state={state} />
      <span>{label}</span>
    </span>
  );
}

export interface RecordParts {
  Badge: ComponentType<PlatformBadgeProps>;
  InfoIcon: ComponentType<{ className: string }>;
  StatusTag: ComponentType<{ state: RecordState; label: string }>;
  SearchDocIcon: ComponentType;
}

export const recordParts: RecordParts = {
  Badge: PlatformBadge,
  InfoIcon,
  StatusTag,
  SearchDocIcon,
};
