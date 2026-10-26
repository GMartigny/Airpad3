// Default controller UI test, in a simulated DOM (jsdom).
// Run: node controller.test.js
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!DOCTYPE html><body></body>", {
    pretendToBeVisual: true,
});
Object.assign(globalThis, {
    // Whiskers.js renders through the global window
    window,
    document: window.document,
    innerWidth: 800,
    innerHeight: 400,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
});

const { createController, Events, ButtonEvent, StickEvent } = await import("../src/index.js");

// Fake connected peer that records what is sent
const sent = [];
const peer = {
    isConnected: true,
    // Like Peer.send(): nothing is sent when not connected
    send: event => peer.isConnected && Boolean(sent.push(event)),
};

const { element, destroy } = createController(peer, {
    fullscreen: false,
});

/**
 * jsdom has no PointerEvent, a MouseEvent with a pointerId does the job
 * @param {Element} target -
 * @param {string} type -
 * @param {Object} init -
 */
const pointer = (target, type, { id = 1, x = 0, y = 0 } = {}) => {
    const event = new window.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
    });
    Object.defineProperty(event, "pointerId", {
        value: id,
    });
    target.dispatchEvent(event);
};
const frame = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve)));

// Layout: one stick zone and two buttons
const zone = element.querySelector(".airpad-stick-zone");
const buttons = element.querySelectorAll(".airpad-button");
assert.ok(zone);
assert.deepEqual([...buttons].map(button => button.textContent), ["A", "B"]);

// Stick: origin where the finger lands, relative movement, clamped to the radius (0.15 × 400 = 60px)
pointer(zone, "pointerdown", { x: 100, y: 200 });
const base = element.querySelector(".airpad-stick-base.active");
const knob = element.querySelector(".airpad-stick-knob");
assert.ok(base);
assert.deepEqual(["--x", "--y", "--radius"].map(name => base.style.getPropertyValue(name)), ["100px", "200px", "60px"], "stick drawn where the finger lands");
assert.equal(sent.length, 0);

pointer(zone, "pointermove", { x: 130, y: 200 });
pointer(zone, "pointermove", { x: 160, y: 200 });
await frame();
assert.equal(sent.length, 1, "one event per frame");
assert.ok(sent[0] instanceof StickEvent);
assert.equal(sent[0].type, Events.STICK_MOVE);
assert.deepEqual([sent[0].x, sent[0].y], [1, 0]);

pointer(zone, "pointermove", { x: 100, y: 500 });
await frame();
assert.deepEqual([sent[1].x, sent[1].y], [0, 1], "clamped to the radius");
assert.deepEqual([knob.style.getPropertyValue("--dx"), knob.style.getPropertyValue("--dy")], ["0px", "60px"], "knob drawn at the clamped offset");

pointer(zone, "pointermove", { x: 100, y: 500 });
await frame();
assert.equal(sent.length, 2, "no event when the position doesn't change");

pointer(zone, "pointerup");
assert.deepEqual([sent[2].x, sent[2].y], [0, 0], "released stick goes back to center");
assert.equal(element.querySelector(".airpad-stick-base.active"), null);

// Buttons, pressed at the same time as the stick (multi-touch)
sent.length = 0;
pointer(zone, "pointerdown", { id: 1, x: 100, y: 200 });
assert.equal(knob.style.getPropertyValue("--dy"), "0px", "a new touch starts with a centered knob");
pointer(buttons[0], "pointerdown", { id: 2 });
pointer(buttons[1], "pointerdown", { id: 3 });
pointer(buttons[0], "pointerup", { id: 2 });
pointer(buttons[0], "lostpointercapture", { id: 2 });
assert.deepEqual(sent.map(event => [event.constructor, event.type, event.button]), [
    [ButtonEvent, Events.BUTTON_DOWN, "A"],
    [ButtonEvent, Events.BUTTON_DOWN, "B"],
    [ButtonEvent, Events.BUTTON_UP, "A"],
]);
assert.ok(buttons[1].classList.contains("pressed"));
assert.ok(!buttons[0].classList.contains("pressed"));

// Nothing is sent once the connection is closed
peer.isConnected = false;
sent.length = 0;
pointer(buttons[1], "pointerup", { id: 3 });
assert.equal(sent.length, 0);

// Custom button names
destroy();
assert.equal(document.querySelector(".airpad-controller"), null);
const custom = createController(peer, {
    buttons: ["Jump", "Fire"],
    fullscreen: false,
});
assert.deepEqual([...custom.element.querySelectorAll("button")].map(button => button.textContent), ["Jump", "Fire"]);

// One or two buttons, never an empty zone
const single = createController(peer, {
    buttons: ["Go"],
    fullscreen: false,
});
assert.deepEqual([...single.element.querySelectorAll("button")].map(button => button.textContent), ["Go"]);
assert.match(single.element.querySelector("style").textContent, /\.airpad-button:only-of-type\s*\{\s*grid-row: 1 \/ 3;/);
single.destroy();
assert.throws(() => createController(peer, {
    buttons: [],
}), /one or two/);
assert.throws(() => createController(peer, {
    buttons: ["A", "B", "C"],
}), /one or two/);

// --- mountController: session ID from the URL or from the last session
const { mountController } = await import("../src/index.js");

/**
 * @param {string} url -
 */
const navigate = (url) => {
    const dom = new JSDOM("<!DOCTYPE html><body></body>", {
        url,
        pretendToBeVisual: true,
    });
    Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        location: dom.window.location,
        history: dom.window.history,
        localStorage: dom.window.localStorage,
    });
    return dom;
};
const statusText = () => document.querySelector(".airpad-status p").textContent;
const statusShown = () => !document.querySelector(".airpad-status").hidden;
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

