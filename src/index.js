import { createSignaling } from "./signaling.js";
import { Events, RESERVED_EVENTS, reviveEvent } from "./events.js";
import { watchDevice } from "./device.js";

export { DEFAULT_SERVER } from "./signaling.js";
export { createController, mountController } from "./controller.js";
export {
    Events,
    AirpadEvent,
    ButtonEvent,
    StickEvent,
    RotateEvent,
    VibrateEvent,
    LockEvent,
    registerEvent,
} from "./events.js";

const TOPIC_PREFIX = "airpad-";

/**
 * Default controller page, relative to the display page
 * @type {string}
 */
export const DEFAULT_CONTROLLER_URL = "controller.html";

/**
 * Ready-made controller page hosted with the demo, for quick tests
 * @type {string}
 */
export const HOSTED_CONTROLLER_URL = "https://airpad3.vercel.app/controller/";

/**
 * Where the phone remembers its player ID, so it gets its number back when it reconnects
 * @type {string}
 */
const PLAYER_STORAGE_KEY = "airpad:player";

const DEFAULT_ICE_SERVERS = [
    {
        urls: "stun:stun.l.google.com:19302",
    },
];

/**
 * How long an offer can wait for its answer
 * @type {number}
 */
const PENDING_TIMEOUT = 60 * 1000;

/**
 * Internal method to plug a WebRTC connection into a peer
 * @type {symbol}
 */
const ATTACH = Symbol("attach");

/**
 * Internal hook called with every event a peer dispatches, to relay it on the session
 * @type {symbol}
 */
const RELAY = Symbol("relay");

/**
 * Internal method to tell the other side why it's disconnected, then close
 * @type {symbol}
 */
const DISMISS = Symbol("dismiss");

/**
 * Internal method deciding whether a player may join
 * @type {symbol}
 */
const ADMIT = Symbol("admit");

/**
 * Why a peer got disconnected, in `event.detail.reason` of `Events.DISCONNECT`
 * @readonly
 * @enum {string}
 */
export const DisconnectReasons = Object.freeze({
    // close() was called on this side
    CLOSED: "closed",
    // The connection dropped, or the other side closed it
    LOST: "lost",
    // The display kicked this controller: it can only join again by scanning the QR code
    KICKED: "kicked",
    // The display closed the session
    ENDED: "ended",
});

/**
 * Internal messages between peers, not dispatched as events, by disconnect reason
 * @type {Object<string, string>}
 */
const CONTROL_MESSAGES = {
    [DisconnectReasons.KICKED]: "kick",
    [DisconnectReasons.ENDED]: "end",
};

/**
 * Max number of pairings in progress, against hello spam
 * @type {number}
 */
const MAX_PENDING = 10;

/**
 * @typedef {Object} AirpadOptions
 * @property {string} [server="https://ntfy.sh"] - ntfy server used for pairing
 * @property {RTCIceServer[]} [iceServers] - STUN/TURN servers
 */

/**
 * @param {number} [length=16] -
 * @return {string}
 */
function randomId (length = 16) {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    return Array.from(crypto.getRandomValues(new Uint8Array(length)), byte => alphabet[byte % alphabet.length])
        .join("");
}

/**
 * Player ID remembered on this device, or a new one when storage isn't available.
 * @return {string}
 */
function devicePlayerId () {
    try {
        const storage = globalThis.localStorage;
        let player = storage?.getItem(PLAYER_STORAGE_KEY);
        if (!player) {
            player = randomId();
            storage?.setItem(PLAYER_STORAGE_KEY, player);
        }
        return player;
    }
    catch {
        return randomId();
    }
}

/**
 * Wait for ICE candidate gathering to complete, with a max delay.
 * The description is sent in one go, without trickle ICE.
 * @param {RTCPeerConnection} connection -
 * @param {number} [timeout=2000] -
 * @return {Promise<void>}
 */
