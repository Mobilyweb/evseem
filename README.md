# OCPP Virtual Charge Point

Simple, configurable, terminal-based OCPP Charging Station simulator written in Node.js with Schema validation.

---

## 🛰 Cockpit Parera Pulse — piloter la borne virtuelle depuis le navigateur

> En une phrase : une page web locale qui démarre toute la stack (platform, websocket, borne
> virtuelle), montre la borne « en vrai » (statut, kW, kWh, flux OCPP) et permet de lancer des
> charges réalistes sans ouvrir six terminaux.

### À quoi ça sert

- **Tester platform avec une borne** sans borne physique : les actions du dashboard (Reset,
  RemoteStart/Stop, smart charging…) arrivent sur la borne virtuelle, et ce qu'elle envoie
  (statuts, transactions, MeterValues) remonte dans le dashboard.
- **Faire une démo** : la borne s'anime, la courbe de charge se dessine, un ticket de fin de
  charge s'affiche.
- **Brancher la borne sur staging** au lieu du local, sans rien lancer d'autre.

Le cockpit ne modifie pas le code OCPP de la borne : il la démarre comme un process, lit ses logs
pour afficher le live et lui envoie des commandes via son API admin (`POST :9999/execute`).

### Prérequis

- **Node 20+** et `npm install` fait une fois à la racine de ce repo.
- Les repos **`platform/`** et **`websocket/`** clonés et installés (`bundle`, `yarn`) — le
  cockpit lance leurs commandes via un shell de login, donc RVM/rbenv choisit la bonne version de
  Ruby dans chaque dossier.
- **Redis** déjà démarré sur `localhost:6379` (le cockpit le vérifie, il ne le lance pas) :
  `redis-cli ping` doit répondre `PONG`.
- Une borne dont l'`identity` est **`jasonborne`** dans la base platform locale (voir
  [BRANCHER_EN_LOCAL.md](./BRANCHER_EN_LOCAL.md), étape 0). Sans elle, la borne est rejetée et
  reçoit des `Reset` en boucle.
- Optionnel : `zenity` (Linux) pour le bouton 📁 de sélection de dossier.

### Démarrage rapide

```bash
npm install          # première fois seulement
npm run cockpit      # → http://localhost:8080
```

1. Cliquer sur l'écran d'accueil, puis **⚙ Config** dans le bandeau.
2. Section **📁 Chemins locaux** : renseigner le dossier `websocket/` et le dossier `platform/`
   (saisie ou bouton 📁). **💾 Enregistrer**.
3. Section **🔌 Borne** : garder les valeurs par défaut (`jasonborne`, `OCPP 1.6`,
   `ws://localhost:3334`).
4. **⏻ TOUT LANCER**. Le cockpit démarre dans l'ordre :
   serveur WebSocket (puma) → Rails web, Vite, Sidekiq, subscriber OCPP (`Ocpp::V16::Ws.start`)
   → borne virtuelle en dernier.
5. Attendre que les pastilles de santé **Redis / WebSocket / Rails / VCP** passent au vert et que
   la borne affiche `Available`. Le dashboard platform est sur http://localhost:3000.

**■ TOUT ARRÊTER** (ou `Ctrl-C` dans le terminal du cockpit) coupe tous les process lancés.

> Le cockpit écoute uniquement sur `127.0.0.1` : il lance des process sur ta machine, il ne doit
> jamais être exposé. Port modifiable avec `COCKPIT_PORT=8081 npm run cockpit`.

### L'écran, zone par zone

- **Bandeau** : lancer / arrêter tout, pastilles d'état de chaque service et de santé.
- **🖧 Serveurs** : détail de chaque service (démarrer / arrêter un seul service) et ses logs en
  direct — c'est là qu'on regarde quand une pastille reste rouge.
