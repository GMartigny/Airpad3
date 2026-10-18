// End-to-end test: local fake ntfy server + Node WebRTC (node-datachannel).
// Run: node --experimental-eventsource e2e.test.js
import http from "node:http";
import assert from "node:assert/strict";
import { RTCPeerConnection } from "node-datachannel/polyfill";

globalThis.RTCPeerConnection = RTCPeerConnection;

// --- Fake ntfy: POST /topic, GET /topic/json?poll=1, GET /topic/sse?since=id
const topics = new Map();
const subscribers = new Map();
let counter = 0;
const ntfy = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const [, topic, kind] = url.pathname.split("/");
    const messages = topics.get(topic) ?? [];
    topics.set(topic, messages);

    if (request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => {
            body += chunk;
        });
        request.on("end", () => {
            const message = {
                id: `m${++counter}`,
                time: Date.now(),
                event: "message",
                topic,
                message: body,
            };
            messages.push(message);
            (subscribers.get(topic) ?? []).forEach(res => res.write(`data: ${JSON.stringify(message)}\n\n`));
            response.writeHead(200, {
                "Content-Type": "application/json",
            });
            response.end(JSON.stringify(message));
        });
        return;
    }
    if (kind === "json") {
        const since = url.searchParams.get("since");
        const start = since === "all" ? 0 : messages.findIndex(message => message.id === since) + 1;
        response.writeHead(200);
        response.end(messages.slice(start).map(message => JSON.stringify(message)).join("\n"));
        return;
    }
    if (kind === "sse") {
        response.writeHead(200, {
            "Content-Type": "text/event-stream",
        });
        response.write(`event: open\ndata: ${JSON.stringify({ event: "open" })}\n\n`);
        const since = url.searchParams.get("since");
        const index = messages.findIndex(message => message.id === since);
        messages.slice(index + 1).forEach(message => response.write(`data: ${JSON.stringify(message)}\n\n`));
        const list = subscribers.get(topic) ?? [];
        list.push(response);
        subscribers.set(topic, list);
        request.on("close", () => list.splice(list.indexOf(response), 1));
        return;
    }
    response.writeHead(404);
    response.end();
});
await new Promise(resolve => ntfy.listen(0, resolve));
const server = `http://localhost:${ntfy.address().port}`;

const {
    host,
    join,
    Events,
    Session,
    DisconnectReasons,
    AirpadEvent,
    ButtonEvent,
    StickEvent,
    RotateEvent,
    LockEvent,
    VibrateEvent,
    registerEvent,
} = await import("../src/index.js");

// --- Fake browser APIs used on the controller side
const vibrations = [];
Object.defineProperty(globalThis, "navigator", {
    value: {
        vibrate: pattern => vibrations.push(pattern),
    },
    configurable: true,
});
const portraitQuery = Object.assign(new EventTarget(), {
    matches: true,
});
globalThis.matchMedia = () => portraitQuery;
globalThis.document = Object.assign(new EventTarget(), {
    visibilityState: "visible",
});

const options = {
    server,
    iceServers: [],
};

/**
 * @param {EventTarget} target -
 * @param {string} type -
 * @param {Function} [filter] -
 * @return {Promise<Event>}
 */
const next = (target, type, filter = () => true) => new Promise((resolve) => {
    const listener = (event) => {
        if (filter(event)) {
            target.removeEventListener(type, listener);
            resolve(event);
        }
    };
    target.addEventListener(type, listener);
});

/**
 * @param {Promise} promise -
 * @param {number} timeout -
 * @return {Promise}
 */
const withTimeout = (promise, timeout) => Promise.race([
    promise,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error("test timed out")), timeout)),
]);

/**
 * Join as a given player, wait for both sides to be connected.
 * libdatachannel (the native WebRTC behind node-datachannel) sometimes rejects the answer with
 * "Got a remote candidate without ICE transport" and closes the connection.
 * This race is specific to the test environment, so joining is retried a few times.
 * The session survives failed attempts, which is also what this checks.
 * @param {Session} session -
 * @param {string} player -
 * @param {Object} [extra] - more join() options
 * @return {Promise<Peer>} the phone side
 */
