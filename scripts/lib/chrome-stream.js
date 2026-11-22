const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const readline = require("node:readline");
const { ignoreFailure } = require("./caught.js");
const { parseJsonlRow } = require("./jsonl.js");
const { noop } = require("./noop.js");
const { writeFd } = require("./write-fd.js");

const STREAM_ARGS = [
	"--input-format",
	"stream-json",
	"--output-format",
	"stream-json",
	"--verbose",
];

/* #5351. */
const KILL_AFTER_MS = 1500;

/**
 * @typedef {{ result: Record<string, unknown> | undefined,
 *   capped: boolean }} TurnEnd
 */

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {import("node:child_process").SpawnOptions} opts
 * @param {(row: Record<string, unknown>) => void} onRow
 */
function startStreamChild(bin, args, opts, onRow) {
	const child = spawn(bin, args, {
		...opts,
		stdio: ["pipe", "pipe", "inherit"],
		detached: true,
	});
	let gone = false;
	/** @type {(() => void) | undefined} */
	let waiter;
	const wake = () => waiter?.();
	/** @type {Promise<[number | null, string | null]>} */
	const exited = new Promise((resolve) => {
		/** @param {number | null} status @param {string | null} signal */
		const end = (status, signal) => {
			gone = true;
			resolve([status, signal]);
			wake();
		};
		child.on("exit", end);
		child.on("error", () => end(null, null));
	});
	child.stdin?.on("error", noop);

	/** @type {Record<string, unknown> | undefined} */
	let lastResult;
	const assistants = new Set();
	if (child.stdout) {
		const lines = readline.createInterface({ input: child.stdout });
		lines.on("line", (line) => {
			const row = parseJsonlRow(line);
			if (row === undefined) writeFd(2, `${line}\n`);
			if (!row) return;
			onRow(row);
			if (row.type === "assistant") {
				const message = /** @type {{id?: unknown} | undefined} */ (row.message);
				assistants.add(message?.id);
			}
			if (row.type === "result") lastResult = row;
			wake();
		});
	}

	/** @param {Record<string, unknown>} message */
	const write = (message) => {
		if (!gone && child.stdin?.writable)
			child.stdin.write(`${JSON.stringify(message)}\n`);
	};

	/** @param {NodeJS.Signals} signal */
	const signalGroup = (signal) => {
		ignoreFailure(() => {
			if (child.pid) process.kill(-child.pid, signal);
		});
	};

	const interrupt = () =>
		write({
			type: "control_request",
			request_id: crypto.randomUUID(),
			request: { subtype: "interrupt" },
		});

	return {
		child,
		exited,
		/** @param {string} text */
		send(text) {
			write({
				type: "user",
				message: { role: "user", content: [{ type: "text", text }] },
			});
		},
		interrupt,
		/**
		 * @param {{capMs: number, capAssistants?: number, graceMs: number}} cap
		 * @returns {Promise<TurnEnd>}
		 */
		turn({ capMs, capAssistants = Number.POSITIVE_INFINITY, graceMs }) {
			lastResult = undefined;
			assistants.clear();
			return new Promise((resolve) => {
				let capped = false;
				/** @type {NodeJS.Timeout | undefined} */
				let grace;
				const done = (/** @type {TurnEnd} */ end) => {
					waiter = undefined;
					clearTimeout(cap);
					clearTimeout(grace);
					resolve(end);
				};
				const hitCap = () => {
					if (capped) return;
					capped = true;
					interrupt();
					grace = setTimeout(
						() => done({ result: undefined, capped }),
						graceMs,
					);
				};
				const cap = setTimeout(hitCap, capMs);
				waiter = () => {
					if (lastResult) return done({ result: lastResult, capped });
					if (gone) return done({ result: undefined, capped });
					if (assistants.size > capAssistants) hitCap();
				};
				waiter();
			});
		},
		async finish() {
			child.stdin?.end();
			return exited;
		},
		async stop() {
			signalGroup("SIGTERM");
			const kill = setTimeout(() => signalGroup("SIGKILL"), KILL_AFTER_MS);
			const end = await exited;
			clearTimeout(kill);
			return end;
		},
		signalGroup,
		get gone() {
			return gone;
		},
	};
}

module.exports = { STREAM_ARGS, startStreamChild };
