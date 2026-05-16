# Testing Library — Framework Audit

*Last updated: 2026-05-14*

## Version Status

| | Value |
|---|---|
| **@testing-library/react** | ^16.1.0 (current) |
| **@testing-library/jest-dom** | ^6.6.3 (current) |
| **@testing-library/user-event** | Not installed |
| **jsdom** | ^26.0.0 (current) |
| **Scope** | apps/web only |

---

## Assessment

All installed versions are current. No breaking changes pending.

- `@testing-library/react` 16.x supports React 19 (including Server Component stubs)
- `@testing-library/jest-dom` 6.x is current with full Vitest compatibility
- `jsdom` 26.x supports modern Web APIs (Fetch, ReadableStream, AbortSignal, etc.)

---

## Missing: `@testing-library/user-event`

The project tests interactions with `fireEvent` (from `@testing-library/react`). The recommended approach is `userEvent` which simulates real user behavior:

```ts
// CURRENT — low-level, no browser simulation
import { fireEvent } from '@testing-library/react';
fireEvent.click(button);
fireEvent.change(input, { target: { value: 'test' } });

// BETTER — simulates real user interaction (focus, keyboard, pointer events)
import userEvent from '@testing-library/user-event';
const user = userEvent.setup();
await user.click(button);
await user.type(input, 'test');
```

`userEvent` fires the full event sequence (pointerdown, mousedown, focus, mouseup, pointerup, click) instead of a single synthetic event. This catches more bugs in event handlers and aligns with how Testing Library recommends testing behavior.

```bash
pnpm add -D @testing-library/user-event --filter @athlya/web
```

---

## Best Practices (Applied Correctly)

The project follows Testing Library's query priority:
1. `getByRole` — accessible elements
2. `getByLabelText` — form fields
3. `getByText` — visible text
4. Avoids `getByTestId` where possible

---

## React 19 — Server Components

Testing Library 16 does not support rendering actual Server Components (they require Node.js async rendering that jsdom cannot emulate). The correct approach:

```ts
// DO NOT try to render Server Components in jsdom tests
// Instead, test their output by mocking the async data fetching:

vi.mock('../lib/data', () => ({
    fetchClasses: vi.fn().mockResolvedValue([...]),
}));

// Then test the Client Components that consume the data
render(<ClassesList initialClasses={mockClasses} />);
```

For Server Component output validation, use `@cloudflare/vitest-pool-workers` or integration tests.

---

## Accessibility Testing

Consider adding `@axe-core/react` for automated accessibility checks in component tests:

```bash
pnpm add -D @axe-core/vitest --filter @athlya/web
```

```ts
import { toHaveNoViolations } from '@axe-core/vitest';
expect.extend(toHaveNoViolations);

test('ClassCard has no accessibility violations', async () => {
    const { container } = render(<ClassCard {...props} />);
    await expect(container).toHaveNoViolations();
});
```

Given the WCAG AA requirement, automated axe checks catch regressions early.

---

## Checklist

- [x] Testing Library 16 (React 19 compatible)
- [x] jest-dom 6 for DOM assertions
- [x] jsdom 26 for browser environment
- [x] Query priority followed (getByRole first)
- [ ] Add `@testing-library/user-event` (replace `fireEvent` for user interactions)
- [ ] Evaluate `@axe-core/vitest` for automated accessibility regression testing

## Sources

- https://testing-library.com/docs/react-testing-library/intro
- https://testing-library.com/docs/user-event/intro
- https://github.com/nicholasbailey/axe-core-vitest
