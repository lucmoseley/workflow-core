/*
 * preload.js — times every child_process call one vitest fork worker makes,
 * the call-log half of the guard-share instrument (#2202, #2783). Given by
 * `NODE_OPTIONS=--require`; `guard_share.py` launches it and sums the log.
 *
 * IT JOINS NO FAMILY (§N3): it gates nothing (no `check-*`), is no hook (no
 * `guard-*`) and writes no tracked file (no `generate-*`); it is a preload,
 * not a program, and has no exit of its own.
 *
 * Only the fork worker logs: `run-vitest.js` is depth 0, vitest depth 1, its
 * fork worker depth 2. Child Node processes the tests start do not log, so a
 * guard's own children are inside its call's wall.
 *
 * `syncBuiltinESMExports()` is what lets an ESM test file's named
 * `import { spawnSync }` see the wrapper; without it only `require` callers do.
 */

const cp = require("node:child_process");
const fs = require("node:fs");
const mod = require("node:module");

const FORK_WORKER_DEPTH = 2;
// Enough of argv to tell `bash <script>` and `git <subcommand>` apart in the
// log; the class needs no more (`guard_share.py classify`).
const ARGS_KEPT = 5;
const ARG_CHARS_KEPT = 120;

const depth = Number(process.env.WFC_GUARD_SHARE_DEPTH || 0);
process.env.WFC_GUARD_SHARE_DEPTH = String(depth + 1);
const OUT = process.env.WFC_GUARD_SHARE_OUT;

/** @param {Record<string, unknown>} entry */
const log = (entry) => {
	try {
		fs.appendFileSync(
			/** @type {string} */ (OUT),
			`${JSON.stringify(entry)}\n`,
		);
	} catch {
		// A lost line costs one record; a throw would fail the test under
		// measure (#2783).
	}
};

/**
 * @param {string} kind
 * @param {unknown} file
 * @param {unknown} args
 * @param {bigint} start
 */
const record = (kind, file, args, start) =>
	log({
		kind,
		file: String(file),
		args: (Array.isArray(args) ? args : [])
			.slice(0, ARGS_KEPT)
			.map((x) => String(x).slice(0, ARG_CHARS_KEPT)),
		ms: Number(process.hrtime.bigint() - start) / 1e6,
	});

if (OUT && depth === FORK_WORKER_DEPTH) {
	/** @type {Record<"spawnSync" | "execFileSync" | "execSync" | "spawn" | "execFile" | "exec", Function>} */
	const api = /** @type {any} */ (cp);
	for (const name of /** @type {const} */ ([
		"spawnSync",
		"execFileSync",
		"execSync",
	])) {
		const orig = api[name];
		/** @param {unknown} file @param {unknown} args @param {...unknown} rest */
		api[name] = function (file, args, ...rest) {
			const start = process.hrtime.bigint();
			try {
				return orig.call(this, file, args, ...rest);
			} finally {
				record(name, file, args, start);
			}
		};
	}
	for (const name of /** @type {const} */ (["spawn", "execFile", "exec"])) {
		const orig = api[name];
		/** @param {unknown} file @param {unknown} args @param {...unknown} rest */
		api[name] = function (file, args, ...rest) {
			const start = process.hrtime.bigint();
			const child = orig.call(this, file, args, ...rest);
			let done = false;
			const finish = () => {
				if (!done) record(name, file, args, start);
				done = true;
			};
			// A child that fails to start emits `error` and never `exit`.
			child.once("exit", finish);
			child.once("error", finish);
			return child;
		};
	}
	mod.syncBuiltinESMExports();
	// The proof the fork worker was instrumented: a log with no `start` is a
	// preload that never loaded, never a file with no guard calls.
	log({ kind: "start", pid: process.pid });
	process.on("exit", () => log({ kind: "end", pid: process.pid }));
}
