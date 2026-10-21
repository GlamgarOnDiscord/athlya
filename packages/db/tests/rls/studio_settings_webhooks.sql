-- =====================================================================
-- studio_settings_webhooks.sql: migration 0053 under the real runtime
-- roles (issues #759, #760)
--
-- Asserts that:
--   - an admin writes the settings columns of their studio, a coach and
--     an admin of another studio do not;
--   - webhook endpoints are read and written by the studio's admins only
--     (webhook_endpoints_admin_read / _insert / _update / _delete), and
--     athlya_app cannot read the signing secret;
--   - an outbox insert records one delivery per enabled endpoint of the
--     studio subscribed to the event type, and none for the others;
--   - webhook_deliveries_admin_read scopes deliveries to the studio's
--     admins;
--   - the cron claims a due delivery once (lease), records a failure with
--     a backoff, a success as delivered, and gives up after six attempts;
--   - the cron functions are SECURITY DEFINER, owned by athlya_owner, with
--     a pinned search_path and EXECUTE for athlya_cron only.
-- =====================================================================

BEGIN;
SELECT plan(25);

-- Seed as the migration superuser: two endpoints in studio A (one
-- disabled), one in studio B.
INSERT INTO webhook_endpoints (id, studio_id, url, events, secret, enabled) VALUES
    ('0e530000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'https://hooks.example.com/a',
     ARRAY['reservation.created', 'reservation.cancelled'], 'whsec_' || repeat('a', 43), true),
    ('0e530000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'https://hooks.example.com/off',
     ARRAY['reservation.created'], 'whsec_' || repeat('b', 43), false),
    ('0e530000-0000-4000-8000-000000000003', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'https://hooks.example.com/b',
     ARRAY['reservation.created'], 'whsec_' || repeat('c', 43), true);

-- ---------- hardening ----------

SELECT ok(
    (SELECT bool_and(p.prosecdef
        AND pg_get_userbyid(p.proowner) = 'athlya_owner'
        AND 'search_path=public, pg_temp' = ANY (p.proconfig)
        AND has_function_privilege('athlya_cron', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('athlya_app', p.oid, 'EXECUTE'))
       FROM pg_proc p
      WHERE p.oid IN ('webhook_claim_deliveries(integer)'::regprocedure,
                      'webhook_record_attempt(uuid, integer, text)'::regprocedure)),
    'webhook cron functions: SECURITY DEFINER, athlya_owner, pinned search_path, athlya_cron only'
);
SELECT ok(
    NOT has_column_privilege('athlya_app', 'webhook_endpoints', 'secret', 'SELECT')
    AND has_column_privilege('athlya_app', 'webhook_endpoints', 'url', 'SELECT')
    AND NOT has_column_privilege('athlya_app', 'webhook_deliveries', 'payload', 'SELECT')
    AND NOT has_table_privilege('athlya_app', 'webhook_deliveries', 'INSERT'),
    'athlya_app reads neither the signing secret nor a delivery payload, and writes no delivery'
);
SELECT ok(
    (SELECT p.prosecdef AND 'search_path=public, pg_temp' = ANY (p.proconfig)
       FROM pg_proc p WHERE p.oid = 'enqueue_webhook_deliveries()'::regprocedure),
    'enqueue_webhook_deliveries: SECURITY DEFINER with a pinned search_path'
);

-- ---------- outbox trigger ----------

INSERT INTO outbox (event_id, event_type, payload, occurred_at, studio_id) VALUES
    ('evt-0053-created', 'reservation.created', '{"reservationId":"r1"}'::jsonb, now(), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    ('evt-0053-promoted', 'reservation.promoted', '{"reservationId":"r2"}'::jsonb, now(), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    ('evt-0053-unscoped', 'reservation.created', '{"reservationId":"r3"}'::jsonb, now(), NULL);

SELECT results_eq(
    $$ SELECT endpoint_id, event_id FROM webhook_deliveries ORDER BY event_id $$,
    $$ VALUES ('0e530000-0000-4000-8000-000000000001'::uuid, 'evt-0053-created'::text) $$,
    'outbox trigger: one delivery for the enabled subscribed endpoint of the studio only'
);

SET LOCAL ROLE athlya_app;

-- ---------- admin A ----------

SELECT test_set_tenant('11111111-1111-4111-8111-111111111113', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'admin');

SELECT isnt_empty(
    $$ UPDATE studios SET timezone = 'America/Montreal', city = 'Montréal', country = 'CA',
              contact_email = 'bonjour@example.com'
        WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' RETURNING id $$,
    'studios_admin_update_own: an admin writes the settings of the studio'
);
SELECT throws_ok(
    $$ UPDATE studios SET country = 'France' WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $$,
    '23514', NULL,
    'studios_settings_shape: a country is an ISO 3166 alpha-2 code'
);
SELECT is((SELECT count(*)::int FROM webhook_endpoints), 2,
    'webhook_endpoints_admin_read: an admin reads the endpoints of the studio');
SELECT throws_ok(
    $$ SELECT secret FROM webhook_endpoints $$,
    '42501', NULL,
    'webhook_endpoints: athlya_app cannot select the signing secret'
);
SELECT lives_ok(
    $$ INSERT INTO webhook_endpoints (studio_id, url, events, secret)
       VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'https://hooks.example.com/new',
               ARRAY['auth.user.registered'], 'whsec_' || repeat('d', 43)) $$,
    'webhook_endpoints_admin_insert: an admin registers an endpoint'
);
SELECT throws_ok(
    $$ INSERT INTO webhook_endpoints (studio_id, url, events, secret)
       VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'https://hooks.example.com/x',
               ARRAY['reservation.created'], 'whsec_' || repeat('e', 43)) $$,
    '42501', NULL,
    'webhook_endpoints_admin_insert: an admin cannot register an endpoint for another studio'
);
SELECT throws_ok(
    $$ INSERT INTO webhook_endpoints (studio_id, url, events, secret)
       VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'http://hooks.example.com/plain',
               ARRAY['reservation.created'], 'whsec_' || repeat('f', 43)) $$,
    '23514', NULL,
    'webhook_endpoints_url_https: plain HTTP is refused'
);
SELECT isnt_empty(
    $$ UPDATE webhook_endpoints SET enabled = false
        WHERE id = '0e530000-0000-4000-8000-000000000001' RETURNING id $$,
    'webhook_endpoints_admin_update: an admin disables an endpoint of the studio'
);
SELECT is_empty(
    $$ DELETE FROM webhook_endpoints WHERE id = '0e530000-0000-4000-8000-000000000003' RETURNING id $$,
    'webhook_endpoints_admin_delete: an admin cannot delete an endpoint of another studio'
);
SELECT is((SELECT count(*)::int FROM webhook_deliveries), 1,
    'webhook_deliveries_admin_read: an admin reads the deliveries of the studio');

-- ---------- coach A and admin B ----------

SELECT test_set_tenant('11111111-1111-4111-8111-111111111114', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'coach');

SELECT is_empty(
    $$ UPDATE studios SET city = 'Lyon' WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' RETURNING id $$,
    'studios_admin_update_own: a coach cannot write the settings'
);
SELECT is((SELECT count(*)::int FROM webhook_endpoints), 0,
    'webhook_endpoints_admin_read: a coach reads no endpoint');
SELECT is((SELECT count(*)::int FROM webhook_deliveries), 0,
    'webhook_deliveries_admin_read: a coach reads no delivery');

SELECT test_set_tenant('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'admin');

SELECT is((SELECT count(*)::int FROM webhook_deliveries), 0,
    'webhook_deliveries_admin_read: an admin of another studio reads none of them');

-- ---------- cron ----------

RESET ROLE;
SELECT test_unset_tenant();
UPDATE webhook_endpoints SET enabled = true WHERE id = '0e530000-0000-4000-8000-000000000001';
-- athlya_cron reads deliveries through the functions only; this view
-- (owned by the superuser) lets the test pick the row it records.
CREATE TEMP VIEW webhook_deliveries_view_for_test AS
    SELECT id, next_attempt_at, lease_until FROM webhook_deliveries WHERE event_id = 'evt-0053-created';
GRANT SELECT ON webhook_deliveries_view_for_test TO athlya_cron;
SET LOCAL ROLE athlya_cron;

SELECT results_eq(
    $$ SELECT event_id, url, attempts FROM webhook_claim_deliveries(10) $$,
    $$ VALUES ('evt-0053-created'::text, 'https://hooks.example.com/a'::text, 1) $$,
    'webhook_claim_deliveries: the due delivery is claimed with its URL, attempt 1'
);
SELECT is_empty(
    $$ SELECT * FROM webhook_claim_deliveries(10) $$,
    'webhook_claim_deliveries: a leased delivery is not claimed twice'
);
SELECT is(
    (SELECT webhook_record_attempt(id, 503, 'server error') FROM webhook_deliveries_view_for_test),
    'pending',
    'webhook_record_attempt: a failure keeps the delivery pending for a retry'
);
SELECT ok(
    (SELECT next_attempt_at > now() + interval '50 seconds' AND lease_until IS NULL
       FROM webhook_deliveries_view_for_test),
    'webhook_record_attempt: the retry waits about a minute and the lease is cleared'
);
SELECT is(
    (SELECT webhook_record_attempt(id, 204, NULL) FROM webhook_deliveries_view_for_test),
    NULL,
    'webhook_record_attempt: an attempt on a delivery that is not leased is ignored'
);

RESET ROLE;
UPDATE webhook_deliveries SET attempts = 5, next_attempt_at = now() - interval '1 second';
SET LOCAL ROLE athlya_cron;

SELECT is((SELECT attempts FROM webhook_claim_deliveries(10)), 6,
    'webhook_claim_deliveries: the sixth attempt is counted');
SELECT is(
    (SELECT webhook_record_attempt(id, NULL, 'timeout') FROM webhook_deliveries_view_for_test),
    'failed',
    'webhook_record_attempt: the sixth failure gives the delivery up'
);

SELECT * FROM finish();
ROLLBACK;
