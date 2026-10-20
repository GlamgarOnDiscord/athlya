# UI direction for the screen refresh

_Status: agreed direction for the screen PRs that follow the shared theme (#706). Last updated: 2026-10-19._

This page fixes the patterns before the per-app screen PRs start, so each one answers "what does it look like" the same way. It describes patterns in words only. The reference links at the bottom point to public gallery pages for mood and are **links only**: nothing is scraped, copied or traced from them, and no image, illustration or asset from those sites enters the repo.

## Ground rules for every screen PR

- **Tokens only.** Colours, radii, spacing and type come from `@athlya/shared/tokens`, through `@athlya/shared/theme.css` on web and studio and the NativeWind preset (`apps/mobile/theme/preset.ts`) on mobile. No hex value, no Tailwind palette colour (`bg-amber-500`, `text-emerald-400`) in a component: map it to a semantic token (`warning`, `success`) or add a token first.
- **Light and dark.** next-themes puts `.light` or `.dark` on `<html>`; `system` is the default. Every screen is checked in both. A theme switch control is not shipped yet; it goes in the account menu, not the main navigation.
- **Contrast is tested.** `packages/shared/tests/token-contrast.test.ts` pins every token pair at WCAG 2.2 AA (4.5:1 text, 3:1 large text and UI). A new pair a screen introduces gets a line there.
- **Brand.** The logo (`<AthlyaLogo />`, `apps/web/public/images/athlya-logo*.png`) and its palette (ink `#0A0A0A`, volt `#D7FF3A`, white) are unchanged. Volt is never text on a light surface. Chart marks use ink on light and volt on dark (`chartColors`).
- **Keep the contracts.** Every `data-testid` and accessible name stays; E2E and axe suites are the gate. No `style=""` attribute rendered on the server (strict CSP, see `apps/web/src/lib/csp.ts`): dynamic values go through CSS variables set from CSSOM, as `.class-card-capacity-bar` does.
- **Motion is optional.** Every animation respects `prefers-reduced-motion` and never carries information on its own.

## Known contrast gaps to close in the screen PRs

The first three are recorded as `KNOWN_GAPS` in the contrast test, with a floor that may not drop; the fourth is a component habit, not a token value:

| Gap                                               | Where it shows                      | Direction                                                                             |
| ------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------- |
| `input` on `background` (1.23:1 light, 1.28 dark) | web/studio form field boundary      | Auth and onboarding PRs: add a field-boundary token at 3:1 and use it for `border-*`. |
| `border` on `background` (same)                   | mobile `TextField` boundary         | Same token on mobile.                                                                 |
| `primary` on `background`, light (2.77:1)         | checked checkbox fill, capacity bar | Keep the brand fill; add a 3:1 outline or icon so the state does not rely on fill.    |
| focus ring drawn at 50% opacity (`ring-ring/50`)  | shadcn/ui components                | Use the ring at full strength; the token itself now passes (4.10:1 light).            |

## Patterns

### Dashboard grid (member home, studio dashboard)

A responsive card grid: one column on phones, two from `md`, a twelve-column grid from `lg` where cards span 3, 4, 6 or 12. The first row holds at most four summary tiles (next class, weekly sessions, streak, credits or plan), each with one number, one label and one link. Below, wide cards for the progression chart and the upcoming bookings. Cards use the `card` surface, `rounded-lg`, `p-6` (`spacing.lg`) and no shadow above `shadow-sm`. Loading states are skeletons the size of the final card, never spinners in the grid.

### Onboarding flow (first launch, studio setup)

A short stepper of three to five steps, one decision per screen, with a visible "step 2 of 4" text and a progress bar exposed with `aria-valuenow`. Back is always available, skip is offered on optional steps, and answers persist as a draft so a reload does not lose them. Mobile uses full-screen steps with the primary action pinned to the bottom safe area. The last step lands on the dashboard with the result of the onboarding visible, not on a "done" page.

### Progress cards (progression)

One metric per card: current value in large tabular numerals (`tabular-nums`), the change against the previous period as text ("+5 kg since last month"), never colour alone, and a small sparkline using the chart tokens. Strength and cardio share the card shape. Empty state explains what to log to see the card fill, with one action.

### Booking calendar (classes)

A week strip (seven days, today marked, horizontal scroll on mobile) above a day list of class cards, rather than a month grid: members book within days, not weeks. Each card shows time, duration, coach, place and the capacity bar, with the state in text (booked, waitlist position, full). The week strip is a single tab stop with arrow-key navigation (roving `tabindex`). The booking result is announced in an `aria-live="polite"` region and the toast. Studio keeps a denser week view for planning, same tokens.

### Auth (sign-in, register, password reset)

A single centred column, max width about 24rem, with the logo lockup above the form (ink on light, volt or white on dark, per the brand guide). Labels above fields, errors under the field in `destructive` text and summarised at the top for screen readers. Turnstile stays where it is, with the CSP nonce. Social or passkey options sit below the main form, separated by a labelled divider. No marketing illustration on these pages.

### Coach (AI coach answers)

A conversation layout: the question pinned above a streamed answer, which renders progressively and is announced politely, with a visible stop control while streaming. Suggested follow-up questions as chips under the answer. Sources or the data the answer used appear in a collapsible section. The answer area keeps a readable measure (about 70 characters) and never uses volt for text on light.

## Allowed component sources

Copying source code from these is allowed; each copy gets a row in [`docs/third-party-ui.md`](../third-party-ui.md) and its colours are replaced with tokens.

| Source                                                  | Licence                                  | Use                                                                                  |
| ------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------ |
| [shadcn/ui](https://ui.shadcn.com)                      | MIT                                      | Base components; already in `components/ui` (style `base-nova`, Base UI primitives). |
| [Magic UI](https://magicui.design)                      | MIT                                      | Animated accents (number tickers, marquees) on marketing and dashboard tiles.        |
| [Aceternity UI](https://ui.aceternity.com)              | Its own free licence terms; read per use | Occasional hero or showcase effects; check the terms before each copy.               |
| [21st.dev](https://21st.dev)                            | Per component; check each one's licence  | Community components; only those with an explicit permissive licence.                |
| [Radix primitives](https://www.radix-ui.com/primitives) | MIT                                      | Accessible primitives where Base UI has no equivalent.                               |
| [Motion](https://motion.dev)                            | MIT                                      | Animation; mind the no-`style=""` CSP rule on server-rendered initial states.        |

Icons and illustrations, free licences only: [Phosphor](https://phosphoricons.com) (MIT, already used, `@phosphor-icons/react`), [Heroicons](https://heroicons.com) (MIT), [unDraw](https://undraw.co) (its own free licence; recolour to tokens).

Mobile equivalents: [react-native-reusables](https://reactnativereusables.com) (MIT, shadcn/ui ported to NativeWind), [Moti](https://moti.fyi) (MIT) on [Reanimated](https://docs.swmansion.com/react-native-reanimated/) (MIT).

## Reference links (mood only, not copied)

Public search and gallery pages; links were not fetched or verified from this environment.

- Dribbble: [fitness dashboard](https://dribbble.com/search/fitness-dashboard), [booking calendar](https://dribbble.com/search/booking-calendar)
- Behance: [fitness app](https://www.behance.net/search/projects?search=fitness%20app)
- Pinterest: [fitness app UI](https://www.pinterest.com/search/pins/?q=fitness%20app%20ui)
- Mobbin: [app pattern library](https://mobbin.com) (onboarding and auth flows of shipped apps)
- Awwwards: [site gallery](https://www.awwwards.com/websites/)