function gatherCandidates (connection, timeout = 2000) {
    if (connection.iceGatheringState === "complete") {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            connection.removeEventListener("icegatheringstatechange", check);
            resolve();
        };
        const check = () => {
            if (connection.iceGatheringState === "complete") {
                done();
            }
        };
        const timer = setTimeout(done, timeout);
        connection.addEventListener("icegatheringstatechange", check);
    });
}

/**
 * @param {Promise} promise -
 * @param {number} timeout -
 * @return {Promise}
 */
function withTimeout (promise, timeout) {
    let timer;
    return Promise.race([
        promise,
        new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Airpad: timed out")), timeout);
        }),
    ]).finally(() => clearTimeout(timer));
}

/**
 * @param {string} controllerUrl - absolute, or relative to the current page
 * @param {string} id -
 * @param {string} [server] -
 * @return {string}
 */
function buildControllerUrl (controllerUrl, id, server) {
    const base = globalThis.location?.href;
    // Without a current page (outside a browser), a relative URL is kept relative
    const placeholder = "relative://airpad/";
    const url = new URL(controllerUrl, base ?? placeholder);
    if (server) {
        url.searchParams.set("server", server);
    }
    url.hash = id;
    return url.toString().replace(placeholder, "");
}

/**
 * Attach the controller an event comes from.
 * @param {Event} event -
 * @param {Peer} controller -
 * @return {Event}
 */
function fromController (event, controller) {
    Object.defineProperty(event, "controller", {
        value: controller,
        enumerable: true,
    });
    return event;
}

/**
 * One end of a WebRTC connection between the display and a controller.
 * - on the phone, `join()` returns one
 * - on the computer, the session holds one per controller (`session.controllers`)
 *
 * Works like any native event target: `addEventListener(type, listener)`.
 * Any event passed to `send(event)` is dispatched on the remote peer,
 * rebuilt with the same class, type and `detail`.
 *
 * Lifecycle events, dispatched locally: `Events.CONNECT`, `Events.DISCONNECT`
 * (with `event.detail.reason`, see `DisconnectReasons`) and `Events.ERROR` (the error is in `event.detail`).
 * A peer can connect again after a disconnection (same player coming back).
 */
export class Peer extends EventTarget {
    #connection;
    #channel;
    #connected = false;

    /**
     * Player number, from 1, given by the display
     * @type {number}
     */
    number;

    /**
     * Session ID (phone side only)
     * @type {string|undefined}
     */
    id;

    /**
     * Resolved when the connection first opens (phone side only)
     * @type {Promise<void>|undefined}
     */
    ready;

    /**
     * Current underlying WebRTC connection
     * @return {RTCPeerConnection|undefined}
     */
    get connection () {
        return this.#connection;
    }

    /**
     * Whether the connection is open
     * @return {boolean}
     */
    get isConnected () {
        return this.#connected && this.#channel?.readyState === "open";
    }

