/*
 * chrome-stream.js — one `claude -p --input-format stream-json` child driven
 * turn by turn, for claude-child.js's Chrome launcher and its closer (#5385).
 *
 * Its stdin is a pipe held open: a prompt goes in as one user message, and a
 * turn is ended early by the stdin interrupt control request, never by
 * SIGTERM or SIGINT, which end the process (#5350). Closing stdin lets the
 * child exit cleanly, which drops its tab group's tabs out of every session's
 * reach (#5352), so `finish` is only for a child whose group is empty; every
 * other end is `stop`, a signal to the child's process group, which keeps the
 * group for a resume (#5375).
 *
 * A stdout line that is no JSON row goes to stderr: the caller's stdout is
 * one JSON line alone (#5381).
 */

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const readline = require("node:readline");
const { parseJsonlRow } = require("./jsonl.js");
const { writeFd } = require("./write-fd.js");

/* #5351: SIGTERM to the whole tree, then SIGKILL at 1.5 s. */
const KILL_AFTER_MS = 1500;

/**
 * @typedef {{ result: Record<string, unknown> | undefined,
 *   capped: boolean }} TurnEnd `capped`: the turn hit its cap and was
 *   interrupted; `result` undefined where no result row came
 */

/**
 * Start the child. `onRow` sees every parsed row first.
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
	child.stdin?.on("error", () => {
		/* EPIPE once the child has gone: `exited` says so */
	});

	/** @type {Record<string, unknown> | undefined} */
	let lastResult;
	let assistants = 0;
	if (child.stdout) {
		const lines = readline.createInterface({ input: child.stdout });
		lines.on("line", (line) => {
			const row = parseJsonlRow(line);
			if (row === undefined) writeFd(2, `${line}\n`);
			if (!row) return;
			onRow(row);
			if (row.type === "assistant") assistants++;
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
		try {
			if (child.pid) process.kill(-child.pid, signal);
		} catch {
			/* already gone */
		}
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
		 * Wait for the turn's result row. At `capMs`, or at `capAssistants`
		 * assistant messages, interrupt it and wait `graceMs` more for the row.
		 * @param {{capMs: number, capAssistants?: number, graceMs: number}} cap
		 * @returns {Promise<TurnEnd>}
		 */
		turn({ capMs, capAssistants = Number.POSITIVE_INFINITY, graceMs }) {
			lastResult = undefined;
			assistants = 0;
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
					if (assistants >= capAssistants) hitCap();
				};
				waiter();
			});
		},
		/** Close stdin, so the child exits cleanly. */
		async finish() {
			child.stdin?.end();
			return exited;
		},
		/** SIGTERM the child's process group, SIGKILL at 1.5 s; stdin kept. */
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

module.exports = { KILL_AFTER_MS, startStreamChild };
