/**
 * Component tests for the studio program authoring UI (task 24.3):
 * list + filter, the editor (create / edit with the optimistic lock),
 * accessible validation, and archive.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTranslator } from '../../../lib/i18n/t';

import { ProgramEditor } from './ProgramEditor';
import { ProgramsAdmin } from './ProgramsAdminList';

import type { ApiClient } from '../../../lib/api/client';
import type { ProgramDetail, ProgramSummary } from '@athlya/shared/schemas/api';

const t = createTranslator('en');

const SUMMARY: ProgramSummary = {
  id: '0b000000-0000-4000-8000-000000000001',
  studioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  title: 'Strength 101',
  description: null,
  status: 'published',
  version: 2,
  weekCount: 1,
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
  archivedAt: null,
};

const DETAIL: ProgramDetail = {
  ...SUMMARY,
  weeks: [
    {
      weekNumber: 1,
      title: null,
      workouts: [
        {
          id: '0d000000-0000-4000-8000-000000000001',
          dayNumber: 1,
          title: 'Squat',
          notes: null,
          exercises: [{ name: 'Back squat', sets: 5, reps: 5 }],
        },
      ],
    },
  ],
};

function fakeClient(overrides: Partial<Record<keyof ApiClient, ReturnType<typeof vi.fn>>> = {}) {
  return {
    get: vi.fn().mockResolvedValue({ items: [] }),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    del: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('<ProgramsAdmin />', () => {
  it('lists programs with their status and refetches on filter change', async () => {
    const client = fakeClient({
      get: vi.fn().mockResolvedValue({
        items: [SUMMARY, { ...SUMMARY, id: 'p2', title: 'Old plan', status: 'archived' }],
      }),
    });
    render(<ProgramsAdmin client={client as unknown as ApiClient} t={t} locale="en" />);

    expect(await screen.findByText('Strength 101')).toBeDefined();
    const row = screen.getByText('Old plan').closest('tr');
    if (row === null) throw new Error('row missing');
    expect(within(row).getByText('Archived')).toBeDefined();
    expect(within(row).queryByRole('button')).toBeNull();
    expect(client.get).toHaveBeenCalledWith('/v1/programs');

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'draft' } });
    await waitFor(() => expect(client.get).toHaveBeenCalledWith('/v1/programs?status=draft'));
  });

  it('shows the empty state', async () => {
    const client = fakeClient();
    render(<ProgramsAdmin client={client as unknown as ApiClient} t={t} locale="en" />);
    expect(await screen.findByText(t('studio.programs.empty'))).toBeDefined();
  });

  it('archives after confirmation with an idempotency key and announces it', async () => {
    const client = fakeClient({ get: vi.fn().mockResolvedValue({ items: [SUMMARY] }) });
    render(<ProgramsAdmin client={client as unknown as ApiClient} t={t} locale="en" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Archive Strength 101' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));

    await waitFor(() =>
      expect(client.post).toHaveBeenCalledWith(
        `/v1/programs/${SUMMARY.id}/archive`,
        undefined,
        expect.objectContaining({
          headers: expect.objectContaining({ 'Idempotency-Key': expect.any(String) }),
        }),
      ),
    );
    expect((await screen.findByRole('status')).textContent).toBe(t('studio.programs.archived'));
  });

  it('opens the editor with the full program and saves with its version', async () => {
    const get = vi.fn((path: string) =>
      Promise.resolve(path === `/v1/programs/${SUMMARY.id}` ? DETAIL : { items: [SUMMARY] }),
    );
    const client = fakeClient({ get });
    render(<ProgramsAdmin client={client as unknown as ApiClient} t={t} locale="en" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Strength 101' }));
    const title = (await screen.findByLabelText('Title')) as HTMLInputElement;
    expect(title.value).toBe('Strength 101');
    fireEvent.change(title, { target: { value: 'Strength 102' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(client.patch).toHaveBeenCalledWith(
        `/v1/programs/${SUMMARY.id}`,
        expect.objectContaining({ version: 2, title: 'Strength 102' }),
        expect.anything(),
      ),
    );
    expect((await screen.findByRole('status')).textContent).toBe(t('studio.programs.saved'));
  });
});

describe('<ProgramEditor />', () => {
  it('builds a week with a workout and exercise, then creates the program', async () => {
    const client = fakeClient();
    const onDone = vi.fn();
    render(
      <ProgramEditor
        mode={{ kind: 'create' }}
        client={client as unknown as ApiClient}
        t={t}
        onDone={onDone}
      />,
    );

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Strength 101' } });
    expect(screen.getByRole('group', { name: 'Week 1' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '+ Add workout' }));
    const workout = screen.getByRole('group', { name: 'Day 1 workout' });
    fireEvent.change(within(workout).getByLabelText('Workout title'), {
      target: { value: 'Squat' },
    });
    fireEvent.change(within(workout).getByLabelText('Exercise 1'), {
      target: { value: 'Back squat' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(true));
    expect(client.post).toHaveBeenCalledWith(
      '/v1/programs',
      {
        title: 'Strength 101',
        status: 'draft',
        weeks: [
          {
            weekNumber: 1,
            workouts: [
              {
                dayNumber: 1,
                title: 'Squat',
                exercises: [{ name: 'Back squat', sets: 3, reps: 10 }],
              },
            ],
          },
        ],
      },
      expect.objectContaining({
        headers: expect.objectContaining({ 'Idempotency-Key': expect.any(String) }),
      }),
    );
  });

  it('lists validation errors in a focused alert and flags the fields', async () => {
    const client = fakeClient();
    render(
      <ProgramEditor
        mode={{ kind: 'create' }}
        client={client as unknown as ApiClient}
        t={t}
        onDone={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '+ Add workout' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(t('studio.programs.editor.errorsTitle'));
    expect(alert.textContent).toContain('Week 1 · Day 1 workout');
    expect(document.activeElement).toBe(alert);
    const title = screen.getByLabelText('Title');
    expect(title.getAttribute('aria-invalid')).toBe('true');
    expect(client.post).not.toHaveBeenCalled();
  });

  it('names remove buttons after the row they remove', () => {
    render(
      <ProgramEditor
        mode={{ kind: 'edit', program: DETAIL }}
        client={fakeClient() as unknown as ApiClient}
        t={t}
        onDone={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Remove exercise 1 of the day 1 workout of week 1' }),
    ).toBeDefined();
    expect(
      screen.getByRole('button', { name: 'Remove the day 1 workout of week 1' }),
    ).toBeDefined();
  });

  it('reports a version conflict from the API', async () => {
    const client = fakeClient({
      patch: vi.fn().mockRejectedValue({ status: 409, problem: { code: 'version_conflict' } }),
    });
    const onDone = vi.fn();
    render(
      <ProgramEditor
        mode={{ kind: 'edit', program: DETAIL }}
        client={client as unknown as ApiClient}
        t={t}
        onDone={onDone}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      t('studio.programs.editor.errors.versionConflict'),
    );
    expect(onDone).not.toHaveBeenCalled();
  });
});