    /**
     * Dispatch an event on the remote peer.
     * Does nothing when not connected.
     * @example peer.send(new ButtonEvent(Events.BUTTON_DOWN, { button: "A" }))
     * @example peer.send(new CustomEvent("score", { detail: 42 }))
     * @param {Event} event - any event, its `detail` must be JSON-serializable
     * @return {boolean} whether the event was sent
     */
    send (event) {
        if (!(event instanceof Event)) {
            throw new TypeError("Airpad: send() expects an Event, like new ButtonEvent(…) or new CustomEvent(…)");
        }
        if (RESERVED_EVENTS.has(event.type)) {
            throw new Error(`Airpad: "${event.type}" is a reserved event type`);
        }
        if (!this.isConnected) {
            return false;
        }
        this.#channel.send(JSON.stringify({
            type: event.type,
            detail: event.detail,
        }));
        return true;
    }

    /**
     * Close the connection. On the computer, this disconnects the controller,
     * which can still come back later (see `kick()` to prevent it).
     */
    close () {
        this.#detach(DisconnectReasons.CLOSED);
    }

    /**
     * Tell the other side why it's disconnected, then close the connection.
     * @param {string} reason - `DisconnectReasons.KICKED` or `DisconnectReasons.ENDED`
     */
    [DISMISS] (reason) {
        if (this.isConnected) {
            try {
                this.#channel.send(JSON.stringify({
                    control: CONTROL_MESSAGES[reason],
                }));
            }
            catch {
                // Closing anyway
            }
        }
        this.#detach(reason);
    }

    /**
     * Plug a WebRTC connection, replacing the current one.
     * @param {RTCPeerConnection} connection -
     * @param {Promise<RTCDataChannel>} channelPromise -
     * @return {Promise<void>} resolved when connected, rejected if it fails before
     */
    [ATTACH] (connection, channelPromise) {
        this.#detach();
        this.#connection = connection;
        const isCurrent = () => connection === this.#connection;

        let state = "connecting";
        let fail;
        const failed = new Promise((resolve, reject) => {
            fail = reject;
        });
        // Always handled by the race below, avoid any unhandled rejection report
        failed.catch(() => {});
        const lost = () => {
            if (!isCurrent() || state === "closed") {
                return;
            }
            const wasConnected = state === "connected";
            state = "closed";
            this.#connected = false;
            if (wasConnected) {
                this.#dispatch(Events.DISCONNECT, {
                    reason: DisconnectReasons.LOST,
                });
            }
            else {
                fail(new Error("Airpad: WebRTC connection failed"));
            }
        };
        connection.addEventListener("connectionstatechange", () => {
            if (["failed", "closed"].includes(connection.connectionState)) {
                lost();
            }
        });

        const opened = channelPromise.then((channel) => {
            if (!isCurrent()) {
                return failed;
            }
            this.#channel = channel;
            channel.addEventListener("message", ({ data }) => {
                if (isCurrent()) {
                    this.#receive(data);
                }
            });
            channel.addEventListener("close", lost);
            if (channel.readyState === "open") {
                return undefined;
            }
            return new Promise((resolve) => {
                channel.addEventListener("open", () => resolve(), {
                    once: true,
                });
            });
        });

        const result = Promise.race([opened, failed]).then(
            () => {
                if (!isCurrent() || state === "closed") {
                    throw new Error("Airpad: WebRTC connection failed");
                }
                state = "connected";
                this.#connected = true;
                this.#dispatch(Events.CONNECT);
            },
            (error) => {
                this.#dispatch(Events.ERROR, error);
                throw error;
            },
        );
        // Failures are reported through the "error" event, avoid unhandled rejections
        result.catch(() => {});
        return result;
    }

    /**
     * Close the current connection, if any.
     * @param {string} [reason] - from `DisconnectReasons`
     */
    #detach (reason = DisconnectReasons.CLOSED) {
        const connection = this.#connection;
        if (!connection) {
            return;
        }
        const channel = this.#channel;
        const wasConnected = this.#connected;
        this.#connected = false;
        this.#connection = undefined;
        this.#channel = undefined;
        // Let queued messages (like a kick) go out before closing the connection
        channel?.close();
        setTimeout(() => connection.close(), channel ? 200 : 0);
        if (wasConnected) {
            this.#dispatch(Events.DISCONNECT, {
                reason,
            });
        }
    }

    /**
     * @param {string} data -
     */
    #receive (data) {
        let message;
        try {
            message = JSON.parse(data);
        }
        catch (error) {
            this.#dispatch(Events.ERROR, error);
            return;
        }
        if (message?.control) {
            const reason = Object.keys(CONTROL_MESSAGES).find(key => CONTROL_MESSAGES[key] === message.control);
            this.#detach(reason ?? DisconnectReasons.LOST);
            return;
        }
        if (typeof message?.type !== "string" || !message.type || RESERVED_EVENTS.has(message.type)) {
            return;
        }
        const event = reviveEvent(message.type, message.detail);
        const notCanceled = this.dispatchEvent(event);
        if (notCanceled && typeof event.defaultAction === "function") {
            // Default actions are best effort (no vibration support…)
            Promise.resolve()
                .then(() => event.defaultAction())
                .catch(() => {});
        }
        this[RELAY]?.(message.type, message.detail, true);
    }

    /**
     * @param {string} type -
     * @param {*} [detail] -
     */
    #dispatch (type, detail) {
        this.dispatchEvent(new CustomEvent(type, {
            detail,
        }));
        this[RELAY]?.(type, detail, false);
    }
}

