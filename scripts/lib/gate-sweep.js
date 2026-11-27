const { execFile, spawn } = require("node:child_process");
const path = require("node:path");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const {
	NOT_STATED,
	PRINTING_FIX,
	REPAIR_STATES,
	parseVerdict,
} = require("./gate-check.js");
const { readJson, writeJson } = require("./refill-json.js");
const { WATCH_CLOSED_LABEL } = require("./watch-label.js");

// guess, workflow-core#2279
const GATE_SWEEP_MS = 30 * 60 * 1000;
// guess, workflow-core#3092
const JUDGE_EVERY_MS = 6 * 60 * 60 * 1000;
// guess, lucmoseley/mantahostels#3869
const REJUDGE_UNCHECKED_MS = 14 * 24 * 60 * 60 * 1000;
// guess, workflow-core#5696
const REJUDGE_UNMET_MS = 14 * 24 * 60 * 60 * 1000;
const ROOT_SWEEP_TIMEOUT_MS = GATE_SWEEP_MS;

const CHECK_GATES = path.join(__dirname, "..", "check-gates.js");
const RELEASE_DUE = path.join(__dirname, "..", "report-release-due.js");
// guess, workflow-core#5435
const RELEASE_DUE_TIMEOUT_MS = 2 * 60 * 1000;

/** @typedef {{root: string, number: number, prompt: string}} Judgement */

/**
 * @typedef {object} GateStore
 * @property {Record<string, string>} readings
 * @property {Record<string, number>} queuedAt
 * @property {Judgement[]} pending
 * @property {number|null} lastSweepAt
 */

/** @param {string} root @param {number} n */
const keyOf = (root, n) => `${root}#${n}`;

/** @typedef {{number: number, closed: boolean}} PromptRow */

/** @param {PromptRow} row */
const buildMetAct = ({ number, closed }) =>
	closed
		? `reopen it (gh issue reopen ${number}), claim it, remove its ${WATCH_CLOSED_LABEL} label, comment the evidence and strip the marker`
		: "comment the evidence and strip the marker";

/** @param {PromptRow} row */
const buildWatchNote = ({ closed }) =>
	closed
		? `, the issue closed under ${WATCH_CLOSED_LABEL}, so judge it unclaimed: claim-issue.js refuses a closed issue`
		: "";

/** @param {PromptRow} row */
const buildJudgementPrompt = (row) =>
	`/triage ${row.number} — its Gated on: reading changed${buildWatchNote(row)}. Run check-gates.js --issue ${row.number} and judge the reading against the condition: met, ${buildMetAct(row)}; unmet, leave the gate and end.`;

/** @param {PromptRow} row @param {string} state */
const buildRepairPrompt = (row, state) =>
	`/triage ${row.number} — its Gated on: check reads ${state}${buildWatchNote(row)}. Judge the condition by hand: met, ${buildMetAct(row)}; unmet, rewrite the check: so that it prints what it saw (for example ${PRINTING_FIX}), run check-gates.js --issue ${row.number} to see it print, and end.`;

/** @param {PromptRow} row */
const buildUncheckedPrompt = (row) =>
	`/triage ${row.number} — its Gated on: line carries no check:${buildWatchNote(row)}. Judge the condition by hand: met, ${buildMetAct(row)}; unmet, leave the gate, and where one command could test the condition add it as the line's check: segment so that it prints what it saw (for example ${PRINTING_FIX}), run check-gates.js --issue ${row.number} to see it print, and end.`;

/** @param {string} state */
const buildStateSeen = (state) => `[${state}]`;

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
 * @param {string} file
 * @param {(line: string) => void} log
 * @returns {GateStore}
 */
function readGateStore(file, log) {
	const raw = recordOf(readJson(file, log));
	/** @type {Record<string, string>} */
	const readings = {};
	for (const [k, v] of Object.entries(recordOf(raw.readings)))
		if (typeof v === "string") readings[k] = v;
	/** @type {Record<string, number>} */
	const queuedAt = {};
	for (const [k, v] of Object.entries(recordOf(raw.queuedAt)))
		if (typeof v === "number") queuedAt[k] = v;
	return {
		readings,
		queuedAt,
		pending: judgementsOf(raw.pending),
		lastSweepAt: typeof raw.lastSweepAt === "number" ? raw.lastSweepAt : null,
	};
}

/**
 * @typedef {{number: number, closed: boolean, seen: string|null} & (
 *   {kind: "reading"} | {kind: "repair", state: string} | {kind: "unchecked"}
 * )} SweptRow
 */

/**
 * @param {string} stdout
 * @returns {SweptRow[] | null}
 */
function sweptRows(stdout) {
	let rows;
	try {
		rows = recordOf(JSON.parse(stdout)).rows;
	} catch {
		return null;
	}
	if (!Array.isArray(rows)) return null;
	return rows.flatMap(
		/** @returns {SweptRow[]} */ (r) => {
			const { number, state, reading, closed: raw } = recordOf(r);
			if (typeof number !== "number") return [];
			const closed = raw === true;
			if (typeof state === "string" && REPAIR_STATES.has(state))
				return [
					{
						number,
						closed,
						seen: buildStateSeen(state),
						kind: "repair",
						state,
					},
				];
			if (state === NOT_STATED)
				return [
					{ number, closed, seen: buildStateSeen(state), kind: "unchecked" },
				];
			return [
				{
					number,
					closed,
					seen:
						state === "READING" && typeof reading === "string" ? reading : null,
					kind: "reading",
				},
			];
		},
	);
}

