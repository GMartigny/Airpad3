// End-to-end test: local fake ntfy server + Node WebRTC (node-datachannel).
// Run: node --experimental-eventsource e2e.test.js
import http from "node:http";
import assert from "node:assert/strict";
import { RTCPeerConnection } from "node-datachannel/polyfill";

globalThis.RTCPeerConnection = RTCPeerConnection;

// --- Fake ntfy: POST /topic, GET /topic/json?poll=1, GET /topic/sse?since=id
const topics = new Map();
const subscribers = new Map();
let counter = 0;
const ntfy = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const [, topic, kind] = url.pathname.split("/");
    const messages = topics.get(topic) ?? [];
    topics.set(topic, messages);

    if (request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => {
            body += chunk;
        });
        request.on("end", () => {
            const message = {
                id: `m${++counter}`,
                time: Date.now(),
                event: "message",
                topic,
                message: body,
            };
            messages.push(message);
            (subscribers.get(topic) ?? []).forEach(res => res.write(`data: ${JSON.stringify(message)}\n\n`));
            response.writeHead(200, {
                "Content-Type": "application/json",
            });
            response.end(JSON.stringify(message));
        });
        return;
    }
    if (kind === "json") {
        const since = url.searchParams.get("since");
        const start = since === "all" ? 0 : messages.findIndex(message => message.id === since) + 1;
        response.writeHead(200);
        response.end(messages.slice(start).map(message => JSON.stringify(message)).join("\n"));
        return;
    }
    if (kind === "sse") {
        response.writeHead(200, {
            "Content-Type": "text/event-stream",
        });
        response.write(`event: open\ndata: ${JSON.stringify({ event: "open" })}\n\n`);
        const since = url.searchParams.get("since");
        const index = messages.findIndex(message => message.id === since);
        messages.slice(index + 1).forEach(message => response.write(`data: ${JSON.stringify(message)}\n\n`));
        const list = subscribers.get(topic) ?? [];
        list.push(response);
        subscribers.set(topic, list);
        request.on("close", () => list.splice(list.indexOf(response), 1));
        return;
    }
    response.writeHead(404);
    response.end();
});
await new Promise(resolve => ntfy.listen(0, resolve));
const server = `http://localhost:${ntfy.address().port}`;

const { host, join } = await import("../src/index.js");
const options = {
    server,
    iceServers: [],
};

const display = await host({
    ...options,
    controllerUrl: "https://example.com/remote/",
});
assert.match(display.id, /^[a-z0-9]{16}$/);
assert.equal(display.url, `https://example.com/remote/#${display.id}`);

const received = [];
display.addEventListener("press", event => received.push(event.detail));
const displayOpen = new Promise(resolve => display.addEventListener("open", resolve, {
    once: true,
}));

const pad = await join(display.id, options);
await displayOpen;
assert.ok(pad instanceof EventTarget);
assert.ok(pad.isOpen && display.isOpen);

const vibrate = new Promise(resolve => pad.addEventListener("vibrate", resolve, {
    once: true,
}));
pad.send("press", {
    button: "A",
});
display.send("vibrate", 50);

const vibrateEvent = await vibrate;
await new Promise(resolve => setTimeout(resolve, 100));

assert.ok(vibrateEvent instanceof CustomEvent);
assert.equal(vibrateEvent.detail, 50);
assert.deepEqual(received, [{
    button: "A",
}]);
assert.throws(() => pad.send("close"), /reserved/);
assert.throws(() => pad.send(""), /non-empty string/);

await assert.rejects(join("inconnu", options), /session not found/);

const closed = new Promise(resolve => display.addEventListener("close", resolve, {
    once: true,
}));
pad.close();
await closed;
display.close();
ntfy.closeAllConnections();
ntfy.close();
console.log("✓ pairing through ntfy, events both ways, reserved types rejected, close propagated, unknown session rejected");
process.exit(0);
