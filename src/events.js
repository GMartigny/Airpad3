/**
 * Event types used by Airpad.
 * @readonly
 * @enum {string}
 */
export const Events = Object.freeze({
    // Connection lifecycle, dispatched locally (can't be sent)
    CONNECT: "connect",
    DISCONNECT: "disconnect",
    ERROR: "error",

    // Controller → display
    BUTTON_DOWN: "buttondown",
    BUTTON_UP: "buttonup",
    STICK_MOVE: "stickmove",
    ROTATE: "rotate",
    LOCK: "lock",
    UNLOCK: "unlock",

    // Display → controller
    VIBRATE: "vibrate",
});

/**
 * Lifecycle events, dispatched locally only.
 * @type {Set<string>}
 */
export const RESERVED_EVENTS = new Set([Events.CONNECT, Events.DISCONNECT, Events.ERROR]);

/**
 * Base class of every event exchanged between peers.
 * Like native events, the second argument is an init dictionary,
 * which is what travels to the other device (as `event.detail`).
 */
export class AirpadEvent extends CustomEvent {
    /**
     * @param {string} type -
     * @param {Object} [init] - JSON-serializable data
     */
    constructor (type, init = {}) {
        super(type, {
            detail: init,
            cancelable: true,
        });
    }
}

/**
 * A button pressed or released on the controller.
 * @example new ButtonEvent(Events.BUTTON_DOWN, { button: "A" })
 */
export class ButtonEvent extends AirpadEvent {
    /**
     * @param {Events.BUTTON_DOWN|Events.BUTTON_UP} type -
     * @param {{button: string}} init -
     */
    constructor (type, { button } = {}) {
        super(type, {
            button,
        });
    }

    /**
     * @return {string}
     */
    get button () {
        return this.detail.button;
    }
}

/**
 * Position of the controller stick, `x` and `y` from -1 to 1 (`y` goes down, like the screen).
 * Sent when the stick moves, and with `x = y = 0` when it's released.
 * @example new StickEvent(Events.STICK_MOVE, { x: 0.5, y: -1 })
 */
export class StickEvent extends AirpadEvent {
    /**
     * @param {Events.STICK_MOVE} type -
     * @param {{x?: number, y?: number}} init -
     */
    constructor (type, { x = 0, y = 0 } = {}) {
        super(type, {
            x,
            y,
        });
    }

    /**
     * Horizontal position, from -1 (left) to 1 (right)
     * @return {number}
     */
    get x () {
        return this.detail.x;
    }

    /**
     * Vertical position, from -1 (up) to 1 (down)
     * @return {number}
     */
    get y () {
        return this.detail.y;
    }

    /**
     * Distance from the center, from 0 to 1
     * @return {number}
     */
    get distance () {
        return Math.min(1, Math.hypot(this.x, this.y));
    }

    /**
     * Direction in radians, 0 pointing right (like `Math.atan2`)
     * @return {number}
     */
    get angle () {
        return Math.atan2(this.y, this.x);
    }
}

/**
 * The controller switched between portrait and landscape.
 * Sent automatically by the controller when it rotates, and once when the connection opens.
 * @example new RotateEvent(Events.ROTATE, { orientation: "landscape" })
 */
export class RotateEvent extends AirpadEvent {
    /**
     * @param {Events.ROTATE} type -
     * @param {{orientation: "portrait"|"landscape"}} init -
     */
    constructor (type, { orientation = "portrait" } = {}) {
        super(type, {
            orientation,
        });
    }

    /**
     * @return {"portrait"|"landscape"}
     */
    get orientation () {
        return this.detail.orientation;
    }
}

/**
 * Ask the controller to vibrate.
 * Default action on the controller: `navigator.vibrate(pattern)` (cancel with `preventDefault()`).
 * @example new VibrateEvent(Events.VIBRATE, { pattern: [50, 30, 50] })
 */
export class VibrateEvent extends AirpadEvent {
    /**
     * @param {Events.VIBRATE} type -
     * @param {{pattern: number|number[]}} init - durations in milliseconds
     */
    constructor (type, { pattern = 50 } = {}) {
        super(type, {
            pattern,
        });
    }

    /**
     * @return {number|number[]}
     */
    get pattern () {
        return this.detail.pattern;
    }

    /**
     */
    defaultAction () {
        globalThis.navigator?.vibrate?.(this.pattern);
    }
}

/**
 * The controller screen was locked (or the page hidden) or unlocked.
 * Sent automatically by the controller.
 * The connection may be suspended while the phone is locked.
 * @example new LockEvent(Events.LOCK)
 */
export class LockEvent extends AirpadEvent {
    /**
     * @param {Events.LOCK|Events.UNLOCK} type -
     */
    constructor (type) {
        super(type);
    }

    /**
     * @return {boolean}
     */
    get locked () {
        return this.type === Events.LOCK;
    }
}

/**
 * Event class to rebuild for each type received from the remote peer.
 * @type {Map<string, typeof AirpadEvent>}
 */
const registry = new Map([
    [Events.BUTTON_DOWN, ButtonEvent],
    [Events.BUTTON_UP, ButtonEvent],
    [Events.STICK_MOVE, StickEvent],
    [Events.ROTATE, RotateEvent],
    [Events.VIBRATE, VibrateEvent],
    [Events.LOCK, LockEvent],
    [Events.UNLOCK, LockEvent],
]);

/**
 * Register your own event class, so it's rebuilt with this class on the remote peer.
 * The class must accept `(type, init)` like `AirpadEvent`.
 * @param {string} type -
 * @param {typeof AirpadEvent} EventClass -
 */
export function registerEvent (type, EventClass) {
    if (RESERVED_EVENTS.has(type)) {
        throw new Error(`Airpad: "${type}" is a reserved event type`);
    }
    registry.set(type, EventClass);
}

/**
 * Rebuild an event received from the remote peer, with its original class.
 * Unknown types become a plain `AirpadEvent`.
 * @param {string} type -
 * @param {*} detail -
 * @return {AirpadEvent}
 */
export function reviveEvent (type, detail) {
    const EventClass = registry.get(type);
    if (!EventClass) {
        // Unknown type: keep the detail as is, null included
        const event = new AirpadEvent(type);
        Object.defineProperty(event, "detail", {
            value: detail ?? null,
        });
        return event;
    }
    return new EventClass(type, detail ?? undefined);
}
