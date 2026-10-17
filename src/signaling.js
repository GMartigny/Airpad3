/**
 * Signalisation via ntfy (https://ntfy.sh) : un simple pub/sub HTTP public,
 * sans compte et sans serveur à héberger.
 * Chaque session utilise son propre topic, nommé à partir d'un ID aléatoire.
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
 * @param {string} [options.server] - URL du serveur ntfy
 * @return {{publish: Function, last: Function, wait: Function}}
 */
export function createSignaling (topic, { server = DEFAULT_SERVER } = {}) {
    const base = `${server}/${topic}`;

    /**
     * Lit le dernier message déjà publié d'un type donné.
     * @param {string} type -
     * @param {string} [since="all"] - ID ntfy à partir duquel lire
     * @return {Promise<Object|undefined>}
     */
    async function poll (type, since = "all") {
        const response = await fetch(`${base}/json?poll=1&since=${since}`);
        if (!response.ok) {
            throw new Error(`Airpad: échec de lecture sur ntfy (${response.status})`);
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
         * Publie un message sur le topic.
         * @param {Object} payload -
         * @return {Promise<{id: string}>} le message créé par ntfy
         */
        async publish (payload) {
            const response = await fetch(base, {
                method: "POST",
                body: JSON.stringify(payload),
            });
            if (!response.ok) {
                throw new Error(`Airpad: échec de publication sur ntfy (${response.status})`);
            }
            return response.json();
        },

        /**
         * Lit le dernier message déjà publié d'un type donné.
         * @param {string} type -
         * @return {Promise<Object|undefined>}
         */
        last (type, since = "all") {
            return poll(type, since);
        },

        /**
         * Attend le prochain message d'un type donné.
         * Écoute en SSE, avec un polling de secours (SSE coupé, proxy qui bufferise…).
         * @param {string} type -
         * @param {Object} [options] -
         * @param {string} [options.since="all"] - ID ntfy à partir duquel écouter
         * @param {number} [options.timeout] - en millisecondes
         * @param {number} [options.pollInterval=2000] - en millisecondes
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
                const timer = setTimeout(() => finish(reject, new Error("Airpad: délai d'attente dépassé")), timeout);
                const interval = setInterval(async () => {
                    try {
                        const payload = await poll(type, since);
                        if (payload) {
                            finish(resolve, payload);
                        }
                    }
                    catch {
                        // Réseau instable : on retentera au prochain tour
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
