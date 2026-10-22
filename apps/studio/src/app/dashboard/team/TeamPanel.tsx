'use client';

/**
 * `/dashboard/team` client surface (issue #756): the studio team with each
 * person's role, the pending invitations, and for the studio owner the
 * invite, change-role and remove actions. A manager reads the same page
 * without the actions. Reads `GET /v1/studios/me/team`; writes the team
 * routes, which the API reserves to admins.
 */
import { ASSIGNABLE_ROLES, can, type StaffRole } from '@athlya/shared/roles';
import { InviteTeamMemberRequestSchema } from '@athlya/shared/schemas/api';
import { CheckIcon, CopyIcon, EnvelopeSimpleIcon, UserPlusIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useId, useMemo, useState, type ReactElement } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

import { MemberAvatar } from '../../../components/MemberAvatar';
import { PageHeader } from '../../../components/shell/PageHeader';
import { useApiClient } from '../../../lib/api/buildClient';
import { ApiError } from '../../../lib/api/client';
import { useAuth } from '../../../lib/auth/AuthContext';
import { inviteLink } from '../../../lib/auth/invite';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { createTranslator, type Translator } from '../../../lib/i18n/t';

import type {
  InviteTeamMemberResponse,
  TeamInvitation,
  TeamMember,
  TeamResponse,
} from '@athlya/shared/schemas/api';

const TEAM_PATH = '/v1/studios/me/team';

const CONTROL =
  'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm';

/** The roles in the order the page describes them, widest first. */
const ROLE_ORDER: readonly StaffRole[] = ['admin', 'manager', 'accueil', 'coach'];

type Load = { kind: 'loading' } | { kind: 'ready'; team: TeamResponse } | { kind: 'error' };

function errorText(err: unknown, t: Translator): string {
  if (err instanceof ApiError && err.problem?.code === 'cannot_change_own_role') {
    return t('studio.team.errors.ownRole');
  }
  return t('errors.generic');
}