/** @param {SweptRow} row */
function buildPrompt(row) {
	switch (row.kind) {
		case "reading":
			return buildJudgementPrompt(row);
		case "repair":
			return buildRepairPrompt(row, row.state);
		case "unchecked":
			return buildUncheckedPrompt(row);
	}
}

/**
 * @param {SweptRow["kind"]} kind
 * @param {string} seen
 * @param {string|undefined} stored
 */
function changedBound(kind, seen, stored) {
	if (kind !== "reading") return JUDGE_EVERY_MS;
	const verdict = parseVerdict(seen);
	if (verdict === "unmet") return REJUDGE_UNMET_MS;
	if (
		verdict === "met" &&
		(stored === undefined || parseVerdict(stored) !== "met")
	)
		return 0;
	return JUDGE_EVERY_MS;
}

/**
 * @param {SweptRow} row
 * @param {string|undefined} stored
 * @param {number|undefined} last
 * @param {number} now
 * @returns {row is SweptRow & {seen: string}}
 */
function isDue(row, stored, last, now) {
	if (row.seen === null) return false;
	const unchanged = stored === row.seen;
	if (unchanged && row.kind !== "unchecked") return false;
	const bound = unchanged
		? REJUDGE_UNCHECKED_MS
		: changedBound(row.kind, row.seen, stored);
	return last === undefined || now - last >= bound;
}

/**
 * @param {Judgement[]} pending
 * @param {string} root
 * @param {SweptRow} row
 */
function enqueue(pending, root, row) {
	const { number } = row;
	const prompt = buildPrompt(row);
	const at = pending.findIndex((j) => j.root === root && j.number === number);
	if (at < 0) pending.push({ root, number, prompt });
	else pending[at] = { root, number, prompt };
}

/**
 * @param {GateStore} store
 * @param {string} root
 * @param {SweptRow[]} rows
 * @param {number} now
 */
function withSweep(store, root, rows, now) {
	const gated = new Set(rows.map((r) => keyOf(root, r.number)));
	/** @param {string} k */
	const kept = (k) => !k.startsWith(`${root}#`) || gated.has(k);
	/** @type {Record<string, string>} */
	const readings = {};
	for (const [k, v] of Object.entries(store.readings))
		if (kept(k)) readings[k] = v;
	/** @type {Record<string, number>} */
	const queuedAt = {};
	for (const [k, v] of Object.entries(store.queuedAt))
		if (kept(k)) queuedAt[k] = v;
	const pending = store.pending.filter((j) => kept(keyOf(j.root, j.number)));
	/** @type {number[]} */
	const queued = [];
	for (const row of rows) {
		const key = keyOf(root, row.number);
		if (!isDue(row, readings[key], queuedAt[key], now)) continue;
		readings[key] = row.seen;
		queuedAt[key] = now;
		queued.push(row.number);
		enqueue(pending, root, row);
	}
	return { store: { ...store, readings, queuedAt, pending }, queued };
}

/**
 * @param {string} file
 * @param {{root: string, issues: number[]}[]} tried
 * @param {(line: string) => void} log
 */
function dropTried(file, tried, log) {
	const store = readGateStore(file, log);
	const pending = store.pending.filter(
		(j) => !tried.some((t) => t.root === j.root && t.issues.includes(j.number)),
	);
	if (pending.length !== store.pending.length)
		writeJson(file, { ...store, pending });
}

/**
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
 * @param {string} root
 * @param {{env: NodeJS.ProcessEnv, script?: string}} opts
 * @returns {Promise<string|null>}
 */
function runReleaseDue(root, { env, script = RELEASE_DUE }) {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[script],
			{
				cwd: root,
				env: { ...env, WFC_REPO_ROOT: root },
				encoding: "utf8",
				timeout: RELEASE_DUE_TIMEOUT_MS,
			},
			(err, stdout, stderr) => {
				const out = `${stdout}${stderr}`.trim();
				const said = /\b(Filed|Refreshed)\b/.test(out);
				if (!err && !said) return resolve(null);
				resolve(`release-due in ${root}: ${out || err?.message}`);
			},
		);
	});
}

/**
 * @param {{file: string,
 *   runRoot: (root: string) => Promise<{stdout: string} | {error: string}>,
 *   log: (line: string) => void, cadenceMs: number}} deps
 */
function gateSweeper({ file, runRoot, log, cadenceMs }) {
	/** @type {Promise<void>|null} */
	let inFlight = null;

	/** @param {string[]} roots @param {number} now */
	async function sweep(roots, now) {
		for (const root of roots) {
			const r = await runRoot(root);
			const rows = "error" in r ? null : sweptRows(r.stdout);
			if (rows === null) {
				log(
					`gate sweep in ${root}: ${"error" in r ? r.error : "no rows in check-gates.js's envelope"}; readings kept`,
				);
				continue;
			}
			const { store, queued } = withSweep(
				readGateStore(file, log),
				root,
				rows,
				now,
			);
			writeJson(file, store);
			if (queued.length > 0)
				log(
					`gate sweep in ${root}: reading or repair state changed, or an unchecked gate came due, on ${queued.map((n) => `#${n}`).join(", ")}; judgement queued`,
				);
		}
	}

	return {
		busy: () => inFlight !== null,
		/**
		 * @param {string[]} roots
		 * @param {number} now
		 * @returns {Promise<void>|null}
		 */
		startIfDue(roots, now) {
			if (inFlight !== null) return null;
			const store = readGateStore(file, log);
			if (store.lastSweepAt !== null && now - store.lastSweepAt < cadenceMs)
				return null;
			writeJson(file, { ...store, lastSweepAt: now });
			const started = sweep(roots, now).finally(() => {
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
	runReleaseDue,
};
