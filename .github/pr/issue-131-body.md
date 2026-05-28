## Summary

- API : Turnstile déjà sur `password-reset/request` + `confirm` — tests auth ajoutés.
- Web : gate client + token state sur `ForgotPasswordForm` ; widget Turnstile sur `ResetPasswordForm`.
- Docs/runbook/checklist ops alignés (issue #131 / audit S7).

Closes #131

## Test plan

- [x] `pnpm --filter @athlya/api test -- src/__tests__/routes/auth.test.ts`
- [x] `node scripts/verify-turnstile-password-reset-checklist.mjs`
- [ ] E2E manuel prod après provisioning Turnstile secrets