async function connect (session, player, extra = {}) {
    for (let attempt = 1; ; attempt++) {
        const connected = next(session, Events.CONNECT, event => session.controllers
            .find(controller => controller === event.controller && controller.isConnected));
        try {
            const pad = await join(session.id, {
                ...options,
                ...extra,
                player,
            });
            await withTimeout(connected, 5000);
            return pad;
        }
        catch (error) {
            if (attempt >= 3) {
                throw error;
            }
        }
    }
}

const session = await host({
    ...options,
    controllerUrl: "https://example.com/remote/",
});
assert.ok(session instanceof Session);
assert.match(session.id, /^[a-z0-9]{16}$/);
assert.equal(session.url, `https://example.com/remote/?server=${encodeURIComponent(server)}#${session.id}`);
assert.deepEqual(session.controllers, []);
assert.equal(session.send(new CustomEvent("score")), false, "send() without controller does nothing");

// --- First player
const initialRotate = next(session, Events.ROTATE);
const initialUnlock = next(session, Events.UNLOCK);
const connectEvent = next(session, Events.CONNECT);
const pad1 = await connect(session, "player-one");
assert.equal(pad1.number, 1);
assert.ok(pad1.isConnected);
const [p1] = session.controllers;
assert.equal(p1.number, 1);
assert.ok(p1.isConnected);
assert.equal((await connectEvent).controller, p1);

// Device events are sent automatically, and relayed on the session with the controller
let event = await initialRotate;
assert.ok(event instanceof RotateEvent);
assert.equal(event.orientation, "portrait");
assert.equal(event.controller, p1);
event = await initialUnlock;
assert.ok(event instanceof LockEvent);
assert.equal(event.locked, false);

let received = next(session, Events.ROTATE);
portraitQuery.matches = false;
portraitQuery.dispatchEvent(new Event("change"));
assert.equal((await received).orientation, "landscape");

received = next(session, Events.LOCK);
document.visibilityState = "hidden";
document.dispatchEvent(new Event("visibilitychange"));
assert.ok((await received).locked);
document.visibilityState = "visible";

// Events from a controller: on the controller itself, and on the session with `event.controller`
const onController = next(p1, Events.BUTTON_DOWN);
received = next(session, Events.BUTTON_DOWN);
pad1.send(new ButtonEvent(Events.BUTTON_DOWN, {
    button: "A",
}));
event = await received;
assert.ok(event instanceof ButtonEvent);
assert.equal(event.button, "A");
assert.equal(event.controller, p1);
assert.equal((await onController).button, "A");

received = next(session, Events.STICK_MOVE);
pad1.send(new StickEvent(Events.STICK_MOVE, {
    x: 0,
    y: -1,
}));
event = await received;
assert.ok(event instanceof StickEvent);
assert.deepEqual([event.x, event.y, event.distance, event.angle], [0, -1, 1, -Math.PI / 2]);

// Default action runs on the phone, unless prevented
received = next(pad1, Events.VIBRATE);
p1.send(new VibrateEvent(Events.VIBRATE, {
    pattern: [50, 30, 50],
}));
assert.ok((await received) instanceof VibrateEvent);
await new Promise(resolve => setTimeout(resolve, 20));
assert.deepEqual(vibrations, [[50, 30, 50]]);

pad1.addEventListener(Events.VIBRATE, prevented => prevented.preventDefault(), {
    once: true,
});
received = next(pad1, Events.VIBRATE);
p1.send(new VibrateEvent(Events.VIBRATE));
await received;
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(vibrations.length, 1);

// Plain CustomEvent, null detail, custom classes
received = next(pad1, "reset");
session.send(new CustomEvent("reset"));
assert.equal((await received).detail, null);

received = next(pad1, "score");
session.send(new CustomEvent("score", {
    detail: 42,
}));
event = await received;
assert.ok(event instanceof AirpadEvent);
assert.equal(event.detail, 42);

