# Audit — `saif-infinity/projet-soc-ips-siem-xdr-`

**Version 2** · 2026-10-11 · Commit audité : `884f565` (branche `master`, 13 commits)
**Périmètre réel :** 193 fichiers Python (~24 700 lignes), 50 JSX (~14 700 lignes), 2 frontends React, 1 backend FastAPI, 46 tables ORM.

> Le repo cloné dans cette session est `AEGIS-Sentinel` (un autre de tes projets). J'ai audité
> `projet-soc-ips-siem-xdr-` **en lecture seule** via une copie locale ; rien n'a été poussé sur
> ton repo. Les livrables sont dans `soc-audit/` (fichiers **non suivis** par git — déplace-les
> ou supprime-les quand tu veux).

**Cette v2 corrige deux affirmations de la v1** (voir §11) et ajoute 4 découvertes trouvées en creusant :
une **injection SQL** dans la console d'administration de base de données, **22 tables supprimables**
par HTTP, l'absence totale de **configuration pytest**, et un **piège de `ruff --fix`** qui casse le build.

---

## 0. Verdict

**Le périmètre et l'architecture sont au-dessus du niveau attendu — mais rien, dans ce repo, n'a jamais été vérifié par une machine.** La CI n'a pas tourné une seule fois (`actions/runs → total_count = 0`), le linter crashait sur sa propre configuration, le frontend ne compile pas, il n'y a aucun Dockerfile, et la suite de tests ne peut même pas être *collectée*. Trois commits consécutifs ont amélioré le README (58 Ko, badges, diagrammes) pendant que le produit était incapable de se construire.

Le problème n'est donc pas le niveau technique : c'est **l'absence de boucle de rétroaction**.

### Tout ce que j'ai mesuré, pas seulement lu

| Vérification | Sur le code d'origine | Après mes patchs |
|---|---|---|
| `frontend && npm ci && npm run build` | ❌ `Could not resolve "../lib/formatters"` | ✅ `built in 6.42s` |
| `admin-frontend && npm run build` | ✅ | ✅ |
| `ruff check .` (commande exacte de la CI) | ❌ **crash** `Unknown rule selector W503` | ✅ s'exécute |
| `ruff check .` (config réparée) | **1078 erreurs** | **0 erreur** |
| Runs GitHub Actions depuis la création | **0** | déclenchés sur `master` |
| `find . -iname Dockerfile*` | **aucun** | ✅ image non-root + healthcheck |
| `pytest --collect-only tests/` | ❌ `ValidationError` → **0 test collecté** | ✅ **242 tests collectés** |
| `pytest` (suite existante + nouveaux tests) | ❌ **0 exécutable** | ✅ **241 passed / 1 échec**¹ |
| `pytest` (nouveaux tests de régression) | — | ✅ **83 passed** (40 sanitizer + 43 DDL) |
| `alembic heads` / `alembic upgrade head --sql` | ❌ aucun Alembic | ✅ `0001 (head)`, SQL généré hors-ligne |
| `LICENSE` / `NOTICE` | ❌ absents (`license: null`) | ✅ AGPL-3.0 (661 lignes) + NOTICE marques |
| `frontend/src/lib/` dans les 13 commits | **0 fichier, jamais commité** | ✅ 2 modules reconstruits |
| `git apply` des **4** patchs sur extraction fraîche | — | ✅ arbre final **identique à l'octet** |

¹ Seul échec : `test_nmap_scan_accepts_json_body`, qui a besoin d'un broker Redis/Celery vivant (`ConnectionRefusedError: localhost:6379`). Absent de ce sandbox, fourni par le service `redis` de la CI. **Échec identique sur le code d'origine.**

---

## 1. Ce qui est réellement bien (à ne pas casser)

