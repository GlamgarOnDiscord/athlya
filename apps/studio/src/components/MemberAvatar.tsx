import Image from 'next/image';

import { cn } from '@/lib/utils';

import { initials } from '../app/dashboard/members/members-view';

import type { ReactElement } from 'react';

interface MemberAvatarProps {
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly size?: 'md' | 'lg';
}

const SIZE = {
  md: { px: 32, className: 'size-8 text-xs' },
  lg: { px: 56, className: 'size-14 text-lg' },
};

/** A member's photo, or their initials on the muted surface when they have none. */
export function MemberAvatar({
  displayName,
  avatarUrl,
  size = 'md',
}: MemberAvatarProps): ReactElement {
  const { px, className } = SIZE[size];
  if (avatarUrl !== null && avatarUrl !== '') {
    return (
      <Image
        src={avatarUrl}
        alt=""
        width={px}
        height={px}
        unoptimized
        className={cn('shrink-0 rounded-full border border-border object-cover', className)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid shrink-0 place-items-center rounded-full border border-border bg-muted font-medium',
        className,
      )}
    >
      {initials(displayName)}
    </span>
  );
}
