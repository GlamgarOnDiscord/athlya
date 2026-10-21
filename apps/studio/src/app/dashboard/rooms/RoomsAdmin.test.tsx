/**
 * Rooms settings: a room already deleted elsewhere counts as deleted, a
 * second click cannot send a second request, and validation errors are
 * shown in the reader's language rather than as library text.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../lib/api/client';
import { LocaleProvider } from '../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../lib/i18n/t';

import { RoomsAdmin } from './RoomsAdmin';

import type { Room } from '@athlya/shared/schemas/api';

const t = createTranslator('fr');
const get = vi.fn();
const del = vi.fn();
const post = vi.fn();

vi.mock('../../../lib/auth/AuthContext', () => ({
  useAuth: () => ({ accessToken: 'jwt' }),
}));

vi.mock('../../../lib/api/buildClient', () => ({
  useApiClient: () => ({ get, post, patch: vi.fn(), del }),
}));

const STUDIO_A = {
  id: 'a0510000-0000-4000-8000-0000000000a1',
  studioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Studio A',
  capacity: 20,
} as unknown as Room;

function renderRooms(): void {
  render(
    <LocaleProvider locale="fr">
      <RoomsAdmin />
    </LocaleProvider>,
  );
}

async function openDeleteDialog(): Promise<void> {
  renderRooms();
  fireEvent.click(
    await screen.findByRole('button', { name: `${t('studio.rooms.delete')}: Studio A` }),
  );
}

beforeEach(() => {
  get.mockReset();
  del.mockReset();
  post.mockReset();
  get.mockResolvedValue({ items: [STUDIO_A] });
});

afterEach(() => {
  cleanup();
});

describe('<RoomsAdmin /> delete', () => {
  it('closes the dialog and refreshes when the room is already gone', async () => {
    del.mockRejectedValue(
      new ApiError('gone', 404, {
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        code: 'not_found',
      }),
    );
    await openDeleteDialog();
    fireEvent.click(screen.getByRole('button', { name: t('studio.rooms.deleteConfirm.confirm') }));
    await waitFor(() => {
      expect(screen.queryByText(t('studio.rooms.deleteConfirm.title'))).toBeNull();
    });
    expect(screen.queryByText(t('studio.rooms.errors.generic'))).toBeNull();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('disables both buttons while the request runs and sends it once', async () => {
    let settle: () => void = () => undefined;
    del.mockReturnValue(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    await openDeleteDialog();
    const confirm = screen.getByRole('button', {
      name: t('studio.rooms.deleteConfirm.confirm'),
    });
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(confirm.hasAttribute('disabled')).toBe(true);
    });
    expect(screen.getByRole('button', { name: t('common.cancel') }).hasAttribute('disabled')).toBe(
      true,
    );
    fireEvent.click(confirm);
    expect(del).toHaveBeenCalledTimes(1);
    await act(async () => {
      settle();
      await Promise.resolve();
    });
  });

  it('keeps the dialog open with an error on any other failure', async () => {
    del.mockRejectedValue(new Error('network'));
    await openDeleteDialog();
    fireEvent.click(screen.getByRole('button', { name: t('studio.rooms.deleteConfirm.confirm') }));
    expect(await screen.findByText(t('studio.rooms.errors.generic'))).toBeDefined();
  });
});

describe('<RoomsAdmin /> validation', () => {
  it('shows localized messages for a blank name and an out of range capacity', async () => {
    renderRooms();
    fireEvent.click(await screen.findByRole('button', { name: t('studio.rooms.create') }));
    fireEvent.change(screen.getByLabelText(t('studio.rooms.fields.name')), {
      target: { value: '   ' },
    });
    fireEvent.change(screen.getByLabelText(t('studio.rooms.fields.capacity')), {
      target: { value: '900' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('studio.rooms.dialog.createSubmit') }));
    expect(await screen.findByText(t('studio.rooms.errors.nameInvalid'))).toBeDefined();
    expect(screen.getByText(t('studio.rooms.errors.capacityInvalid'))).toBeDefined();
    expect(post).not.toHaveBeenCalled();
  });
});