- **⚙ Config** : chemins, borne, thème, mode de connexion (voir plus bas).
- **La borne (à gauche)** : statut OCPP en grand, puissance (kW), énergie (kWh), connecteur
  actif, transaction en cours. Le sélecteur en haut à droite de la borne choisit le connecteur
  (EVSE 1, 2…). Trois onglets de commande :
  - **⚡ Charge** : lancer / arrêter une charge (détail ci-dessous).
  - **🎛 Actions** : forcer un statut de connecteur (`Available`, `Preparing`, `Charging`,
    `SuspendedEV`, `Finishing`, `Faulted`, `Unavailable` en 1.6) et **⏏ Déconnecter** /
    **↻ Reconnecter** la borne (simule une coupure réseau).
  - **⚙ Config** : configuration OCPP de la borne (équivalent `GetConfiguration`), modifiable.
- **FLUX OCPP (à droite)** : tous les messages échangés, dans les deux sens, en temps réel. Les
  300 derniers sont gardés ; **clear** vide la liste. Pour s'y retrouver :
  - **🔎 filtrer par action ou contenu…** : recherche texte (ex. `MeterValues`, un idTag, un
    numéro de transaction), les correspondances sont surlignées ;
  - **Sens** : **➡ Émis** (par la borne) / **⬅ Reçus** (depuis platform) ;
  - **Type** : **CALL** (demande), **RESULT** (réponse), **ERROR** ;
  - **Messages** : une puce par type de message vu passer (`BootNotification`, `Heartbeat`…),
    cliquer pour masquer / réafficher, **tout / rien** pour tout basculer.

  Le compteur affiche `affichés / total` quand un filtre est actif ; **réinitialiser** remet tout
  à zéro. Les filtres sont mémorisés dans le navigateur.

### Lancer une charge

1. Onglet **⚡ Charge**, choisir le connecteur puis un **scénario de charge (idTag)** :
   - **JS — Mobilypass** / **Max — Mobilypass** : cartes Mobilypass de deux comptes existants,
     retrouvées dans ta base locale par le seed (voir plus bas). L'acceptation dépend de la
     configuration de la station, comme en vrai.
   - **SIMTAG — whitelist** : tag accepté sans carte, uniquement sur une station privée
     commissionnée.
2. **▶ Démarrer** : la borne enchaîne `Preparing` → `Authorize` → `StartTransaction` →
   `Charging`, puis envoie des MeterValues toutes les 5 s (énergie, puissance, intensité par
   phase, SoC) qui alimentent les graphiques du dashboard.
3. La charge suit une courbe réaliste : pleine puissance jusqu'à 80 %, puis baisse progressive
   (badge « 🔋 taper fin de charge »). À 100 % elle **s'arrête toute seule** ; sinon
   **⏹ Arrêter**.
4. En fin de charge, un ticket **⚡ CHARGE TERMINÉE** affiche durée, énergie, puissance moyenne /
   max et numéro de transaction.

Bon à savoir :

- Si l'autorisation ne répond pas en 12 s, la charge est annulée automatiquement (le connecteur
  ne reste jamais bloqué).
- Un **arrêt à distance** depuis le dashboard (RemoteStopTransaction) arrête aussi la charge
  côté cockpit.
- Plusieurs connecteurs peuvent charger en même temps : l'arrêt d'une charge ne libère que son
  propre connecteur. La session tourne côté serveur : recharger la page ne la coupe pas.
- Au démarrage, la borne annonce **tous** ses connecteurs à platform (réglage « Connecteurs »),
  pas seulement le premier. Modifier ce nombre pendant que la borne tourne la reconnecte
  automatiquement.

### Smart charging

Depuis le dashboard platform, appliquer un profil de limitation (current limit profile) à la
borne : la puissance simulée se plafonne immédiatement (badge « ⚡ limité (smart charging) ») et
les graphiques du dashboard le reflètent. Supprimer le profil → la puissance repart.

### Scénarios et seed

