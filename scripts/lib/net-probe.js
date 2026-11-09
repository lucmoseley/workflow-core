/*
 * net-probe.js — whether the Anthropic API host is reachable: a DNS lookup,
 * then a TCP connect to api.anthropic.com:443 (#4815). The refill loop asks
 * once per tick before it types an API-error resume or runs a fallback for
 * one, as a resume typed while the network is down is lost (#4657 Finding 1).
 * It says only that the network is back, not that the API is healthy: a 5xx
 * or 529 after that is the retry watchdog's to ride out.
 *
 * Run as a child, so the loop's synchronous acts can ask it: `node
 * net-probe.js` exits 0 reachable, else 1 with why on stderr. WFC_NET_PROBE
 * names a program run in its place, for a suite's stand-in (§N7).
 */

const { spawnSync } = require("node:child_process");
const dns = require("node:dns");
const net = require("node:net");
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

/** Look the host up, then connect to it; exit 0 once connected. */
function main() {
	const fail = (/** @type {string} */ why) => {
		writeFd(2, `${why}\n`);
		process.exit(1);
	};
	const timer = setTimeout(
		() => fail(`${HOST} gave no answer in ${STEP_TIMEOUT_MS} ms`),
		STEP_TIMEOUT_MS,
	);
	dns.lookup(HOST, (err, address) => {
		clearTimeout(timer);
		if (err) return fail(`${HOST} did not resolve: ${err.code ?? err.message}`);
		const socket = net.connect({ host: address, port: PORT });
		socket.setTimeout(STEP_TIMEOUT_MS, () =>
			fail(`${HOST}:${PORT} took no connection in ${STEP_TIMEOUT_MS} ms`),
		);
		socket.on("connect", () => {
			socket.destroy();
			process.exit(0);
		});
		socket.on("error", (e) => fail(`${HOST}:${PORT} refused: ${e.message}`));
	});
}

if (require.main === module) main();

module.exports = { probeNetwork };
