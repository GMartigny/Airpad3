# Airpad3

Connect phones to a computer with a QR code, using WebRTC, with no server to host. As many controllers as needed.

Pairing goes through [ntfy.sh](https://ntfy.sh), a free public HTTP pub/sub. Once connected, both devices talk peer-to-peer over a WebRTC DataChannel.

## How it works

1. The display creates a session, listening on the ntfy topic `airpad-<id>`.
2. The QR code holds the controller page URL, with the ID in the fragment: `…/controller.html#<id>`.
3. The controller says hello on the topic, the display answers with a fresh WebRTC offer.
4. The controller publishes its answer, and the direct connection opens.

Every phone that scans the QR code joins as a new player, with its own number. The session lives until the display closes it: a player can leave and come back, it gets its number back (each phone remembers its player ID).

## Usage

Everything goes through events. Every object is a native `EventTarget`: listen with `addEventListener`, and `send(event)` dispatches the event on the other side, rebuilt with the same class.

```js
import { host, Events, VibrateEvent } from "airpad3";

const session = await host(); // controller page: "controller.html", next to the current page
showQrCode(session.url);

session.addEventListener(Events.CONNECT, ({ controller }) => addPlayer(controller.number));
session.addEventListener(Events.STICK_MOVE, ({ controller, x, y }) => players[controller.number].move(x, y));
session.addEventListener(Events.BUTTON_DOWN, ({ controller, button }) => {
    console.log(`Player ${controller.number} pressed ${button}`);
    controller.send(new VibrateEvent(Events.VIBRATE, { pattern: 30 })); // this controller only
});
session.addEventListener(Events.DISCONNECT, ({ controller }) => pausePlayer(controller.number));

session.send(new CustomEvent("gameover")); // every connected controller
```

- Events sent by a controller are dispatched on its `Peer` (`session.controllers`) **and** on the session, with `event.controller`.
- `session.send(event)` reaches every connected controller, `controller.send(event)` a single one.
- A controller keeps its place and `number` for the whole session, even after a disconnection, until kicked. A new player gets the lowest free number, from 1.

### Kicking a controller

```js
controller.kick(); // or session.kick(controller)
```

The controller is disconnected and removed from `session.controllers`: its place and number are freed for the next new player. Its automatic reconnections are refused (resuming the last session, reconnect button, page reload…). Scanning the QR code again lets it back in, as a new player with the lowest free number.

On the phone, `Events.DISCONNECT` tells why in `event.detail.reason`, one of `DisconnectReasons`:

| Reason | |
| --- | --- |
| `CLOSED` | `close()` was called on this side |
| `LOST` | The connection dropped, or the other side closed it |
| `KICKED` | The display kicked this controller |
| `ENDED` | The display closed the session |

### Controller page

`host()` points the QR code to `controller.html`, next to the display page (change it with `controllerUrl`). Serving it only takes:

```html
<!-- controller.html -->
<script type="module">
    import { mountController } from "airpad3";
    mountController();
</script>
```

`mountController()` joins the session from the URL, mounts the default controller and handles the connection status:

- it shows the player number given by the display
- it remembers the last session: opening the page without `#id` resumes it, so a lost URL isn't a problem
- it removes the ID from the URL once read: reloading the page resumes, only a QR code scan counts as a new join
- when disconnected, it shows a reconnect button, and reconnects by itself when the page becomes visible again (unlocked phone)
- when kicked, or when the game is over, it says so, stops reconnecting and asks to scan a QR code again

The default controller has a floating stick on the left half (it starts where the finger lands and moves relative to it) and two buttons stacked on the right half, each one a quarter of the screen, `A` on top and `B` below (or a single button filling the right half). It sends `STICK_MOVE`, `BUTTON_DOWN` and `BUTTON_UP` by itself, along with the automatic `ROTATE`, `LOCK` and `UNLOCK`, and goes fullscreen on first touch.

| `mountController` option | Default | Description |
| --- | --- | --- |
| `joinOptions` | `{}` | Options passed to `join()`. `server` defaults to the `?server=` URL parameter |
| `storageKey` | `"airpad:session"` | `localStorage` key of the last session |
| `onConnect` | – | Called with the new `Peer` after each (re)connection, to listen to events |
| every `createController` option | | See below |

For a fully custom controller page, join yourself and send your own events:

```js
import { join, Events, ButtonEvent, createController } from "airpad3";

const pad = await join(location.hash.slice(1)); // resolves once connected
console.log(`You are player ${pad.number}`);
pad.send(new ButtonEvent(Events.BUTTON_DOWN, { button: "Start" }));

// Or mount the default controller UI on it, with other button names
createController(pad, { buttons: ["Jump", "Fire"] });
```

| `createController` option | Default | Description |
| --- | --- | --- |
| `element` | `document.body` | Where to mount the controller |
| `buttons` | `["A", "B"]` | One or two button names, top to bottom |
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
| `CONNECT`, `DISCONNECT`, `ERROR` | `CustomEvent` | local | Connection lifecycle: `event.detail.reason` for `DISCONNECT`, the error in `event.detail` for `ERROR`. On the session, they come with `event.controller`. Can't be sent |

Automatic events can be turned off with `join(id, { deviceEvents: false })`.

### Custom events

Any event can be sent, its `detail` must be JSON-serializable:

```js
session.send(new CustomEvent("score", { detail: 42 }));
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
| `host(options)` | Create a session (computer side). Resolves with a `Session` |
| `session.id`, `session.url` | Session ID, and the controller URL to put in the QR code |
| `session.controllers` | Every `Peer` in the session, connected or not, by number (kicked ones are removed) |
| `session.send(event)` | Dispatch an event on every connected controller. Returns `false` when none got it |
| `session.close()` | End the session, disconnecting every controller with `DisconnectReasons.ENDED` |
| `controller.kick()` | Remove a controller and free its place, it can only come back by scanning the QR code (computer side) |
| `join(id, options)` | Join a session (phone side). Resolves with a connected `Peer` |
| `peer.number` | Player number, from 1 |
| `peer.id`, `peer.ready` | Session ID, and a promise resolved on the first connection (phone side only) |
| `peer.send(event)` | Dispatch an event on the other side. Returns `false` (and sends nothing) when not connected |
| `peer.isConnected` | Whether the connection is open |
| `peer.close()` | Disconnect. On the computer, the player can still come back |
| `mountController(options)` | Turn the page into a controller (join, UI, player number, status, resume) |
| `createController(peer, options)` | Mount the default controller UI on a peer |
| `addEventListener(type, listener)` | On a session or a peer, for remote or lifecycle events |

### Options

| Option | Default | Description |
| --- | --- | --- |
| `server` | `https://ntfy.sh` | ntfy server (you can host your own) |
| `iceServers` | Google STUN | STUN/TURN servers |
| `timeout` | 15 s | Max pairing delay (`join` only) |
| `player` | remembered on the device | Player ID, to get the same number back when reconnecting (`join` only) |
| `resume` | `false` | Automatic reconnection rather than a QR code scan, refused for a kicked player (`join` only). On refusal, the error has `reason: "kicked"` (or `"busy"` when too many phones join at once) |
| `controllerUrl` | `"controller.html"` | Controller page URL, resolved against the current page (`host` only). `HOSTED_CONTROLLER_URL` points to a ready-made one, for quick tests |
| `deviceEvents` | `true` | Send `ROTATE`, `LOCK` and `UNLOCK` automatically (`join` only) |

## Demo

Live at [airpad3.vercel.app](https://airpad3.vercel.app): open it on a computer and scan the QR code with one or more phones.

To run it locally:

```sh
npm run demo
```

Open `/demo/` on the computer and scan the QR code with a phone on the same network.

## Limitations

- ntfy topics are public: the random 16-character ID is enough to avoid collisions, but signaling data is not encrypted.
- ntfy.sh applies per-IP rate limits to anonymous users.
- Outside a local network, some NATs require a TURN server.
- Each controller has its own WebRTC connection to the computer: fine for a living room full of players, not for hundreds.
- Anyone with the session ID (in the QR code) can join. Pairing messages, player IDs included, are readable by anyone who knows it: they could impersonate a player.
- At most 10 pairings are handled at once, against hello spam.

## Tests

```sh
npm test
```

The tests run a local fake ntfy server with two Node WebRTC peers (`node-datachannel`), and the default controller in a simulated DOM (`jsdom`).

## License

[MIT](LICENSE) © Guillaume Martigny
