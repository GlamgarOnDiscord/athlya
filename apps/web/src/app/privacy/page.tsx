/**
 * Privacy policy page — Sprint-4 Slice 4.2 (Vague 32, audit
 * finding S5-014).
 *
 * The page surfaces the RGPD-mandated information notice (Art 13)
 * so the registration flow's consent click has a target document
 * to point at. The structure mirrors the CNIL's recommended
 * skeleton — every section heading maps to one Art 13 obligation:
 *
 *   - 1. Identité du responsable de traitement (Art 13.1.a)
 *   - 2. Finalités du traitement (Art 13.1.c)
 *   - 3. Base légale (Art 13.1.c — exécution contractuelle / consentement)
 *   - 4. Destinataires / sous-traitants (Art 13.1.e)
 *   - 5. Durées de conservation (Art 13.2.a)
 *   - 6. Droits de la personne concernée (Art 13.2.b)
 *   - 7. Transfert hors UE (Art 13.1.f)
 *   - 8. Réclamation CNIL (Art 13.2.d)
 *
 * Content here is a placeholder — the actual legal copy must be
 * reviewed by a DPO / legal counsel before launch. We ship the
 * structure now so the registration flow has something to link to,
 * and so any forgotten section is visible by its absence rather
 * than by a missing link.
 */
import Link from 'next/link';

import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Politique de confidentialité — Athlya',
  description:
    'Informations RGPD : comment Athlya traite vos données personnelles, vos droits, et comment les exercer.',
};

export default function PrivacyPolicyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 prose prose-slate">
      <Link
        href="/"
        className="mb-4 inline-flex items-center text-sm text-muted-foreground hover:text-foreground not-prose"
      >
        ← Retour
      </Link>
      <h1>Politique de confidentialité</h1>
      <p>
        <em>Dernière mise à jour : à compléter par le DPO avant le lancement.</em>
      </p>

      <section>
        <h2>1. Responsable de traitement</h2>
        <p>
          Athlya SAS, [adresse du siège]. Délégué à la protection des données :{' '}
          <a href="mailto:dpo@athlya.app">dpo@athlya.app</a>.
        </p>
      </section>

      <section>
        <h2>2. Finalités du traitement</h2>
        <ul>
          <li>
            <strong>Gestion du compte adhérent</strong> — création, authentification, sécurité
            (rate-limit, anti-fraude Cloudflare Turnstile, détection de réutilisation de token).
          </li>
          <li>
            <strong>Réservation et présence aux cours</strong> — capacité, file d&apos;attente,
            check-in QR.
          </li>
          <li>
            <strong>Communications transactionnelles</strong> — confirmations, rappels, alertes de
            sécurité (toujours envoyées indépendamment du consentement marketing).
          </li>
          <li>
            <strong>Communications marketing</strong> — uniquement si vous y avez explicitement
            consenti dans vos paramètres.
          </li>
          <li>
            <strong>Statistiques anonymisées</strong> — uniquement si vous y avez explicitement
            consenti.
          </li>
        </ul>
      </section>

      <section>
        <h2>3. Base légale</h2>
        <p>
          Le traitement repose sur l&apos;exécution du contrat d&apos;abonnement (Art 6.1.b RGPD)
          pour les finalités nécessaires au service, et sur votre consentement (Art 6.1.a) pour les
          finalités optionnelles (marketing, statistiques, cookies tiers).
        </p>
      </section>

      <section>
        <h2>4. Destinataires et sous-traitants</h2>
        <p>
          La liste des sous-traitants (Cloudflare Workers / R2 / KV, Neon Postgres, Upstash Redis,
          Stripe, Resend, Expo Push, Sentry) et leurs finalités respectives sont documentées dans le
          registre de traitement disponible sur demande à
          <a href="mailto:dpo@athlya.app"> dpo@athlya.app</a>. Tous les hébergements de données
          personnelles sont localisés en Union européenne.
        </p>
      </section>

      <section>
        <h2>5. Durées de conservation</h2>
        <ul>
          <li>
            <strong>Compte actif</strong> — pour la durée de votre abonnement.
          </li>
          <li>
            <strong>Compte supprimé</strong> — anonymisation des données personnelles dans un délai
            de 30 jours après la demande de suppression. L&apos;identifiant opaque est conservé pour
            préserver la cohérence des données historiques agrégées (statistiques de fréquentation)
            ; aucune donnée nominative ne reste accessible.
          </li>
          <li>
            <strong>Logs de sécurité</strong> — 12 mois (obligation de moyens contre la fraude, Art
            32 RGPD).
          </li>
          <li>
            <strong>Factures</strong> — 10 ans (obligation comptable, Art L123-22 Code de commerce).
          </li>
        </ul>
      </section>

      <section>
        <h2>6. Vos droits</h2>
        <p>Conformément aux articles 15 à 22 du RGPD, vous disposez des droits suivants :</p>
        <ul>
          <li>
            <strong>Accès</strong> et <strong>portabilité</strong> — export complet de vos données
            via la page <Link href="/me/export">Mon compte → Exporter mes données</Link>.
          </li>
          <li>
            <strong>Effacement</strong> — suppression de votre compte via{' '}
            <Link href="/me/delete">Mon compte → Supprimer mon compte</Link>.
          </li>
          <li>
            <strong>Rectification</strong> — modification de votre profil via{' '}
            <Link href="/me">Mon compte</Link>.
          </li>
          <li>
            <strong>Limitation</strong> et <strong>opposition</strong> — nous contacter à{' '}
            <a href="mailto:dpo@athlya.app">dpo@athlya.app</a>.
          </li>
        </ul>
      </section>

      <section>
        <h2>7. Transferts hors Union européenne</h2>
        <p>
          Aucun transfert de données personnelles n&apos;est opéré hors Union européenne.
          L&apos;ensemble des sous-traitants est sélectionné pour héberger les données dans des
          centres de données de l&apos;Union européenne.
        </p>
      </section>

      <section>
        <h2>8. Réclamation</h2>
        <p>
          Si vous estimez que le traitement de vos données ne respecte pas le RGPD, vous pouvez
          introduire une réclamation auprès de la Commission Nationale de l&apos;Informatique et des
          Libertés (CNIL) — <a href="https://www.cnil.fr">www.cnil.fr</a>.
        </p>
      </section>

      <hr />

      <p>
        <Link href="/legal">Mentions légales</Link> &middot;{' '}
        <Link href="/cookies">Politique cookies</Link>
      </p>
    </main>
  );
}
