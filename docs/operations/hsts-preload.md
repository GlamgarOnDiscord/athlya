# HSTS preload submission

**Sprint 15 / Slice 15.2 (Epic SP5.7 + SP6.7)**

Procédure ops pour soumettre `athlya.app` au HSTS preload list de
Chromium / Firefox / Safari.

## Contexte

Le middleware `security-headers.ts` émet déjà l'en-tête :

```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
```

(2 ans, includeSubDomains, preload flag).

Le flag `preload` ne change RIEN tant que le domaine n'est pas
**effectivement listé** dans la preload list maintenue par
Google Chromium (utilisée aussi par Firefox + Safari).

Une fois listé : tout browser qui rencontre `athlya.app` ou
`*.athlya.app` connaît HTTPS-only **avant même la première
requête**. Empêche un attaquant qui contrôle DNS/réseau de
forcer un downgrade HTTP au tout premier hit.

## Pré-requis HARD (Chromium policy)

Avant submission, le domaine DOIT remplir :

1. **Servir un certificat HTTPS valide** sur `athlya.app` apex
2. **Redirect 301 HTTP → HTTPS** sur l'apex
3. **Servir tous les sous-domaines en HTTPS** — y compris ceux
   futurs (à cause du `includeSubDomains`)
4. **HSTS header sur la racine** avec `max-age >= 31536000`
   (1 an min, on a 2 ans), `includeSubDomains` ET `preload`
5. **Au moins 6 mois en production** sans rollback du header

⚠️ **POINT CRITIQUE** : une fois le domaine submitted + accepted,
**rollback est extrêmement difficile** (Chromium update se fait
sur 6+ semaines, et certains users ne mettent jamais à jour).

C'est pour ça que cette tâche est marquée "manuelle ops 6 mois
prod" — il faut un track record stable AVANT submission.

## Pré-flight checklist (avant submission)

À cocher après 6 mois de prod stable :

| Check | Tool | OK ? |
| ----------------------------------------------------------------------------------------------------- | ---------------------------- | --------------- | --- |
| Certif HTTPS sur `athlya.app` valide | `curl -I https://athlya.app` | ⏳ |
| Redirect HTTP → HTTPS | `curl -I http://athlya.app` | ⏳ |
| HSTS header présent sur racine | `curl -sI https://athlya.app | grep -i strict` | ⏳ |
| `max-age >= 31536000` | manual check | ⏳ |
| `includeSubDomains` flag | manual check | ⏳ |
| `preload` flag | manual check | ⏳ |
| Tous les sous-domaines en HTTPS (test : `app.athlya.app`, `staging.api.athlya.app`, `api.athlya.app`) | curl chacun | ⏳ |
| Aucun service interne HTTP-only sur `*.athlya.app` (intranet, monitoring, etc.) | review DNS records | ⏳ |
| 6 mois prod stable sans rollback HSTS | git log | ⏳ |

## Submission step

Quand TOUTES les checks ci-dessus sont OK :

1. Aller sur <https://hstspreload.org/>
2. Entrer `athlya.app` dans le champ
3. La page lance un check automatique sur les 7 critères
4. Si ALL GREEN → cliquer "Submit"
5. Email de confirmation reçu sous 24h
6. Inclusion effective dans Chrome stable : ~6-12 semaines
   (cycle release Chromium)
7. Inclusion Firefox + Safari : ~12-16 semaines
   (ils consomment la liste Chromium upstream)

## Vérification post-inclusion

Une fois le mail confirmé :

```bash
# Doit retourner true:
curl -s "https://hstspreload.org/api/v2/status?domain=athlya.app" | jq '.status'
# > "preloaded"
```

Et après 12 semaines, vérifier dans Chrome :

```
chrome://net-internals/#hsts
# Query domain: athlya.app
# Doit afficher: include_subdomains_for_static_sts: true
```

## Désinclusion (procedure)

Si jamais on doit retirer `athlya.app` de la preload list :

1. Soumettre une demande de removal sur <https://hstspreload.org/removal/>
2. Le rollout dans Chromium prend 18-24 mois (ils sont
   intentionnellement lents pour préserver la sécurité des
   users)
3. **PRÉFÉRER** garder le domaine en preload et migrer une
   service-app si besoin de HTTP — la désinclusion est un last
   resort.

## Provisioning checklist (post-6-mois)

| Item                                             | Status             | Owner  |
| ------------------------------------------------ | ------------------ | ------ |
| Audit pré-flight 9 checks                        | ⏳ J+180 prod      | DevOps |
| Submission hstspreload.org                       | ⏳ après audit OK  | DevOps |
| Email confirmation reçu                          | ⏳ J+1 submission  | DevOps |
| Inclusion Chrome stable confirmée                | ⏳ J+90 submission | DevOps |
| Tag dans `incident_log` "HSTS preload effective" | ⏳ J+90            | DevOps |

## Risques

| Risque                                                | Mitigation                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| Sous-domaine HTTP-only oublié (ex: status.athlya.app) | Audit DNS exhaustif avant submission                           |
| Cert HTTPS expire pendant la fenêtre 6 mois           | Auto-renewal Cloudflare + monitoring expiry                    |
| Rollback HSTS impossible                              | 18+ mois pour désinscription — accepté comme tradeoff sécurité |

## Références

- `packages/api/src/middleware/security-headers.ts` — header HSTS
- HSTS Preload list officielle: <https://hstspreload.org/>
- Source Chromium: <https://source.chromium.org/chromium/chromium/src/+/main:net/http/transport_security_state_static.json>
- Audit finding S4-009 (Sprint 1 audit)