class JumpEvent extends AirpadEvent {
    get height () {
        return this.detail.height;
    }
}
registerEvent("jump", JumpEvent);
received = next(session, "jump");
pad1.send(new JumpEvent("jump", {
    height: 3,
}));
event = await received;
assert.ok(event instanceof JumpEvent);
assert.equal(event.height, 3);

// Invalid sends
assert.throws(() => pad1.send(new CustomEvent(Events.DISCONNECT)), /reserved/);
assert.throws(() => pad1.send("buttondown"), /expects an Event/);
assert.throws(() => registerEvent(Events.CONNECT, JumpEvent), /reserved/);

// --- Second player: its own number, broadcast and targeted sends
const pad2 = await connect(session, "player-two");
assert.equal(pad2.number, 2);
const [, p2] = session.controllers;
assert.deepEqual(session.controllers.map(controller => controller.number), [1, 2]);

let toPad1 = next(pad1, "round");
let toPad2 = next(pad2, "round");
assert.ok(session.send(new CustomEvent("round", {
    detail: 1,
})));
assert.equal((await toPad1).detail, 1);
assert.equal((await toPad2).detail, 1);

let pad1Got = false;
pad1.addEventListener("private", () => {
    pad1Got = true;
});
toPad2 = next(pad2, "private");
p2.send(new CustomEvent("private"));
await toPad2;
await new Promise(resolve => setTimeout(resolve, 50));
assert.equal(pad1Got, false, "controller.send() only reaches that controller");

received = next(session, Events.BUTTON_DOWN);
pad2.send(new ButtonEvent(Events.BUTTON_DOWN, {
    button: "B",
}));
assert.equal((await received).controller, p2);

// --- Unknown session
await assert.rejects(join("unknown", {
    ...options,
    timeout: 1500,
}), /session not found/);

// --- A player leaves and comes back with the same number
let disconnected = next(session, Events.DISCONNECT);
const pad1Closed = next(pad1, Events.DISCONNECT);
pad1.close();
assert.equal((await pad1Closed).detail.reason, DisconnectReasons.CLOSED);
event = await disconnected;
assert.equal(event.controller, p1);
assert.equal(event.detail.reason, DisconnectReasons.LOST);
assert.equal(p1.isConnected, false);
assert.ok(p2.isConnected, "other players are not affected");
assert.equal(session.controllers.length, 2, "a player keeps its place");

const pad1Again = await connect(session, "player-one", {
    resume: true,
});
assert.equal(pad1Again.number, 1);
assert.ok(p1.isConnected);
assert.equal(session.controllers.length, 2);

// --- Same player in a second tab: the new connection replaces the old one
const oldTabClosed = next(pad1Again, Events.DISCONNECT);
const pad1Tab = await connect(session, "player-one");
await withTimeout(oldTabClosed, 5000);
assert.equal(pad1Tab.number, 1);
assert.ok(pad1Tab.isConnected && p1.isConnected && p2.isConnected);

// --- A third player gets number 3
const pad3 = await connect(session, "player-three");
assert.equal(pad3.number, 3);

