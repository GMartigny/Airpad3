import { ButtonEvent, Events, StickEvent } from "./events.js";

const STYLE = `
.airpad-controller {
    position: fixed;
    inset: 0;
    display: grid;
    grid-template: 1fr 1fr / 1fr 1fr;
    background: #1e1e1e;
    color: #eee;
    font-family: system-ui, sans-serif;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
    -webkit-tap-highlight-color: transparent;
    overflow: hidden;
}
.airpad-stick-zone {
    grid-area: 1 / 1 / 3 / 2;
    position: relative;
    overflow: hidden;
}
.airpad-stick-zone::after {
    content: "Touch and slide";
    position: absolute;
    inset: auto 0 16px;
    text-align: center;
    opacity: .3;
    font-size: .9em;
}
.airpad-stick-base {
    position: absolute;
    width: calc(var(--airpad-radius) * 2);
    height: calc(var(--airpad-radius) * 2);
    margin: calc(var(--airpad-radius) * -1) 0 0 calc(var(--airpad-radius) * -1);
    border: 2px solid #ffffff40;
    border-radius: 50%;
    background: #ffffff10;
    display: none;
}
.airpad-stick-base.active {
    display: block;
}
.airpad-stick-knob {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 50%;
    height: 50%;
    margin: -25% 0 0 -25%;
    border-radius: 50%;
    background: #ffffffa0;
}
.airpad-button {
    border: none;
    border-left: 2px solid #1e1e1e;
    margin: 0;
    padding: 0;
    font: bold 3em system-ui, sans-serif;
    color: #ffffffd0;
    background: #c9211e;
}
.airpad-button + .airpad-button {
    border-top: 2px solid #1e1e1e;
    background: #2e86de;
}
.airpad-button.pressed {
    filter: brightness(1.35);
}
`;

/**
 * @param {string} className -
 * @return {HTMLDivElement}
 */
function div (className) {
    const element = document.createElement("div");
    element.className = className;
    return element;
}

/**
 * @param {number} value -
 * @return {number}
 */
const round = value => Math.round(value * 1000) / 1000;

/**
 * Default controller: a floating stick on the left half,
 * two buttons stacked on the right half (each one a quarter of the screen).
 * Sends `Events.STICK_MOVE`, `Events.BUTTON_DOWN` and `Events.BUTTON_UP` on the peer.
 * @param {import("./index.js").Peer} peer - connected peer, from `join()`
 * @param {Object} [options] -
 * @param {HTMLElement} [options.element=document.body] - where to mount the controller
 * @param {[string, string]} [options.buttons=["A", "B"]] - button names, top to bottom
 * @param {number} [options.stickRadius=0.15] - stick radius, relative to the smallest screen side
 * @param {boolean} [options.fullscreen=true] - go fullscreen on first touch
 * @return {{element: HTMLElement, destroy: Function}}
 */
export function createController (peer, options = {}) {
    const {
        element = document.body,
        buttons = ["A", "B"],
        stickRadius = 0.15,
        fullscreen = true,
    } = options;

    const send = (event) => {
        if (peer.isOpen) {
            peer.send(event);
        }
    };

    const root = div("airpad-controller");
    const style = document.createElement("style");
    style.textContent = STYLE;
    const zone = div("airpad-stick-zone");
    const base = div("airpad-stick-base");
    const knob = div("airpad-stick-knob");
    base.append(knob);
    zone.append(base);
    root.append(style, zone);
    root.addEventListener("contextmenu", event => event.preventDefault());

    if (fullscreen) {
        root.addEventListener("pointerdown", () => {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen?.()?.catch?.(() => {});
            }
        }, {
            once: true,
        });
    }

    // --- Stick: starts where the finger lands, moves relative to it
    let stick;
    let sent = {
        x: 0,
        y: 0,
    };
    let frame;
    const radius = () => Math.min(globalThis.innerWidth, globalThis.innerHeight) * stickRadius;

    const flush = () => {
        frame = undefined;
        const position = stick ?? {
            x: 0,
            y: 0,
        };
        if (Math.abs(position.x - sent.x) < 0.01 && Math.abs(position.y - sent.y) < 0.01) {
            return;
        }
        sent = {
            x: round(position.x),
            y: round(position.y),
        };
        send(new StickEvent(Events.STICK_MOVE, sent));
    };
    const scheduleFlush = () => {
        frame ??= requestAnimationFrame(flush);
    };

    zone.addEventListener("pointerdown", (event) => {
        if (stick) {
            return;
        }
        zone.setPointerCapture?.(event.pointerId);
        const rect = zone.getBoundingClientRect();
        const r = radius();
        stick = {
            pointerId: event.pointerId,
            originX: event.clientX,
            originY: event.clientY,
            x: 0,
            y: 0,
        };
        zone.style.setProperty("--airpad-radius", `${r}px`);
        base.style.left = `${event.clientX - rect.left}px`;
        base.style.top = `${event.clientY - rect.top}px`;
        knob.style.transform = "";
        base.classList.add("active");
    });

    zone.addEventListener("pointermove", (event) => {
        if (stick?.pointerId !== event.pointerId) {
            return;
        }
        const r = radius();
        let dx = event.clientX - stick.originX;
        let dy = event.clientY - stick.originY;
        const distance = Math.hypot(dx, dy);
        if (distance > r) {
            dx *= r / distance;
            dy *= r / distance;
        }
        stick.x = dx / r;
        stick.y = dy / r;
        knob.style.transform = `translate(${dx}px, ${dy}px)`;
        scheduleFlush();
    });

    const release = (event) => {
        if (stick?.pointerId !== event.pointerId) {
            return;
        }
        stick = undefined;
        base.classList.remove("active");
        if (frame) {
            cancelAnimationFrame(frame);
        }
        flush();
    };
    ["pointerup", "pointercancel", "lostpointercapture"].forEach(type => zone.addEventListener(type, release));

    // --- Buttons: each one a quarter of the screen, no empty zone
    buttons.slice(0, 2).forEach((name) => {
        const button = document.createElement("button");
        button.className = "airpad-button";
        button.textContent = name;
        let pointerId;

        button.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            if (pointerId !== undefined) {
                return;
            }
            pointerId = event.pointerId;
            button.setPointerCapture?.(event.pointerId);
            button.classList.add("pressed");
            send(new ButtonEvent(Events.BUTTON_DOWN, {
                button: name,
            }));
        });
        const up = (event) => {
            if (event.pointerId !== pointerId) {
                return;
            }
            pointerId = undefined;
            button.classList.remove("pressed");
            send(new ButtonEvent(Events.BUTTON_UP, {
                button: name,
            }));
        };
        ["pointerup", "pointercancel", "lostpointercapture"].forEach(type => button.addEventListener(type, up));

        root.append(button);
    });

    element.append(root);

    return {
        element: root,
        destroy () {
            if (frame) {
                cancelAnimationFrame(frame);
            }
            root.remove();
        },
    };
}
