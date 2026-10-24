/*
 * gate-sweep.js — the refill loop's gate sweep (#2279): on its own cadence,
 * outside every tick, it runs check-gates.js in each served checkout and
 * queues one `/triage <n>` judgement for each `**Gated on:**` issue whose
 * reading differs from the one stored for it, a first sighting included.
 * Residual: the first sweep, or one over an unreadable store, queues a
 * judgement for every gated issue in every served checkout, each launched
 * ahead of the ranking as slots allow.
 *
 * NO EXIT CODE IS A VERDICT HERE (mantahostels#1332). A reading's change only
 * summons a judge; the launched session reads it against the condition and
 * strips the marker or leaves it. "Changed" is the reading's text: a reading
 * embedding a clock changes every sweep, and that is a `check:` segment to
 * repair, not something to filter here.
 *
 * ONE FILE, under the loop's files (lib/refill-loop.js's loopFiles): each
 * issue's stored reading keyed by checkout and number, the judgements still
 * to launch, and when the last sweep started, so a restart keeps all three.
 */

const { spawn } = require("node:child_process");
const path = require("node:path");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { readJson, writeJson } = require("./refill-loop.js");

/* A guess: often enough that a met gate waits on its judge about as long as
 * a session takes to start, rare enough that a sweep of slow checks (one runs
 * to check-gates.js's 60 s budget on every sweep, mantahostels#2491) is not
 * running most of the time. */
const GATE_SWEEP_MS = 30 * 60 * 1000;
/* One checkout's sweep; check-gates.js bounds each check, so this only
 * catches a sweep hung outside them. Untraced. */
const ROOT_SWEEP_TIMEOUT_MS = GATE_SWEEP_MS;

const CHECK_GATES = path.join(__dirname, "..", "check-gates.js");

/** @typedef {{root: string, number: number, prompt: string}} Judgement */

/**
 * @typedef {object} GateStore
 * @property {Record<string, string>} readings keyed `<root>#<n>`
 * @property {Judgement[]} pending queued, not yet tried
 * @property {number|null} lastSweepAt ms the last sweep started
 */

/** @param {string} root @param {number} n */
const keyOf = (root, n) => `${root}#${n}`;

/**
 * The launch prompt for one judgement. It names no number but the issue's,
 * since the dispatcher reads every integer in a prompt as an issue it holds;
 * a resolved check-gates.js path could carry a plugin version's.
 * @param {number} n
 */
const judgementPrompt = (n) =>
	`/triage ${n} — its Gated on: reading changed. Run check-gates.js --issue ${n} and judge the reading against the condition: met, comment the evidence and strip the marker; unmet, leave the gate and end.`;

/** @param {unknown} raw @returns {Record<string, unknown>} */
const recordOf = (raw) =>
	typeof raw === "object" && raw !== null
		? /** @type {Record<string, unknown>} */ (raw)
		: {};

/** @param {unknown} raw @returns {Judgement[]} */
function judgementsOf(raw) {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((item) => {
		const { root, number, prompt } = recordOf(item);
		return typeof root === "string" &&
			typeof number === "number" &&
			Number.isInteger(number) &&
			typeof prompt === "string"
			? [{ root, number, prompt }]
			: [];
	});
}

/**
 * The store's fields; an absent or unreadable file is an empty store.
 * @param {string} file
 * @returns {GateStore}
 */
function readGateStore(file) {
	const raw = recordOf(readJson(file));
	/** @type {Record<string, string>} */
	const readings = {};
	for (const [k, v] of Object.entries(recordOf(raw.readings)))
		if (typeof v === "string") readings[k] = v;
	return {
		readings,
		pending: judgementsOf(raw.pending),
		lastSweepAt: typeof raw.lastSweepAt === "number" ? raw.lastSweepAt : null,
	};
}

/**
 * One checkout's rows from check-gates.js's --json envelope: each conditioned
 * issue, its reading where its `check:` printed one, else null. Null where the
 * envelope is unreadable or carries no rows, so nothing stored for that
 * checkout moves.
 * @param {string} stdout
 * @returns {{number: number, reading: string|null}[] | null}
 */
function sweptRows(stdout) {
	let rows;
	try {
		rows = recordOf(JSON.parse(stdout)).rows;
	} catch {
		return null;
	}
	if (!Array.isArray(rows)) return null;
	return rows.flatMap((r) => {
		const { number, state, reading } = recordOf(r);
		if (typeof number !== "number") return [];
		return [
			{
				number,
				reading:
					state === "READING" && typeof reading === "string" ? reading : null,
			},
		];
	});
}

