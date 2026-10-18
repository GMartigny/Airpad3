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

const display = await host(); // uses the default controller page
showQrCode(display.url);

display.addEventListener(Events.OPEN, () => console.log("Controller connected"));
display.addEventListener(Events.BUTTON_DOWN, (event) => {
    console.log(`${event.button} pressed`);
    display.send(new VibrateEvent(Events.VIBRATE, { pattern: 30 }));
});
display.addEventListener(Events.STICK_MOVE, ({ x, y }) => player.move(x, y));
display.addEventListener(Events.ROTATE, event => console.log(event.orientation));
display.addEventListener(Events.LOCK, () => pauseGame());

// Controller (phone): only needed for a custom controller page
import { join, Events, ButtonEvent } from "airpad3";

const pad = await join(location.hash.slice(1)); // resolves once connected
pad.send(new ButtonEvent(Events.BUTTON_DOWN, { button: "A" }));
```

### Default controller

The lib ships a ready-to-use controller page (`controller/index.html`), used by default by `host()`:

- left half: a floating stick, it starts where the finger lands and moves relative to it
- right half: two buttons stacked, each one a quarter of the screen, `A` on top and `B` below

It sends `STICK_MOVE`, `BUTTON_DOWN` and `BUTTON_UP` by itself, along with the automatic `ROTATE`, `LOCK` and `UNLOCK`. It goes fullscreen on first touch.

To mount it in your own page, with other button names:

```js
import { join, createController } from "airpad3";

const pad = await join(location.hash.slice(1));
createController(pad, { buttons: ["Jump", "Fire"] });
```

| `createController` option | Default | Description |
| --- | --- | --- |
| `element` | `document.body` | Where to mount the controller |
| `buttons` | `["A", "B"]` | Button names, top to bottom |
| `stickRadius` | `0.15` | Stick radius, relative to the smallest screen side |
| `fullscreen` | `true` | Go fullscreen on first touch |

### Events

All types are available as constants on `Events`.

| Constant | Class | Direction | Description |
| --- | --- | --- | --- |
| `BUTTON_DOWN`, `BUTTON_UP` | `ButtonEvent` (`button`) | phone → computer | A button pressed or released |
| `STICK_MOVE` | `StickEvent` (`x`, `y`, `distance`, `angle`) | phone → computer | Stick position, `x` and `y` from -1 to 1 (`y` goes down). At most once per frame, `0, 0` on release |
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
| `createController(peer, options)` | Mount the default controller UI |

### Options

| Option | Default | Description |
| --- | --- | --- |
| `server` | `https://ntfy.sh` | ntfy server (you can host your own) |
| `iceServers` | Google STUN | STUN/TURN servers |
| `timeout` | 5 min (computer), 15 s (phone) | Max pairing delay |
| `controllerUrl` | hosted default controller | Controller page URL, used to build `display.url` (`host` only) |
| `deviceEvents` | `true` | Send `ROTATE`, `LOCK` and `UNLOCK` automatically (`join` only) |

## Demo

Live at [airpad3.vercel.app](https://airpad3.vercel.app): open it on a computer and scan the QR code with a phone. The default controller is hosted at [airpad3.vercel.app/controller/](https://airpad3.vercel.app/controller/).

To run it locally:

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

The tests run a local fake ntfy server with two Node WebRTC peers (`node-datachannel`), and the default controller in a simulated DOM (`jsdom`).

## License

[MIT](LICENSE) © Guillaume Martigny
