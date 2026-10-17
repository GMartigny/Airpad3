# Airpad3

Connecte un ordinateur et un téléphone avec un QR code, en WebRTC, sans serveur à héberger.

L'appairage passe par [ntfy.sh](https://ntfy.sh), un pub/sub HTTP public et gratuit. Une fois connectés, les deux appareils échangent en pair-à-pair via un DataChannel WebRTC.

## Fonctionnement

1. L'écran crée une offre WebRTC et la publie sur le topic ntfy `airpad-<id>`.
2. Le QR code contient l'URL de la manette avec l'ID dans le fragment : `…/remote/#<id>`.
3. La manette lit l'offre, publie sa réponse sur le même topic.
4. L'écran reçoit la réponse (SSE, avec polling de secours) et la connexion directe s'ouvre.

## Usage

```js
// Écran
import { host } from "airpad3";

const display = await host({ controllerUrl: "remote/" });
showQrCode(display.url);
display.on("open", () => console.log("Manette connectée"));
display.on("message", data => console.log(data));

// Manette
import { join } from "airpad3";

const pad = await join(location.hash.slice(1));
pad.send({ name: "A", state: "down" });
```

### Options

| Option | Défaut | Description |
| --- | --- | --- |
| `server` | `https://ntfy.sh` | Serveur ntfy (tu peux héberger le tien) |
| `iceServers` | STUN Google | Serveurs STUN/TURN |
| `timeout` | 5 min (écran), 15 s (manette) | Délai max d'appairage |
| `controllerUrl` | – | URL de la page manette, pour construire `display.url` |

### Événements

`open`, `message`, `close`, `error`

## Démo

```sh
npm run demo
```

Ouvre `/demo/` sur l'ordinateur et scanne le QR code avec un téléphone sur le même réseau.

## Limites

- Les topics ntfy sont publics : l'ID aléatoire (16 caractères) suffit pour éviter les collisions, mais les données de signalisation ne sont pas chiffrées.
- ntfy.sh applique des quotas par IP aux utilisateurs anonymes.
- Hors réseau local, certains NAT nécessitent un serveur TURN.

## Tests

```sh
npm test
```

Le test lance un faux serveur ntfy local et deux pairs WebRTC Node (`node-datachannel`).
