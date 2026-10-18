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
 * @return {Promise<Event>}
 */
const next = (target, type) => new Promise(resolve => target.addEventListener(type, resolve, {
    once: true,
}));

/**
 * libdatachannel (the native WebRTC behind node-datachannel) sometimes rejects the answer with
 * "Got a remote candidate without ICE transport" and closes the connection.
 * This race is specific to the test environment, so joining is retried a few times.
 * The display session survives failed attempts, which is also what this checks.
 * @param {Peer} display -
 * @return {Promise<Peer>} the controller, once both sides are open
 */
async function connect (display) {
    for (let attempt = 1; ; attempt++) {
        const displayOpen = next(display, Events.OPEN);
        try {
            const pad = await join(display.id, options);
            await withTimeout(displayOpen, 5000);
            return pad;
        }
        catch (error) {
            if (attempt >= 3) {
                throw error;
            }
        }
    }
}

/**
 * @param {Promise} promise -
 * @param {number} timeout -
 * @return {Promise}
 */
const withTimeout = (promise, timeout) => Promise.race([
    promise,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error("test timed out")), timeout)),
]);

const display = await host({
    ...options,
    controllerUrl: "https://example.com/remote/",
});
const initialRotate = next(display, Events.ROTATE);
const initialUnlock = next(display, Events.UNLOCK);
const pad = await connect(display);
assert.match(display.id, /^[a-z0-9]{16}$/);
assert.equal(display.url, `https://example.com/remote/?server=${encodeURIComponent(server)}#${display.id}`);
assert.ok(pad instanceof EventTarget);
assert.ok(pad.isOpen && display.isOpen);

// Orientation is sent automatically once connected, then on each change
let event = await initialRotate;
assert.ok(event instanceof RotateEvent);
assert.equal(event.orientation, "portrait");

// The lock state is sent on connection too (a lock may have dropped the previous connection)
event = await initialUnlock;
assert.ok(event instanceof LockEvent);
assert.equal(event.locked, false);

let received = next(display, Events.ROTATE);
portraitQuery.matches = false;
portraitQuery.dispatchEvent(new Event("change"));
event = await received;
assert.equal(event.orientation, "landscape");

// Screen lock is sent automatically
received = next(display, Events.LOCK);
document.visibilityState = "hidden";
document.dispatchEvent(new Event("visibilitychange"));
event = await received;
assert.ok(event instanceof LockEvent);
assert.ok(event.locked);

received = next(display, Events.UNLOCK);
document.visibilityState = "visible";
document.dispatchEvent(new Event("visibilitychange"));
event = await received;
assert.equal(event.locked, false);

// Stick position is rebuilt as a StickEvent
received = next(display, Events.STICK_MOVE);
pad.send(new StickEvent(Events.STICK_MOVE, {
    x: 0,
    y: -1,
}));
event = await received;
assert.ok(event instanceof StickEvent);
assert.deepEqual([event.x, event.y, event.distance], [0, -1, 1]);
assert.equal(event.angle, -Math.PI / 2);

// Built-in event classes are rebuilt with their class on the other side
received = next(display, Events.BUTTON_DOWN);
pad.send(new ButtonEvent(Events.BUTTON_DOWN, {
    button: "A",
}));
event = await received;
assert.ok(event instanceof ButtonEvent);
assert.equal(event.type, "buttondown");
assert.equal(event.button, "A");

// Default action runs unless prevented
received = next(pad, Events.VIBRATE);
display.send(new VibrateEvent(Events.VIBRATE, {
    pattern: [50, 30, 50],
}));
event = await received;
assert.ok(event instanceof VibrateEvent);
await new Promise(resolve => setTimeout(resolve, 20));
assert.deepEqual(vibrations, [[50, 30, 50]]);

pad.addEventListener(Events.VIBRATE, prevented => prevented.preventDefault(), {
    once: true,
});
received = next(pad, Events.VIBRATE);
display.send(new VibrateEvent(Events.VIBRATE));
await received;
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(vibrations.length, 1);

// A null detail stays null
received = next(pad, "reset");
display.send(new CustomEvent("reset"));
event = await received;
assert.equal(event.detail, null);

// A plain CustomEvent works too
received = next(pad, "score");
display.send(new CustomEvent("score", {
    detail: 42,
}));
event = await received;
assert.ok(event instanceof AirpadEvent);
assert.equal(event.detail, 42);

// Custom classes can be registered
class JumpEvent extends AirpadEvent {
    get height () {
        return this.detail.height;
    }
}
registerEvent("jump", JumpEvent);
received = next(display, "jump");
pad.send(new JumpEvent("jump", {
    height: 3,
}));
event = await received;
assert.ok(event instanceof JumpEvent);
assert.equal(event.height, 3);

// Invalid sends
assert.throws(() => pad.send(new CustomEvent(Events.CLOSE)), /reserved/);
assert.throws(() => pad.send("buttondown"), /expects an Event/);
assert.throws(() => registerEvent(Events.OPEN, JumpEvent), /reserved/);

await assert.rejects(join("unknown", {
    ...options,
    timeout: 1500,
}), /session not found/);

// The session survives the controller leaving: a controller can join again with the same ID
let closed = next(display, Events.CLOSE);
pad.close();
await closed;
assert.equal(display.isOpen, false);
assert.equal(display.send(new CustomEvent("score")), false, "send() without controller does nothing");
const pad2 = await connect(display);
assert.ok(display.isOpen && pad2.isOpen);

// Another controller takes over: the previous one is disconnected
const pad2Closed = next(pad2, Events.CLOSE);
closed = next(display, Events.CLOSE);
const pad3 = await connect(display);
await closed;
await withTimeout(pad2Closed, 5000);
assert.ok(display.isOpen && pad3.isOpen);
assert.equal(pad2.isOpen, false);

received = next(display, Events.BUTTON_DOWN);
pad3.send(new ButtonEvent(Events.BUTTON_DOWN, {
    button: "B",
}));
assert.equal((await received).button, "B");

// Closing the display ends the session
closed = next(pad3, Events.CLOSE);
display.close();
await withTimeout(closed, 5000);
await assert.rejects(join(display.id, {
    ...options,
    timeout: 1500,
}), /session not found/);

// A failed offer preparation is retried when a controller says hello
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
const pad4 = await connect(resilient);
assert.ok(resilient.isOpen && pad4.isOpen);
resilient.close();

ntfy.closeAllConnections();
ntfy.close();
console.log("✓ pairing, device events, event classes both ways, default actions, custom events, reconnection, takeover, session end, unknown session");
process.exit(0);