/**
 * Display side session: one QR code, as many controllers as needed.
 * Every event received from a controller is dispatched here too,
 * with `event.controller` telling which one sent it.
 * `Events.CONNECT` and `Events.DISCONNECT` are dispatched each time a controller connects or leaves.
 * A controller that comes back (same phone) gets its number back.
 */
export class Session extends EventTarget {
    /**
     * Session ID, in the QR code
     * @type {string}
     */
    id;

    /**
     * Controller page URL with the session ID, to put in the QR code
     * @type {string}
     */
    url;

    #controllers = new Map();
    #numbers = new Map();
    #kicked = new Set();
    #closed = false;
    #dispose;

    /**
     * @param {string} id -
     * @param {string} url -
     * @param {Function} dispose - stops listening for controllers
     */
    constructor (id, url, dispose) {
        super();
        this.id = id;
        this.url = url;
        this.#dispose = dispose;
    }

    /**
     * Every controller that joined, connected or not, by player number.
     * A player keeps its place (and number) until kicked.
     * @return {Peer[]}
     */
    get controllers () {
        return [...this.#controllers.values()].sort((a, b) => a.number - b.number);
    }

    /**
     * Whether the session is closed
     * @return {boolean}
     */
    get isClosed () {
        return this.#closed;
    }

    /**
     * Dispatch an event on every connected controller.
     * Use `controller.send(event)` to target a single one.
     * @param {Event} event - any event, its `detail` must be JSON-serializable
     * @return {boolean} whether at least one controller got it
     */
    send (event) {
        return this.controllers
            .map(controller => controller.send(event))
            .some(Boolean);
    }

    /**
     * Remove a controller from the session: it's disconnected, its place and number are freed,
     * and its automatic reconnections are refused. It can only join again by scanning the QR code,
     * as a new player.
     * Same as `controller.kick()`.
     * @param {Peer} controller -
     */
    kick (controller) {
        const player = [...this.#controllers].find(([, peer]) => peer === controller)?.[0];
        if (player === undefined) {
            throw new Error("Airpad: this controller isn't part of the session");
        }
        this.#kicked.add(player);
        this.#controllers.delete(player);
        this.#numbers.delete(player);
        controller[DISMISS](DisconnectReasons.KICKED);
    }

    /**
     * Whether a kicked player is still refused
     * @param {string} player -
     * @return {boolean}
     */
    isKicked (player) {
        return this.#kicked.has(player);
    }

    /**
     * Decide whether a player may join, and give it a number.
     * A QR code scan (not a resume) lifts a kick.
     * @param {string} player -
     * @param {boolean} resume - automatic reconnection, not a QR code scan
     * @return {number|undefined} the player number, or undefined if refused
     */
    [ADMIT] (player, resume) {
        if (!resume) {
            this.#kicked.delete(player);
        }
        if (this.#kicked.has(player)) {
            return undefined;
        }
        if (!this.#numbers.has(player)) {
            // Lowest free number, places freed by kicks are taken again
            const taken = new Set(this.#numbers.values());
            let number = 1;
            while (taken.has(number)) {
                number++;
            }
            this.#numbers.set(player, number);
        }
        return this.#numbers.get(player);
    }

    /**
     * End the session: disconnects every controller (with `DisconnectReasons.ENDED`),
     * and none can join anymore.
     */
    close () {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#dispose();
        this.#controllers.forEach(controller => controller[DISMISS](DisconnectReasons.ENDED));
    }

    /**
     * @param {string} player - player ID, stable across reconnections
     * @param {number} number -
     * @return {Peer}
     */
    [ATTACH] (player, number) {
        let controller = this.#controllers.get(player);
        if (!controller) {
            controller = new Peer();
            controller.number = number;
            controller.kick = () => this.kick(controller);
            controller[RELAY] = (type, detail, remote) => {
                const event = remote ? reviveEvent(type, detail) : new CustomEvent(type, {
                    detail,
                });
                this.dispatchEvent(fromController(event, controller));
            };
            this.#controllers.set(player, controller);
        }
        return controller;
    }
}

/**
 * Display side (computer): create a session and wait for controllers.
 * Controllers join by scanning the QR code (`session.url`), as many as needed.
 * The session stays open until `close()`.
 * @param {AirpadOptions & {controllerUrl?: string}} [options] -
 * `controllerUrl` is resolved against the current page (default: "controller.html")
 * @return {Promise<Session>}
 */
export async function host (options = {}) {
    const {
        server,
        iceServers = DEFAULT_ICE_SERVERS,
        controllerUrl = DEFAULT_CONTROLLER_URL,
    } = options;

    const id = randomId();
    const signaling = createSignaling(TOPIC_PREFIX + id, {
        server,
    });

    /**
     * Offers are prepared in advance, so a controller gets one right away
     * @return {Promise<{connection: RTCPeerConnection, channel: RTCDataChannel, sdp: string, createdAt: number}>}
     */
    const prepare = async () => {
        const connection = new RTCPeerConnection({
            iceServers,
        });
        const channel = connection.createDataChannel("airpad");
        await connection.setLocalDescription(await connection.createOffer());
        await gatherCandidates(connection);
        return {
            connection,
            channel,
            sdp: connection.localDescription.sdp,
            createdAt: Date.now(),
        };
    };
    /**
     * Prepare the next offer in the background, a failure is retried on the next hello
     * @return {Promise}
     */
    const prepareNext = () => {
        const promise = prepare();
        promise.catch(() => {});
        return promise;
    };

    let next = prepareNext();
    const pending = new Map();
    const refuse = (nonce, reason) => signaling.publish({
        type: "refused",
        nonce,
        reason,
    });

    const unsubscribe = signaling.subscribe(message => onMessage(message));
    const session = new Session(id, buildControllerUrl(controllerUrl, id, server), () => {
        unsubscribe();
        pending.forEach(({ connection, timer }) => {
            clearTimeout(timer);
            connection.close();
        });
        pending.clear();
        next.then(({ connection }) => connection.close(), () => {});
    });
    const reportError = error => session.dispatchEvent(new CustomEvent(Events.ERROR, {
        detail: error,
    }));

    /**
     * @param {Object} message -
     */
    async function onMessage (message) {
        if (session.isClosed || !message.nonce) {
            return;
        }
        try {
            if (message.type === "hello") {
                if (pending.size >= MAX_PENDING) {
                    await refuse(message.nonce, "busy");
                    return;
                }
                // A player keeps its number for the whole session, unless kicked
                const player = String(message.player || message.nonce);
                const number = session[ADMIT](player, Boolean(message.resume));
                if (number === undefined) {
                    await refuse(message.nonce, DisconnectReasons.KICKED);
                    return;
                }

                // Take the prepared offer right away, so concurrent hellos never share one
                const prepared = next;
                next = prepareNext();
                let offer = await prepared.catch(() => undefined);
                // Don't hand out a failed offer, or one left unused for too long
                if (!offer || Date.now() - offer.createdAt > PENDING_TIMEOUT) {
                    offer?.connection.close();
                    offer = await prepare();
                }
                if (session.isClosed) {
                    offer.connection.close();
                    return;
                }

                const timer = setTimeout(() => {
                    pending.delete(message.nonce);
                    offer.connection.close();
                }, PENDING_TIMEOUT);
                pending.set(message.nonce, {
                    ...offer,
                    player,
                    number,
                    timer,
                });
                await signaling.publish({
                    type: "offer",
                    nonce: message.nonce,
                    number,
                    sdp: offer.sdp,
                });
            }
            else if (message.type === "answer" && pending.has(message.nonce)) {
                const { connection, channel, player, number, timer } = pending.get(message.nonce);
                pending.delete(message.nonce);
                clearTimeout(timer);
                // Kicked while pairing: refuse it
                if (session.isKicked(player)) {
                    connection.close();
                    await refuse(message.nonce, DisconnectReasons.KICKED);
                    return;
                }
                await connection.setRemoteDescription({
                    type: "answer",
                    sdp: message.sdp,
                });
                // Same player coming back (or a second tab): the new connection replaces the old one
                session[ATTACH](player, number)[ATTACH](connection, Promise.resolve(channel));
            }
        }
        catch (error) {
            reportError(error);
        }
    }

    return session;
}

/**
 * @param {string} reason -
 * @return {Error} with the refusal `reason`
 */
function refusal (reason) {
    const message = reason === DisconnectReasons.KICKED ?
        "Airpad: kicked from this session, scan the QR code to join again" :
        "Airpad: too many players joining at once, try again";
    return Object.assign(new Error(message), {
        reason,
    });
}

/**
 * Controller side (phone): join a session from its ID.
 * Resolves once connected, with the player number in `peer.number`.
 * @param {string} id - ID read from the QR code
 * @param {AirpadOptions & {timeout?: number, player?: string, deviceEvents?: boolean}} [options] -
 * `timeout` (default 15s) max pairing delay,
 * `player` player ID, to get the same number back when reconnecting (default: remembered on this device),
 * `resume` (default `false`) automatic reconnection, refused for a kicked player (a fresh QR code scan isn't),
 * `deviceEvents` (default `true`) sends `Events.ROTATE`, `Events.LOCK` and `Events.UNLOCK` automatically
 * @return {Promise<Peer>}
 */
export async function join (id, options = {}) {
    const {
        server,
        iceServers = DEFAULT_ICE_SERVERS,
        timeout = 15 * 1000,
        player = devicePlayerId(),
        resume = false,
        deviceEvents = true,
    } = options;

    const start = Date.now();
    const remaining = () => Math.max(0, timeout - (Date.now() - start));
    const signaling = createSignaling(TOPIC_PREFIX + id, {
        server,
    });

    // Say hello, the display answers with a fresh offer for this nonce
    const nonce = randomId();
    const hello = await signaling.publish({
        type: "hello",
        nonce,
        player,
        resume,
    });
    let offer;
    try {
        offer = await signaling.wait(message => ["offer", "refused"].includes(message.type) && message.nonce === nonce, {
            since: hello.id,
            timeout: remaining(),
        });
    }
    catch {
        throw new Error("Airpad: session not found");
    }
    if (offer.type === "refused") {
        throw refusal(offer.reason);
    }

    const connection = new RTCPeerConnection({
        iceServers,
    });
    const channelPromise = new Promise((resolve) => {
        connection.addEventListener("datachannel", ({ channel }) => resolve(channel), {
            once: true,
        });
    });
    const peer = new Peer();
    peer.id = id;
    peer.number = offer.number;
    peer.ready = peer[ATTACH](connection, channelPromise);

    try {
        await connection.setRemoteDescription({
            type: "offer",
            sdp: offer.sdp,
        });
        await connection.setLocalDescription(await connection.createAnswer());
        await gatherCandidates(connection);
        const answer = await signaling.publish({
            type: "answer",
            nonce,
            sdp: connection.localDescription.sdp,
        });
        // The display can still refuse it (kicked while pairing)
        const stopListening = new AbortController();
        const refused = signaling.wait(message => message.type === "refused" && message.nonce === nonce, {
            since: answer.id,
            timeout: remaining(),
            signal: stopListening.signal,
        }).then(message => Promise.reject(refusal(message.reason)), () => new Promise(() => {}));
        try {
            await withTimeout(Promise.race([peer.ready, refused]), remaining());
        }
        finally {
            stopListening.abort();
        }
    }
    catch (error) {
        peer.close();
        throw error;
    }

    if (deviceEvents) {
        peer.addEventListener(Events.DISCONNECT, watchDevice(peer), {
            once: true,
        });
    }
    return peer;
}
