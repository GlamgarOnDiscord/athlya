'use client';

/**
 * Rooms settings (issue #748): the list of the studio's rooms with their
 * optional capacity, and the create, edit and delete dialogs. Rooms come
 * from `GET /v1/classes/rooms`; writes go to the admin-only
 * `POST / PATCH / DELETE /v1/classes/rooms`.
 */
import {
  CreateRoomRequestSchema,
  UpdateRoomRequestSchema,
  type Room,
} from '@athlya/shared/schemas/api';
import { CircleNotchIcon, DoorOpenIcon, PencilSimpleIcon, TrashIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useId, useMemo, useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { PageHeader } from '../../../components/shell/PageHeader';
import { useApiClient } from '../../../lib/api/buildClient';
import { fetchRooms } from '../../../lib/api/rooms';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { createTranslator, type Translator } from '../../../lib/i18n/t';
import { newIdempotencyKey } from '../../../lib/idempotency';
import { problemCodeOf } from '../classes/class-form';

import type { ApiClient } from '../../../lib/api/client';

type ListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly rooms: ReadonlyArray<Room> }
  | { readonly kind: 'error' };

type Editor = { readonly kind: 'create' } | { readonly kind: 'edit'; readonly room: Room };

export function RoomsAdmin(): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const { accessToken } = useAuth();
  const getToken = useCallback(() => accessToken, [accessToken]);
  const client = useApiClient(getToken);

  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [nonce, setNonce] = useState(0);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [deleting, setDeleting] = useState<Room | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchRooms(client).then(
      (rooms) => !cancelled && setList({ kind: 'ready', rooms }),
      () => !cancelled && setList({ kind: 'error' }),
    );
    return () => {
      cancelled = true;
    };
  }, [client, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const confirmDelete = useCallback(async () => {
    if (deleting === null) return;
    setDeleteError(null);
    try {
      await client.del(`/v1/classes/rooms/${deleting.id}`);
      setDeleting(null);
      refresh();
    } catch {
      setDeleteError(t('studio.rooms.errors.generic'));
    }
  }, [client, deleting, refresh, t]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('studio.rooms.title')}
        subtitle={t('studio.rooms.subtitle')}
        actions={
          <Button onClick={() => setEditor({ kind: 'create' })}>{t('studio.rooms.create')}</Button>
        }
      />

      {list.kind === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      ) : null}

      <div className="rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('studio.rooms.columns.name')}</TableHead>
              <TableHead>{t('studio.rooms.columns.capacity')}</TableHead>
              <TableHead>
                <span className="sr-only">{t('studio.rooms.edit')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.kind === 'loading'
              ? Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={`skeleton-${String(i)}`}>
                    <TableCell>
                      <Skeleton className="h-4 w-32" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-16" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="ml-auto h-7 w-16" />
                    </TableCell>
                  </TableRow>
                ))
              : null}
            {list.kind === 'ready' && list.rooms.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="py-8 text-center whitespace-normal">
                  <span className="flex flex-col items-center gap-2 text-muted-foreground">
                    <DoorOpenIcon aria-hidden="true" className="size-6" />
                    {t('studio.rooms.empty')}
                  </span>
                </TableCell>
              </TableRow>
            ) : null}
            {list.kind === 'ready'
              ? list.rooms.map((room) => (
                  <TableRow key={room.id}>
                    <TableCell className="font-medium">{room.name}</TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {room.capacity === null
                        ? t('studio.rooms.noCapacity')
                        : t('studio.rooms.capacityValue', { count: room.capacity })}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`${t('studio.rooms.edit')}: ${room.name}`}
                          onClick={() => setEditor({ kind: 'edit', room })}
                        >
                          <PencilSimpleIcon aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-destructive hover:text-destructive"
                          aria-label={`${t('studio.rooms.delete')}: ${room.name}`}
                          onClick={() => {
                            setDeleteError(null);
                            setDeleting(room);
                          }}
                        >
                          <TrashIcon aria-hidden="true" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              : null}
          </TableBody>
        </Table>
      </div>

      {editor !== null ? (
        <RoomDialog
          editor={editor}
          client={client}
          t={t}
          onClose={(saved) => {
            setEditor(null);
            if (saved) refresh();
          }}
        />
      ) : null}

      {deleting !== null ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('studio.rooms.deleteConfirm.title')}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">{t('studio.rooms.deleteConfirm.body')}</p>
            {deleteError !== null ? (
              <p role="alert" className="text-sm text-destructive">
                {deleteError}
              </p>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleting(null)}>
                {t('common.cancel')}
              </Button>
              <Button variant="destructive" onClick={() => void confirmDelete()}>
                {t('studio.rooms.deleteConfirm.confirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

function RoomDialog({
  editor,
  client,
  t,
  onClose,
}: {
  readonly editor: Editor;
  readonly client: ApiClient;
  readonly t: Translator;
  readonly onClose: (saved: boolean) => void;
}): ReactElement {
  const id = useId();
  const initial = editor.kind === 'edit' ? editor.room : null;
  const [name, setName] = useState(initial?.name ?? '');
  const [capacity, setCapacity] = useState(
    initial?.capacity === null || initial === null ? '' : String(initial.capacity),
  );
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (): Promise<void> => {
    setErrors({});
    setFailure(null);
    const body = { name, capacity: capacity.trim() === '' ? null : Number(capacity) };
    const parsed =
      editor.kind === 'create'
        ? CreateRoomRequestSchema.safeParse(body)
        : UpdateRoomRequestSchema.safeParse(body);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.map(String).join('.');
        next[key] ??= issue.message;
      }
      setErrors(next);
      return;
    }
    setPending(true);
    try {
      const init = { headers: { 'Idempotency-Key': newIdempotencyKey() } };
      if (editor.kind === 'create') await client.post('/v1/classes/rooms', parsed.data, init);
      else await client.patch(`/v1/classes/rooms/${editor.room.id}`, parsed.data, init);
      onClose(true);
    } catch (err) {
      setFailure(
        problemCodeOf(err) === 'room_name_taken'
          ? t('studio.rooms.errors.nameTaken')
          : t('studio.rooms.errors.generic'),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose(false);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editor.kind === 'create'
              ? t('studio.rooms.dialog.createTitle')
              : t('studio.rooms.dialog.editTitle')}
          </DialogTitle>
        </DialogHeader>
        <form
          id={`${id}-form`}
          noValidate
          aria-busy={pending}
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-name`}>{t('studio.rooms.fields.name')}</Label>
            <Input
              id={`${id}-name`}
              required
              maxLength={80}
              value={name}
              aria-invalid={errors['name'] !== undefined}
              onChange={(e) => setName(e.target.value)}
            />
            {errors['name'] !== undefined ? (
              <span role="alert" className="text-sm text-destructive">
                {errors['name']}
              </span>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-capacity`}>{t('studio.rooms.fields.capacity')}</Label>
            <Input
              id={`${id}-capacity`}
              type="number"
              min={1}
              max={500}
              value={capacity}
              aria-invalid={errors['capacity'] !== undefined}
              aria-describedby={`${id}-capacity-help`}
              onChange={(e) => setCapacity(e.target.value)}
              className="w-32"
            />
            <p id={`${id}-capacity-help`} className="text-xs text-muted-foreground">
              {t('studio.rooms.fields.capacityHelp')}
            </p>
            {errors['capacity'] !== undefined ? (
              <span role="alert" className="text-sm text-destructive">
                {errors['capacity']}
              </span>
            ) : null}
          </div>
          {failure !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
        </form>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => onClose(false)}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={`${id}-form`} disabled={pending}>
            {pending ? (
              <CircleNotchIcon className="mr-2 size-4 animate-spin" aria-hidden="true" />
            ) : null}
            {editor.kind === 'create'
              ? t('studio.rooms.dialog.createSubmit')
              : t('studio.rooms.dialog.editSubmit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
