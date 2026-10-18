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

const DEFAULT_ICE_SERVERS = [
    {
        urls: "stun:stun.l.google.com:19302",
    },
];

/**
 * Internal method to plug a WebRTC connection into a peer
 * @type {symbol}
 */
const ATTACH = Symbol("attach");

/**
 * Internal hook called when the peer is closed by its owner
 * @type {symbol}
 */
const DISPOSE = Symbol("dispose");

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
 * One end of an Airpad connection.
 * Works like any native event target: `addEventListener(type, listener)`.
 * Any event passed to `send(event)` is dispatched on the remote peer,
 * rebuilt with the same class, type and `detail`.
 *
 * Lifecycle events, dispatched locally: `Events.OPEN`, `Events.CLOSE`
 * and `Events.ERROR` (the error is in `event.detail`).
 * On the display side, a session outlives its controllers:
 * `OPEN` and `CLOSE` are dispatched each time a controller connects or leaves.
 */
export class Peer extends EventTarget {
    #connection;
    #channel;
    #open = false;
    #closed = false;

    /**
     * Resolved when the connection first opens
     * @type {Promise<void>}
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
    get isOpen () {
        return this.#open && this.#channel?.readyState === "open";
    }

    /**
     * Dispatch an event on the remote peer.
     * @example peer.send(new ButtonEvent(Events.BUTTON_DOWN, { button: "A" }))
     * @example peer.send(new CustomEvent("score", { detail: 42 }))
     * @param {Event} event - any event, its `detail` must be JSON-serializable
     */
    send (event) {
        if (!(event instanceof Event)) {
            throw new TypeError("Airpad: send() expects an Event, like new ButtonEvent(…) or new CustomEvent(…)");
        }
        if (RESERVED_EVENTS.has(event.type)) {
            throw new Error(`Airpad: "${event.type}" is a reserved event type`);
        }
        if (!this.isOpen) {
            throw new Error("Airpad: connection is not open");
        }
        this.#channel.send(JSON.stringify({
            type: event.type,
            detail: event.detail,
        }));
    }

    /**
     * Close the connection (and the session, on the display side).
     */
    close () {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this[DISPOSE]?.();
        this.#detach();
    }

    /**
     * Plug a WebRTC connection, replacing the current one.
     * @param {RTCPeerConnection} connection -
     * @param {Promise<RTCDataChannel>} channelPromise -
     * @return {Promise<void>} resolved when open, rejected if it fails before
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
        const lost = () => {
            if (!isCurrent() || state === "closed") {
                return;
            }
            const wasOpen = state === "open";
            state = "closed";
            this.#open = false;
            if (wasOpen) {
                this.#dispatch(Events.CLOSE);
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
                state = "open";
                this.#open = true;
                this.#dispatch(Events.OPEN);
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
     */
    #detach () {
        const connection = this.#connection;
        if (!connection) {
            return;
        }
        const wasOpen = this.#open;
        this.#open = false;
        this.#connection = undefined;
        this.#channel = undefined;
        connection.close();
        if (wasOpen) {
            this.#dispatch(Events.CLOSE);
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
    }

    /**
     * @param {string} type -
     * @param {*} [detail] -
     */
    #dispatch (type, detail) {
        this.dispatchEvent(new CustomEvent(type, {
            detail,
        }));
    }
}

/**
 * Display side (computer): create a session and wait for controllers.
 * The session stays open until `close()`: a controller can leave and come back
 * (or another one can take its place) with the same ID.
 * @param {AirpadOptions & {controllerUrl?: string}} [options] -
 * `controllerUrl` is resolved against the current page (default: "controller.html")
 * @return {Promise<Peer & {id: string, url: string}>}
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
    const peer = new Peer();
    peer.id = id;
    const url = new URL(controllerUrl, globalThis.location?.href);
    if (server) {
        url.searchParams.set("server", server);
    }
    url.hash = id;
    peer.url = url.toString();

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
    const reportError = error => peer.dispatchEvent(new CustomEvent(Events.ERROR, {
        detail: error,
    }));

    let next = prepare();
    let pending;
    let resolveReady;
    peer.ready = new Promise((resolve) => {
        resolveReady = resolve;
    });

    const onMessage = async (message) => {
        try {
            if (message.type === "hello" && message.nonce) {
                let offer = await next;
                // Don't hand out an offer left unused for too long
                if (Date.now() - offer.createdAt > 60 * 1000) {
                    offer.connection.close();
                    offer = await prepare();
                }
                next = prepare();
                pending?.connection.close();
                pending = {
                    ...offer,
                    nonce: message.nonce,
                };
                await signaling.publish({
                    type: "offer",
                    nonce: message.nonce,
                    sdp: offer.sdp,
                });
            }
            else if (message.type === "answer" && message.nonce && message.nonce === pending?.nonce) {
                const { connection, channel } = pending;
                pending = undefined;
                await connection.setRemoteDescription({
                    type: "answer",
                    sdp: message.sdp,
                });
                peer[ATTACH](connection, Promise.resolve(channel)).then(resolveReady, () => {});
            }
        }
        catch (error) {
            reportError(error);
        }
    };

    const unsubscribe = signaling.subscribe(onMessage);
    peer[DISPOSE] = () => {
        unsubscribe();
        pending?.connection.close();
        next.then(({ connection }) => connection.close(), () => {});
    };

    return peer;
}

/**
 * Controller side (phone): join a session from its ID.
 * Resolves once the connection is open.
 * @param {string} id - ID read from the QR code
 * @param {AirpadOptions & {timeout?: number, deviceEvents?: boolean}} [options] -
 * `timeout` (default 15s) max pairing delay,
 * `deviceEvents` (default `true`) sends `Events.ROTATE`, `Events.LOCK` and `Events.UNLOCK` automatically
 * @return {Promise<Peer>}
 */
export async function join (id, options = {}) {
    const {
        server,
        iceServers = DEFAULT_ICE_SERVERS,
        timeout = 15 * 1000,
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
    });
    let offer;
    try {
        offer = await signaling.wait(message => message.type === "offer" && message.nonce === nonce, {
            since: hello.id,
            timeout: remaining(),
        });
    }
    catch {
        throw new Error("Airpad: session not found");
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
    peer.ready = peer[ATTACH](connection, channelPromise);

    await connection.setRemoteDescription({
        type: "offer",
        sdp: offer.sdp,
    });
    await connection.setLocalDescription(await connection.createAnswer());
    await gatherCandidates(connection);
    await signaling.publish({
        type: "answer",
        nonce,
        sdp: connection.localDescription.sdp,
    });

    try {
        await withTimeout(peer.ready, remaining());
    }
    catch (error) {
        peer.close();
        throw error;
    }

    if (deviceEvents) {
        peer.addEventListener(Events.CLOSE, watchDevice(peer), {
            once: true,
        });
    }
    return peer;
}
