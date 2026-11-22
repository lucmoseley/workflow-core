const { spawnSync } = require("node:child_process");
const dns = require("node:dns");
const net = require("node:net");
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");

const HOST = "api.anthropic.com";
const PORT = 443;
// guess, #4816
const STEP_TIMEOUT_MS = 3000;
// guess, #4816
const CHILD_TIMEOUT_MS = 2 * STEP_TIMEOUT_MS + 2000;

/**
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
		(e) => {
			writeFd(2, `the probe failed: ${caught(e).message}\n`);
			process.exit(1);
		},
	);

module.exports = { probeNetwork, main };
