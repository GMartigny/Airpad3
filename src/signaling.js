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
 * @param {string} topic -
 * @param {Object} [options] -
 * @param {string} [options.server] - ntfy server URL
 * @return {{publish: Function, last: Function, wait: Function}}
 */
export function createSignaling (topic, { server = DEFAULT_SERVER } = {}) {
    const base = `${server}/${topic}`;

    /**
     * Read the last already published message of a given type.
     * @param {string} type -
     * @param {string} [since="all"] - ntfy message ID to read from
     * @return {Promise<Object|undefined>}
     */
    async function poll (type, since = "all") {
        const response = await fetch(`${base}/json?poll=1&since=${since}`);
        if (!response.ok) {
            throw new Error(`Airpad: failed to read from ntfy (${response.status})`);
        }
        const text = await response.text();
        return text.split("\n")
            .filter(Boolean)
            .map(parse)
            .filter(message => message?.event === "message")
            .map(message => parse(message.message))
            .filter(payload => payload?.type === type)
            .at(-1);
    }

    return {
        /**
         * Publish a message on the topic.
         * @param {Object} payload -
         * @return {Promise<{id: string}>} the message created by ntfy
         */
        async publish (payload) {
            const response = await fetch(base, {
                method: "POST",
                body: JSON.stringify(payload),
            });
            if (!response.ok) {
                throw new Error(`Airpad: failed to publish on ntfy (${response.status})`);
            }
            return response.json();
        },

        /**
         * Read the last already published message of a given type.
         * @param {string} type -
         * @return {Promise<Object|undefined>}
         */
        last (type, since = "all") {
            return poll(type, since);
        },

        /**
         * Wait for the next message of a given type.
         * Listen with SSE, with a polling fallback (dropped SSE, buffering proxy…).
         * @param {string} type -
         * @param {Object} [options] -
         * @param {string} [options.since="all"] - ntfy message ID to listen from
         * @param {number} [options.timeout] - in milliseconds
         * @param {number} [options.pollInterval=2000] - in milliseconds
         * @return {Promise<Object>}
         */
        wait (type, { since = "all", timeout = 5 * 60 * 1000, pollInterval = 2000 } = {}) {
            return new Promise((resolve, reject) => {
                const source = new EventSource(`${base}/sse?since=${since}`);
                const finish = (callback, value) => {
                    clearTimeout(timer);
                    clearInterval(interval);
                    source.close();
                    callback(value);
                };
                const timer = setTimeout(() => finish(reject, new Error("Airpad: timed out")), timeout);
                const interval = setInterval(async () => {
                    try {
                        const payload = await poll(type, since);
                        if (payload) {
                            finish(resolve, payload);
                        }
                    }
                    catch {
                        // Unstable network: retry on next tick
                    }
                }, pollInterval);

                source.addEventListener("message", ({ data }) => {
                    const message = parse(data);
                    if (message?.event !== "message") {
                        return;
                    }
                    const payload = parse(message.message);
                    if (payload?.type === type) {
                        finish(resolve, payload);
                    }
                });
            });
        },
    };
}
