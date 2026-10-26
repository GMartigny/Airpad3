import { reactive, render, renderStyle, unreactive } from "@gmartigny/whiskers.js";
import { ButtonEvent, Events, StickEvent } from "./events.js";
import { join } from "./index.js";

const BACKGROUND = "#1e1e1e";

const CONTROLLER_STYLE = {
    ".airpad-controller": {
        position: "fixed",
        inset: 0,
        display: "grid",
        "grid-template": "1fr 1fr / 1fr 1fr",
        background: BACKGROUND,
        color: "#eee",
        "font-family": "system-ui, sans-serif",
        "touch-action": "none",
        "user-select": "none",
        "-webkit-user-select": "none",
        "-webkit-touch-callout": "none",
        "-webkit-tap-highlight-color": "transparent",
        overflow: "hidden",
    },
    ".airpad-stick-zone": {
        "grid-area": "1 / 1 / 3 / 2",
        position: "relative",
        overflow: "hidden",
    },
    ".airpad-stick-zone::after": {
        content: "\"Touch and slide\"",
        position: "absolute",
        inset: "auto 0 16px",
        "text-align": "center",
        opacity: 0.3,
        "font-size": ".9em",
    },
    ".airpad-stick-base": {
        position: "absolute",
        left: "var(--x)",
        top: "var(--y)",
        width: "calc(var(--radius) * 2)",
        height: "calc(var(--radius) * 2)",
        margin: "calc(var(--radius) * -1) 0 0 calc(var(--radius) * -1)",
        border: "2px solid #ffffff40",
        "border-radius": "50%",
        background: "#ffffff10",
        display: "none",
    },
    ".airpad-stick-base.active": {
        display: "block",
    },
    ".airpad-stick-knob": {
        position: "absolute",
        left: "50%",
        top: "50%",
        width: "50%",
        height: "50%",
        margin: "-25% 0 0 -25%",
        "border-radius": "50%",
        background: "#ffffffa0",
        transform: "translate(var(--dx, 0), var(--dy, 0))",
    },
    ".airpad-button": {
        border: "none",
        "border-left": `2px solid ${BACKGROUND}`,
        margin: 0,
        padding: 0,
        font: "bold 3em system-ui, sans-serif",
        color: "#ffffffd0",
        background: "#c9211e",
    },
    ".airpad-button:only-of-type": {
        "grid-row": "1 / 3",
    },
    ".airpad-button + .airpad-button": {
        "border-top": `2px solid ${BACKGROUND}`,
        background: "#2e86de",
    },
    ".airpad-button.pressed": {
        filter: "brightness(1.35)",
    },
};

const STATUS_STYLE = {
    ".airpad-player": {
        position: "fixed",
        top: "12px",
        left: "50%",
        "z-index": 1,
        transform: "translateX(-50%)",
        padding: "4px 14px",
        "border-radius": "999px",
        background: "#000000a0",
        color: "#fff",
        font: "bold 1em system-ui, sans-serif",
        "pointer-events": "none",
    },
    ".airpad-status": {
        position: "fixed",
        inset: 0,
        "z-index": 1,
        display: "flex",
        "flex-direction": "column",
        "align-items": "center",
        "justify-content": "center",
        gap: "16px",
        padding: "16px",
        "text-align": "center",
        background: `${BACKGROUND}f0`,
        color: "#eee",
        "font-family": "system-ui, sans-serif",
    },
    ".airpad-status button": {
        border: "none",
        "border-radius": "8px",
        padding: "12px 24px",
        font: "inherit",
        "font-weight": "bold",
        color: "#fff",
        background: "#2e86de",
    },
    ".airpad-player[hidden], .airpad-status[hidden], .airpad-status button[hidden]": {
        display: "none",
    },
};

const RELEASE_EVENTS = ["@pointerup", "@pointercancel", "@lostpointercapture"];

/**
 * @param {number} value -
 * @return {number}
 */
const round = value => Math.round(value * 1000) / 1000;

/**
 * Same listener for several events, as Whiskers.js props
 * @param {string[]} events - prefixed with "@"
 * @param {Function} listener -
 * @return {Object}
 */