Au démarrage (et dès que le dossier `platform/` est renseigné), le cockpit exécute
`cockpit/seeds/charge_scenarios.rb` via `rails runner` dans platform. Ce script est **en lecture
seule** : il ne crée ni ne modifie rien, il retrouve simplement l'UID de la carte Mobilypass
active des deux comptes de test. Si un compte n'existe pas dans ta base, le scénario apparaît
« (introuvable) » et seul SIMTAG reste utilisable.

### Mode staging (brancher la borne sur staging)

**⚙ Config** → section **🛰 Connexion** → **Mode = Staging**, puis renseigner :

- **WS_URL staging** : l'endpoint OCPP de staging (`wss://…`) ;
- **Identity borne réelle** : une borne de staging **sans risque** (jamais une borne client active) ;
- **Password (basic-auth)** : si l'endpoint l'exige.

En staging, **aucun serveur local n'est lancé** : ⏻ TOUT LANCER ne démarre que la borne, qui se
connecte directement à staging (pas de ngrok ; VPN nécessaire si l'endpoint est privé). Les
scénarios Mobilypass viennent de la base **locale** : sur staging, ces idTags peuvent ne pas
exister. Changer de mode pendant que la borne tourne la reconnecte automatiquement.

### Configuration

Tout ce qui est saisi dans l'UI est enregistré dans `cockpit/config.json` (ignoré par git, propre
à chaque poste). Modèle : [`cockpit/config.example.json`](./cockpit/config.example.json).
Réglages sans champ dans l'UI, à modifier directement dans le fichier (puis relancer le cockpit) :

- `voltage` (230 V), `current` (32 A), `phases` (3) : puissance cible de la charge simulée ;
- `idTag` (`SIMTAG`) : tag utilisé si aucun scénario n'est choisi ;
- `ports` : ports websocket (3334), rails (3000), vite (3036), redis (6379).

La durée d'une charge de 0 à 100 % (`sessionFullSeconds`, 120 s par défaut) et le nombre de
connecteurs se règlent dans l'UI (« Durée charge sim », « Connecteurs »).

### OCPP 2.0.1

Le cockpit sait lancer la borne en 2.0.1 (`index_201.ts`, subscriber `Ocpp::V201::Ws.start`),
mais le serveur `websocket/` impose le sous-protocole `ocpp1.6` : pour tester la 2.0.1 en local,
il faut patcher le sous-protocole dans `websocket/middlewares/ocpp_backend.rb`.

### Dépannage

- **Borne `Rejected` puis `Reset` en boucle** : l'identity n'existe pas dans la base platform →
  [BRANCHER_EN_LOCAL.md](./BRANCHER_EN_LOCAL.md), étape 0.
- **Service marqué ⚠ « (chemin manquant) », bouton ▶ grisé** : le dossier `websocket/` ou
  `platform/` n'est pas renseigné dans ⚙ Config.
- **Un service ne démarre pas / reste rouge** : ouvrir **🖧 Serveurs**, cliquer le service, lire
  ses logs (souvent : chemin faux, gems non installées, mauvaise version de Ruby).
- **Pastille Redis rouge** : Redis n'est pas démarré, le cockpit ne le lance pas.
- **Transaction / MeterValues jamais visibles dans le dashboard** : Sidekiq ou le subscriber OCPP
  est arrêté (voir 🖧 Serveurs).
- **Mode staging, la borne ne se connecte pas** : WS_URL ou identity vide, VPN non connecté, ou
  mot de passe basic-auth incorrect (voir FLUX OCPP et les logs VCP).
- **Bouton 📁 sans effet** : `zenity` n'est pas installé, saisir le chemin à la main.

### Pour les devs

- `cockpit/server.ts` : serveur HTTP (Hono), API `/api/*` et flux temps réel `/events` (SSE).
- `cockpit/services.ts` : lancement / arrêt des process, ordre de démarrage, santé, seed.
- `cockpit/chargeSession.ts` : moteur de charge par connecteur (machine à états, courbe, smart
  charging, MeterValues).