/**
 * The store after one checkout's sweep, and the issues it queued. A changed
 * reading is stored and queued once; a check that printed none keeps the
 * reading stored and queues nothing; an issue no longer gated leaves the
 * store and the queue.
 * @param {GateStore} store
 * @param {string} root
 * @param {{number: number, reading: string|null}[]} rows
 */
function withSweep(store, root, rows) {
	const gated = new Set(rows.map((r) => keyOf(root, r.number)));
	/** @type {Record<string, string>} */
	const readings = {};
	for (const [k, v] of Object.entries(store.readings))
		if (!k.startsWith(`${root}#`) || gated.has(k)) readings[k] = v;
	const pending = store.pending.filter(
		(j) => j.root !== root || gated.has(keyOf(root, j.number)),
	);
	/** @type {number[]} */
	const queued = [];
	for (const { number, reading } of rows) {
		const key = keyOf(root, number);
		if (reading === null || readings[key] === reading) continue;
		readings[key] = reading;
		queued.push(number);
		if (!pending.some((j) => j.root === root && j.number === number))
			pending.push({ root, number, prompt: judgementPrompt(number) });
	}
	return { store: { ...store, readings, pending }, queued };
}

/**
 * Take each judgement the tick tried off the queue, launched or refused: a
 * refused one would otherwise take a slot every tick. The next changed
 * reading queues it again.
 * @param {string} file
 * @param {{root: string, issues: number[]}[]} tried
 */
function dropTried(file, tried) {
	const store = readGateStore(file);
	const pending = store.pending.filter(
		(j) => !tried.some((t) => t.root === j.root && t.issues.includes(j.number)),
	);
	if (pending.length !== store.pending.length)
		writeJson(file, { ...store, pending });
}

/**
 * Run check-gates.js --json in `root` as a child the caller does not wait
 * on; resolves with its stdout, or an error string where it could not run.
 * @param {string} root
 * @param {{env: NodeJS.ProcessEnv, script?: string}} opts
 * @returns {Promise<{stdout: string} | {error: string}>}
 */
function runCheckGates(root, { env, script = CHECK_GATES }) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [script, "--json"], {
			cwd: root,
			env,
			stdio: ["ignore", "pipe", "ignore"],
			timeout: ROOT_SWEEP_TIMEOUT_MS,
		});
		let stdout = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (d) => {
			if (stdout.length < CHILD_MAX_BUFFER) stdout += d;
		});
		child.on("error", (err) => resolve({ error: err.message }));
		child.on("close", (_code, signal) =>
			resolve(signal ? { error: `killed by ${signal}` } : { stdout }),
		);
	});
}

/**
 * The loop's sweeper. `startIfDue` returns at once: the sweep runs its
 * checkouts in series in children, so no tick waits on a check. One sweep at
 * a time.
 * @param {{file: string,
 *   runRoot: (root: string) => Promise<{stdout: string} | {error: string}>,
 *   log: (line: string) => void, cadenceMs: number}} deps
 */
function gateSweeper({ file, runRoot, log, cadenceMs }) {
	/** @type {Promise<void>|null} */
	let inFlight = null;

	/** @param {string[]} roots */
	async function sweep(roots) {
		for (const root of roots) {
			const r = await runRoot(root);
			const rows = "error" in r ? null : sweptRows(r.stdout);
			if (rows === null) {
				log(
					`gate sweep in ${root}: ${"error" in r ? r.error : "no rows in check-gates.js's envelope"}; readings kept`,
				);
				continue;
			}
			const { store, queued } = withSweep(readGateStore(file), root, rows);
			writeJson(file, store);
			if (queued.length > 0)
				log(
					`gate sweep in ${root}: reading changed on ${queued.map((n) => `#${n}`).join(", ")}; judgement queued`,
				);
		}
	}

	return {
		/** Whether a sweep this sweeper started is still running. */
		busy: () => inFlight !== null,
		/**
		 * @param {string[]} roots
		 * @param {number} now
		 * @returns {Promise<void>|null} the sweep started, else null
		 */
		startIfDue(roots, now) {
			if (inFlight !== null) return null;
			const store = readGateStore(file);
			if (store.lastSweepAt !== null && now - store.lastSweepAt < cadenceMs)
				return null;
			writeJson(file, { ...store, lastSweepAt: now });
			const started = sweep(roots).finally(() => {
				inFlight = null;
			});
			inFlight = started;
			return started;
		},
	};
}

module.exports = {
	GATE_SWEEP_MS,
	dropTried,
	gateSweeper,
	readGateStore,
	runCheckGates,
};
