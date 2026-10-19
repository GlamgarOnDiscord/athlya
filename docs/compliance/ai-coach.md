# AI coach — RGPD note (Epic 21)

Issue **#644**. The AI coach (`GET /v1/coach`, `POST /v1/coach/ask`, web `/me/coach`) sends a
summary of a member's training data to Mistral AI to generate advice. This note records what is
sent, what is kept, and how the member opts in.

## Opt-in

- The feature is behind the `ai-coach` feature flag, **OFF by default**
  ([`feature-flags.md`](../operations/feature-flags.md)). With the flag off, no endpoint calls the
  provider and the web hides the coach.
- With the flag on, each request also needs the member's **`consents.thirdParty`** opt-in
  (Requirement 3.3). Without it, `POST /v1/coach/ask` answers 403
  `third_party_consent_required` **before** any training data is read. The member grants or
  withdraws it at any time in the consents form on `/me`.
- The web page states what is sent before the member asks a question.

## What is sent to the provider

Built by `buildCoachContext` (`packages/ai-coach/src/context.ts`), the only code path that turns
stored data into prompt input:

| Sent                                                                                             | Never sent                                  |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| The member's question (≤ 500 characters, typed by the member)                                    | User, studio and session identifiers        |
| Last 30 days: totals (sessions, volume), sessions per ISO week                                   | E-mail, display name, avatar, role, studio  |
| Up to 8 most trained exercises: name, session count, volume, best estimated 1RM                  | Session notes (free text)                   |
| Up to 15 most recent sessions: UTC day, duration, up to 10 exercises with sets, reps, top weight | Time of day, location, device, IP, consents |

Exercise names are free text, so they are cleaned first: control characters dropped, e-mail
addresses and runs of 6+ digits masked, length cut to 40 characters. Property tests
(`packages/ai-coach/tests/context.test.ts`) check that identifiers and notes never reach the
context, whatever the stored rows.

Workout data can reveal health-adjacent information. The prompt only carries training load, and
the page asks members not to type health details they want to keep private. Before the flag is
opened to members, add the processing to the register and the DPIA
([`dpia-template.md`](../security/dpia-template.md)).

## Provider and transfer

- Mistral AI (a French company), through `@ai-sdk/mistral`. The adapter calls the provider's
  default endpoint (`https://api.mistral.ai/v1`) unless `MISTRAL_BASE_URL` is set. Athlya does
  not claim EU-only processing until the operator has confirmed where the Mistral account
  processes and stores requests. If Mistral offers a regional (EU) endpoint for the account, set
  `MISTRAL_BASE_URL` to it on both Workers before enabling the flag in production.
- Sign the Mistral DPA and archive it with the other processor agreements before enabling the
  flag in production.
- The operator must check the account's data-retention settings in the Mistral console before
  enabling the flag: zero data retention (ZDR) where the plan offers it, otherwise the retention
  period for abuse monitoring, and the training opt-out. The API terms in force at signature
  govern how long Mistral keeps inputs and outputs and whether they may be used for training.

## Retention at Athlya

- Neither the question nor the advice is stored: no database row, no log line with the content,
  `Cache-Control: no-store` on both responses, the streamed one included (issue #675). A client
  that disconnects mid-stream aborts the provider call.
- The only state kept is the daily quota counter in Redis, `coach:quota:<UTC day>:<userId>`,
  which expires at the next UTC midnight.
- Error logs record the error code and class only, never the prompt or the provider message.

## Erasure and access

- Nothing to erase on account deletion beyond the quota counter, which expires within a day.
- The RGPD export (`/v1/members/me/export`) has nothing extra to include: no coach data is kept.

## Operator checklist

- [ ] DPA signed with Mistral AI and archived; register entry added.
- [ ] Mistral console: processing region, retention (ZDR where available) and training opt-out
      checked; `MISTRAL_BASE_URL` set to the regional endpoint if one applies.
- [ ] `MISTRAL_API_KEY` set on the gateway and reservations Workers
      ([`rotate-secrets.md`](../runbooks/rotate-secrets.md#mistral_api_key)).
- [ ] `ai-coach` flag opened by phase, staff allow-list first.