- `cockpit/logParser.ts` : lecture des logs de la borne pour reconstruire son état.
- `cockpit/public/` : l'interface (HTML, JS, CSS et thèmes).
- Architecture complète de la chaîne borne ↔ websocket ↔ Redis ↔ platform :
  [BRANCHER_EN_LOCAL.md](./BRANCHER_EN_LOCAL.md).

## Watch our video introduction

[![VCP Video](https://img.youtube.com/vi/YsXjnk0mhfA/0.jpg)](https://www.youtube.com/watch?v=YsXjnk0mhfA)

## Prerequisites

- Node.js 12+

Run:

```bash
npm install
```

## Install dependencies

Run:

```bash
npm install zod
```

## Running VCP

Configure env variables:

```
WS_URL - websocket endpoint
CP_ID - ID of this VCP
PASSWORD - if used for OCPP Authentication, otherwise can be left blank
CONNECTORS - number of connectors announced at boot (default: 1)
```

Run OCPP 1.6:

```bash
npm start index_16.ts
```

Run OCPP 2.0.1:

```bash
npm start index_201.ts
```

When testing different configurations, you can create multiple `.env` files and pass the env file or the env file suffix as an argument, for example:

```bash
# uses .env
npm start .env index_16.ts
# uses .env if exists
npm start index_16.ts
# uses .env.production
npm start .env.production index_16.ts
# uses .env.production
npm start production index_16.ts
```

### Auto-restart

Normally, the VCP will exit after receiving the `Reset` message.
If you want to let the VCP re-establish the WS connection after receiving the `Reset` message, you can use the `npm start:auto-restart` command.

Example:
```bash
WS_URL=ws://localhost:3000 CP_ID=vcp_16_test npm run start:auto-restart index_16.ts

# ...
2026-03-06 09:55:51 info: Receive message ⬅️  [2,"248a82ba-58e3-4a3d-ae8f-74470add510f","Reset",{"type":"Hard"}]
2026-03-06 09:55:51 info: Responding with ➡️  [3,"248a82ba-58e3-4a3d-ae8f-74470add510f",{"status":"Accepted"}]
2026-03-06 09:55:51 info: Waiting for 3 seconds to close VCP...
2026-03-06 09:55:54 info: Closing VCP
2026-03-06 09:55:54 info: Auto-restart enabled. Closing old VCP...
2026-03-06 09:55:54 info: Waiting for 3 seconds...
2026-03-06 09:55:57 info: Starting new VCP
2026-03-06 09:55:57 info: Connecting... | {
  endpoint: 'ws://localhost:3000',
  chargePointId: 'vcp_16_test',
  ocppVersion: 'OCPP_1.6',
  basicAuthPassword: '123',
  adminPort: 9999
}
# ...
```

## Example

```bash
> WS_URL=ws://localhost:3000 CP_ID=vcp_16_test npm start index_16.ts

2023-03-27 13:09:17 info: Connecting... | {
  endpoint: 'ws://localhost:3000',
  chargePointId: 'vcp_16_test',
  ocppVersion: 'OCPP_1.6',
  basicAuthPassword: 'password',
  adminWsPort: 9999
}
2023-03-27 13:09:17 info: Sending message ➡️  [2,"5fe44756-05e1-4065-9c91-11b456b55913","BootNotification",{"chargePointVendor":"Solidstudio","chargePointModel":"test","chargePointSerialNumber":"S001","firmwareVersion":"1.0.0"}]
2023-03-27 13:09:17 info: Sending message ➡️  [2,"aad8d05d-3a6b-4c51-a9fc-7275d4a6cbc3","StatusNotification",{"connectorId":1,"errorCode":"NoError","status":"Available"}]
2023-03-27 13:09:17 info: Receive message ⬅️  [3,"5fe44756-05e1-4065-9c91-11b456b55913",{"currentTime":"2023-03-27T11:09:17.883Z","interval":30,"status":"Accepted"}]
2023-03-27 13:09:17 info: Receive message ⬅️  [2,"658c8f5b-9f86-487f-91f8-1d656453978a","ChangeConfiguration",{"key":"MeterValueSampleInterval","value":"60"}]
2023-03-27 13:09:17 info: Responding with ➡️  [3,"658c8f5b-9f86-487f-91f8-1d656453978a",{"status":"Accepted"}]
2023-03-27 13:09:17 info: Receive message ⬅️  [2,"34fc4673-deff-48d3-bb8e-d94d75fa619a","GetConfiguration",{"key":["SupportedFeatureProfiles"]}]
2023-03-27 13:09:17 info: Responding with ➡️  [3,"34fc4673-deff-48d3-bb8e-d94d75fa619a",{"configurationKey":[{"key":"SupportedFeatureProfiles","readonly":true,"value":"Core,FirmwareManagement,LocalAuthListManagement,Reservation,SmartCharging,RemoteTrigger"},{"key":"ChargeProfileMaxStackLevel","readonly":true,"value":"99"},{"key":"HeartbeatInterval","readonly":false,"value":"300"},{"key":"GetConfigurationMaxKeys","readonly":true,"value":"99"}]}]
2023-03-27 13:09:17 info: Receive message ⬅️  [3,"aad8d05d-3a6b-4c51-a9fc-7275d4a6cbc3",{}]
2023-03-27 13:09:18 info: Receive message ⬅️  [2,"d7610ad2-63d0-470f-9bd9-6e47d5483429","SetChargingProfile",{"connectorId":0,"csChargingProfiles":{"chargingProfileId":30,"stackLevel":0,"chargingProfilePurpose":"ChargePointMaxProfile","chargingProfileKind":"Absolute","chargingSchedule":{"chargingRateUnit":"A","chargingSchedulePeriod":[{"startPeriod":0,"limit":10.0}]}}}]
2023-03-27 13:09:18 info: Responding with ➡️  [3,"d7610ad2-63d0-470f-9bd9-6e47d5483429",{"status":"Accepted"}]
2023-03-27 13:10:17 info: Sending message ➡️  [2,"79a41b2e-2c4a-4a65-9d7e-417967a8f95f","Heartbeat",{}]
2023-03-27 13:10:17 info: Receive message ⬅️  [3,"79a41b2e-2c4a-4a65-9d7e-417967a8f95f",{"currentTime":"2023-03-27T11:10:17.955Z"}]
```

## Executing Admin Commands

Some messages are automatically sent by the VCP, for example, `BootNotification` or `StartTransaction` and `StopTransaction`.
However, for Operations initiated by Charge Point (compare e.g. with OCPP 1.6, Chapter 4) one can send the messages using `admin` functionality.
VCP exposes a separate Websocket endpoint that will "proxy" all messages to Central System Websocket.
For example usage, see `admin/` folder.

```bash
npx tsx admin/v16/Authorize/authorize.ts
```

---

## Contributing

### Bug Reports & Feature Requests

Please use the [issue tracker](https://github.com/solidstudiosh/ocpp-virtual-charge-point/issues) to report any bugs or file feature requests.

### Developing

We encourage contributions through pull requests and follow the standard "fork-and-pull" git workflow. Feel free to create a fork of the repository, make your changes, and submit a pull request for review. We appreciate your contributions!

1. Fork the repository on GitHub.
2. Clone the forked repository to your local machine.
3. Create a new branch for your changes.
4. Make your changes to the code and commit them to your local branch.
5. Push the changes to your forked repository on GitHub.
6. Create a new pull request on the original repository.
7. Wait for feedback and make any necessary changes.
8. Once your pull request has been reviewed and accepted, it will be merged into the original repository.

When creating your pull request, please include a clear description of the changes you have made, and any relevant context or reasoning behind those changes.
