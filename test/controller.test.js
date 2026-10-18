// Default controller UI test, in a simulated DOM (jsdom).
// Run: node controller.test.js
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!DOCTYPE html><body></body>", {
    pretendToBeVisual: true,
});
Object.assign(globalThis, {
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
    isOpen: true,
    send: event => sent.push(event),
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
assert.ok(element.querySelector(".airpad-stick-base.active"));
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

pointer(zone, "pointermove", { x: 100, y: 500 });
await frame();
assert.equal(sent.length, 2, "no event when the position doesn't change");

pointer(zone, "pointerup");
assert.deepEqual([sent[2].x, sent[2].y], [0, 0], "released stick goes back to center");
assert.equal(element.querySelector(".airpad-stick-base.active"), null);

// Buttons, pressed at the same time as the stick (multi-touch)
sent.length = 0;
pointer(zone, "pointerdown", { id: 1, x: 100, y: 200 });
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
peer.isOpen = false;
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

console.log("✓ controller: layout, relative stick, clamping, throttling, release, multi-touch buttons");
process.exit(0);
