/**
 * Cookie policy page — Sprint-4 Slice 4.2 (Vague 32, audit
 * finding S5-014).
 *
 * The page documents which cookies the app sets, why, and which
 * are subject to consent under the ePrivacy Directive (2009/136/CE)
 * + the CNIL doctrine. As of Vague 31, the app does NOT load any
 * third-party tracking SDK, so no consent banner is technically
 * required (S5-009). Adding analytics in the future will require a
 * banner BEFORE the SDK loads — tracked separately as S5-009.
 */
import Link from 'next/link';

import type { Metadata } from 'next';

export const metadata: Metadata = {
    title: 'Politique cookies — Athlya',
    description: 'Quels cookies Athlya utilise et pourquoi.',
};

export default function CookiePolicyPage() {
    return (
        <main className="mx-auto max-w-3xl px-6 py-12 prose prose-slate">
            <Link href="/" className="mb-4 inline-flex items-center text-sm text-muted-foreground hover:text-foreground not-prose">
                ← Retour
            </Link>
            <h1>Politique cookies</h1>
            <p>
                <em>Dernière mise à jour : à compléter par le DPO avant le lancement.</em>
            </p>

            <section>
                <h2>Qu&apos;est-ce qu&apos;un cookie ?</h2>
                <p>
                    Un cookie est un petit fichier déposé par un site web
                    sur le terminal de l&apos;utilisateur (navigateur,
                    application). Il permet au site de reconnaître
                    l&apos;utilisateur d&apos;une visite à l&apos;autre, de
                    mémoriser des préférences ou de suivre une session
                    authentifiée.
                </p>
            </section>

            <section>
                <h2>Cookies utilisés par Athlya</h2>

                <h3>Cookies strictement nécessaires (sans consentement)</h3>
                <p>
                    Conformément à l&apos;article 82 de la Loi Informatique
                    et Libertés et à la doctrine CNIL, ces cookies ne
                    nécessitent pas votre consentement préalable car ils
                    sont indispensables à la fourniture du service.
                </p>
                <table>
                    <thead>
                        <tr>
                            <th>Nom</th>
                            <th>Finalité</th>
                            <th>Durée</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td><code>athlya.refresh</code></td>
                            <td>
                                Maintien de la session authentifiée.
                                <code>HttpOnly</code> + <code>Secure</code> +{' '}
                                <code>SameSite=Lax</code> + <code>Path=/api/auth</code>.
                            </td>
                            <td>30 jours (rotation à chaque utilisation)</td>
                        </tr>
                        <tr>
                            <td><code>NEXT_LOCALE</code></td>
                            <td>
                                Mémorisation de la langue choisie
                                (français / anglais).
                            </td>
                            <td>1 an</td>
                        </tr>
                    </tbody>
                </table>

                <h3>Cookies tiers</h3>
                <p>
                    À la date de mise en ligne de la présente politique,
                    Athlya n&apos;utilise <strong>aucun</strong> cookie de
                    mesure d&apos;audience, de personnalisation publicitaire,
                    ni de réseau social. Aucune SDK analytics tierce
                    n&apos;est chargée.
                </p>
                <p>
                    Si nous ajoutons à l&apos;avenir un service tel que
                    mesure d&apos;audience anonymisée (Plausible) ou suivi
                    d&apos;erreurs (Sentry browser), une bannière de
                    consentement préalable sera affichée et les SDK
                    correspondantes ne seront chargées qu&apos;après votre
                    accord explicite.
                </p>
            </section>

            <section>
                <h2>Comment refuser ou supprimer les cookies ?</h2>
                <p>
                    Les cookies strictement nécessaires ne peuvent pas être
                    refusés sans rendre le service inutilisable. Vous pouvez
                    toutefois supprimer tous les cookies depuis les
                    paramètres de votre navigateur. La déconnexion du compte
                    Athlya supprime immédiatement le cookie{' '}
                    <code>athlya.refresh</code>.
                </p>
            </section>

            <section>
                <h2>Cloudflare Turnstile (anti-bot)</h2>
                <p>
                    Le challenge anti-bot Cloudflare Turnstile présenté lors
                    de l&apos;inscription et de la connexion ne dépose
                    aucun cookie sur votre terminal et n&apos;effectue aucun
                    suivi inter-sites. Il fonctionne via une API JavaScript
                    en mémoire qui rend un jeton à usage unique côté
                    serveur.
                </p>
            </section>

            <hr />

            <p>
                <Link href="/privacy">Politique de confidentialité</Link> &middot;{' '}
                <Link href="/legal">Mentions légales</Link>
            </p>
        </main>
    );
}
