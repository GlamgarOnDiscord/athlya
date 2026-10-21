'use client';

/**
 * Room filter of a planning screen (issue #748): every room, or one.
 * Hidden while the studio has no room. Shared by the admin classes page
 * and the coach schedule.
 */
import { useId, type ReactElement } from 'react';

import type { Translator } from '../../../lib/i18n/t';
import type { Room } from '@athlya/shared/schemas/api';

export function RoomFilter({
  rooms,
  value,
  t,
  onChange,
}: {
  readonly rooms: ReadonlyArray<Room>;
  readonly value: string | null;
  readonly t: Translator;
  readonly onChange: (roomId: string | null) => void;
}): ReactElement | null {
  const id = useId();
  if (rooms.length === 0) return null;
  return (
    <>
      <label htmlFor={id} className="sr-only">
        {t('studio.classes.planning.roomFilter')}
      </label>
      <select
        id={id}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        className="h-8 max-w-40 min-w-0 rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:border-input dark:bg-input/30"
      >
        <option value="">{t('studio.classes.planning.allRooms')}</option>
        {rooms.map((room) => (
          <option key={room.id} value={room.id}>
            {room.name}
          </option>
        ))}
      </select>
    </>
  );
}