// --- Kicked: disconnected, place freed, automatic reconnections refused, a QR code scan is accepted
const [, , p3] = session.controllers;
const pad3Kicked = next(pad3, Events.DISCONNECT);
disconnected = next(session, Events.DISCONNECT);
p3.kick();
event = await disconnected;
assert.equal(event.controller, p3);
assert.equal(event.detail.reason, DisconnectReasons.KICKED);
assert.equal((await withTimeout(pad3Kicked, 5000)).detail.reason, DisconnectReasons.KICKED, "the phone knows it was kicked");
assert.ok(p1.isConnected && p2.isConnected, "other players are not affected");
assert.deepEqual(session.controllers.map(controller => controller.number), [1, 2], "the place is freed");
assert.throws(() => session.kick(p3), /isn't part of the session/);

const refused = await join(session.id, {
    ...options,
    player: "player-three",
    resume: true,
}).catch(error => error);
assert.match(refused.message, /kicked/);
assert.equal(refused.reason, DisconnectReasons.KICKED);

// The freed number goes to the next new player
const pad5 = await connect(session, "player-five");
assert.equal(pad5.number, 3, "lowest free number");

// A scan lifts the kick: back as a new player, with the first free number
const pad3Scanned = await connect(session, "player-three");
assert.equal(pad3Scanned.number, 4);
const p3Again = session.controllers.find(controller => controller.number === 4);
assert.notEqual(p3Again, p3, "a new controller, the kicked one is gone");

// Resuming is still fine for players who weren't kicked
const pad3Resumed = await connect(session, "player-three", {
    resume: true,
});
assert.equal(pad3Resumed.number, 4);
assert.throws(() => session.kick(new EventTarget()), /isn't part of the session/);

// --- Closing the session disconnects everyone with a reason, nobody can join anymore
const reasons = Promise.all([pad1Tab, pad2, pad5, pad3Resumed].map(pad => withTimeout(next(pad, Events.DISCONNECT), 5000)));
session.close();
assert.ok((await reasons).every(({ detail }) => detail.reason === DisconnectReasons.ENDED), "phones know the session ended");
assert.ok(session.isClosed);
assert.ok(session.controllers.every(controller => !controller.isConnected));
await assert.rejects(join(session.id, {
    ...options,
    timeout: 1500,
}), /session not found/);

// --- Raw protocol helpers, to play race conditions step by step
const publish = async (sessionId, payload) => (await fetch(`${server}/airpad-${sessionId}`, {
    method: "POST",
    body: JSON.stringify(payload),
})).json();
const read = async (sessionId, predicate) => {
    for (let attempt = 0; attempt < 50; attempt++) {
        const lines = (await (await fetch(`${server}/airpad-${sessionId}/json?poll=1&since=all`)).text())
            .split("\n").filter(Boolean).map(line => JSON.parse(JSON.parse(line).message));
        const found = lines.find(predicate);
        if (found) {
            return found;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("message not found");
};

// --- Kicked while pairing: the answer is refused
const racing = await host(options);
const racer = await connect(racing, "racer");
await publish(racing.id, {
    type: "hello",
    nonce: "race-nonce",
    player: "racer",
    resume: true,
});
await read(racing.id, message => message.type === "offer" && message.nonce === "race-nonce");
racing.controllers[0].kick();
await publish(racing.id, {
    type: "answer",
    nonce: "race-nonce",
    sdp: "not even used",
});
const raceRefusal = await read(racing.id, message => message.type === "refused" && message.nonce === "race-nonce");
assert.equal(raceRefusal.reason, DisconnectReasons.KICKED);
assert.deepEqual(racing.controllers, [], "the kicked player didn't sneak back in");
assert.equal(racer.isConnected, false);
racing.close();

// --- Too many pairings at once: refused as busy
const crowded = await host(options);
for (let index = 0; index < 10; index++) {
    await publish(crowded.id, {
        type: "hello",
        nonce: `crowd-${index}`,
        player: `crowd-${index}`,
    });
}
await read(crowded.id, message => message.type === "offer" && message.nonce === "crowd-9");
const busy = await join(crowded.id, {
    ...options,
    player: "late",
}).catch(error => error);
assert.equal(busy.reason, "busy");
crowded.close();

// --- A failed offer preparation is retried when a controller says hello
let failures = 1;
globalThis.RTCPeerConnection = class extends RTCPeerConnection {
    constructor (...args) {
        if (failures-- > 0) {
            throw new Error("WebRTC unavailable");
        }
        super(...args);
    }
};
const resilient = await host(options);
const pad4 = await connect(resilient, "player-four");
assert.equal(pad4.number, 1);
resilient.close();

ntfy.closeAllConnections();
ntfy.close();
console.log("✓ multi-controllers: numbers, relayed events, broadcast and targeted sends, comeback, second tab, kick freeing the place, kick during pairing, busy, session end with reason, device events, default actions, custom events");
process.exit(0);