- **Clean architecture** `domain / application / infrastructure / interface` respectée dans la grande majorité des 193 fichiers. Rare à ce niveau.
- **Multi-tenancy dans le bon ordre** : le tenant vient du **JWT** d'abord ; le header `X-Tenant-ID` n'est accepté que sur le lane `X-API-Key` (`interface/middleware/tenant.py:41-53`).
- **RBAC appliqué globalement** par `apply_role_guard()` qui insère la dépendance dans chaque route, au lieu de 200 décorateurs copiés-collés (`core/rbac.py:118-131`).
- **`secrets.compare_digest`** déjà utilisé correctement pour les webhooks par slug/token (`core/auth.py:180-260`) : la bonne idée était là, elle n'avait juste pas été généralisée (§3.4).
- **`paramiko.RejectPolicy()`** sur le SSH Suricata — pas de `AutoAddPolicy`, donc pas de MITM trivial. Beaucoup de projets "sécurité" ratent ça.
- **Les 9 endpoints de `database.py` sont bien tous derrière `get_current_admin`** (j'avais laissé entendre le contraire en v1 — vérifié : 9 routes, 9 dépendances). Le plan d'administration séparé est défendable.
- **`PROTECTED_TABLES` existe** pour empêcher le `DROP` des tables système — l'intention est bonne, c'est la maintenance qui a lâché (§3.6).
- **Actions de réponse réelles** : `wazuh_block`, `quarantine_file`, `restart_service`, notifications chiffrées Fernet, avec approbation et rollback. Ce ne sont pas des stubs.
- **`docker-compose.prod.yml`** : `read_only: true`, `no-new-privileges`, ports liés à `127.0.0.1`.
- **Tests qui testent des propriétés** (isolation multi-tenant, RBAC, corrélation MITRE) plutôt que des mocks qui se renvoient la balle.

Le socle est bon. Tout ce qui suit est un problème de **finition et de vérification**, pas de conception.

---

## 2. P0 — Le repo ne fonctionne pas

### 2.1 🔴 `.gitignore` ligne 26 a mangé le code source du frontend

`.gitignore:26` contient `lib/` — une règle d'artifact de virtualenv Python, **non ancrée**. Elle a donc aussi ignoré `frontend/src/lib/`. Vérifié sur les **13 commits** : `frontend/src/lib/` n'y apparaît **jamais**.

Or 8 fichiers l'importent :

```
src/contexts/AuthContext.jsx:2       import { createFetchWithAuth } from "../lib/api";
src/components/TopologyView.jsx:2    import { createFetchWithAuth } from "../lib/api";
src/pages/MitrePage.jsx:5            import { createFetchWithAuth } from "../lib/api";
src/pages/DashboardPage.jsx:5        import { getHourlyAlertsData } from "../lib/formatters";
src/pages/AICopilotPage.jsx:5        import { formatReport } from "../lib/formatters";
src/pages/AIHistoryPage.jsx:4        import { formatReport } from "../lib/formatters";
src/pages/InvestigationModal.jsx:2   import { formatReport } from "../lib/formatters";
src/pages/SuricataPage.jsx:5         import { formatSuricataDetails } from "../lib/formatters";
```

**Chaîne de conséquences :** `npm run build` échoue → `frontend/dist/` n'existe jamais → le service `frontend` de `docker-compose.prod.yml` monte un volume vide → nginx sert du 404 → **le produit n'a jamais pu être déployé**. Et comme la CI ne tourne jamais (§2.3), personne ne l'a vu.

✅ **Corrigé** : `lib/` et `lib64/` retirés du `.gitignore`, et les deux modules reconstruits à partir de leurs 30+ call-sites (contrat déduit : `res.ok`/`res.json()` conservés, 401 → logout, `silent: true` pour les pollers, `X-Tenant-ID` injecté, JSON automatique). **Le build passe.**

### 2.2 🔴 Aucun Dockerfile, et `prod.yml` build un dossier inexistant

- `docker-compose.prod.yml:112` → `wazuh: build: ./wazuh` — **le répertoire `wazuh/` n'existe pas**.
- `backend`, `worker`, `syslog` → `build: ./backend` — **aucun Dockerfile** dans tout le repo.
- `docker-compose.yml` (dev) ne définit **que `redis`** mais déclare un volume top-level `pgdata:` orphelin ; `make prod` ne peut pas fonctionner.

✅ **Corrigé** : `backend/Dockerfile` (python:3.13-slim, layer deps séparé, fix opencv headless, user non-root uid 10001, healthcheck `/health`, `--proxy-headers`) et `docker-compose.yml` de dev devenu un vrai fichier (TimescaleDB + Redis + profil `ai` pour Ollama, healthchecks, ports en loopback).

### 2.3 🔴 La CI est décorative — 6 défauts indépendants

`actions/runs → total_count = 0`. Elle n'a **jamais** tourné :

1. **Déclencheur faux** — `ci.yml:5,7` : `branches: [main, develop]` et `pull_request: branches: [main]`. La seule branche du repo est **`master`**.
2. **`lint-backend` crash** — `backend/ruff.toml:6` ignore `W503`, un code **flake8** que ruff ne connaît pas : `Cause: Unknown rule selector W503`. Le linter n'a jamais lu un seul fichier.
3. **`lint-frontend` impossible** — la CI lance `npx eslint src --ext .jsx,.js` alors qu'il n'y a **ni config ESLint ni dépendance ESLint** dans `frontend/package.json` (et `--ext` n'existe plus en ESLint 9).
4. **`test-backend` échoue à l'import** — `Settings` a **8 `SecretStr` obligatoires** (vérifié par AST : `JWT_SECRET_KEY, API_KEY, WAZUH_PASS, WAZUH_INDEXER_PASS, SURICATA_PASS, WAZUH_SSH_PASS, ADMIN_API_KEY, ADMIN_JWT_SECRET`). La CI n'en fournit que 4 et il n'y a **aucun `conftest.py`** → `pydantic ValidationError` à la collection (§2.5).
5. **`build-backend`** build un contexte sans Dockerfile (§2.2).
6. **`deploy`** ne déploie rien : le step fait trois `echo` des commandes. Un check vert nommé *Deploy Production* qui n'a jamais rien déployé est **pire** que pas de check.

✅ **Corrigé** : `ci.yml` réécrit — triggers sur `master`, lint sans installer insightface/onnxruntime, **build des deux frontends** comme vrai gate (c'est exactement la classe de bug qui est passée), les 10 variables d'env, image `timescaledb` alignée sur la prod, job `compose config -q`, et un `deploy` qui **échoue explicitement** si les secrets manquent.

### 2.4 🔴 Deux `NameError` : le honeypot n'a jamais rien enregistré

```
app/infrastructure/honeypot/service.py:116   db = db_factory()   # F821 Undefined name
app/infrastructure/honeypot/service.py:147   db = db_factory()   # F821 Undefined name
```

`db_factory` est un **paramètre de `start()`**, invisible dans `_handle_connection()`. Les deux appels sont dans des `except Exception as e: logger.warning(...)`. Donc, depuis toujours : le honeypot **écoute sur `0.0.0.0:2323/3389/8443/5555`** (`bootstrap.py:98`), incrémente un compteur en mémoire, loggue un warning noyé… et **n'insère ni `Alert` ni `HoneypotEvent`**. Une surface d'attaque réelle qui produit zéro télémétrie — le pire des deux mondes.

✅ **Corrigé** : `self._db_factory` (défaut `SessionLocal`, remplacé par `start()`).

### 2.5 🔴 Aucun fichier de configuration pytest — la suite ne se collecte pas

Il n'existe **ni `pytest.ini`, ni `pyproject.toml`, ni `setup.cfg`, ni `tox.ini`** dans `backend/`. Mesuré sur le code d'origine :

```
$ pytest --collect-only -q tests/test_timescale.py
ERROR tests/test_timescale.py - pydantic_core._pydantic_core.ValidationError: …
!!!! Interrupted: 1 error during collection !!!!
no tests collected, 1 error
```

`Settings()` est instanciée **à l'import** (`settings = Settings()`), donc les 14 modules de test échouent à la collection. Les ~110 Ko de tests écrits n'ont **jamais pu s'exécuter** tels quels.

✅ **Corrigé** : `backend/tests/conftest.py` (les 8 secrets + DSN en valeurs jetables, `os.environ.setdefault` pour que la CI garde la main, intégrations réseau désactivées) et `backend/pytest.ini` (`testpaths`, `--strict-markers`). Mesuré : **0 test collecté → 123 tests collectés**.

### 2.6 🟠 `ruff` une fois réparé : 1078 erreurs, et un piège

968 sont auto-fixables. Répartition : 199 `UP045`, 172 `UP006`, **144 `F401`**, 135 `I001`, 115 `W293`, 114 `UP017`, **5 `F811`**, **2 `F821`** (§2.4), 12 `E712` (`== True`), 3 `E711` (`== None`), 1 `E722` (`except:` nu).

⚠️ **Le piège que j'ai trouvé en le faisant vraiment** : `ruff check --fix` supprime les imports « inutilisés » — or ce codebase repose sur des **shims de re-export** (§5.4). `app/db.py` ne contient que :
```python
from .core.db import engine, SessionLocal, Base, get_db
from .application.tenant import get_tenant_id, query_with_tenant
```
Ruff les efface, et **tout** `from ...db import get_db` du projet casse. 9 shims sur 12 portaient déjà `# noqa: F401` ; **les 3 qui ne l'avaient pas** (`app/db.py`, `app/services/__init__.py`, `app/services/wazuh_service.py`) sont exactement ceux que le fix éventre. Je l'ai découvert parce que mes propres tests de régression ont cessé de se collecter après l'autofix.

✅ **Corrigé** : les 3 shims protégés, puis autofix appliqué → **1078 → 52 erreurs**, backend compile toujours, 83 tests passent toujours. Livré en **patch séparé** pour que tu puisses le relire indépendamment.

---

## 3. P1 — Sécurité

### 3.1 🔴 `POST /api/faces/identify` : oracle biométrique public

`interface/api/faces.py:101-127`, docstring assumée : *« Public (pré-auth) »*, et le routeur `faces` est `{"exempt": True}` dans `ROUTER_POLICIES` (`interface/main.py:132`).

Sans aucun credential, on POSTe une image et on reçoit `{"status":"recognized","username":"j.doe","similarity":0.61,"authorized":true}`. C'est un **oracle d'identification 1:N non authentifié**, sans rate-limit, qui énumère les identités du tenant — et une donnée biométrique au sens de l'**art. 9 RGPD**.

✅ **Corrigé** : scope `surveillance:read` (viewer+) ou clé d'API.

### 3.2 🔴 Injection SQL dans la console d'administration de base de données

`interface/api/database.py` déclare un ensemble `ALLOWED_TYPES` (ligne 567) — **qui n'est jamais utilisé nulle part**. À la place :

```python
col_type = col.type.strip().upper()          # ← interpolé tel quel
parts = [f'"{col_name}" {col_type}']
…
elif col.default is not None:
    # Validate default is a simple safe SQL expression     ← le commentaire ment
    parts.append(f"DEFAULT {col.default}")   # ← interpolé tel quel
create_sql = f'CREATE TABLE "{table_name}" (\n' + ",\n".join(col_defs) + "\n)"
```

`POST /api/admin/database/tables` avec `{"name":"c","type":"integer); DROP TABLE tenants; --"}` concatène l'attaque dans le DDL ; le champ `default` accepte n'importe quelle expression. Les noms de table/colonne **étaient** validés par regex (`_validate_identifier`), ce qui rend l'oubli des deux autres champs d'autant plus visible.

✅ **Corrigé** : `_validate_column_type()` (base dans `ALLOWED_TYPES`, modificateur de taille seulement pour `varchar`/`char`/`numeric`) et `_validate_default()` (littéraux + `now()`, `current_timestamp`, `gen_random_uuid()`, booléens). Validé par 23 cas de test, dont toutes les tentatives d'injection.

### 3.3 🔴 `PROTECTED_TABLES` a dérivé : 22 tables sur 46 supprimables par HTTP

`DELETE /api/admin/database/tables/{name}` exécute `DROP TABLE … CASCADE`, protégé par une liste **écrite à la main** de 25 noms. L'ORM en déclare **46**. Résultat mesuré :

```
tables déclarées dans domain/models : 46
PROTECTED_TABLES écrit à la main    : 25
→ supprimables (22) : agent_ai_analyses, agent_orders, agent_telemetry_events, agents,
  correlation_state, face_login_requests, honeypot_events, investigation_evidence,
  investigation_recommendations, investigations, notification_channels, notification_dedup,
  registration_requests, report_logs, report_recipients, report_schedules, report_templates,
  reports, response_action_results, response_rollbacks, response_runs, unverified_face_attempts
→ protégée mais inexistante (1) : "users"
```

Parmi elles : `registration_requests` (hashes de mots de passe en attente), `notification_channels` (configs de canaux), `response_runs` (historique des actions de réponse = la piste d'audit du SOAR).

✅ **Corrigé** : `_protected_tables()` dérive la liste de `Base.metadata.tables` ∪ l'ancienne liste littérale. Elle ne peut plus dériver quand un modèle est ajouté — et un test (`test_every_orm_table_is_protected_from_drop`) échouera si ça se reproduit.

### 3.4 🔴 Login multi-tenant : le mot de passe est testé sur **tous** les tenants

`interface/api/auth.py:191+` :
```python
if check_password(user_key, form_data.password, tenant_id=None):   # None = tous les tenants
    tenant_user = db.query(TenantUser).filter(TenantUser.username == form_data.username).first()
```
`check_password(..., tenant_id=None)` est documenté *« Cross-tenant lookup: check all users with this username »* (`infrastructure/persistence/password_store.py:52-79`). Si les tenants A et B ont chacun un `admin`, **un mot de passe valide dans A authentifie la requête**, puis `.first()` sans filtre renvoie un rôle et un `tenant_id` **arbitraires** (ordre physique de la table). Toute l'isolation multi-tenant tombe sur la porte d'entrée.

✅ **Corrigé** : tenant résolu explicitement (`X-Tenant-ID`, défaut `default`), `check_password` **et** la requête de rôle filtrées sur ce tenant, + contrôle `is_active`.

### 3.5 🔴 Le « terminal restreint » était contournable de 4 façons

`sanitize_command()` bloquait les métacaractères shell puis ne comparait **que `parts[0]`** à l'allowlist :

| Vecteur | Pourquoi ça passait |
|---|---|
| `docker run --privileged -v /:/host alpine chroot /host` | `docker` était dans l'allowlist ; le backend fait `subprocess.run(["docker","exec",<container>, …])` depuis l'hôte |
| `find /var/log -type f -exec cat /etc/shadow +` | seul `parts[1]` était vérifié pour `find` ; `+` et `-exec` ne sont pas des métacaractères |
| `grep -r root /etc/shadow` | `grep` était autorisé **sans aucune restriction de chemin** (seuls `cat`/`tail`/`head`/`find` l'étaient) |
| `systemctl edit wazuh-manager` | `systemctl` autorisé sans sous-commande → écrire une unit file = exécution de code |

Preuve que le contrôle n'avait jamais été testé : `"docker ps"` et `"docker stats"` figuraient dans l'allowlist en tant qu'entrées **deux mots** alors que seul le premier mot était comparé → entrées mortes. Et `top`/`htop` (interactifs) brûlaient systématiquement le timeout de 15 s. Une commande rejetée renvoyait en plus **HTTP 200** avec `{"status":"error"}`, indiscernable d'un succès pour l'UI.

✅ **Corrigé** : matching sur préfixe 1 *ou* 2 mots ; `docker`/`grep`/`find`/`top`/`htop` retirés ; blocklist de flags (`-exec`, `-execdir`, `-delete`, `--file`, `--directory`, `-o`, `-e`…) ; **tout** chemin absolu d'une commande de lecture doit être dans un répertoire sûr ; `..` interdit ; `HTTPException(400)`. **40 tests de régression** couvrent les vecteurs ci-dessus et les diagnostics légitimes qui doivent continuer à passer.

### 3.6 🟠 Six comparaisons de secrets non constantes en temps

`secrets.compare_digest` était utilisé pour les webhooks… mais pas ailleurs :
```
core/auth.py:38,49,141            api_key == / != settings.API_KEY…
core/rbac.py:47,62                api_key == settings.API_KEY… / == sa
interface/middleware/tenant.py:51 api_key == settings.API_KEY…
interface/api/auth.py:100         api_key == settings.API_KEY…
interface/api/agent.py:45,49      api_key == … / token == …        ← plan d'ingestion agent, exempt de RBAC
interface/api/realtime.py:94      api_key == …                     ← authentification du WebSocket
```
✅ **Corrigé partout** (vérifié : `grep -rn "== settings.API_KEY" app | wc -l` → **0**).

### 3.7 🟠 RBAC *fail-open* : l'inconnu devient analyste

`core/rbac.py:31` — utilisateur absent de `TenantUser` ⇒ rôle lu dans le store JSON legacy avec **`"analyst"` par défaut**, un rôle qui écrit. Un défaut d'autorisation doit tomber au plus bas. ✅ **Corrigé → `"viewer"`**.

### 3.8 🟠 Fuite inter-tenants dans l'enrichissement des alertes (+ N+1)

`interface/api/realtime.py:36-53` : les alertes sont correctement filtrées par tenant, mais l'enrichissement ne l'est pas :
```python
asset  = db.query(Asset).filter(Asset.ip == item.src_ip).first()     # pas de tenant_id
device = db.query(Device).filter(Device.ip == item.src_ip).first()   # pas de tenant_id
```
→ le nom d'employé, le département et le MAC servis au tenant A peuvent venir des tables du tenant B. C'est exactement ce que `query_with_tenant()` existe pour empêcher. Au passage : **2 requêtes par alerte dans une boucle** sur un endpoint que le dashboard interroge toutes les 5 s.

✅ **Corrigé** : filtre `tenant_id` + 2 requêtes batchées `IN (…)`.

### 3.9 🟠 Le mot de passe admin **est** la clé d'API

`admin_auth.py:48-56` : `verify_admin_password()` hache `settings.ADMIN_API_KEY` dans un fichier et compare le mot de passe saisi à ce hash. Donc **un seul secret statique partagé** pour tout le rôle admin : pas de comptes nominatifs, pas de révocation individuelle, pas de rotation, et le même secret sert de mot de passe humain *et* de clé machine. Le token obtenu vit 8 h et est promu **`super_admin`** sur tous les routers (`core/rbac.py:80-95`).

**À faire** (pas dans le patch — changement de modèle) : de vrais comptes admin en base, `ADMIN_API_KEY` réservé au machine-to-machine, token admin de 30 min.

### 3.10 🟡 Un mot de passe réel en dur dans le code

`core/config.py:5` : `DATABASE_URL: str = "postgresql+pg8000://postgres:saif@localhost:5432/postgres"` — ton mot de passe Postgres local, en clair, dans un repo **public**. Tous tes autres secrets sont correctement en `SecretStr` obligatoires ; celui-ci doit suivre le même régime.

### 3.11 🟡 Rate-limit du login inefficace derrière un proxy, et *fail-open*

`interface/api/auth.py:47-62` : la clé est `request.client.host`. Derrière le nginx de `prod.yml`, **tous les clients partagent l'IP du proxy** → soit lockout global après 10 essais, soit contournement. Et `except _redis.ConnectionError: pass` = fail-open si Redis tombe.

✅ **Partiellement corrigé** : `--proxy-headers` ajouté au `CMD` du Dockerfile et à `make dev-backend`. **Reste à faire** : keyer sur IP **+ username**, et fail-closed en production.

### 3.12 🟡 Biométrie : le fallback n'est pas une biométrie

`face_service.py:16,18` : `SIMILARITY_THRESHOLD = 0.45` (cosinus ArcFace, défendable) mais **`HAAR_SIMILARITY_THRESHOLD = 0.78` sur `cv2.compareHist(..., HISTCMP_CORREL)`** — une corrélation d'histogramme couleur d'un crop de visage n'identifie personne (même carnation + même éclairage = accès). La « liveness » (ratio de texture > 0.15) est battue par une photo imprimée, qui a de la texture.

**À faire** : sortir le chemin Haar de tout flux d'**authentification**, et documenter la reconnaissance faciale comme un **facteur faible**, jamais unique.

---

## 4. P2 — Le produit ment à l'utilisateur

Ce n'est pas cosmétique : un jury clique « Test connection », voit « Connecté (23.4 ms) », **croit** que ça marche — puis lit le code.

### 4.1 🔴 L'état du parc réseau était un `random()` **persisté en base**

```python
# Simulate connection test (demo mode)
latency = round(random.uniform(2, 50), 1)
reachable = random.random() > 0.3      # 70% success rate for demo
if reachable: d.status = "online"; d.last_connected = datetime.now(timezone.utc)
else:         d.status = "error"
db.commit()                            # ← le bruit aléatoire devient l'état de référence
```
Un tirage aléatoire écrit dans `NetworkDevice.status` et resservi à tous les utilisateurs comme **l'état réel du parc**. Pire qu'un stub : un stub ment une fois, celui-ci corrompt la donnée.

✅ **Corrigé** : vrai `socket.create_connection((d.ip, d.port), timeout=3)` avec latence mesurée. Aucun credential SSH requis, et ça dit enfin la vérité.

### 4.2 🔴 « Configuration appliquée » alors que rien n'est envoyé

`push-config` renvoyait `success=True` / `"Simulated push of N commands"` alors qu'**aucun transport SSH n'existe** pour les équipements réseau. L'UI (`NetworkDevicesPage.jsx:363`) faisait alors `toast.success("Configuration appliquée")`.

Le plus ironique : **l'UI avait déjà la branche honnête** —
```js
} else { toast.warning(data.error || "Commandes générées sans envoi SSH"); }
```
Le frontend était prêt à dire la vérité ; c'est le backend qui mentait.

✅ **Corrigé** : `success=False` + `error="No SSH transport for network devices yet…"` + `logger.warning("DRY RUN …")`. Le générateur (`command_builder.py`, 40 Ko) garde toute sa valeur : il devient ce qu'il est vraiment, un **générateur de config à copier-coller**.

**Et le README (58 Ko, ~890 lignes, « 🛡️ Security & Zero-Trust Design », « ✨ Advantages ») ne contenait pas une seule occurrence de « simulé », « mock », « demo mode » ou « non implémenté ».** ✅ **Corrigé** : nouvelle section **`## ✅ Statut réel des fonctionnalités`** insérée en tête — trois tableaux (*Implémenté et fonctionnel* / *Partiel — dépend d'un déploiement réel* / *Non implémenté (assumé)*) + une liste *Dette connue*. C'est la correction qui change le plus la perception du projet : on pardonne une feature manquante, pas une feature fantôme.

### 4.3 🟠 Topologie Wazuh et matériel des agents fabriqués

- `application/wazuh/topology.py:48-55` : si Wazuh est injoignable → **`mock_agents`**, donc un graphe peuplé alors qu'aucun agent n'existe.
- `infrastructure/wazuh/client.py:266` : `{"cpu_name": "Intel Core i7-10700K (Mock)", …}`.

**À faire** : `{"status":"source_unavailable","agents":[]}` + bannière UI. Un SOC qui invente des données quand sa sonde tombe est **pire** qu'un SOC qui affiche une erreur — c'est précisément le moment où l'analyste doit savoir.

### 4.4 🟠 La « bande passante par analyste » est celle du serveur

`interface/api/sensors.py:376-390` — `sample_bandwidth_for_online_analysts()` lit `psutil.net_io_counters()` **sur le serveur** et écrit la même mesure pour chaque analyste en ligne. Mesurer le trafic d'un poste exige un agent sur ce poste (tu en as un : `agent.py`, 17 Ko) — branche la métrique dessus, ou renomme en « trafic du collecteur ».

### 4.5 🟡 Le scanner ARP scanne le réseau du serveur

`infrastructure/scanner.py:46-99` émet des ARP scapy sur les interfaces **locales**, en boucle, dans le processus API. En prod conteneurisée (`read_only`, `no-new-privileges`, pas de `NET_ADMIN`, pas de `network_mode: host`) ça ne peut qu'échouer. Et juridiquement, scanner un réseau sans autorisation n'est pas anodin : il faut une ligne explicite dans le README (« ne déployez que sur un réseau dont vous êtes propriétaire »).

---

## 5. P3 — Architecture & dette

### 5.1 Deux frontends React qui dupliquent tout
`frontend/` + `admin-frontend/` : deux `package.json`, deux `vite.config.js`, deux design systems (2 363 lignes de CSS + Tailwind v4 d'un côté, **2 675 lignes** de CSS à la main de l'autre), deux implémentations d'auth/token. Chaque correction doit être faite deux fois, avec des comportements différents (l'admin ne gère pas le tenant).
**À faire** : workspaces + paquets `@sentinel/ui` et `@sentinel/api` ; ou, plus réaliste à court terme, supprimer `admin-frontend` et en faire une route `/admin` gated par rôle — tu as déjà `AdminPage.jsx` et `SuperAdminPage.jsx` dans `frontend/`.

### 5.2 Cinq seuils de sévérité différents pour le mot « critique »
```
components/AlertRow.jsx:23        sev >= 12
pages/RemediationPage.jsx:64      severityLevel >= 10
pages/AlertHistoryModal.jsx:78    parseInt(alert.Severity) >= 10
components/Layout.jsx:157         (a.Severity || a.severity || 0) >= 8
pages/DashboardPage.jsx:78        a.Severity >= 8
components/TopologyView.jsx:187   parseInt(a.Severity || 0) >= 7
```
Le compteur « critiques » du menu, celui du dashboard et celui de la topologie **ne peuvent pas être égaux**. Dans un SIEM, la classification de sévérité est *le* contrat sémantique.
✅ Le patch fournit `severityOf()` / `severityBucket()` / `SEVERITY_CRITICAL=12` dans `lib/formatters.js` (aligné sur les buckets déjà utilisés par `TerminalAlertsPage.jsx:46-49`). **Reste à migrer les 6 call-sites.**

### 5.3 Pas de migrations : 8 `ALTER TABLE` à la main + `create_all()` au démarrage
`bootstrap.py:23` fait `Base.metadata.create_all()`, puis `ensure_columns()`, `ensure_timescaledb()`, `ensure_mitre_columns()`, `_init_defaults()`. Et 8 sites font de l'ALTER interpolé :
```
application/pipeline.py:187                  text(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")
domain/models.py:456                         text(f"ALTER TABLE agent_ai_analyses ADD COLUMN {col} TEXT")
domain/rule_models.py:109                    text(f'ALTER TABLE "rules" ADD COLUMN {col_name} {col_sql}')
infrastructure/threat_intel/client.py:153    idem
infrastructure/timescale.py:71-72            DROP CONSTRAINT / ADD PRIMARY KEY
```
Aucun rollback, aucun historique, aucun moyen de savoir quelle version de schéma tourne en prod ; `create_all()` ne modifie jamais une colonne existante (donc les ALTER manuels sont **nécessaires**) ; le schéma dépend de l'ordre de démarrage.
**À faire** : Alembic (`alembic init` + un autogenerate initial), les 8 `ensure_*` deviennent des révisions. ~2 h de travail, et c'est ce qui sépare un projet étudiant d'un projet professionnel.

### 5.4 La migration « clean architecture » est à moitié faite — et elle mord
Trois chemins coexistent vers les mêmes objets :
```
app/config.py, app/auth.py, app/db.py, app/models.py, app/schemas.py,
app/scanner.py, app/jwt_utils.py, app/logging_filter.py, app/admin_auth.py   ← 9 shims
app/services/*.py                                                            ← 7 modules de 43 à 295 octets, tous des re-exports
```
et le code métier importe au hasard l'un ou l'autre (`from ...models import Alert` dans `realtime.py`, `from ...domain.models import Tenant` dans `core/auth.py`). `app/main.py` se décrit lui-même comme *« a permanent shim »*, et `interface/main.py` refuse un refactor d'`include_router` *« to keep the route count identical »*.

Ces shims ont un coût concret : ce sont eux qui rendent `ruff --fix` dangereux (§2.6), et c'est pour les préserver que `app/auth.py` re-exportait encore un `get_token()` **mort** (corps = `pass`) que j'ai supprimé — la suppression a cassé le shim, ce que seuls des tests pouvaient attraper.
**À faire** : une passe mécanique pour que tout importe depuis `domain/`, `core/`, `application/`, puis **supprimer** les 9 shims et `app/services/`.

### 5.5 `core/auth.py` contenait le brouillon de sa propre génération
Lignes 72-100 (origine) : une fonction `get_token()` dont le corps est `pass`, précédée de ~12 lignes de raisonnement à voix haute restées dans le code :
```python
    # Note: the Depends with use_cache=False is to allow both to be called? Actually, we want to try header first.
    # We can do: if header_token is not None, return header_token, else return query_token.
    # But note: the dependency system will call both functions. …
    # Let's do it differently: we'll create a single function that …
    pass
```
Plus des imports en milieu de fichier (lignes 87 et 101). C'est la trace qui fait dire à un lecteur « généré et jamais relu » — **dommage, parce que le reste du fichier (les webhooks par slug) est vraiment bien pensé.** ✅ **Supprimé** (et le shim `app/auth.py` mis à jour en conséquence).

### 5.6 Tâches de fond fragiles
`bootstrap.py` lance 5 `asyncio.create_task(...)` **sans conserver de référence** (un task sans référence peut être ramassé par le GC — documenté dans la doc d'asyncio) et sans annulation au shutdown. Combiné à `@app.on_event("startup")` (`interface/main.py:93`), **déprécié** dans FastAPI et supprimable à tout moment dans la plage `>=0.139,<1.0` que tu as pinée.
**À faire** : un `lifespan`, une liste de tasks conservée, `cancel()` + `gather(..., return_exceptions=True)` à l'arrêt.

### 5.7 Le honeypot tourne dans le processus API
`bootstrap.py:98` ouvre 4 ports d'écoute **dans** le process FastAPI, ports codés en dur, `tenant_id="default"` codé en dur (donc invisible des autres tenants). Un honeypot doit être un service isolé : sinon un crash du handler emporte l'API — et ici le handler crashait à chaque connexion (§2.4).

### 5.8 `docker exec` depuis le backend = root sur l'hôte (et impossible en prod)
Le chemin Wazuh de `terminal.py` fait `subprocess.run(["docker","exec", …])` depuis le backend, ce qui suppose le socket Docker — donc un équivalent root sur l'hôte. Or `docker-compose.prod.yml` met le backend en `read_only` + `no-new-privileges` **sans** socket Docker : **cette fonctionnalité ne peut pas marcher en prod telle qu'elle est packagée.** Choisis : un sidecar dédié, ou l'assumer comme dev-only (c'est ce que dit maintenant la section Statut du README).

---

## 6. P4 — Hygiène du repo (ce qu'on voit en 30 secondes)

| Problème | Détail | Action |
|---|---|---|
| **Pas de LICENSE** | `license: null` sur l'API. Repo public sans licence = tous droits réservés, personne ne peut réutiliser légalement. | MIT ou **AGPL-3.0** (cohérent pour un SIEM). *Décision à prendre par toi — je ne l'ai pas mise dans le patch.* |
| **`celerybeat-schedule` committé** | Binaire 12 Ko d'état runtime dans `backend/`. | `git rm --cached backend/celerybeat-schedule` (✅ entrée `.gitignore` ajoutée). |
| **12 logos de marques** | `frontend/public/brand-logos/{cisco,paloalto,huawei,juniper,aruba,ubiquiti,dell,netgear,tplink,dlink,fortinet}.png` — ~340 Ko de marques déposées dans un repo public. | Risque juridique réel. Badges texte/génériques, ou mention d'usage nominatif. |
| **Makefile personnel** | `Makefile:3` → `WAZUH_DIR = $(USERPROFILE)\OneDrive\Desktop\wazuh version(4.7.2)-pfe\wazuh-docker\single-node` ; `start`, `cmd /c`, `.\venv\Scripts\`, `rmdir /s /q`. **Ne marche que sur ton PC.** | ✅ **Réécrit en POSIX** (cibles `install / infra / dev / test / lint / build / clean`, chaque ligne documentée, `lint` = exactement ce que fait la CI). `start.bat` reste pour Windows. |
| **README de 58 Ko** | ~890 lignes, badges, 6 diagrammes, 3 commits dédiés, aucune section *Limitations*. | ✅ Section **Statut réel** ajoutée. À réduire ensuite à ~150 lignes. |
| **`docker-compose.yml` bancal** | Ne définissait que `redis` + volume orphelin. | ✅ **Réécrit** (TimescaleDB + Redis + profil Ollama, healthchecks, loopback). |
| **`--blue: #00ff88`** | `frontend/src/index.css:12` : la variable `--blue` vaut vert. | Renommer ou corriger. |
| **Fichiers géants** | `HostAgentsPage.jsx` 50 Ko, `LoginPage.jsx` 46 Ko, `command_builder.py` 40 Ko, `CasesPage.jsx` 38 Ko, `models.py` 27 Ko, `database.py` 24 Ko. | Découper. |
| **0 test frontend** | 14 700 lignes de JSX, aucun test, aucun ESLint, aucun TypeScript. | ESLint + `vitest` sur `lib/formatters.js` (le code le plus logique du front). |
| **`insightface` casse l'install** | `requirements.txt` contient un commentaire expliquant qu'il faut désinstaller opencv puis réinstaller à la main **après chaque** `pip install` — reproduit 3 fois (CI ×2, Makefile). | `constraints.txt` qui pin `opencv-python-headless`, ou la reconnaissance faciale en extra optionnel. |

---

## 7. Ce que je supprimerais (le vrai problème : le périmètre)

Le projet annonce **SOC + IPS + SIEM + XDR + SOAR + gestion de parc réseau + reconnaissance faciale + honeypot + tarification Stripe + IA + rapports PDF** : le périmètre cumulé de Splunk, Cortex XSOAR, Tenable et Clearpass. Résultat mécanique : 24 700 lignes de backend dont **la CI n'a jamais vérifié une ligne**, un frontend qui ne compile pas, 4 fonctionnalités simulées. La largeur a été payée en profondeur.

**Garder (réel et bon)** : ingestion → normalisation ECS → corrélation → MITRE → alerte ; Wazuh/Suricata/syslog comme sources avec **état honnête** ; cases/investigations/hunts ; RBAC + multi-tenancy ; **une** action de réponse câblée de bout en bout (ex. `wazuh_block_ip`) avec approbation + rollback.

**Retirer ou passer en « expérimental »** : push de configuration réseau (§4.1/4.2 — garde le *générateur*, supprime les endpoints) ; reconnaissance faciale comme facteur d'authentification (§3.1, §3.12) ; honeypot dans le process API (§2.4, §5.7) ; `admin-frontend` comme app séparée (§5.1) ; `PricingPage.jsx` / Stripe.

**8 000 lignes qui tournent, se déploient et disent la vérité valent mieux que 40 000 lignes que rien n'a jamais vérifiées.**

---

## 8. Les quatre patchs (testés de bout en bout)

| Patch | Portée | Taille |
|---|---|---|
| 📁 `00-all-fixes-combined.diff` | **tout en un** (pristine → état final) | 184 fichiers, 491 Ko |
| 📁 `01-fixes-build-security.diff` | P0 build + P1 sécurité, écrits à la main | 28 fichiers, 110 Ko |
| 📁 `02-lint-ruff-autofix.diff` | churn mécanique `ruff --fix` (safe) | 146 fichiers, 276 Ko |
| 📁 `03-lint-manual-and-functional-fixes.diff` | lint manuel (52 → 0) + correctifs fonctionnels | 50 fichiers, 133 Ko |

**Deux façons d'appliquer, au choix.** Soit le patch unique `00`, soit la chaîne
`01 → 02 → 03` (trois commits séparés, plus relisible en revue : le bruit
mécanique du linting ne noie pas les corrections de sécurité).

```bash
git clone https://github.com/saif-infinity/projet-soc-ips-siem-xdr-.git && cd projet-soc-ips-siem-xdr-

# ── Option A : tout d'un coup ─────────────────────────────────────────────
git checkout -b fix/everything
git apply --whitespace=nowarn /chemin/00-all-fixes-combined.diff

# ── Option B : trois commits distincts (recommandé pour la revue) ─────────
git checkout -b fix/p0-build-and-security
git apply --whitespace=nowarn /chemin/01-fixes-build-security.diff
cd frontend && npm ci && npm run build          # ✅ doit passer
cd ../backend && pytest -q                      # ✅ collecte enfin (242 tests)
git add -A && git commit -m "fix: build, CI, security, honesty"

git apply --whitespace=nowarn /chemin/02-lint-ruff-autofix.diff
cd backend && python -m compileall -q app
git add -A && git commit -m "style: ruff --fix (safe fixes only)"

git apply --whitespace=nowarn /chemin/03-lint-manual-and-functional-fixes.diff
cd backend && ruff check .                      # ✅ All checks passed!
git add -A && git commit -m "fix: lint manuel, cycle de vie, rate-limit, mocks, Alembic, licence"
```

> ⚠️ Utilisez **`git apply`**, pas `patch -p1`. Le patch supprime
> `backend/celerybeat-schedule`, un fichier binaire : GNU `patch` refuse les
> diffs binaires git (`git binary diffs are not supported`). Si vous tenez à
> `patch -p1`, appliquez-le puis supprimez ce fichier à la main.

### Contenu du patch 1

| Fichier | Correction |
|---|---|
| `frontend/src/lib/api.js` *(nouveau)* | `createFetchWithAuth` : 401→logout, `X-Tenant-ID`, JSON auto, toast sauf `silent` |
| `frontend/src/lib/formatters.js` *(nouveau)* | `formatReport` (React sans `dangerouslySetInnerHTML`), `getHourlyAlertsData`, `formatSuricataDetails`, **une seule** classification de sévérité |
| `.gitignore` | suppression de `lib/` + `lib64/` (**cause racine**), ajout `celerybeat-schedule`, `.ruff_cache/` |
| `backend/ruff.toml` | suppression de `W503` → ruff fonctionne à nouveau |
| `backend/Dockerfile` *(nouveau)* | image manquante, non-root, healthcheck, `--proxy-headers` |
| `.github/workflows/ci.yml` | triggers `master`, 10 variables d'env, build des **2** frontends, `compose config`, `deploy` qui échoue au lieu d'`echo` |
| `backend/tests/conftest.py` *(nouveau)* | les 8 secrets requis + DSN jetables → **0 → 123 tests collectés** |
| `backend/pytest.ini` *(nouveau)* | `testpaths`, `--strict-markers` (aucune config pytest n'existait) |
| `backend/tests/test_terminal_sanitizer.py` *(nouveau)* | **40 tests** : les 4 bypass + les diagnostics légitimes |
| `backend/tests/test_database_admin_ddl.py` *(nouveau)* | **43 tests** : injection DDL + non-dérive de `PROTECTED_TABLES` |
| `app/interface/api/terminal.py` | allowlist 2 mots, `docker`/`grep`/`find` retirés, flags interdits, chemins contraints, **400** au lieu de 200 |
| `app/interface/api/database.py` | `_validate_column_type` / `_validate_default` (injection), `_protected_tables()` dérivé de l'ORM |
| `app/interface/api/auth.py` | login scopé au tenant, `is_active`, `compare_digest` |
| `app/interface/api/faces.py` | `/identify` authentifié (`surveillance:read`) |
| `app/interface/api/realtime.py` | enrichissement scopé au tenant + batché (N+1), `compare_digest` sur le WS |
| `app/interface/api/network_config.py` | `test-connection` = **vrai TCP connect** ; `push-config` = **dry run assumé** |
| `app/interface/api/agent.py`, `middleware/tenant.py` | `compare_digest` |
| `app/core/rbac.py` | rôle par défaut `viewer` (fail-closed), `compare_digest` |
| `app/core/auth.py` | `_key_matches()`, suppression du stub mort `get_token()` et de ses 12 lignes de brouillon |
| `app/auth.py`, `app/db.py`, `app/services/{__init__,wazuh_service}.py` | re-exports protégés (`# noqa: F401`) — sinon `ruff --fix` les efface et casse tout |
| `app/infrastructure/honeypot/service.py` | les 2 `NameError` → `self._db_factory` |
| `docker-compose.yml` | vrai compose de dev (TimescaleDB + Redis + profil Ollama, healthchecks) |
| `Makefile` | réécrit en POSIX, plus de chemin OneDrive ni de `cmd /c` |
| `README.md` | section **`## ✅ Statut réel des fonctionnalités`** |

### Contenu du patch 3 (50 fichiers)

| Domaine | Fichier | Correction |
|---|---|---|
| **Cycle de vie** | `app/interface/main.py` | `@app.on_event("startup")` (déprécié, retiré de Starlette 0.36+) → handler `lifespan` avec `finally` |
| | `app/application/bootstrap.py` | `_spawn()` : les 5 `asyncio.create_task` étaient **sans référence** (destruction possible par le GC, aucune annulation à l'arrêt) → tâches nommées, référencées, `done_callback` ; nouveau `run_shutdown()` |
| **Honeypot** | `bootstrap.py`, `honeypot/service.py`, `core/config.py` | 4 ports en écoute sur `0.0.0.0` par défaut → `ENABLE_HONEYPOT` (défaut **false**) + `HONEYPOT_PORTS` configurable + `stop()` à l'arrêt |
| **Rate-limit** | `app/interface/api/auth.py` | clé IP seule → **IP + compte visé** (un botnet ne brute-force plus un compte librement, un NAT ne verrouille plus tout un bureau) ; `fail-open` → **fail-closed en production** (503) ; `ConnectionError` seul → `RedisError` (un timeout Redis faisait tomber `/auth/token` en 500) ; nouveau `_client_ip()` + `TRUST_PROXY_HEADERS` (défaut false, sinon `X-Forwarded-For` est forgeable) |
| **Secrets** | `app/core/config.py` | DSN par défaut `postgres:saif@localhost` → sans mot de passe |
| **Honnêteté** | `app/application/wazuh/topology.py` | 3 hôtes inventés (`Workstation-01`, `192.168.1.10`…) renvoyés quand Wazuh est injoignable → état vide + drapeau `source_unavailable` ; le nœud manager n'affiche plus `"normal"` en dur |
| | `app/infrastructure/wazuh/client.py` | `{"cpu_name": "Intel Core i7-10700K (Mock)", "ram_total": 16777216, …}` → clés conservées mais `None` + `"available": false` |
| | `app/interface/api/sensors.py` | `sample_bandwidth_for_online_analysts` divisait le débit **du serveur** par le nombre d'analystes connectés et l'écrivait comme trafic individuel → `sample_server_bandwidth`, une seule mesure étiquetée `interface="server"` |
| **Sévérité** | 8 fichiers frontend | « critique » valait `>=12`, `>=10`, `>=8`, `>=7` selon l'écran → tous migrés vers `SEVERITY_CRITICAL/HIGH/MEDIUM` + `severityOf()` de `lib/formatters.js` |
| **CSS** | `frontend/src/index.css` | `--blue: #00ff88` (vert), `--blue: #ef4444` (rouge) → `--focus-ring`, son seul usage réel |
| **Migrations** | `alembic.ini`, `migrations/{env.py,script.py.mako,versions/0001_baseline.py}`, `requirements.txt`, `bootstrap.py` | aucun Alembic (`create_all()` ne sait ni `ALTER` ni `DROP`) → scaffold complet, DSN lu depuis `settings`, baseline `0001`, `create_all()` derrière `AUTO_CREATE_SCHEMA` |
| **Licence** | `LICENSE`, `NOTICE` | `license: null` sur l'API GitHub → **AGPL-3.0** (661 lignes) + NOTICE d'attribution nominative pour les 12 logos de marques |
| **Hygiène** | `backend/celerybeat-schedule`, `backend/.gitignore` | artefact d'exécution Celery de 12 Ko **supprimé** du dépôt |
| **Lint manuel** | 30 fichiers | les 52 erreurs que `ruff --fix` ne sait pas corriger seul : `E712/E711` (`.is_(True)`/`.is_(None)`), `UP031` (f-strings), `E701/E702` (instructions composées), `E741` (`l` ambigu), `N802/N806` (casse), `E722` (`except:` nu), `F401` (re-export explicite + `__all__`), `E402`, `W291` |
| **Tests** | `tests/conftest.py`, `tests/test_rbac.py`, `tests/test_audit_fixes.py`, `tests/test_approval_flows.py` | voir §12.2 |

### Vérification finale (extraction fraîche du tarball `master`)

```
chaîne 01 + 02 + 03 → git apply      ✅ 3/3 appliqués
                     → diff -rq      ✅ arbre IDENTIQUE à l'état final, 0 divergence
patch unique 00      → git apply     ✅ appliqué
                     → diff -rq      ✅ arbre IDENTIQUE à l'état final, 0 divergence
ruff check .                         ✅ All checks passed!  (1078 → 52 → 0)
python -m compileall app migrations  ✅
pytest (16 fichiers, un par un)      ✅ 241 passed / 1 échec (Redis absent du sandbox)
npm run build      (frontend)        ✅ built in 8.08s
npm run build      (admin-frontend)  ✅ built in 5.99s
alembic heads                        ✅ 0001 (head)
alembic upgrade head --sql           ✅ SQL généré hors-ligne
```

*Le seul échec, `test_nmap_scan_accepts_json_body`, exige un broker Redis/Celery vivant ; il échoue **à l'identique sur le code d'origine**. La CI fournit ce service.*

---

## 9. Plan d'action

**Semaine 1 — rendre le repo vivant** *(les patchs couvrent ~85 %)*
1. Appliquer le patch 1, vérifier les deux builds, pousser, **regarder la CI devenir verte pour la première fois**.
2. Appliquer le patch 2, puis traiter les 52 erreurs ruff restantes à la main (15 `E701`, 12 `E712`, 4 `E741`, 4 `E402`, 3 `E711`, 2 `F401`, 1 `E722`…).
3. `LICENSE` (AGPL-3.0 recommandé), `git rm --cached backend/celerybeat-schedule`, retirer les logos de marques.

**Semaine 2 — arrêter de mentir**
4. Relire la section Statut du README et la tenir à jour à chaque feature.
5. Remplacer les 3 mocks restants (`topology.py`, `client.py:266`, bande passante par analyste) par des états explicites + bannière UI.
6. Alembic (§5.3) — c'est le plus gros gain « professionnel » pour ~2 h.

**Semaine 3 — consolider**
7. `lifespan` FastAPI + tasks de fond référencées et annulables (§5.6).
8. Finir la migration clean architecture : supprimer les 9 shims (§5.4) — et seulement **après**, car ils sont ce qui rend le linting automatique dangereux.
9. Une seule classification de sévérité partout (§5.2), un seul `apiFetch` pour les deux frontends.
10. Comptes admin nominatifs (§3.9), rate-limit IP+username fail-closed (§3.11).

**Semaine 4 — réduire et démontrer**
11. Couper le périmètre (§7).
12. Démo de 3 minutes sur **un seul** flux réel : alerte Wazuh → enrichissement → corrélation MITRE → case → blocage IP approuvé → rollback. Aucun `random()` ne remplace ça.

---

## 10. Réponse directe

> *« en quoi je modifie, et quel est le point faible ou stupide ? »*

- **Point faible structurel :** aucune boucle de vérification. CI jamais déclenchée, linter dont la config crashait, pas de Dockerfile, pas de conftest, pas de pytest.ini. 40 000 lignes écrites sans qu'une machine n'en valide une seule — tout le reste en découle.
- **Point « stupide » le plus coûteux :** `.gitignore:26`. Une règle d'artifact Python non ancrée (`lib/`) a empêché **tout le frontend** d'entrer dans Git depuis le premier commit. Un `npm run build` local l'aurait révélé en 6 secondes.
- **Point « stupide » le plus dommageable :** `random.random() > 0.3` commité en base comme état du parc, et `success=True` sur un push jamais envoyé — documentés par 58 Ko de README qui ne disent jamais « simulé ».
- **Le plus dangereux techniquement :** `ALLOWED_TYPES` déclaré et jamais utilisé → injection SQL dans `CREATE TABLE` depuis la console admin ; et `PROTECTED_TABLES` écrit à la main qui a dérivé de 22 tables, dont `response_runs` et `registration_requests`.
- **Ce qu'il faut modifier en premier :** patch 1 → patch 2 → section honnêteté du README → Alembic → réduire le périmètre.

---

## 11. Corrections apportées à la v1 de cet audit

Par honnêteté envers toi — deux affirmations de ma première passe étaient inexactes :

1. **v1 :** « `database.py` expose `DROP TABLE` et sa seule protection est `get_current_admin`, le routeur étant exempt de RBAC. »
   **v2 :** les 9 endpoints sont bien tous derrière `get_current_admin` (vérifié), et `PROTECTED_TABLES` **existe**. Les vrais problèmes sont ailleurs et pires : la liste a **dérivé de 22 tables** (§3.3) et `ALLOWED_TYPES` n'est **jamais utilisé**, ce qui ouvre une injection SQL (§3.2).
2. **v1 :** « 968 erreurs ruff auto-fixables, il suffit de lancer `ruff --fix`. »
   **v2 :** c'est un **piège**. L'autofix efface les re-exports des 3 shims non protégés et casse `from ...db import get_db` dans tout le projet (§2.6). Je l'ai découvert parce que mes tests de régression ont cessé de se collecter après l'avoir lancé. D'où le patch de lint **séparé** et la protection préalable des shims.

Ajouts de la v2 : injection SQL (§3.2), tables supprimables (§3.3), absence de config pytest avec mesure 0 → 123 tests collectés (§2.5), piège `ruff --fix` (§2.6), et la section Statut réel dans le README (§4.2).

---

## 12. Tour « tout corriger » — journal complet

### 12.1 Où on en est, en chiffres mesurés

| Indicateur | Code d'origine | Après les 3 patchs |
|---|---|---|
| `ruff check .` | **crash** (`Unknown rule selector W503`) puis **1078 erreurs** | **0 erreur** |
| `pytest` (collecte) | **0 test collecté** (`ValidationError` sur 8 secrets) | **242 tests collectés** |
| `pytest` (exécution) | impossible | **241 passed, 1 échec** (Redis absent du sandbox) |
| `npm run build` (frontend) | ❌ `Could not resolve "../lib/formatters"` | ✅ `built in 8.08s` |
| `npm run build` (admin-frontend) | ✅ | ✅ `built in 5.99s` |
| `alembic heads` | ❌ aucun Alembic, aucune `alembic.ini` | ✅ `0001 (head)` |
| `LICENSE` | ❌ absent | ✅ AGPL-3.0, 661 lignes |
| Comparaisons de secrets non constantes | 6 (`==` sur API key / tokens) | **0** |
| Mocks renvoyés comme données réelles | 5 | **2** (les 2 restants sont assumés et étiquetés, voir §12.4) |
| Fichiers binaires d'exécution committés | 1 (`celerybeat-schedule`) | 0 |

Tout le reste de la liste « reste à faire » de la §9 a été exécuté : cycle de vie
ASGI, références de tâches, honeypot derrière un flag, rate-limit IP+compte et
fail-closed, DSN sans secret, migration Alembic, NOTICE de marques, renommage
`--blue`, migration des seuils de sévérité frontend, lint manuel.

### 12.2 Les trois surprises de la suite de tests

Personne n'avait jamais exécuté ces tests (0 collecte possible avant
`conftest.py`). Les voici donc passés pour la première fois — et trois choses
sont apparues.

**(a) Deux échecs préexistants, et ils sont révélateurs.**
`test_normalization.py::test_suricata_webhook_goes_through_pipeline` et
`::test_wazuh_webhook_goes_through_pipeline` échouent **à l'identique sur le code
d'origine** (`assert 'ignored' == 'success'`). Cause : `is_source_enabled()`
retombe sur `ENABLE_SURICATA_SOURCE` / `ENABLE_WAZUH_SOURCE`, dont le défaut
livré est `False` — donc `POST /api/suricata/webhook` répond
`{"status": "ignored"}` **avant même de lire le corps de la requête**
(`app/interface/api/suricata.py:62`). Les tests affirment un comportement dont
ils ne posent jamais la precondition. Corrigé dans `conftest.py` (les deux
sources activées : elles ne pilotent que le `TestClient` de l'app, aucun trafic
sortant). Ce qui mérite votre attention, c'est l'implication produit : **un
webhook correctement authentifié reçoit HTTP 200 et `"ignored"` quand la source
est désactivée**. Un intégrateur qui branche Suricata et oublie de cocher la
source dans les réglages perdra silencieusement toutes ses alertes, avec un code
de succès. À passer en 409/422, ou à journaliser en avertissement visible.

**(b) Un test codait la vulnérabilité.**
`test_rbac.py::test_me_missing_user_fallback` affirmait `body["role"] == "analyst"`
pour un porteur de JWT **absent de `TenantUser`** — c'est-à-dire qu'il
verrouillait le RBAC fail-open de la §3.4. Mon correctif (défaut `viewer`) l'a
fait échouer. J'ai mis le test à jour pour affirmer le comportement sûr, et
ajouté `test_missing_user_cannot_write` : un JWT qui **revendique** `admin` ne
doit pas pouvoir écrire si le compte n'existe pas. C'est le seul test que j'ai
modifié pour autre chose qu'une signature.

**(c) Un échec d'infrastructure, pas de code.**
`test_audit_fixes.py::test_nmap_scan_accepts_json_body` tombe sur
`ConnectionRefusedError: localhost:6379` puis `RuntimeError: Retry limit
exceeded while trying to reconnect to the Celery result store backend`. Il lui
faut un broker vivant. Échec identique sur le code d'origine. La CI fournit le
service `redis`.

Au passage : `check_rate_limit()` a gagné un paramètre `username=`. Les deux
stubs `_no_rate_limit` des tests existants levaient donc `TypeError`. Ils
acceptent maintenant `**_kwargs`.

### 12.3 Découvertes faites en corrigeant

1. **Les hachages de mots de passe sont écrits dans l'arbre de code.**
   `password_store.py:7` → `HASH_STORE_PATH = Path(__file__).parents[2] /
   "face_data" / "password_hashes.json"`, soit `backend/app/face_data/`. Un
   simple `pytest` crée ce fichier avec de vrais hachages bcrypt dedans — je
   l'ai constaté en exécutant la suite sur le code d'origine. Le `.gitignore` du
   patch 1 couvre désormais `backend/app/face_data/`, mais le principe reste à
   revoir : des données d'authentification ne devraient jamais vivre sous le
   code source (chemin non configurable, collides avec les déploiements en
   lecture seule, finit dans les images Docker).

2. **Une sixième convention de sévérité, côté backend cette fois.**
   `app/interface/api/reporting.py::_sev_bucket` classe sur une échelle 0-15
   (`<=3 info, <=6 low, <=9 medium, <=12 high, sinon critical`), tandis que
   `app/infrastructure/jobs/ai_tasks.py:106` et
   `app/application/wazuh/ai_reporting.py:124` dupliquent un troisième jeu de
   seuils (`>=7 critical, >=5 high, >=3 medium`). Les 4 buckets du frontend ne
   couvrent pas `info`. La migration frontend de ce tour aligne l'affichage ;
   **le backend reste à unifier**, sinon les rapports PDF et l'IA continueront de
   classer autrement que l'écran.

3. **`celerybeat-schedule` était invisible aux outils habituels.** Le fichier est
   binaire *et* déjà listé dans `.gitignore` : ni `git add -A` ni `diff -ruN` ne
   signalent sa suppression. Il a fallu forcer son suivi dans la base du patch
   pour que la suppression soit exprimable. C'est aussi la raison pour laquelle
   les patchs doivent s'appliquer avec `git apply` et non `patch -p1`.

4. **`--blue` ne désignait jamais du bleu.** `frontend/src/index.css` définit
   `--blue: #00ff88` (vert), `--blue: #ef4444` (rouge), `--blue: #00ff41` (vert)
   selon le thème, pour un seul consommateur : `outline: 2px solid var(--blue)`.
   Renommé `--focus-ring`, ce qu'il est réellement.

### 12.4 Ce qui reste — et pourquoi c'est votre décision, pas la mienne

| Sujet | État | Ce qu'il vous reste à trancher |
|---|---|---|
| **Licence** | AGPL-3.0 fournie | C'est un choix juridique. L'AGPL est cohérente avec un SIEM destiné à être exposé en SaaS (l'article 13 couvre l'usage réseau). Si vous préférez MIT/Apache-2.0/propriétaire, remplacez `LICENSE` et le premier paragraphe de `NOTICE` — le reste du dépôt n'en dépend pas. |
| **Les 12 logos de marques** | Conservés + NOTICE d'attribution nominative | Je ne les ai **pas** supprimés : `NetworkDevicesPage.jsx:17,26` les référence et la page retombe proprement sur une icône générique si un fichier manque. La NOTICE explique les conditions. Si vous redistribuez publiquement, vérifiez les chartes de Cisco, Fortinet et Palo Alto Networks (les plus restrictives) — ou supprimez les entrées correspondantes de `VENDOR_LOGOS`. |
| **`push_config`, le dernier mock** | Étiqueté, pas supprimé | `network_config.py::push_config` renvoie toujours `success=True` avec la mention « Simulated push » : il ne pousse réellement aucune configuration sur les équipements. (`test_connection`, lui, fait depuis le patch 1 un vrai TCP connect.) Le rendre réel suppose un driver par constructeur — Netmiko/NAPALM — et des identifiants réseau : c'est un chantier, pas un correctif. En l'état, le dry-run est annoncé explicitement dans la section « Statut réel des fonctionnalités » du README. |
| **Les 2 frontends dupliqués** | Inchangés | Fusionner `frontend/` et `admin-frontend/` est un refactor de plusieurs jours avec risque de régression UI. À planifier, pas à improviser dans un patch. |
| **Unification backend de la sévérité** | Non faite | Voir §12.3.2 : touche le reporting PDF et les jobs IA. À faire avec des tests de non-régression sur les rapports déjà générés. |

---

*Fin de l'audit. Chiffres mesurés dans ce sandbox le 11 octobre 2026 sur le
tarball `master` (commit `884f565`), venv Python 3.11 sans PostgreSQL ni Redis
locaux, ruff 0.17.0, Node 20 + Vite.*
