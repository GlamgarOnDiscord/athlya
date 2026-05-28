## Summary

- Unknown `event.type` on queue consumers → log `queue.unknown_event_type`, redirect `EVENTS_DLQ`, ack primary (plus retry si DLQ down).
- Catalogue partagé `known-event-types.ts` (notifications + RGPD).
- Alerte Axiom A15 + query + runbook event-bus.

Closes #132

## Test plan

- [x] `pnpm --filter @athlya/api test -- src/__tests__/reject-unknown-queue-event.test.ts src/__tests__/known-event-types.test.ts src/__tests__/queue-cascade.test.ts`
- [x] `node scripts/verify-unknown-queue-event-checklist.mjs`
