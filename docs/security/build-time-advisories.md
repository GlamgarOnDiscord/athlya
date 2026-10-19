# Avis de dépendances limités au build

Avis de sécurité connus sur des dépendances que l'on ne peut pas corriger par
un override, faute de version corrigée publiée. Tous arrivent par la chaîne
d'outils mobile (Expo CLI, Metro) et ne sont exposés qu'au moment du build ou
du serveur de développement : aucun n'est embarqué dans le bundle de l'app ni
exécuté par les Workers de production.

**Date de réexamen : 2027-01-17** (même échéance que les `ignoreUntil` de
[`osv-scanner.toml`](../../osv-scanner.toml)). À cette date, ou dès qu'une
version corrigée paraît, remplacer l'entrée par un override scopé
(`pkg@<fixed>: ^fixed` dans `pnpm-workspace.yaml`, justifié dans
`scripts/overrides-rationale.json`) et retirer l'ignore OSV.

| Paquet       | Avis                                                                     | Versions touchées | Correctif publié | Chemin                                                                                    | Exposition                                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------ | ----------------- | ---------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node-forge` | [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) | `<=1.4.0`         | aucun            | `expo` > `@expo/cli` > `@expo/code-signing-certificates` > `node-forge`                   | Build et dev uniquement : certificats du serveur de dev et signature des manifestes `expo-updates`, que l'app n'utilise pas. Ne vérifie jamais de signature tierce.                                                                           |
| `braces`     | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | `<=3.0.3`         | aucun            | `react-native` > `@react-native/community-cli-plugin` > `metro` > `micromatch` > `braces` | Build et dev uniquement : Metro et les outils CLI développent des globs écrits dans le dépôt, jamais une entrée utilisateur. Le même paquet arrive aussi par `fast-glob` (eslint-config-next, CLI shadcn, ts-morph), avec la même exposition. |

## Corrigés par override

Deux autres avis de la même chaîne ont une version corrigée et sont fermés par
un override scopé dans `pnpm-workspace.yaml` :

- `uuid@<11.1.1` → `^11.1.1` ([GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)), via `@expo/config-plugins` > `xcode`. `xcode@3` appelle `require('uuid').v4()`, que uuid 11 expose toujours en CommonJS ; un `expo prebuild --platform ios` passe avec l'override.
- `postcss-selector-parser@<7.1.6` → `^7.1.6` ([GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf)), via `nativewind` > `react-native-css-interop` > `tailwindcss@3` et `postcss-nested`. Un `expo export --platform ios` passe avec l'override.

## Vérifier

```bash
pnpm audit                                  # seuls node-forge et braces doivent rester
pnpm why node-forge braces --filter mobile  # chemins ci-dessus
```
