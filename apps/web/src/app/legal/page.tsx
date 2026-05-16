/**
 * Mentions légales (Legal notice) page — Sprint-4 Slice 4.2
 * (Vague 32, audit finding S5-014).
 *
 * Required by the French LCEN (Loi pour la confiance dans
 * l'économie numérique, Art 6.III). Identifies the editor, the
 * host, and the publication director. Placeholder copy — a DPO /
 * legal counsel must validate before launch.
 */
import Link from 'next/link';

import type { Metadata } from 'next';

export const metadata: Metadata = {
    title: 'Mentions légales — Athlya',
    description: 'Identification de l\'éditeur, de l\'hébergeur et du directeur de la publication.',
};

export default function LegalNoticePage() {
    return (
        <main className="mx-auto max-w-3xl px-6 py-12 prose prose-slate">
            <Link href="/" className="mb-4 inline-flex items-center text-sm text-muted-foreground hover:text-foreground not-prose">
                ← Retour
            </Link>
            <h1>Mentions légales</h1>
            <p>
                <em>Dernière mise à jour : à compléter par le DPO avant le lancement.</em>
            </p>

            <section>
                <h2>Éditeur du site</h2>
                <p>
                    Athlya SAS, [forme juridique], au capital de [montant] €.<br />
                    [Adresse du siège].<br />
                    RCS [ville] — n° [numéro].<br />
                    SIRET : [numéro].<br />
                    TVA intracommunautaire : [numéro].<br />
                    Contact : <a href="mailto:contact@athlya.app">contact@athlya.app</a>.
                </p>
            </section>

            <section>
                <h2>Directeur de la publication</h2>
                <p>[Nom du représentant légal].</p>
            </section>

            <section>
                <h2>Hébergement</h2>
                <p>
                    Cloudflare Workers — Cloudflare, Inc., 101 Townsend St,
                    San Francisco, CA 94107, États-Unis. Les données
                    personnelles sont hébergées exclusivement sur des centres
                    de données situés dans l&apos;Union européenne (Smart
                    Placement EU-pinned).<br />
                    Neon Postgres — Neon Inc., région <code>aws-eu-central-1</code>.<br />
                    Upstash Redis — Upstash Inc., région{' '}
                    <code>eu-west-1</code>.
                </p>
            </section>

            <section>
                <h2>Propriété intellectuelle</h2>
                <p>
                    L&apos;ensemble du site (textes, graphismes, logos, code
                    source) est protégé au titre du droit d&apos;auteur. Toute
                    reproduction, en tout ou partie, est interdite sans
                    autorisation préalable.
                </p>
            </section>

            <hr />

            <p>
                <Link href="/privacy">Politique de confidentialité</Link> &middot;{' '}
                <Link href="/cookies">Politique cookies</Link>
            </p>
        </main>
    );
}
