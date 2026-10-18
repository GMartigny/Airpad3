# Airpad3

Connect a computer and a phone with a QR code, using WebRTC, with no server to host.

Pairing goes through [ntfy.sh](https://ntfy.sh), a free public HTTP pub/sub. Once connected, both devices talk peer-to-peer over a WebRTC DataChannel.

## How it works

1. The display creates a WebRTC offer and publishes it on the ntfy topic `airpad-<id>`.
2. The QR code holds the controller URL, with the ID in the fragment: `…/remote/#<id>`.
3. The controller reads the offer and publishes its answer on the same topic.
4. The display receives the answer (SSE, with a polling fallback) and the direct connection opens.

## Usage

Both ends are native `EventTarget`s. Anything sent with `send(type, detail)` is dispatched on the other device as a `CustomEvent` of the same type, with `detail` as payload. Works both ways.

```js
// Display (computer)
import { host } from "airpad3";

const display = await host({ controllerUrl: "remote/" });
showQrCode(display.url);

display.addEventListener("open", () => console.log("Controller connected"));
display.addEventListener("buttondown", ({ detail }) => {
    console.log(`${detail} pressed`);
    display.send("vibrate", 30);
});

// Controller (phone)
import { join } from "airpad3";

const pad = await join(location.hash.slice(1)); // resolves once connected
pad.addEventListener("vibrate", ({ detail }) => navigator.vibrate(detail));
pad.send("buttondown", "A");
```

### API

| Member | Description |
| --- | --- |
| `host(options)` | Create a session (display side). Resolves with a `Peer` having `id` and `url` |
| `join(id, options)` | Join a session (controller side). Resolves with an open `Peer` |
| `peer.send(type, detail?)` | Dispatch a `CustomEvent` on the remote peer. `detail` must be JSON-serializable |
| `peer.addEventListener(type, listener)` | Listen to remote or built-in events |
| `peer.isOpen` | Whether the connection is open |
| `peer.ready` | Promise resolved when the connection opens, rejected if it fails before |
| `peer.close()` | Close the connection |

### Options

| Option | Default | Description |
| --- | --- | --- |
| `server` | `https://ntfy.sh` | ntfy server (you can host your own) |
| `iceServers` | Google STUN | STUN/TURN servers |
| `timeout` | 5 min (display), 15 s (controller) | Max pairing delay |
| `controllerUrl` | – | Controller page URL, used to build `display.url` |

### Built-in events

| Event | Description |
| --- | --- |
| `open` | Connection established |
| `close` | Connection closed, by either side |
| `error` | Something went wrong, the `Error` is in `event.detail` |

These types are reserved: `send()` refuses them.

## Demo

```sh
npm run demo
```

Open `/demo/` on the computer and scan the QR code with a phone on the same network.

## Limitations

- ntfy topics are public: the random 16-character ID is enough to avoid collisions, but signaling data is not encrypted.
- ntfy.sh applies per-IP rate limits to anonymous users.
- Outside a local network, some NATs require a TURN server.

## Tests

```sh
npm test
```

The test runs a local fake ntfy server and two Node WebRTC peers (`node-datachannel`).

## License

[MIT](LICENSE) © Guillaume Martigny
