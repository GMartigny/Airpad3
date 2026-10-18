import { createSignaling } from "./signaling.js";
import { Events, RESERVED_EVENTS, reviveEvent } from "./events.js";
import { watchDevice } from "./device.js";

export { DEFAULT_SERVER } from "./signaling.js";
export { createController } from "./controller.js";
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
 * Hosted default controller page (see `controller/index.html`)
 * @type {string}
 */
export const DEFAULT_CONTROLLER_URL = "https://gmartigny.github.io/Airpad3/controller/";
const DEFAULT_ICE_SERVERS = [
    {
        urls: "stun:stun.l.google.com:19302",
    },
];

/**
 * @typedef {Object} AirpadOptions
 * @property {string} [server="https://ntfy.sh"] - ntfy server used for pairing
 * @property {RTCIceServer[]} [iceServers] - STUN/TURN servers
 * @property {number} [timeout] - max pairing delay, in milliseconds
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
 */
export class Peer extends EventTarget {
    #channel;

    /**
     * @param {RTCPeerConnection} connection -
     * @param {Promise<RTCDataChannel>} channelPromise -
     */
    constructor (connection, channelPromise) {
        super();

        /**
         * Underlying WebRTC connection
         * @type {RTCPeerConnection}
         */
        this.connection = connection;

        const failed = new Promise((resolve, reject) => {
            connection.addEventListener("connectionstatechange", () => {
                if (["failed", "closed"].includes(connection.connectionState) && !this.isOpen) {
                    reject(new Error("Airpad: WebRTC connection failed"));
                }
            });
        });

        const opened = channelPromise.then((channel) => {
            this.#channel = channel;
            channel.addEventListener("message", ({ data }) => this.#receive(data));
            channel.addEventListener("close", () => this.#dispatch(Events.CLOSE));

            if (channel.readyState === "open") {
                return undefined;
            }
            return new Promise((resolve) => {
                channel.addEventListener("open", () => resolve(), {
                    once: true,
                });
            });
        });

        /**
         * Resolved when the connection opens, rejected if it fails before
         * @type {Promise<void>}
         */
        this.ready = Promise.race([opened, failed]).then(
            () => this.#dispatch(Events.OPEN),
            (error) => {
                this.#dispatch(Events.ERROR, error);
                throw error;
            },
        );
        // Failures are reported through the "error" event, avoid unhandled rejections
        this.ready.catch(() => {});
    }

    /**
     * Whether the connection is open
     * @return {boolean}
     */
    get isOpen () {
        return this.#channel?.readyState === "open";
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
     * Close the connection.
     */
    close () {
        this.#channel?.close();
        this.connection.close();
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
            // Default actions are best effort (no vibration support, orientation lock refused…)
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
 * Display side (computer): create a session and wait for a controller.
 * @param {AirpadOptions & {controllerUrl?: string}} [options] -
 * @return {Promise<Peer & {id: string, url: string}>}
 */
export async function host (options = {}) {
    const {
        server,
        iceServers = DEFAULT_ICE_SERVERS,
        timeout = 5 * 60 * 1000,
        controllerUrl = DEFAULT_CONTROLLER_URL,
    } = options;

    const id = randomId();
    const signaling = createSignaling(TOPIC_PREFIX + id, {
        server,
    });

    const connection = new RTCPeerConnection({
        iceServers,
    });
    const channel = connection.createDataChannel("airpad");

    await connection.setLocalDescription(await connection.createOffer());
    await gatherCandidates(connection);
    const published = await signaling.publish({
        type: "offer",
        sdp: connection.localDescription.sdp,
    });

    const peer = new Peer(connection, Promise.resolve(channel));
    peer.id = id;
    const url = new URL(controllerUrl, globalThis.location?.href);
    if (server) {
        url.searchParams.set("server", server);
    }
    url.hash = id;
    peer.url = url.toString();

    signaling.wait("answer", {
        since: published.id,
        timeout,
    })
        .then(({ sdp }) => connection.setRemoteDescription({
            type: "answer",
            sdp,
        }))
        .catch(error => peer.dispatchEvent(new CustomEvent(Events.ERROR, {
            detail: error,
        })));

    return peer;
}

/**
 * Controller side (phone): join a session from its ID.
 * Resolves once the channel is open.
 * @param {string} id - ID read from the QR code
 * @param {AirpadOptions & {deviceEvents?: boolean}} [options] - `deviceEvents` (default `true`)
 * sends `Events.ROTATE`, `Events.LOCK` and `Events.UNLOCK` automatically
 * @return {Promise<Peer>}
 */
export async function join (id, options = {}) {
    const {
        server,
        iceServers = DEFAULT_ICE_SERVERS,
        timeout = 15 * 1000,
        deviceEvents = true,
    } = options;

    const signaling = createSignaling(TOPIC_PREFIX + id, {
        server,
    });
    const offer = await signaling.last("offer");
    if (!offer) {
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

    await connection.setRemoteDescription({
        type: "offer",
        sdp: offer.sdp,
    });
    await connection.setLocalDescription(await connection.createAnswer());
    await gatherCandidates(connection);
    await signaling.publish({
        type: "answer",
        sdp: connection.localDescription.sdp,
    });

    const peer = new Peer(connection, channelPromise);
    try {
        await withTimeout(peer.ready, timeout);
    }
    catch (error) {
        connection.close();
        throw error;
    }

    if (deviceEvents) {
        peer.addEventListener(Events.CLOSE, watchDevice(peer), {
            once: true,
        });
    }
    return peer;
}