const listenAll = (events, listener) => Object.fromEntries(events.map(event => [event, listener]));

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

    // --- Stick: starts where the finger lands, moves relative to it
    let stick;
    let sent = {
        x: 0,
        y: 0,
    };
    let frame;
    const radius = () => Math.min(globalThis.innerWidth, globalThis.innerHeight) * stickRadius;

    const knob = render("div", {
        class: "airpad-stick-knob",
    });
    const base = render("div", {
        class: "airpad-stick-base",
    }, knob);

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

    const release = (event) => {
        if (stick?.pointerId !== event.pointerId) {
            return;
        }
        stick = undefined;
        // New props replace the previous ones: the position variables go away, the knob stays
        render(base, {
            class: "airpad-stick-base",
        });
        if (frame) {
            cancelAnimationFrame(frame);
        }
        flush();
    };

    const zone = render("div", {
        class: "airpad-stick-zone",
        "@pointerdown": (event) => {
            if (stick) {
                return;
            }
            zone.setPointerCapture?.(event.pointerId);
            const rect = zone.getBoundingClientRect();
            stick = {
                pointerId: event.pointerId,
                originX: event.clientX,
                originY: event.clientY,
                x: 0,
                y: 0,
            };
            render(knob, {
                class: "airpad-stick-knob",
            });
            render(base, {
                class: ["airpad-stick-base", "active"],
                "--x": `${event.clientX - rect.left}px`,
                "--y": `${event.clientY - rect.top}px`,
                "--radius": `${radius()}px`,
            });
        },
        "@pointermove": (event) => {
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
            render(knob, {
                class: "airpad-stick-knob",
                "--dx": `${dx}px`,
                "--dy": `${dy}px`,
            });
            scheduleFlush();
        },
        ...listenAll(RELEASE_EVENTS, release),
    }, base);

    // --- Buttons: each one a quarter of the screen, no empty zone
    const buttonElements = buttons.map((name) => {
        let pointerId;
        const button = render("button");

        /**
         * @param {boolean} pressed -
         * @return {HTMLButtonElement}
         */
        const draw = pressed => render(button, {
            class: {
                "airpad-button": true,
                pressed,
            },
            "@pointerdown": (event) => {
                event.preventDefault();
                if (pointerId !== undefined) {
                    return;
                }
                pointerId = event.pointerId;
                button.setPointerCapture?.(event.pointerId);
                draw(true);
                send(new ButtonEvent(Events.BUTTON_DOWN, {
                    button: name,
                }));
            },
            ...listenAll(RELEASE_EVENTS, (event) => {
                if (event.pointerId !== pointerId) {
                    return;
                }
                pointerId = undefined;
                draw(false);
                send(new ButtonEvent(Events.BUTTON_UP, {
                    button: name,
                }));
            }),
        }, name);

        return draw(false);
    });

    let wantsFullscreen = fullscreen;
    const root = render("div", {
        class: "airpad-controller",
        "@contextmenu": event => event.preventDefault(),
        "@pointerdown": () => {
            if (wantsFullscreen && !document.fullscreenElement) {
                wantsFullscreen = false;
                document.documentElement.requestFullscreen?.()?.catch?.(() => {});
            }
        },
    }, [
        renderStyle(CONTROLLER_STYLE),
        zone,
        ...buttonElements,
    ]);

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

    let connect;

    // --- Status overlay and player badge, re-rendered on change
    const ui = {
        // { text: string, action?: boolean }, or undefined when hidden
        status: undefined,
        // Player number given by the display
        player: undefined,
    };
    const style = renderStyle(STATUS_STYLE);
    const statusElement = reactive(ui, "status", (status, node) => render(node ?? "div", {
        class: "airpad-status",
        hidden: !status,
    }, [
        render("p", status?.text),
        render("button", {
            type: "button",
            hidden: !status?.action,
            "@click": () => connect(true),
        }, "Reconnect"),
    ]));
    const badge = reactive(ui, "player", (player, node) => render(node ?? "div", {
        class: "airpad-player",
        hidden: player === undefined,
    }, player !== undefined && `Player ${player}`));
    element.append(style, statusElement, badge);

    const show = (text, action = false) => {
        ui.status = {
            text,
            action,
        };
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
    // Once kicked, or once the session is over, only a new QR code scan can join
    let finished = false;

    const finish = (text) => {
        finished = true;
        writeStorage(storage, storageKey);
        show(text);
    };
    const onKicked = () => finish("You were removed from the game. Scan the QR code to join again.");

    /**
     * @param {boolean} resume - automatic reconnection, not a QR code scan
     */
    connect = async (resume) => {
        if (connecting || finished || peer?.isConnected) {
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
            ui.status = undefined;
            controller ??= createController(proxy, {
                element,
                ...controllerOptions,
            });
            ui.player = peer.number;
            peer.addEventListener(Events.DISCONNECT, ({ detail }) => {
                if (detail?.reason === "kicked") {
                    onKicked();
                }
                else if (detail?.reason === "ended") {
                    finish("The game is over. Scan a new QR code to play again.");
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
            else if (resume && error.reason !== "busy") {
                finish("Last session is over, scan the QR code on the screen");
            }
            else {
                show(error.message.replace(/^Airpad: /, ""), true);
            }
        }
        finally {
            connecting = false;
        }
    };

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
            unreactive(ui);
            style.remove();
            statusElement.remove();
            badge.remove();
        },
    };
}
