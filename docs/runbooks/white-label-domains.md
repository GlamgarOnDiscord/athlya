# Runbook : marque blanche, domaines et e-mails du studio (issue #761)

Ce que le studio fait seul dans la console (Configuration, Identité
visuelle) : logos clair et sombre, couleur (contrôle AA), mention « via
Athlya » des e-mails, enregistrement d'un domaine web et d'un domaine
d'envoi, création des enregistrements DNS affichés, bouton « Vérifier
maintenant » (vraie requête DNS over HTTPS vers 1.1.1.1 depuis le Worker).

Ce que seul un opérateur fait : provisionner le domaine chez Cloudflare
ou Resend, saisir la clé DKIM, puis activer le domaine. Rien de cela
n'est simulé par l'application.

## Ce qui arrive en base

Migration **`0053_white_label.sql`** (expand seulement) :

- `studios.brand_logo_light`, `studios.brand_logo_dark` (nullable),
  `studios.hide_athlya_branding` (défaut `false`) ;
- table `studio_domains` (FORCE RLS, politique `studio_domains_admin_own`),
  trigger qui remet à zéro vérification et activation quand le nom change ;
- fonction `notification_studio_branding(uuid)` pour le consommateur de
  notifications.

`athlya_app` n'a **aucun** droit UPDATE sur `studio_domains.activated_at`
ni `studio_domains.dkim_record` : ces deux colonnes s'écrivent avec la
connexion du propriétaire du schéma (secret `MIGRATION_DB_URL_*`).

## Ordre de mise en service

1. Appliquer la migration (`deploy-production.yml` le fait avant les
   Workers, ou `DATABASE_URL=… node packages/db/scripts/migrate.mjs`).
   L'ancien Worker ignore les nouvelles colonnes et la nouvelle table.
2. Déployer les Workers, puis le studio.
3. Facultatif, logos sur R2 : définir `AVATARS_PUBLIC_URL` sur le Worker
   reservations (et la passerelle, `worker-routing.test.ts` compare les
   deux). Sans elle, les logos restent en URL `data:` plafonnée à 128 Ko
   et les e-mails affichent le nom du studio à la place du logo (la
   plupart des clients bloquent les images `data:`). Avec elle, ajouter
   l'origine publique à `img-src` de `apps/studio/src/lib/csp.ts`.

## Domaine web (CNAME vers `domains.athlya.app`)

Prérequis, une seule fois : Cloudflare for SaaS activé sur la zone
`athlya.app`, origine de repli `domains.athlya.app` créée.

Pour chaque studio, quand sa carte affiche « Vérifié » :

1. Cloudflare, zone `athlya.app`, SSL/TLS, Custom Hostnames : ajouter le
   nom du studio (validation HTTP), attendre « Active » pour le
   certificat et le nom.
2. Activer en base :

   ```sql
   UPDATE studio_domains SET activated_at = now()
    WHERE kind = 'web' AND hostname = 'club.monstudio.fr' AND status = 'verified';
   ```

Limite connue : l'app membre ne résout pas encore un nom personnalisé vers
le studio (le garde de tenant lit le slug). Tant que ce routage n'est pas
livré, n'activez un domaine web qu'avec une redirection décidée au cas par
cas.

## Domaine d'envoi (Resend)

1. Le studio enregistre `monstudio.fr`. Resend, Domains, Add domain :
   `monstudio.fr`, région **eu-west-1** (l'enregistrement MX affiché par la
   console vise `feedback-smtp.eu-west-1.amazonses.com` ; une autre région
   impose de changer `RESEND_RETURN_PATH_MX` dans
   `packages/api/src/white-label/dns-records.ts`).
2. Copier la valeur TXT `resend._domainkey` donnée par Resend :

   ```sql
   UPDATE studio_domains SET dkim_record = 'p=MIGfMA0G…'
    WHERE kind = 'email' AND hostname = 'monstudio.fr';
   ```

3. Le studio crée ses enregistrements et clique « Vérifier maintenant ».
   Une fois « Vérifié », lancer aussi la vérification dans Resend.
4. Resend affiche « Verified » : activer en base.

   ```sql
   UPDATE studio_domains SET activated_at = now()
    WHERE kind = 'email' AND hostname = 'monstudio.fr' AND status = 'verified';
   ```

Dès l'activation, les e-mails du studio partent de
`"Nom du studio" <noreply@monstudio.fr>`. Avant, ils partent de l'adresse
par défaut (`RESEND_FROM`), aux couleurs du studio.

## Retour arrière

- Désactiver un domaine : `UPDATE studio_domains SET activated_at = NULL
  WHERE …;` (les e-mails reviennent sur l'expéditeur Athlya au message
  suivant), puis retirer le custom hostname ou le domaine Resend.
- Annuler la migration : `0053_white_label.down.sql` (les objets R2 sous
  `studio-logos/` restent dans le bucket).
