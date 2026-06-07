/**
 * Pure-TS audit log anonymisation — Sprint 13 / Slice 13.3 (Epic
 * B10.2).
 *
 * ⚠️ NON CÂBLÉ EN PRODUCTION — INCOMPATIBLE AVEC L'IMMUTABILITÉ (issue #200).
 *
 * Ce module exécute deux UPDATE paramétrés directs sur `audit_log` sous
 * l'identité du role connecté (`CRON_DB_URL`, `athlya_cron`). Mais le
 * trigger `audit_log_immutable()` (migration 0003) lève
 * `audit_log is append-only` (SQLSTATE P0001) pour **tout role sauf
 * `athlya_owner`** — un GRANT ou une POLICY ne change rien, le trigger
 * s'exécute après le contrôle de privilège. Un UPDATE direct par
 * `athlya_cron` échouera donc toujours.
 *
 * Le seul chemin d'anonymisation valide est la fonction SECURITY
 * DEFINER `anonymize_user_audit()` (migration 0003), qui tourne en
 * `athlya_owner` et que le trigger laisse passer. C'est elle que
 * `worker.scheduled` appelle en production (voir `worker.ts`,
 * `SELECT anonymize_user_audit($1)`), via l'EXECUTE accordé à
 * `athlya_cron` en 0003. Le grant `UPDATE ON audit_log` du 0009 a été
 * révoqué (migration 0012) car mort et trompeur.
 *
 * Conservé uniquement comme référence du shape SQL ; ne pas le câbler
 * sans d'abord retirer ou assouplir le trigger d'immutabilité.
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
