import { Events, LockEvent, RotateEvent } from "./events.js";

/**
 * Send device events from the controller to the display:
 * - `Events.ROTATE` when switching between portrait and landscape (and once at start)
 * - `Events.LOCK` / `Events.UNLOCK` when the screen is locked or unlocked (page hidden or visible), and once at start
 *   (after a lock dropped the connection, the new one tells the display the screen is unlocked)
 * Does nothing where these APIs don't exist.
 * @param {import("./index.js").Peer} peer -
 * @return {Function} stop watching
 */
export function watchDevice (peer) {
    const cleanups = [];
    const send = (event) => {
        if (peer.isOpen) {
            peer.send(event);
        }
    };
    const listen = (target, type, listener) => {
        target.addEventListener(type, listener);
        cleanups.push(() => target.removeEventListener(type, listener));
    };

    const portrait = globalThis.matchMedia?.("(orientation: portrait)");
    if (portrait) {
        const sendOrientation = () => send(new RotateEvent(Events.ROTATE, {
            orientation: portrait.matches ? "portrait" : "landscape",
        }));
        listen(portrait, "change", sendOrientation);
        sendOrientation();
    }

    const { document } = globalThis;
    if (document) {
        const sendLock = () => send(new LockEvent(
            document.visibilityState === "hidden" ? Events.LOCK : Events.UNLOCK,
        ));
        listen(document, "visibilitychange", sendLock);
        sendLock();
    }

    return () => cleanups.forEach(cleanup => cleanup());
}
