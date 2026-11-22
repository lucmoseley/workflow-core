const cp = require("node:child_process");
const fs = require("node:fs");
const mod = require("node:module");
const { ignoreFailure } = require("../lib/caught.js");

const FORK_WORKER_DEPTH = 2;
const ARGS_KEPT = 5;
const ARG_CHARS_KEPT = 120;

const depth = Number(process.env.WFC_GUARD_SHARE_DEPTH || 0);
process.env.WFC_GUARD_SHARE_DEPTH = String(depth + 1);
const OUT = process.env.WFC_GUARD_SHARE_OUT;

/** @param {Record<string, unknown>} entry */
const log = (entry) => {
	ignoreFailure(() =>
		fs.appendFileSync(
			/** @type {string} */ (OUT),
			`${JSON.stringify(entry)}\n`,
		),
	);
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
			child.once("exit", finish);
			child.once("error", finish);
			return child;
		};
	}
	mod.syncBuiltinESMExports();
	log({ kind: "start", pid: process.pid });
	process.on("exit", () => log({ kind: "end", pid: process.pid }));
}
