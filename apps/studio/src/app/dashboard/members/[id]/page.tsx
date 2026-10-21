/**
 * `/dashboard/members/[id]`: a member file (issue #746), studio admins only.
 *
 * Server entry that hands the member id to the client `<MemberFile>`,
 * which reads `GET /v1/members/:id`. `<RequireAdmin>` keeps coaches out
 * and the API answers anyone but an admin with 403.
 */
import { MemberFile } from './MemberFile';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Fiche membre' };

export default async function MemberFilePage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}): Promise<ReactElement> {
  const { id } = await params;
  return <MemberFile memberId={id} />;
}