export function TeamPanel(): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const { accessToken, user } = useAuth();
  const getToken = useCallback(() => accessToken, [accessToken]);
  const client = useApiClient(getToken);
  const manages = user !== null && can(user.role, 'team.manage');

  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let cancelled = false;
    void client.get<TeamResponse>(TEAM_PATH).then(
      (team) => !cancelled && setLoad({ kind: 'ready', team }),
      () => !cancelled && setLoad({ kind: 'error' }),
    );
    return () => {
      cancelled = true;
    };
  }, [client, version]);

  const changeRole = useCallback(
    async (member: TeamMember, role: StaffRole | 'member') => {
      setBusyId(member.id);
      try {
        await client.patch(`${TEAM_PATH}/members/${member.id}`, { role });
        toast.success(
          role === 'member'
            ? t('studio.team.removedToast', { name: member.displayName })
            : t('studio.team.roleChangedToast', {
                name: member.displayName,
                role: t(`studio.members.role.${role}`),
              }),
        );
        refresh();
      } catch (err) {
        toast.error(errorText(err, t));
      } finally {
        setBusyId(null);
      }
    },
    [client, refresh, t],
  );

  const revoke = useCallback(
    async (invitation: TeamInvitation) => {
      setBusyId(invitation.id);
      try {
        await client.del(`${TEAM_PATH}/invitations/${invitation.id}`);
        toast.success(t('studio.team.revokedToast', { email: invitation.email }));
        refresh();
      } catch (err) {
        toast.error(errorText(err, t));
      } finally {
        setBusyId(null);
      }
    },
    [client, refresh, t],
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('studio.team.title')}
        subtitle={t(manages ? 'studio.team.subtitle' : 'studio.team.subtitleReadOnly')}
        actions={
          manages ? (
            <Button size="lg" onClick={() => setInviting(true)}>
              <UserPlusIcon aria-hidden="true" data-icon="inline-start" />
              {t('studio.team.invite.open')}
            </Button>
          ) : undefined
        }
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-6 xl:col-span-8">
          <section
            aria-labelledby="team-members"
            className="flex flex-col rounded-lg border border-border bg-card"
          >
            <h2
              id="team-members"
              className="border-b border-border px-4 py-3 text-sm font-semibold"
            >
              {t('studio.team.members.title')}
              {load.kind === 'ready' ? (
                <span className="ml-2 font-normal text-muted-foreground">
                  {load.team.members.length}
                </span>
              ) : null}
            </h2>
            {load.kind === 'loading' ? (
              <div className="flex flex-col gap-3 p-4">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : load.kind === 'error' ? (
              <p role="alert" className="p-4 text-sm text-destructive">
                {t('studio.team.loadError')}
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {load.team.members.map((member) => (
                  <MemberRow
                    key={member.id}
                    member={member}
                    self={member.id === user?.id}
                    manages={manages}
                    busy={busyId === member.id}
                    t={t}
                    onRole={(role) => {
                      void changeRole(member, role);
                    }}
                    onRemove={() => setRemoving(member)}
                  />
                ))}
              </ul>
            )}
          </section>

          {load.kind === 'ready' && load.team.invitations.length > 0 ? (
            <section
              aria-labelledby="team-invitations"
              className="flex flex-col rounded-lg border border-border bg-card"
            >
              <h2
                id="team-invitations"
                className="border-b border-border px-4 py-3 text-sm font-semibold"
              >
                {t('studio.team.invitations.title')}
              </h2>
              <ul className="flex flex-col divide-y divide-border">
                {load.team.invitations.map((invitation) => (
                  <li
                    key={invitation.id}
                    className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span
                        aria-hidden="true"
                        className="grid size-8 shrink-0 place-items-center rounded-full border border-border text-muted-foreground"
                      >
                        <EnvelopeSimpleIcon className="size-4" />
                      </span>
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-medium">{invitation.email}</span>
                        <span className="text-xs text-muted-foreground">
                          {t('studio.team.invitations.expires', {
                            date: new Intl.DateTimeFormat(locale, {
                              day: 'numeric',
                              month: 'long',
                            }).format(new Date(invitation.expiresAt)),
                          })}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{t(`studio.members.role.${invitation.role}`)}</Badge>
                      {manages ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busyId === invitation.id}
                          onClick={() => {
                            void revoke(invitation);
                          }}
                        >
                          {t('studio.team.invitations.revoke')}
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <section
          aria-labelledby="team-roles"
          className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 xl:col-span-4 xl:self-start"
        >
          <h2 id="team-roles" className="text-sm font-semibold">
            {t('studio.team.roles.title')}
          </h2>
          <dl className="flex flex-col gap-3">
            {ROLE_ORDER.map((role) => (
              <div key={role} className="flex flex-col gap-0.5">
                <dt className="text-sm font-medium">{t(`studio.members.role.${role}`)}</dt>
                <dd className="text-sm text-muted-foreground">{t(`studio.team.roles.${role}`)}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      {inviting ? (
        <InviteDialog
          t={t}
          onClose={(changed) => {
            setInviting(false);
            if (changed) refresh();
          }}
          invite={(body) => client.post<InviteTeamMemberResponse>(`${TEAM_PATH}/invitations`, body)}
        />
      ) : null}

      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('studio.team.remove.title', { name: removing?.displayName ?? '' })}
            </DialogTitle>
            <DialogDescription>{t('studio.team.remove.body')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (removing !== null) void changeRole(removing, 'member');
                setRemoving(null);
              }}
            >
              {t('studio.team.remove.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MemberRow({
  member,
  self,
  manages,
  busy,
  t,
  onRole,
  onRemove,
}: {
  readonly member: TeamMember;
  readonly self: boolean;
  readonly manages: boolean;
  readonly busy: boolean;
  readonly t: Translator;
  readonly onRole: (role: StaffRole) => void;
  readonly onRemove: () => void;
}): ReactElement {
  const selectId = useId();
  const editable = manages && !self;
  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <MemberAvatar displayName={member.displayName} avatarUrl={member.avatarUrl} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">
            {member.displayName}
            {self ? (
              <span className="ml-2 font-normal text-muted-foreground">{t('studio.team.you')}</span>
            ) : null}
          </span>
          {member.email !== null ? (
            <span className="truncate text-xs text-muted-foreground">{member.email}</span>
          ) : null}
        </div>
      </div>
      {editable ? (
        <div className="flex items-center gap-2">
          <label htmlFor={selectId} className="sr-only">
            {t('studio.team.roleOf', { name: member.displayName })}
          </label>
          <select
            id={selectId}
            className={`${CONTROL} sm:w-40`}
            value={member.role}
            disabled={busy}
            onChange={(e) => {
              const role = ASSIGNABLE_ROLES.find((r) => r === e.target.value);
              if (role !== undefined && role !== member.role) onRole(role);
            }}
          >
            {ROLE_ORDER.map((role) => (
              <option key={role} value={role}>
                {t(`studio.members.role.${role}`)}
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm" disabled={busy} onClick={onRemove}>
            {t('studio.team.remove.open')}
          </Button>
        </div>
      ) : (
        <Badge
          variant={member.role === 'admin' ? 'default' : 'secondary'}
          className="self-start sm:self-auto"
        >
          {t(`studio.members.role.${member.role}`)}
        </Badge>
      )}
    </li>
  );
}

type InviteStep =
  | { kind: 'form'; error: string | null; pending: boolean }
  | { kind: 'link'; email: string; link: string; copied: boolean };

function InviteDialog({
  t,
  invite,
  onClose,
}: {
  readonly t: Translator;
  readonly invite: (body: { email: string; role: StaffRole }) => Promise<InviteTeamMemberResponse>;
  readonly onClose: (changed: boolean) => void;
}): ReactElement {
  const emailId = useId();
  const roleId = useId();
  const linkId = useId();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<StaffRole>('coach');
  const [step, setStep] = useState<InviteStep>({ kind: 'form', error: null, pending: false });
  const [changed, setChanged] = useState(false);

  const submit = async (): Promise<void> => {
    const parsed = InviteTeamMemberRequestSchema.safeParse({ email, role });
    if (!parsed.success) {
      setStep({ kind: 'form', error: t('studio.team.invite.invalidEmail'), pending: false });
      return;
    }
    setStep({ kind: 'form', error: null, pending: true });
    try {
      const outcome = await invite(parsed.data);
      setChanged(true);
      if (outcome.outcome === 'role_updated') {
        toast.success(
          t('studio.team.roleChangedToast', {
            name: outcome.member.displayName,
            role: t(`studio.members.role.${outcome.member.role}`),
          }),
        );
        onClose(true);
        return;
      }
      setStep({
        kind: 'link',
        email: outcome.invitation.email,
        link: inviteLink(window.location.origin, outcome.token),
        copied: false,
      });
    } catch (err) {
      setStep({ kind: 'form', error: errorText(err, t), pending: false });
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !(step.kind === 'form' && step.pending)) onClose(changed);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {step.kind === 'form'
              ? t('studio.team.invite.title')
              : t('studio.team.invite.linkTitle')}
          </DialogTitle>
          <DialogDescription>
            {step.kind === 'form'
              ? t('studio.team.invite.body')
              : t('studio.team.invite.linkBody', { email: step.email })}
          </DialogDescription>
        </DialogHeader>

        {step.kind === 'form' ? (
          <form
            id="team-invite"
            noValidate
            aria-busy={step.pending}
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={emailId}>{t('studio.team.invite.email')}</Label>
              <Input
                id={emailId}
                type="email"
                autoComplete="off"
                maxLength={254}
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={roleId}>{t('studio.team.invite.role')}</Label>
              <select
                id={roleId}
                className={CONTROL}
                value={role}
                onChange={(e) => {
                  const next = ASSIGNABLE_ROLES.find((r) => r === e.target.value);
                  if (next !== undefined) setRole(next);
                }}
              >
                {ROLE_ORDER.map((r) => (
                  <option key={r} value={r}>
                    {t(`studio.members.role.${r}`)}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{t(`studio.team.roles.${role}`)}</p>
            </div>
            {step.error !== null ? (
              <p role="alert" className="text-sm text-destructive">
                {step.error}
              </p>
            ) : null}
          </form>
        ) : (
          <div className="flex flex-col gap-2">
            <Label htmlFor={linkId}>{t('studio.team.invite.link')}</Label>
            <div className="flex gap-2">
              <Input
                id={linkId}
                readOnly
                value={step.link}
                className="min-w-0 flex-1 font-mono text-sm"
              />
              <Button
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(step.link).then(
                    () => setStep({ ...step, copied: true }),
                    () => toast.error(t('errors.generic')),
                  );
                }}
              >
                {step.copied ? (
                  <CheckIcon aria-hidden="true" data-icon="inline-start" />
                ) : (
                  <CopyIcon aria-hidden="true" data-icon="inline-start" />
                )}
                {step.copied ? t('studio.team.invite.copied') : t('studio.team.invite.copy')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('studio.team.invite.linkOnce')}</p>
          </div>
        )}

        <DialogFooter>
          {step.kind === 'form' ? (
            <>
              <Button variant="outline" disabled={step.pending} onClick={() => onClose(changed)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" form="team-invite" disabled={step.pending}>
                {t('studio.team.invite.submit')}
              </Button>
            </>
          ) : (
            <Button onClick={() => onClose(true)}>{t('studio.team.invite.done')}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