/**
 * Fake join: records calls, resolves with a fake peer, or rejects for unknown IDs
 */
const joins = [];
const fakeJoin = async (id, options) => {
    joins.push([id, options.server, options.resume]);
    if (id === "over") {
        throw new Error("Airpad: session not found");
    }
    if (id === "kicked") {
        throw Object.assign(new Error("Airpad: kicked from this session"), {
            reason: "kicked",
        });
    }
    const fake = new EventTarget();
    fake.number = joins.length;
    fake.isConnected = true;
    fake.send = () => {};
    fake.close = () => {
        fake.isConnected = false;
    };
    return fake;
};

// ID in the URL: joins it, remembers it, mounts the controller
let dom = navigate("https://game.test/controller.html?server=https://ntfy.test#abc");
let mounted = mountController({
    join: fakeJoin,
    fullscreen: false,
});
await tick();
assert.deepEqual(joins.at(-1), ["abc", "https://ntfy.test", false], "a scan isn't a resume");
assert.equal(localStorage.getItem("airpad:session"), "abc");
assert.equal(location.hash, "", "the ID is removed from the URL, a reload counts as resuming");
assert.equal(location.search, "?server=https://ntfy.test");
assert.ok(!statusShown());
assert.equal(document.querySelectorAll(".airpad-controller").length, 1);
assert.equal(document.querySelector(".airpad-player").textContent, "Player 1", "shows the player number");

// Disconnected: shows a reconnect button, reconnecting keeps a single controller
const firstPeer = mounted.peer;
firstPeer.isConnected = false;
firstPeer.dispatchEvent(new CustomEvent(Events.DISCONNECT));
assert.ok(statusShown());
assert.equal(statusText(), "Disconnected");
document.querySelector(".airpad-status button").click();
await tick();
assert.equal(joins.length, 2);
assert.equal(joins.at(-1)[2], true, "the reconnect button resumes");
assert.notEqual(mounted.peer, firstPeer);
assert.ok(!statusShown());
assert.equal(document.querySelectorAll(".airpad-controller").length, 1);

// Kicked by the display: no reconnect button, no automatic reconnection, session forgotten
mounted.peer.isConnected = false;
mounted.peer.dispatchEvent(new CustomEvent(Events.DISCONNECT, {
    detail: {
        reason: "kicked",
    },
}));
assert.match(statusText(), /removed from the game/);
assert.ok(document.querySelector(".airpad-status button").hidden);
assert.equal(localStorage.getItem("airpad:session"), null);
document.dispatchEvent(new dom.window.Event("visibilitychange"));
await mounted.reconnect();
assert.equal(joins.length, 2, "never reconnects by itself once kicked");
mounted.destroy();

// No ID in the URL: resumes the last session
const stored = dom.window.localStorage;
dom = navigate("https://game.test/controller.html");
dom.window.localStorage.setItem("airpad:session", "abc");
mounted = mountController({
    join: fakeJoin,
    fullscreen: false,
});
assert.equal(statusText(), "Resuming last session…");
await tick();
assert.deepEqual(joins.at(-1).slice(0, 1).concat(joins.at(-1)[2]), ["abc", true], "resumes the stored session");
assert.ok(!statusShown());
mounted.destroy();

// Resuming after being kicked is refused: asks to scan again
dom.window.localStorage.setItem("airpad:session", "kicked");
mounted = mountController({
    join: fakeJoin,
    fullscreen: false,
});
await tick();
assert.match(statusText(), /removed from the game/);
assert.equal(dom.window.localStorage.getItem("airpad:session"), null);
mounted.destroy();

// The session ended: says so, forgets it, never reconnects by itself
dom.window.localStorage.setItem("airpad:session", "abc");
mounted = mountController({
    join: fakeJoin,
    fullscreen: false,
});
await tick();
let joinsBefore = joins.length;
mounted.peer.isConnected = false;
mounted.peer.dispatchEvent(new CustomEvent(Events.DISCONNECT, {
    detail: {
        reason: "ended",
    },
}));
assert.match(statusText(), /game is over/);
assert.ok(document.querySelector(".airpad-status button").hidden);
assert.equal(dom.window.localStorage.getItem("airpad:session"), null);
document.dispatchEvent(new dom.window.Event("visibilitychange"));
await mounted.reconnect();
assert.equal(joins.length, joinsBefore, "never reconnects once the game is over");
mounted.destroy();

// Last session is over: forgets it and asks to scan again
dom.window.localStorage.setItem("airpad:session", "over");
mounted = mountController({
    join: fakeJoin,
    fullscreen: false,
});
await tick();
assert.equal(dom.window.localStorage.getItem("airpad:session"), null);
assert.match(statusText(), /scan the QR code/);
joinsBefore = joins.length;
document.dispatchEvent(new dom.window.Event("visibilitychange"));
await mounted.reconnect();
assert.equal(joins.length, joinsBefore, "stops trying a session that is over");
mounted.destroy();

// Nothing to join
mounted = mountController({
    join: fakeJoin,
    fullscreen: false,
});
assert.equal(statusText(), "Scan the QR code shown on the screen");
assert.equal(joins.length, 6);
mounted.destroy();
assert.ok(stored);

console.log("✓ controller: layout, relative stick, clamping, throttling, release, multi-touch buttons, mountController (URL ID, resume, session over, reconnect, kick, game over)");
process.exit(0);
