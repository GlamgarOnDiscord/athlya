/**
 * `/dashboard/classes/[id]`: a class with its roster (issue #746).
 *
 * Server entry that hands the class id to the client `<ClassRoster>`,
 * which reads `GET /v1/classes/:id/roster` with the signed-in token. The
 * page is open to studio admins and, through `<RequireAdmin>`'s coach
 * routes, to coaches; the API answers a coach of another class with 403.
 */
import { ClassRoster } from './ClassRoster';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Cours' };

export default async function ClassRosterPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}): Promise<ReactElement> {
  const { id } = await params;
  return <ClassRoster classId={id} />;
}
