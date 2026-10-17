import { createSignaling } from "./signaling.js";

export { DEFAULT_SERVER } from "./signaling.js";

const TOPIC_PREFIX = "airpad-";
const DEFAULT_ICE_SERVERS = [
    {
        urls: "stun:stun.l.google.com:19302",
    },
];

/**
 * @typedef {Object} AirpadOptions
 * @property {string} [server="https://ntfy.sh"] - serveur ntfy utilisé pour l'appairage
 * @property {RTCIceServer[]} [iceServers] - serveurs STUN/TURN
 * @property {number} [timeout] - délai max d'appairage, en millisecondes
 */

/**
 * @typedef {Object} Peer
 * @property {Function} on - on(eventName, callback) : "open", "message", "close", "error"
 * @property {Function} off - off(eventName, callback)
 * @property {Function} send - envoie une donnée sérialisable en JSON
 * @property {Function} close - ferme la connexion
 * @property {Promise<void>} ready - résolue à l'ouverture du canal
 * @property {RTCPeerConnection} connection - connexion WebRTC sous-jacente
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
 * Attend la fin de la collecte des candidats ICE, avec un délai max.
 * La réponse est envoyée en une fois, sans « trickle ICE ».
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
            timer = setTimeout(() => reject(new Error("Airpad: délai d'attente dépassé")), timeout);
        }),
    ]).finally(() => clearTimeout(timer));
}

/**
 * @param {RTCPeerConnection} connection -
 * @param {Promise<RTCDataChannel>} channelPromise -
 * @return {Peer & {emit: Function}}
 */
function createPeer (connection, channelPromise) {
    const listeners = {};
    let channel;

    const peer = {
        connection,
        on (eventName, callback) {
            (listeners[eventName] ??= new Set()).add(callback);
            return peer;
        },
        off (eventName, callback) {
            listeners[eventName]?.delete(callback);
            return peer;
        },
        emit (eventName, payload) {
            listeners[eventName]?.forEach(callback => callback(payload));
        },
        send (data) {
            if (channel?.readyState !== "open") {
                throw new Error("Airpad: la connexion n'est pas ouverte");
            }
            channel.send(JSON.stringify(data));
        },
        close () {
            channel?.close();
            connection.close();
        },
    };

    peer.ready = channelPromise.then((dataChannel) => {
        channel = dataChannel;
        channel.addEventListener("message", ({ data }) => {
            try {
                peer.emit("message", JSON.parse(data));
            }
            catch (error) {
                peer.emit("error", error);
            }
        });
        channel.addEventListener("close", () => peer.emit("close"));

        if (channel.readyState === "open") {
            return undefined;
        }
        return new Promise((resolve) => {
            channel.addEventListener("open", () => resolve(), {
                once: true,
            });
        });
    }).then(() => peer.emit("open"));

    connection.addEventListener("connectionstatechange", () => {
        if (connection.connectionState === "failed") {
            peer.emit("error", new Error("Airpad: la connexion WebRTC a échoué"));
        }
    });

    return peer;
}

/**
 * Côté écran (ordinateur) : crée une session et attend un contrôleur.
 * @param {AirpadOptions & {controllerUrl?: string}} [options] -
 * @return {Promise<Peer & {id: string, url?: string}>}
 */
export async function host (options = {}) {
    const {
        server,
        iceServers = DEFAULT_ICE_SERVERS,
        timeout = 5 * 60 * 1000,
        controllerUrl,
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

    const peer = createPeer(connection, Promise.resolve(channel));
    peer.id = id;
    if (controllerUrl) {
        const url = new URL(controllerUrl, globalThis.location?.href);
        url.hash = id;
        peer.url = url.toString();
    }

    signaling.wait("answer", {
        since: published.id,
        timeout,
    })
        .then(({ sdp }) => connection.setRemoteDescription({
            type: "answer",
            sdp,
        }))
        .catch(error => peer.emit("error", error));

    return peer;
}

/**
 * Côté contrôleur (mobile) : rejoint une session à partir de son ID.
 * Résolue une fois le canal ouvert.
 * @param {string} id - ID lu dans le QR code
 * @param {AirpadOptions} [options] -
 * @return {Promise<Peer>}
 */
export async function join (id, options = {}) {
    const {
        server,
        iceServers = DEFAULT_ICE_SERVERS,
        timeout = 15 * 1000,
    } = options;

    const signaling = createSignaling(TOPIC_PREFIX + id, {
        server,
    });
    const offer = await signaling.last("offer");
    if (!offer) {
        throw new Error("Airpad: session introuvable");
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

    const peer = createPeer(connection, channelPromise);
    try {
        await withTimeout(peer.ready, timeout);
    }
    catch (error) {
        connection.close();
        throw error;
    }
    return peer;
}
