# Monday Task Bridge

[English](README.md) · Français · [Tiếng Việt](README.vi.md)

Auteur : **Nhat Nguyen** · Développé par **Nexkit** · [nathanpixodeo@gmail.com](mailto:nathanpixodeo@gmail.com)

*Ce document est une traduction du README anglais. Si les deux versions diffèrent, le [README anglais](README.md) fait foi.*

Permettez à un agent IA (Claude Code, Codex, agy ou tout client MCP) de lire les tâches monday.com, avec leurs mises à jour (updates) et leurs images originales, via **votre Chrome connecté à monday**. Vous n'avez besoin ni d'un token d'API monday, ni d'une app installée par un administrateur, ni d'une offre MCP monday : connectez-vous une fois à monday dans Chrome, et l'extension fait le reste.

Le projet comprend deux parties qui s'exécutent sur votre PC :

- **Une extension Chrome** qui lit les tâches avec votre session monday.
- **Un bridge local avec un serveur MCP**, avec lequel votre agent communique. Le bridge écoute uniquement sur `127.0.0.1:3457`.

> **État du projet :** prototype personnel. La vérification des types (typecheck), la compilation (build) et les tests automatisés passent en CI, et la lecture des tâches a été vérifiée sur de vraies tâches monday. Considérez `complete` comme un signal indicatif, sans garantie, et lisez `warnings` avant de vous fier à un instantané (snapshot).

## Démarrage rapide

Il vous faut :

