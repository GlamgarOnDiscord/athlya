/**
 * Pure-TS audit log anonymisation — Sprint 13 / Slice 13.3 (Epic
 * B10.2).
 *
 * Pattern alternatif au SECURITY DEFINER `anonymize_user_audit()`
 * de la migration 0003. Cette implémentation TypeScript :
 *
 *   1. Exécute deux UPDATE paramétrés sur `audit_log` qui scrubent
 *      les colonnes PII (`actor_id`, `metadata.email`,
 *      `metadata.userAgent`, `metadata.ip`) tout en préservant le
 *      row count pour la traçabilité forensique.
 *
 *   2. N'a PAS besoin de la fonction SECURITY DEFINER ; l'identité
 *      d'exécution est celle du role connecté (`CRON_DB_URL`,
 *      typiquement `athlya_cron`).
 *
 * Pré-requis schema (migration `0009_audit_cron_grants.sql` à
 * livrer en slice future si jamais Neon refuse le `BYPASSRLS` du
 * 0003) :
 *
 *     -- audit_log doit autoriser UPDATE par `athlya_cron`
 *     CREATE POLICY audit_anonymize_cron ON audit_log
 *         FOR UPDATE TO athlya_cron USING (true);
 *     GRANT UPDATE (actor_id, metadata) ON audit_log TO athlya_cron;
 *
 * Tant que cette migration n'est pas en place, l'`anonymizeOne`
 * de la slice 13.2 reste branché sur le SECURITY DEFINER existant
 * (qui fonctionnera dès que migration 0003 sera appliquée via une
 * fenêtre de superuser temporaire).
 *
 * Ce module est exposé en alternative — le runner tente
 * `anonymizeOne` (SECURITY DEFINER), et si l'opérateur opte pour
 * le pattern pure-TS, il câble `anonymizeViaSql` à la place.
 *
 * Algorithme par utilisateur :
 *   - 1 UPDATE sur les rows où `actor_id = $userId`
 *   - 1 UPDATE sur les rows dont `metadata->>'subjectUserId' = $userId`
 *   - Les deux UPDATE écrivent `metadata = jsonb_strip_nulls(metadata
 *     - 'email' - 'userAgent' - 'ip')`
 *   - Le `actor_id` du premier UPDATE devient `NULL`
 *
 * Retourne le nombre total de rows touchées (somme des 2 UPDATE).
 */

import type { CronSqlExecutor } from '../adapters/cron-sql-executor.js';

/**
 * Anonymise l'audit log d'un utilisateur via du SQL pur.
 *
 * @param executeSql exécuteur SQL — typiquement le binding
 *                   `athlya_cron` avec les grants minimum requis.
 * @param userId UUID v4 de l'utilisateur cible.
 * @returns nombre total de rows audit_log touchées.
 */
export async function anonymizeAuditLogViaSql(
  executeSql: CronSqlExecutor,
  userId: string,
): Promise<number> {
  // Validation runtime — le runner upstream a déjà filtré sur
  // `users WHERE deleted_at + 30d AND audit_anonymized_at IS NULL`,
  // donc le userId arrivant ici provient toujours de la base.
  // Garde-fou défensif : on rejette quand même les valeurs
  // malformées pour ne pas envoyer un payload bogué à Postgres.
  if (
    typeof userId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(userId)
  ) {
    throw new Error(`anonymizeAuditLogViaSql: malformed userId "${userId}"`);
  }

  // Step 1 — anonymise les rows where the user IS the actor.
  // `actor_id = NULL` + scrub metadata. `jsonb_strip_nulls` n'est
  // pas requis ici parce que `metadata - 'email'` produit déjà
  // un objet sans la clef.
  const actorRows = await executeSql.execute(
    `UPDATE audit_log
            SET actor_id = NULL,
                metadata = (metadata - 'email' - 'userAgent' - 'ip')
          WHERE actor_id = $1::uuid`,
    [userId],
  );

  // Step 2 — anonymise les rows where the user est référencé dans
  // metadata.subjectUserId (ex : un admin qui a soft-deleted un
  // user — l'admin est `actor_id`, le user supprimé est dans
  // `metadata.subjectUserId`).
  const subjectRows = await executeSql.execute(
    `UPDATE audit_log
            SET metadata = (metadata - 'email' - 'userAgent' - 'ip')
          WHERE metadata->>'subjectUserId' = $1`,
    [userId],
  );

  return actorRows + subjectRows;
}
