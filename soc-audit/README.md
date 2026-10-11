# Audit et correctifs — `saif-infinity/projet-soc-ips-siem-xdr-`

⚠️ **Ce dossier ne contient pas de code de ce dépôt-ci** (`AEGIS-Sentinel`, application
Electron). Il contient les livrables d'un audit mené sur un **autre** dépôt de
l'organisation : [`saif-infinity/projet-soc-ips-siem-xdr-`](https://github.com/saif-infinity/projet-soc-ips-siem-xdr-)
(SIEM/XDR, Python FastAPI + 2 frontends React, branche `master`, commit `884f565`).

Il est déposé ici uniquement parce que la session de travail est liée à cette branche.

## Fichiers

| Fichier | Contenu |
|---|---|
| `AUDIT-projet-soc-ips-siem-xdr.md` | Le rapport complet : verdict chiffré, findings P0→P4, ce qui est bien et ne doit pas être cassé, plan d'action, journal des corrections (§12) |
| `00-all-fixes-combined.diff` | **Tout en un** — 184 fichiers, du code d'origine à l'état final |
| `01-fixes-build-security.diff` | P0 build + P1 sécurité, écrits à la main — 28 fichiers |
| `02-lint-ruff-autofix.diff` | Churn mécanique `ruff --fix` — 146 fichiers |
| `03-lint-manual-and-functional-fixes.diff` | Lint manuel (52 → 0 erreurs) + correctifs fonctionnels — 50 fichiers |
| `LICENSE-AGPL-3.0.txt` | Licence proposée (le dépôt audité n'en avait aucune) |
| `NOTICE.txt` | Attribution nominative des 12 logos de marques + rappel des conditions |

## Appliquer les patchs

Soit le patch unique `00`, soit la chaîne `01 → 02 → 03` (trois commits séparés,
plus lisible en revue : le bruit mécanique du linting ne noie pas les corrections
de sécurité).

```bash
git clone https://github.com/saif-infinity/projet-soc-ips-siem-xdr-.git
cd projet-soc-ips-siem-xdr-

# Option A — tout d'un coup
git checkout -b fix/everything
git apply --whitespace=nowarn /chemin/00-all-fixes-combined.diff

# Option B — trois commits (recommandé)
git checkout -b fix/p0-build-and-security
git apply --whitespace=nowarn /chemin/01-fixes-build-security.diff
cd frontend && npm ci && npm run build && cd ..
git add -A && git commit -m "fix: build, CI, security, honesty"

git apply --whitespace=nowarn /chemin/02-lint-ruff-autofix.diff
git add -A && git commit -m "style: ruff --fix (safe fixes only)"

git apply --whitespace=nowarn /chemin/03-lint-manual-and-functional-fixes.diff
cd backend && ruff check .          # All checks passed!
git add -A && git commit -m "fix: lint manuel, cycle de vie, rate-limit, mocks, Alembic, licence"
```

> Utilisez **`git apply`**, pas `patch -p1` : les patchs suppriment
> `backend/celerybeat-schedule`, un fichier binaire, et GNU `patch` refuse les
> diffs binaires git.

## Résultat mesuré

| | Code d'origine | Après les patchs |
|---|---|---|
| `ruff check .` | crash (`Unknown rule selector W503`), puis **1078 erreurs** | **0 erreur** |
| `pytest` | **0 test collecté** | **242 collectés, 241 passent**¹ |
| `npm run build` (frontend) | ❌ `Could not resolve "../lib/formatters"` | ✅ 8.08s |
| `npm run build` (admin-frontend) | ✅ | ✅ 5.99s |
| `alembic heads` | aucun Alembic | ✅ `0001 (head)` |
| `LICENSE` | absent | ✅ AGPL-3.0 |
| Comparaisons de secrets non constantes | 6 | **0** |
| Mocks servis comme données réelles | 5 | 1 (assumé, étiqueté) |

¹ Seul échec : `test_nmap_scan_accepts_json_body`, qui exige un broker Redis/Celery
vivant. Il échoue à l'identique sur le code d'origine.

Les deux voies d'application (`00` seul, et `01+02+03`) ont été vérifiées sur une
extraction fraîche du tarball `master` : `diff -rq` renvoie **0 divergence** avec
l'arbre final attendu.