- Google Chrome, connecté à monday.com
- [Node.js](https://nodejs.org) 22.12 ou plus récent, et [Git](https://git-scm.com)
- Au moins une CLI d'agent : Claude Code, Codex ou agy

### 1. Lancer l'installeur

Ouvrez un terminal et lancez une seule commande.

Windows (PowerShell) :

```powershell
irm https://raw.githubusercontent.com/nathanpixodeo/monday-task-bridge/main/scripts/install.ps1 | iex
```

macOS / Linux :

```sh
curl -fsSL https://raw.githubusercontent.com/nathanpixodeo/monday-task-bridge/main/scripts/install.sh | bash
```

L'installeur :

- télécharge le code et le compile,
- installe la [commande `monday-bridge`](#la-commande-monday-bridge), qui fonctionne depuis n'importe quel dossier,
- enregistre le serveur MCP auprès de chaque CLI d'agent qu'il trouve (Claude Code, Codex, agy) ; vous n'avez aucune commande `mcp add` à lancer vous-même,
- autorise ces CLI à lire monday sans vous demander à chaque fois ([mode d'approbation](#mode-dapprobation--auto-ou-manuel) `auto`),
- démarre le bridge,
- ouvre `chrome://extensions` et attend que vous chargiez l'extension et que vous l'appairiez (étapes 2 et 3).

Gardez le terminal ouvert jusqu'à ce qu'il affiche **Done**.

### 2. Charger l'extension dans Chrome

Faites-le dans le profil Chrome connecté à monday.com.

1. Ouvrez `chrome://extensions` (l'installeur l'ouvre pour vous).
2. Activez le **Mode développeur** (Developer mode), en haut à droite.
3. Cliquez sur **Charger l'extension non empaquetée** (Load unpacked) et choisissez le dossier de l'extension. L'installeur copie son chemin dans le presse-papiers (sous Windows et macOS) :

   | OS | Dossier de l'extension |
   | --- | --- |
   | Windows | `%LOCALAPPDATA%\Programs\monday-task-bridge\dist\extension` |
   | macOS / Linux | `~/.monday-task-bridge/dist/extension` |

4. Épinglez **Monday Task Bridge** dans la barre d'outils pour ouvrir sa popup en un clic.

### 3. Appairer l'extension avec le bridge

1. Ouvrez la popup de l'extension et appuyez sur le **power button** (bouton marche/arrêt). La popup affiche un code à 6 chiffres.
2. Saisissez ce code dans le terminal de l'installeur et appuyez sur Entrée.
3. La popup affiche **Connected**. L'installeur se termine par **Done**.

Le code expire au bout de deux minutes. S'il a expiré, appuyez à nouveau sur le power button pour obtenir un nouveau code.

### 4. Redémarrer votre agent et le tester

Redémarrez toute session Claude Code, Codex ou agy déjà ouverte, pour qu'elle charge les nouveaux outils. Vérifiez que le serveur est bien présent :

```powershell
claude mcp list    # ou : codex mcp list / agy mcp list
```

`monday-task-bridge` doit figurer dans la liste (Claude Code affiche `✔ Connected`). Demandez ensuite à votre agent, par exemple :

> Lis cette tâche monday : https://your-team.monday.com/boards/123/pulses/456

> Liste les tâches monday qui me sont assignées.

Chrome doit être lancé, avec le power button de l'extension activé, chaque fois qu'un agent lit monday.

## La commande monday-bridge

L'installeur ajoute une commande `monday-bridge` au dossier global de npm, comme les commandes `claude`, `codex` et `agy`. Lancez-la depuis n'importe quel dossier, dans n'importe quel terminal :

| Commande | Ce qu'elle fait |
| --- | --- |
| `monday-bridge status` | Indique si le bridge tourne, s'il est appairé et si l'extension est connectée, ainsi que les dossiers d'installation, de l'extension et de données. |
| `monday-bridge start` | Démarre le bridge en arrière-plan. Vous en avez rarement besoin : les agents démarrent le bridge d'eux-mêmes. |
| `monday-bridge stop` | Arrête le bridge. Le prochain appel d'un agent le redémarre. |
| `monday-bridge run` | Lance le bridge dans la fenêtre courante, avec son journal à l'écran. Ctrl+C l'arrête. |
| `monday-bridge pair 123456` | Approuve le code à 6 chiffres affiché dans la popup de l'extension. |
| `monday-bridge approval auto` | Permet aux agents de lire monday sans demande de confirmation oui/non à chaque fois. `manual` les fait demander de nouveau ; `status` affiche le mode. Voir [Mode d'approbation](#mode-dapprobation--auto-ou-manuel). |
| `monday-bridge help` | Liste les commandes. |

La commande est un lien vers le dossier d'installation : les mises à jour ne demandent donc aucune réinstallation.

## Mettre à jour, appairer à nouveau, désinstaller

**Mettre à jour :** relancez la commande d'installation. Cliquez ensuite sur **Actualiser** (Reload) sur la carte Monday Task Bridge dans `chrome://extensions`.

**Appairer à nouveau** (après **Unpair**, un nouveau profil Chrome ou un code expiré) : ouvrez la popup, appuyez sur le power button et approuvez le nouveau code depuis n'importe quel terminal :

```powershell
monday-bridge pair 123456
```

La popup affiche cette commande avec votre code, prête à être copiée.

**Un autre profil Claude Code :** Claude Code conserve ses réglages par profil. Faites pointer `CLAUDE_CONFIG_DIR` vers l'autre profil et relancez l'installeur :

```powershell
$env:CLAUDE_CONFIG_DIR = "$HOME\.claude-profiles\other-profile"
irm https://raw.githubusercontent.com/nathanpixodeo/monday-task-bridge/main/scripts/install.ps1 | iex
```

**Désinstaller :**

1. Retirez les règles d'approbation et le serveur MCP de chaque CLI d'agent, arrêtez le bridge et supprimez la commande `monday-bridge` :

   ```powershell
   monday-bridge approval manual
   claude mcp remove -s user monday-task-bridge
   codex mcp remove monday-task-bridge
   agy mcp remove monday-task-bridge
   monday-bridge stop
   npm uninstall -g monday-task-bridge
   ```

2. Cliquez sur **Supprimer** (Remove) sur la carte de l'extension dans `chrome://extensions`.
3. Supprimez le dossier d'installation : `%LOCALAPPDATA%\Programs\monday-task-bridge` sous Windows, `~/.monday-task-bridge` sous macOS/Linux.
4. Supprimez le dossier de données (voir [Données locales et confidentialité](#données-locales-et-confidentialité)).

### Options de l'installeur

Définissez ces variables d'environnement avant de lancer l'installeur :

| Variable | Effet |
| --- | --- |
| `MONDAY_BRIDGE_HOME` | Installer dans un autre dossier. |
| `MONDAY_BRIDGE_CLIENTS` | Les CLI d'agent à enregistrer, séparées par des virgules. La valeur par défaut est `claude,codex,agy` ; `none` n'en enregistre aucune. |
| `MONDAY_BRIDGE_APPROVAL` | `auto` (par défaut) ou `manual` ; voir [Mode d'approbation](#mode-dapprobation--auto-ou-manuel). |
| `CLAUDE_CONFIG_DIR` | Le profil Claude Code dans lequel enregistrer le serveur. |

## Mode d'approbation : auto ou manuel

Par défaut, une CLI d'agent vous demande d'approuver chaque appel d'outil MCP : chaque lecture monday s'arrête donc sur une demande de confirmation oui/non. Le mode d'approbation règle ce comportement pour les outils du bridge, dans Claude Code, Codex et agy à la fois :

- **`auto`** : l'agent lit les tâches, les tableaux (boards) et les images sans demander. L'installeur active ce mode.
- **`manual`** : l'agent demande avant chaque lecture, comme les CLI le font par défaut.

Vous pouvez changer de mode à tout moment, depuis n'importe quel dossier. Redémarrez ensuite les sessions d'agent ouvertes :

```powershell
monday-bridge approval auto      # lire sans demander
monday-bridge approval manual    # demander avant chaque lecture
monday-bridge approval status    # afficher le mode de chaque CLI
```

`auto` ne couvre que les outils de lecture. `monday_write_back` demande toujours une confirmation. La commande écrit les règles suivantes, et `manual` les retire :

| CLI | Fichier | Règle pour chaque outil de lecture |
| --- | --- | --- |
| Claude Code | `settings.json` dans le dossier du profil (`~/.claude`, ou `CLAUDE_CONFIG_DIR`) | `permissions.allow`: `mcp__monday-task-bridge__monday_read_task` |
| Codex | `config.toml` dans `~/.codex` (ou `CODEX_HOME`) | `[mcp_servers.monday-task-bridge.tools.monday_read_task]` avec `approval_mode = "approve"` |
| agy | `~/.gemini/antigravity-cli/settings.json` | `permissions.allow`: `mcp(monday-task-bridge/monday_read_task)` |

`MONDAY_BRIDGE_CLIENTS` limite les CLI que la commande modifie. Pour un autre profil Claude Code, définissez d'abord `CLAUDE_CONFIG_DIR`, comme pour l'installeur.

## Ce que votre agent peut faire

| Outil MCP | Résultat |
| --- | --- |
| `monday_read_task` | Une lecture en direct de n'importe quelle tâche, par `url` ou par `boardId` + `itemId` (`accountHost` en option). Vous n'avez pas besoin d'ouvrir la tâche. |
| `monday_read_open_task` | Une lecture en direct de la tâche ouverte dans votre onglet Chrome actif, ou dans le premier onglet de tâche ouvert. |
| `monday_list_assigned_tasks` | Une liste en direct des tâches qui vous sont assignées (dans n'importe quelle colonne Personnes), avec le tableau, le lien et les colonnes. Le paramètre optionnel `boardIds` limite la lecture à ces tableaux. L'outil parcourt jusqu'à 100 tableaux actifs et 5000 tâches (éléments et sous-éléments, ou items et subitems) en 160 secondes au maximum. Quand une limite ou un tableau illisible a tronqué la liste, `complete` vaut false et `warnings` en donne la raison. Résultat non mis en cache. |
| `monday_list_boards` | Les tableaux actifs sur lesquels vous pouvez être assigné, avec leur espace de travail, à utiliser comme `boardIds` ci-dessus. |
| `monday_get_image` | Les octets originaux PNG, JPEG, GIF ou WebP d'une pièce jointe dont le statut est `ready`. |
| `monday_get_task` | Le dernier instantané en cache, éventuellement filtré par `boardId` et/ou `itemId`. |
| `monday_list_tasks` | Les résumés des instantanés en cache. |
| `monday_bridge_status` | L'état de santé du bridge, l'appairage et l'état de connexion de l'extension. |

Un déroulé typique pour un agent : appeler `monday_read_task` avec le lien de la tâche, lire `complete` et `warnings`, puis appeler `monday_get_image` pour chaque pièce jointe qu'il doit voir.

Les outils ne font que lire. La seule exception est `monday_write_back`, qui ajoute une mise à jour à un élément et peut modifier sa colonne Statut (Status). Les agents ne voient jamais cet outil, sauf si leur client MCP démarre le serveur avec `MONDAY_BRIDGE_ALLOW_WRITE=1`. L'installeur ne définit pas cette variable.

## La popup de l'extension

Le **power button** active et désactive la connexion. Quand il est désactivé, les lectures échouent avec `BROWSER_OFFLINE`. L'icône de la barre d'outils est en couleur quand l'extension est connectée, et grise sinon. Un badge signale tout ce qui demande votre attention :

| Badge | Signification |
| --- | --- |
| `…` (violet) | Lecture d'une tâche en cours, ou attente de l'approbation de l'appairage. |
| `!` (rouge) | La connexion est activée, mais le bridge est hors ligne ou non connecté. |
| `!` (ambre) | La dernière lecture est incomplète. Ouvrez la popup pour lire ses avertissements. |
| `+` (ambre) | Un hôte d'images a besoin d'une autorisation. |
| aucun | L'extension est connectée (icône en couleur), ou désactivée ou non appairée (icône grise). |

## Fonctionnement

1. Un agent appelle un outil MCP. Le serveur MCP (démarré par la CLI de l'agent) transmet la requête au bridge, et démarre le bridge en arrière-plan s'il ne tourne pas.
2. Le bridge envoie la requête à l'extension appairée via un WebSocket local.
3. L'extension appelle **la propre API web de monday** (`https://<account>.monday.com/v2`, GraphQL) : le même endpoint que celui de l'application web de monday, avec votre session de navigateur et le token CSRF de l'application. Une seule requête renvoie le nom de la tâche, chaque colonne sous forme de texte, les mises à jour avec leurs réponses et leurs auteurs, et les fichiers joints. Aucun onglet ne s'ouvre.
4. Les images originales sont téléchargées depuis le stockage de fichiers de monday et vérifiées octet par octet. Les fichiers qui ne sont pas des images sont listés dans un champ `Other files`.
5. L'instantané revient au bridge, qui le met en cache et le renvoie à l'agent.

L'extension ne parcourt jamais les tableaux, ne lit ni n'exporte jamais la valeur des cookies, et ne remplace jamais les images originales par des captures d'écran. Elle ne voit que les tâches que votre compte monday peut voir.

## Données locales et confidentialité

Le bridge écoute uniquement sur l'interface de bouclage (loopback) et rejette les pages web. L'appairage exige que le code à 6 chiffres soit approuvé sur votre PC. Ensuite, l'extension doit envoyer un bearer token depuis sa propre origine d'extension, et le serveur MCP utilise un token admin local distinct. **Unpair** dans la popup révoque le token de l'extension. Chaque nouvel appairage émet un nouveau token : un ancien token cesse donc de fonctionner.

Le token CSRF que monday place dans la page de son application reste dans la mémoire de l'extension et n'est jamais envoyé au bridge. L'extension a un accès hôte (host access) à `*.monday.com` et au stockage de fichiers de monday (`files-monday-com.s3.amazonaws.com`) pour les images originales.

Les instantanés, les images et les tokens sont stockés **non chiffrés** dans votre profil utilisateur :

| OS | Dossier de données |
| --- | --- |
| Windows | `%LOCALAPPDATA%\monday-task-bridge` |
| macOS | `~/Library/Application Support/monday-task-bridge` |
| Linux | `$XDG_DATA_HOME/monday-task-bridge`, ou `~/.local/share/monday-task-bridge` |

Le journal du bridge est `bridge.log`, dans ce dossier. `MONDAY_BRIDGE_DATA_DIR` déplace le dossier ; le bridge, l'utilitaire d'appairage et le serveur MCP doivent alors tous utiliser la même valeur. Chaque nouvel instantané réduit le cache vers **200 instantanés / 7 jours** et supprime les images qu'aucun instantané conservé n'utilise. Ne commitez et ne partagez jamais ce dossier.

## Dépannage

### Installer et connecter l'agent

- **`claude mcp list` affiche `monday-task-bridge` en échec, ou l'agent signale `Cannot find module '...\dist\bridge\mcp.js'` :** le chemin enregistré est faux, ou le code n'a pas été compilé à cet endroit. Cela vient souvent d'une installation manuelle avec un chemin relatif, d'une variable PowerShell utilisée dans un autre shell, ou de barres obliques inverses (backslashes) tapées dans Git Bash. Relancez la commande d'installation : elle compile le code et enregistre le chemin complet. Si l'ancienne entrée apparaît encore, supprimez-la avec `claude mcp remove monday-task-bridge` depuis le dossier où vous l'avez ajoutée, puis relancez l'installeur.
- **`Cannot find package '@modelcontextprotocol/sdk'` (ou `ws`, `zod`) :** les dépendances manquent, par exemple parce que seul `dist` a été copié sur ce PC. Relancez la commande d'installation.
- **`irm` échoue avec "Could not create SSL/TLS secure channel" (anciennes versions de Windows 10) :** lancez `[Net.ServicePointManager]::SecurityProtocol = 'Tls12'` dans la même fenêtre, puis relancez la commande d'installation.
- **`npm.ps1 cannot be loaded because running scripts is disabled` :** PowerShell bloque le script d'appel (shim) de npm. Utilisez `npm.cmd` au lieu de `npm`. L'installeur le fait déjà.
- **"is not empty and is not a git checkout" :** le dossier d'installation contient d'autres fichiers. Supprimez-le, ou définissez `MONDAY_BRIDGE_HOME` sur un autre dossier.
- **L'agent ne liste pas les outils monday :** redémarrez la session de l'agent après l'installation.
- **`monday-bridge` is not recognized / command not found (commande non reconnue ou introuvable) :** relancez la commande d'installation. Si l'erreur persiste, vérifiez que le dossier affiché par `npm config get prefix` (sous macOS/Linux, son sous-dossier `bin`) figure dans votre PATH, puis ouvrez un nouveau terminal.
- **`monday-bridge.ps1 cannot be loaded because running scripts is disabled` (l'exécution des scripts est désactivée) :** PowerShell bloque les scripts d'appel (shims) de npm. Lancez une fois `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, ou tapez `monday-bridge.cmd` au lieu de `monday-bridge`.
- **L'agent demande encore une confirmation avant chaque lecture monday :** lancez `monday-bridge approval status` ; la commande doit indiquer `auto` pour cette CLI. Redémarrez ensuite la session de l'agent. Dans Codex, réenregistrer le serveur avec `codex mcp remove` puis `codex mcp add` supprime les règles ; relancez `auto`.

### Lire les tâches

- **`BROWSER_OFFLINE` ou `extensionConnected: false` :** Chrome doit être lancé, et le power button de la popup doit être activé. Utilisez **Retry connection** dans la popup si besoin.
- **"Not signed in to `<account>`.monday.com" (non connecté à monday) :** connectez-vous à monday dans le profil Chrome qui contient l'extension, puis réessayez.
- **"monday API: …" :** monday a rejeté la requête ; le message vient de monday. Une tâche que vous ne pouvez pas voir dans monday renvoie "monday has no task … that this account can see".
- **`CAPTURE_TIMEOUT` :** une lecture ne s'est pas terminée en 180 secondes. Vérifiez l'erreur affichée dans la popup et réessayez.
- **`NO_SNAPSHOT` :** aucune tâche en cache ne correspond aux ID, ou la lecture a échoué. Appelez d'abord `monday_bridge_status`.
- **`INVALID_TARGET` :** l'URL n'est pas un lien de tâche `https://<account>.monday.com/boards/<id>/pulses/<id>`, ou aucun compte n'est connu pour cet ID de tableau et d'élément. Passez `accountHost`, ou ouvrez monday dans Chrome.
- **Aucun onglet de tâche trouvé :** utilisez `monday_read_task` avec le lien de la tâche au lieu de `monday_read_open_task`.
- **Image indisponible :** seuls les originaux PNG, JPEG, GIF et WebP sont renvoyés ; les autres fichiers sont listés dans `Other files`. Les images de plus de **25 Mo chacune** ou de **75 Mo par lecture** sont ignorées. Si une image est stockée hors du stockage de fichiers habituel de monday, la popup demande une fois d'autoriser cet hôte. Ne l'autorisez que si vous reconnaissez l'hôte.
- **Plus de 100 mises à jour :** seules les 100 plus récentes sont lues, et `warnings` le signale.
- **L'appairage échoue ou expire :** appuyez à nouveau sur le power button et saisissez le nouveau code dans les deux minutes. Appairer une autre extension (dans un autre profil Chrome, ou chargée depuis un autre dossier) remplace l'appairage précédent.
- **La popup affiche "The bridge no longer accepts this browser" (le bridge n'accepte plus ce navigateur) :** un autre appairage a remplacé celui-ci, ou le bridge utilise un autre dossier de données. Appairez à nouveau.

Pour vérifier le bridge, lancez `monday-bridge status`. Cette commande n'a besoin d'aucun token et n'en affiche aucun. Une lecture en direct exige que le bridge tourne, ainsi que **Paired: yes** et **Connected: yes**.

Quand vous signalez un problème, indiquez la forme de l'URL de la tâche, l'erreur de la popup et les avertissements de l'instantané. Ne publiez pas de cookies de session, de tokens du bridge ni de contenu de tâche privé dans une issue publique.

## Installation manuelle (depuis les sources)

Utilisez cette méthode pour le développement, ou si vous ne pouvez pas lancer l'installeur.

```powershell
git clone https://github.com/nathanpixodeo/monday-task-bridge.git
cd monday-task-bridge
npm ci
npm run build
npm install -g --install-links=false .
monday-bridge start
```

`npm install -g` ajoute la commande `monday-bridge` sous forme de lien vers ce dossier. Chargez `dist/extension` dans Chrome comme à l'étape 2 du démarrage rapide. Appuyez ensuite sur le power button et approuvez le code avec `monday-bridge pair 123456`.

Enregistrez le serveur MCP avec le **chemin complet** de `dist/bridge/mcp.js`. Ce chemin doit exister : compilez donc d'abord. Remplacez `C:\path\to\monday-task-bridge` par votre dossier :

```powershell
claude mcp add -s user monday-task-bridge -- node "C:\path\to\monday-task-bridge\dist\bridge\mcp.js"
codex mcp add monday-task-bridge -- node "C:\path\to\monday-task-bridge\dist\bridge\mcp.js"
agy mcp add monday-task-bridge node "C:\path\to\monday-task-bridge\dist\bridge\mcp.js"
```

- Gardez `-s user` pour Claude Code. Sans cette option, le serveur n'est enregistré que pour le dossier courant.
- Dans Git Bash, écrivez le chemin avec des barres obliques (`C:/path/to/...`). Bash supprime les barres obliques inverses qui ne sont pas entre guillemets.
- Pour tout autre client MCP, utilisez un serveur stdio avec `command` défini sur `node` et `args` défini sur le chemin complet :

  ```json
  {
    "mcpServers": {
      "monday-task-bridge": {
        "command": "node",
        "args": ["C:/path/to/monday-task-bridge/dist/bridge/mcp.js"]
      }
    }
  }
  ```

Aucun token ne va dans la configuration du client : le serveur MCP lit son token admin dans le dossier de données.

Pour lire sans demande de confirmation oui/non à chaque fois, lancez `monday-bridge approval auto` après l'enregistrement (voir [Mode d'approbation](#mode-dapprobation--auto-ou-manuel)).

## Développement

```powershell
npm run typecheck
npm test
npm run build
```

L'extension Chrome se trouve dans `extension/` (le mapping de l'API est dans `extension/helpers/monday-api.ts`). Le bridge, le serveur MCP et les CLI sont dans `bridge/` (`cli.ts` est la commande `monday-bridge` ; elle lance `start-cli`, `pair-cli`, `approval-cli` et `server`), les types de payload partagés dans `shared/`, et les installeurs dans `scripts/`. `npm run bridge`, `npm run mcp`, `npm run pair` et `npm run approval` lancent les mêmes programmes depuis les sources. La CI exécute l'installation, la vérification des types, les tests et la compilation sous Node.js 24. Le résultat de compilation dans `dist/` n'est pas commité.

L'extension utilise toujours le port `3457` ; gardez ce port libre. Elle ne suit pas une valeur personnalisée de `MONDAY_BRIDGE_PORT`.
