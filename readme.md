# Airpad3

Connect a computer and a phone with a QR code, using WebRTC, with no server to host.

Pairing goes through [ntfy.sh](https://ntfy.sh), a free public HTTP pub/sub. Once connected, both devices talk peer-to-peer over a WebRTC DataChannel.

## How it works

1. The display creates a WebRTC offer and publishes it on the ntfy topic `airpad-<id>`.
2. The QR code holds the controller URL, with the ID in the fragment: `…/remote/#<id>`.
3. The controller reads the offer and publishes its answer on the same topic.
4. The display receives the answer (SSE, with a polling fallback) and the direct connection opens.

## Usage

Everything goes through events. Both ends are native `EventTarget`s: listen with `addEventListener`, and `send(event)` dispatches the event on the other device, rebuilt with the same class.

```js
// Display (computer)
import { host, Events, VibrateEvent } from "airpad3";

const display = await host({ controllerUrl: "remote/" });
showQrCode(display.url);

display.addEventListener(Events.OPEN, () => console.log("Controller connected"));
display.addEventListener(Events.BUTTON_DOWN, (event) => {
    console.log(`${event.button} pressed`);
    display.send(new VibrateEvent(Events.VIBRATE, { pattern: 30 }));
});
display.addEventListener(Events.ROTATE, event => console.log(event.orientation));
display.addEventListener(Events.LOCK, () => pauseGame());

// Controller (phone)
import { join, Events, ButtonEvent } from "airpad3";

const pad = await join(location.hash.slice(1)); // resolves once connected
pad.send(new ButtonEvent(Events.BUTTON_DOWN, { button: "A" }));
```

### Events

All types are available as constants on `Events`.

| Constant | Class | Direction | Description |
| --- | --- | --- | --- |
| `BUTTON_DOWN`, `BUTTON_UP` | `ButtonEvent` (`button`) | phone → computer | A button pressed or released |
| `ROTATE` | `RotateEvent` (`orientation`) | phone → computer | Switched between `"portrait"` and `"landscape"`. **Sent automatically**, and once on connection |
| `LOCK`, `UNLOCK` | `LockEvent` (`locked`) | phone → computer | Screen locked or unlocked (page hidden or visible). **Sent automatically** |
| `VIBRATE` | `VibrateEvent` (`pattern`) | computer → phone | Vibrates the phone by default, cancel with `preventDefault()` |
| `OPEN`, `CLOSE`, `ERROR` | `CustomEvent` | local | Connection lifecycle, the error is in `event.detail`. Can't be sent |

Automatic events can be turned off with `join(id, { deviceEvents: false })`.

### Custom events

Any event can be sent, its `detail` must be JSON-serializable:

```js
display.send(new CustomEvent("score", { detail: 42 }));
pad.addEventListener("score", event => console.log(event.detail));
```

To get your own class on the other side, extend `AirpadEvent` (constructor `(type, init)`, `init` becomes `detail`) and register it on both ends:

```js
import { AirpadEvent, registerEvent } from "airpad3";

class JumpEvent extends AirpadEvent {
    get height () {
        return this.detail.height;
    }
}
registerEvent("jump", JumpEvent);

pad.send(new JumpEvent("jump", { height: 3 }));
```

### API

| Member | Description |
| --- | --- |
| `host(options)` | Create a session (computer side). Resolves with a `Peer` having `id` and `url` |
| `join(id, options)` | Join a session (phone side). Resolves with an open `Peer` |
| `peer.send(event)` | Dispatch an event on the remote peer |
| `peer.addEventListener(type, listener)` | Listen to remote or lifecycle events |
| `peer.isOpen` | Whether the connection is open |
| `peer.ready` | Promise resolved when the connection opens, rejected if it fails before |
| `peer.close()` | Close the connection |

### Options

| Option | Default | Description |
| --- | --- | --- |
| `server` | `https://ntfy.sh` | ntfy server (you can host your own) |
| `iceServers` | Google STUN | STUN/TURN servers |
| `timeout` | 5 min (computer), 15 s (phone) | Max pairing delay |
| `controllerUrl` | – | Controller page URL, used to build `display.url` (`host` only) |
| `deviceEvents` | `true` | Send `ROTATE`, `LOCK` and `UNLOCK` automatically (`join` only) |

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
