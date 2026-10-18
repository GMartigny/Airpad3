import { ButtonEvent, Events, StickEvent } from "./events.js";
import { join } from "./index.js";

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
.airpad-button:only-of-type {
    grid-row: 1 / 3;
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
 * two buttons stacked on the right half (each one a quarter of the screen), or a single one filling it.
 * Sends `Events.STICK_MOVE`, `Events.BUTTON_DOWN` and `Events.BUTTON_UP` on the peer.
 * @param {import("./index.js").Peer} peer - connected peer, from `join()`
 * @param {Object} [options] -
 * @param {HTMLElement} [options.element=document.body] - where to mount the controller
 * @param {string[]} [options.buttons=["A", "B"]] - one or two button names, top to bottom
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

    if (!Array.isArray(buttons) || buttons.length < 1 || buttons.length > 2) {
        throw new TypeError("Airpad: the default controller needs one or two button names");
    }

    const send = event => peer.send(event);

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
    buttons.forEach((name) => {
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

const STATUS_STYLE = `
.airpad-player {
    position: fixed;
    top: 12px;
    left: 50%;
    z-index: 1;
    transform: translateX(-50%);
    padding: 4px 14px;
    border-radius: 999px;
    background: #000000a0;
    color: #fff;
    font: bold 1em system-ui, sans-serif;
    pointer-events: none;
}
.airpad-player[hidden] {
    display: none;
}
.airpad-status {
    position: fixed;
    inset: 0;
    z-index: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    padding: 16px;
    text-align: center;
    background: #1e1e1ef0;
    color: #eee;
    font-family: system-ui, sans-serif;
}
.airpad-status[hidden] {
    display: none;
}
.airpad-status button {
    border: none;
    border-radius: 8px;
    padding: 12px 24px;
    font: inherit;
    font-weight: bold;
    color: #fff;
    background: #2e86de;
}
.airpad-status button[hidden] {
    display: none;
}
`;

/**
 * @param {Storage|undefined} storage -
 * @param {string} key -
 * @return {string|undefined}
 */
function readStorage (storage, key) {
    try {
        return storage?.getItem(key) ?? undefined;
    }
    catch {
        return undefined;
    }
}

/**
 * @param {Storage|undefined} storage -
 * @param {string} key -
 * @param {string} [value] - removes the key when undefined
 */
function writeStorage (storage, key, value) {
    try {
        if (value === undefined) {
            storage?.removeItem(key);
        }
        else {
            storage?.setItem(key, value);
        }
    }
    catch {
        // Storage disabled (private mode…): nothing to remember
    }
}

/**
 * Turn the current page into a full controller:
 * joins the session from the URL (`#id`), or the last one if the ID is missing,
 * mounts the default controller, shows the player number, and handles connection status and reconnection.
 * A controller page only needs: `mountController()`.
 * @param {Object} [options] - also accepts every `createController` option
 * @param {Object} [options.joinOptions] - options passed to `join()`, `server` defaults to the `?server=` URL parameter
 * @param {string} [options.storageKey="airpad:session"] - where the last session ID is remembered
 * @param {Function} [options.onConnect] - called with the new peer after each (re)connection
 * @return {{readonly peer: import("./index.js").Peer|undefined, reconnect: Function, destroy: Function}}
 */
export function mountController (options = {}) {
    const {
        element = document.body,
        joinOptions = {},
        storageKey = "airpad:session",
        onConnect,
        join: joinSession,
        ...controllerOptions
    } = options;
    const storage = globalThis.localStorage;
    const server = joinOptions.server ?? new URLSearchParams(globalThis.location?.search).get("server") ?? undefined;

    // --- Status overlay
    const status = div("airpad-status");
    const style = document.createElement("style");
    style.textContent = STATUS_STYLE;
    const message = document.createElement("p");
    const action = document.createElement("button");
    action.type = "button";
    action.textContent = "Reconnect";
    status.append(style, message, action);
    const badge = div("airpad-player");
    badge.hidden = true;
    element.append(status, badge);
    const show = (text, withAction = false) => {
        message.textContent = text;
        action.hidden = !withAction;
        status.hidden = false;
    };

    // --- Stable target for the controller, the peer changes on each reconnection
    let peer;
    const proxy = {
        get isConnected () {
            return Boolean(peer?.isConnected);
        },
        send: event => Boolean(peer?.send(event)),
    };
    let controller;

    const scanned = globalThis.location?.hash.slice(1);
    const id = scanned || readStorage(storage, storageKey);
    if (scanned) {
        // Only a QR code scan carries the ID: reloading the page then counts as resuming
        try {
            globalThis.history?.replaceState(null, "", `${location.pathname}${location.search}`);
        }
        catch {
            // History not available: a reload will count as a new scan
        }
    }
    let connecting = false;
    let kicked = false;

    const onKicked = () => {
        kicked = true;
        writeStorage(storage, storageKey);
        show("You were removed from the game. Scan the QR code to join again.");
    };

    /**
     * @param {boolean} resume - automatic reconnection, not a QR code scan
     */
    const connect = async (resume) => {
        if (connecting || kicked || peer?.isConnected) {
            return;
        }
        connecting = true;
        show(resume ? "Resuming last session…" : "Connecting…");
        try {
            peer = await (joinSession ?? join)(id, {
                ...joinOptions,
                server,
                resume,
            });
            writeStorage(storage, storageKey, id);
            status.hidden = true;
            controller ??= createController(proxy, {
                element,
                ...controllerOptions,
            });
            // Player number given by the display
            badge.textContent = `Player ${peer.number}`;
            badge.hidden = peer.number === undefined;
            peer.addEventListener(Events.DISCONNECT, ({ detail }) => {
                if (detail?.reason === "kicked") {
                    onKicked();
                }
                else {
                    show("Disconnected", true);
                }
            }, {
                once: true,
            });
            onConnect?.(peer);
        }
        catch (error) {
            if (error.reason === "kicked") {
                onKicked();
            }
            else if (resume) {
                writeStorage(storage, storageKey);
                show("Last session is over, scan the QR code on the screen");
            }
            else {
                show(error.message.replace(/^Airpad: /, ""), true);
            }
        }
        finally {
            connecting = false;
        }
    };

    action.addEventListener("click", () => connect(true));

    // Coming back to the page (unlocked phone…): reconnect by itself
    const onVisible = () => {
        if (document.visibilityState === "visible" && controller && !peer?.isConnected) {
            connect(true);
        }
    };
    document.addEventListener("visibilitychange", onVisible);

    if (id) {
        connect(!scanned);
    }
    else {
        show("Scan the QR code shown on the screen");
    }

    return {
        get peer () {
            return peer;
        },
        reconnect: () => connect(true),
        destroy () {
            document.removeEventListener("visibilitychange", onVisible);
            peer?.close();
            controller?.destroy();
            status.remove();
            badge.remove();
        },
    };
}
