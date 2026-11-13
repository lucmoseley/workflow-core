/*
 * net-probe.js — whether the Anthropic API host is reachable: a DNS lookup,
 * then a TCP connect to api.anthropic.com:443 (workflow-core#4815). The refill loop asks
 * once per tick before it types an API-error resume or runs a fallback for
 * one, as a resume typed while the network is down is lost (workflow-core#4657 Finding 1).
 * It says only that the network is back, not that the API is healthy: a 5xx
 * or 529 after that is the retry watchdog's to ride out.
 *
 * Run as a child, so the loop's synchronous acts can ask it: `node
 * net-probe.js` exits 0 reachable, else 1 with why on stderr. WFC_NET_PROBE
 * names a program run in its place, for a suite's stand-in (§N7):
 * lib/net-probe-fake.ts's, held to this one by lib/net-probe.contract.test.ts.
 */

const { spawnSync } = require("node:child_process");
const dns = require("node:dns");
const net = require("node:net");
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");

const HOST = "api.anthropic.com";
const PORT = 443;
/* Untraced: long enough for a slow lookup and handshake on a working link,
 * short enough that a tick with the network down stalls little. */
const STEP_TIMEOUT_MS = 3000;
/* The child's hang guard: both steps plus node's start-up; untraced. */
const CHILD_TIMEOUT_MS = 2 * STEP_TIMEOUT_MS + 2000;

/**
 * Null where the host is reachable, else why not.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
function probeNetwork(env = process.env) {
	const [file, args] = env.WFC_NET_PROBE
		? [env.WFC_NET_PROBE, []]
		: [process.execPath, [__filename]];
	const r = spawnSync(file, args, {
		encoding: "utf8",
		timeout: CHILD_TIMEOUT_MS,
		env,
	});
	if (r.error) return `the probe did not run: ${r.error.message}`;
	if (r.status === 0) return null;
	return r.stderr.trim() || `the probe exited ${r.status ?? r.signal}`;
}

/**
 * The child's work: null where the host is reachable, else the line it
 * prints. The seams let lib/net-probe.contract.test.ts run it offline (workflow-core#4826).
 * @param {object} [seams]
 * @param {(host: string, cb: (err: NodeJS.ErrnoException|null, address: string) => void) => void} [seams.lookup]
 * @param {number} [seams.port]
 * @param {number} [seams.timeoutMs]
 * @returns {Promise<string|null>}
 */
function main({
	lookup = dns.lookup,
	port = PORT,
	timeoutMs = STEP_TIMEOUT_MS,
} = {}) {
	return new Promise((resolve) => {
		/** @type {import("node:net").Socket|undefined} */
		let socket;
		let settled = false;
		const settle = (/** @type {string|null} */ why) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket?.destroy();
			resolve(why);
		};
		const timer = setTimeout(
			() => settle(`${HOST} gave no answer in ${timeoutMs} ms`),
			timeoutMs,
		);
		lookup(HOST, (err, address) => {
			if (settled) return;
			clearTimeout(timer);
			if (err)
				return settle(`${HOST} did not resolve: ${err.code ?? err.message}`);
			socket = net.connect({ host: address, port });
			socket.setTimeout(timeoutMs, () =>
				settle(`${HOST}:${port} took no connection in ${timeoutMs} ms`),
			);
			socket.on("connect", () => settle(null));
			socket.on("error", (e) =>
				settle(`${HOST}:${port} refused: ${e.message}`),
			);
		});
	});
}

if (require.main === module)
	main().then(
		(why) => {
			if (why) writeFd(2, `${why}\n`);
			process.exit(why ? 1 : 0);
		},
		/* Only a lookup that throws rather than calling back lands here. */
		(e) => {
			writeFd(2, `the probe failed: ${caught(e).message}\n`);
			process.exit(1);
		},
	);

module.exports = { probeNetwork, main };
