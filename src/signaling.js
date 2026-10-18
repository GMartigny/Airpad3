/**
 * Signaling through ntfy (https://ntfy.sh): a simple public HTTP pub/sub,
 * with no account and no server to host.
 * Each session uses its own topic, named after a random ID.
 */

export const DEFAULT_SERVER = "https://ntfy.sh";

/**
 * @param {string} text -
 * @return {Object|undefined}
 */
function parse (text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}

/**
 * @typedef {Object} Signaling
 * @property {Function} publish - publish(payload): Promise<{id: string}>
 * @property {Function} subscribe - subscribe(listener, options): Function to unsubscribe
 * @property {Function} wait - wait(predicate, options): Promise<Object>
 */

/**
 * @param {string} topic -
 * @param {Object} [options] -
 * @param {string} [options.server] - ntfy server URL
 * @return {Signaling}
 */
export function createSignaling (topic, { server = DEFAULT_SERVER } = {}) {
    const base = `${server}/${topic}`;

    /**
     * Publish a message on the topic.
     * @param {Object} payload -
     * @return {Promise<{id: string}>} the message created by ntfy
     */
    async function publish (payload) {
        const response = await fetch(base, {
            method: "POST",
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            throw new Error(`Airpad: failed to publish on ntfy (${response.status})`);
        }
        return response.json();
    }

    /**
     * Listen to every message published on the topic after `since`.
     * Uses SSE, with a polling fallback (dropped SSE, buffering proxy…).
     * Each message is delivered once, in order.
     * @param {Function} listener - called with each message payload
     * @param {Object} [options] -
     * @param {string} [options.since="all"] - ntfy message ID to listen from
     * @param {number} [options.pollInterval=10000] - in milliseconds, keep it high on ntfy.sh (rate limits)
     * @return {Function} stop listening
     */
    function subscribe (listener, { since = "all", pollInterval = 10 * 1000 } = {}) {
        const seen = new Set();
        let last = since;
        let stopped = false;

        const deliver = (message) => {
            if (stopped || message?.event !== "message" || seen.has(message.id)) {
                return;
            }
            seen.add(message.id);
            last = message.id;
            const payload = parse(message.message);
            if (payload) {
                listener(payload);
            }
        };

        const poll = async () => {
            try {
                const response = await fetch(`${base}/json?poll=1&since=${last}`);
                if (response.ok) {
                    (await response.text()).split("\n")
                        .filter(Boolean)
                        .forEach(line => deliver(parse(line)));
                }
            }
            catch {
                // Unstable network: retry on next tick
            }
        };

        const source = new EventSource(`${base}/sse?since=${since}`);
        source.addEventListener("message", ({ data }) => deliver(parse(data)));
        const interval = setInterval(poll, pollInterval);

        return () => {
            stopped = true;
            clearInterval(interval);
            source.close();
        };
    }

    /**
     * Wait for the first message matching a predicate.
     * @param {Function} predicate - called with each payload
     * @param {Object} [options] -
     * @param {string} [options.since="all"] - ntfy message ID to listen from
     * @param {number} [options.timeout=15000] - in milliseconds
     * @param {number} [options.pollInterval=2000] - in milliseconds
     * @param {AbortSignal} [options.signal] - stop waiting (rejects)
     * @return {Promise<Object>}
     */
    function wait (predicate, { since = "all", timeout = 15 * 1000, pollInterval = 2000, signal } = {}) {
        return new Promise((resolve, reject) => {
            const finish = (callback, value) => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                unsubscribe();
                callback(value);
            };
            const onAbort = () => finish(reject, new Error("Airpad: aborted"));
            signal?.addEventListener("abort", onAbort);
            const timer = setTimeout(() => finish(reject, new Error("Airpad: timed out")), timeout);
            const unsubscribe = subscribe((payload) => {
                if (predicate(payload)) {
                    finish(resolve, payload);
                }
            }, {
                since,
                pollInterval,
            });
        });
    }

    return {
        publish,
        subscribe,
        wait,
    };
}
