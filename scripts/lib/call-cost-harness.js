/*
 * call-cost-harness.js — what one call of a hot-path program costs: the repo
 * modules it loads and the child processes it starts (base §G13 (5), #5335).
 *
 * FOR TESTS ONLY, as lib/run-in-process.js is. A pin asserts both lists with
 * exact equality, so any growth fails the run naming what grew; no timing
 * figure is ever read (mantahostels#2255).
 *
 *   callCost / callCostAsync  a Node program, run in-process through
 *       runInProcess / runInProcessAsync with their options unchanged.
 *   shellCallCost             a shell program, run as a real process with a
 *       recording shim first on PATH for each watched binary.
 *   call_cost (call_cost_harness.py)  the Python half, for pytest.
 *
 * A child is recorded as the executable's basename and its first argument,
 * joined by a space: `git rev-parse`, `node precommit-dispatch.js`. An
 * absolute first argument is shown relative to the scripts root, else to the
 * call's cwd, else as its basename, so a pin holds no machine path. The shell
 * half records a `node run-budgeted.js` start as the command run-budgeted.js
 * runs, so a hook's bounded checker shows by its own name (#5361).
 *
 * Every call throws where the program exits other than `expectStatus`
 * (default 0) or writes stderr without `allowStderr`: a pin over a broken
 * call is not a pin over the common path.
 *
 * BLIND SPOT (Node): children are counted by replacing each process-starting
 * function on the shared `node:child_process` export for the call's duration.
 * runInProcess purges repo modules before the call, so a repo module that
 * destructures a starter at load binds the recorder; a node_modules package
 * cached before the call that bound one earlier is not seen.
 *
 * BLIND SPOT (shell): only watched binaries started by the program itself are
 * recorded — a shim marks the environment it hands on, so a node child's own
 * `git` call is that child's cost, pinned by its own Node pin.
 */

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { relativeUnder } = require("./is-under.js");
const { parseRun, RUN_BUDGETED } = require("./run-budgeted.js");
const { runInProcess, runInProcessAsync } = require("./run-in-process.js");
const { shellQuote } = require("./sh-quote.js");

/** @typedef {import("./run-in-process.js").RunOptions} RunOptions */
/** @typedef {import("./run-in-process.js").RunResult} RunResult */

/**
 * @typedef {object} CostOptions
 * @property {number} [expectStatus] the exit the call must end on (default 0)
 * @property {boolean} [allowStderr] whether stderr may carry text
 * @property {string} [root] the directory `modules` is relative to and
 *           filtered by (default: the program's nearest `scripts` ancestor)
 *
 * @typedef {RunResult & { modules: string[], children: string[] }} CostResult
 */

const STARTERS = /** @type {const} */ ([
	"spawn",
	"spawnSync",
	"exec",
	"execSync",
	"execFile",
	"execFileSync",
	"fork",
]);

const HARNESS = new Set([
	path.join(__dirname, "run-in-process.js"),
	__filename,
]);

const NODE_MODULES = `${path.sep}node_modules${path.sep}`;

/**
 * The nearest ancestor of `script` named `scripts`, or its own directory.
 *
 * @param {string} script
 */
function scriptsRootOf(script) {
	let dir = path.dirname(script);
	for (;;) {
		if (path.basename(dir) === "scripts") return dir;
		const up = path.dirname(dir);
		if (up === dir) return path.dirname(script);
		dir = up;
	}
}

/**
 * @param {string} arg
 * @param {string} root
 * @param {string} cwd
 */
function shownArg(arg, root, cwd) {
	if (!path.isAbsolute(arg)) return arg;
	for (const base of [root, cwd]) {
		const rel = relativeUnder(base, arg);
		if (rel) return rel;
	}
	return path.basename(arg);
}

/**
 * One child as `basename firstArg`. A shell-string start (exec, execSync, or
 * a spawn with no argv) is split on whitespace.
 *
 * @param {string} route
 * @param {unknown[]} argv the starter's own arguments
 * @param {string} root
 * @param {string} cwd
 */
function childOf(route, argv, root, cwd) {
	const [command, rest] = argv;
	let file = String(command);
	/** @type {unknown} */
	let first;
	if (route === "fork") {
		first = file;
		file = process.execPath;
	} else if (Array.isArray(rest)) {
		first = rest[0];
	} else {
		const [head = "", next] = file
			.trim()
			.split(/\s+/)
			.map((token) => token.replace(/^(["'])(.*)\1$/, "$2"));
		file = head;
		first = next;
	}
	const name = path.basename(file);
	return first === undefined
		? name
		: `${name} ${shownArg(String(first), root, cwd)}`;
}

/**
 * Replaces every starter on `node:child_process` with a recorder that
 * forwards to the original, and returns the function putting them back.
 *
 * @param {string[]} children accumulator: each start is pushed here, in order
 * @param {string} root
 * @param {string} cwd
 */
function recordStarts(children, root, cwd) {
	const cp = /** @type {Record<string, Function>} */ (
		/** @type {unknown} */ (childProcess)
	);
	const saved = new Map(
		STARTERS.map((route) => [route, /** @type {Function} */ (cp[route])]),
	);
	/* Node's exec starts through the exported execFile, so a start made
	 * inside another starter is that starter's own. */
	let depth = 0;
	/**
	 * @param {string} route
	 * @param {Function} forward
	 */
	const recording =
		(route, forward) =>
		(/** @type {unknown[]} */ ...argv) => {
			if (depth === 0) children.push(childOf(route, argv, root, cwd));
			depth++;
			try {
				return forward.apply(childProcess, argv);
			} finally {
				depth--;
			}
		};
	for (const [route, original] of saved) {
		const recorder = recording(route, original);
		const custom = /** @type {Record<symbol, unknown>} */ (
			/** @type {unknown} */ (original)
		)[promisify.custom];
		if (typeof custom === "function")
			Object.defineProperty(recorder, promisify.custom, {
				value: recording(route, custom),
			});
		cp[route] = recorder;
	}
	return () => {
		for (const [route, original] of saved) cp[route] = original;
	};
}

/**
 * The repo modules under `root` left in require.cache, harness and
 * node_modules aside, relative and sorted.
 *
 * @param {string} root
 */
function loadedUnder(root) {
	return Object.keys(require.cache)
		.filter((k) => !k.includes(NODE_MODULES) && !HARNESS.has(k))
		.flatMap((k) => relativeUnder(root, k) || [])
		.sort();
}

/**
 * @param {string} label
 * @param {RunResult} r
 * @param {CostOptions} options
 */
function refuseBroken(label, r, options) {
	const expected = options.expectStatus ?? 0;
	const problems = [];
	if (r.status !== expected)
		problems.push(`exited ${r.status}, not ${expected}`);
	if (r.stderr !== "" && !options.allowStderr) problems.push("wrote to stderr");
	if (problems.length > 0)
		throw new Error(
			`callCost: ${label} ${problems.join(" and ")}, so this is no pin of ` +
				`its common path.\n--- stderr ---\n${r.stderr}--- stdout ---\n${r.stdout}`,
		);
}

/**
 * @param {string} scriptPath
 * @param {RunOptions & CostOptions} options
 */
function setUp(scriptPath, options) {
	const script = path.resolve(scriptPath);
	const root = options.root ?? scriptsRootOf(script);
	/** @type {string[]} */
	const children = [];
	const restore = recordStarts(children, root, options.cwd ?? process.cwd());
	return { script, root, children, restore };
}

/**
 * @param {string} scriptPath
 * @param {string[]} [args]
 * @param {RunOptions & CostOptions} [options]
 * @returns {CostResult}
 */
function callCost(scriptPath, args = [], options = {}) {
	const { script, root, children, restore } = setUp(scriptPath, options);
	/** @type {RunResult} */
	let r;
	try {
		r = runInProcess(script, args, options);
	} finally {
		restore();
	}
	refuseBroken(path.relative(root, script), r, options);
	return { ...r, modules: loadedUnder(root), children };
}

/**
 * @param {string} scriptPath
 * @param {string[]} [args]
 * @param {RunOptions & CostOptions} [options]
 * @returns {Promise<CostResult>}
 */
async function callCostAsync(scriptPath, args = [], options = {}) {
	const { script, root, children, restore } = setUp(scriptPath, options);
	/** @type {RunResult} */
	let r;
	try {
		r = await runInProcessAsync(script, args, options);
	} finally {
		restore();
	}
	refuseBroken(path.relative(root, script), r, options);
	return { ...r, modules: loadedUnder(root), children };
}

const WATCHED = ["node", "python3", "git", "gh"];
const RUNNER = path.basename(RUN_BUDGETED);
const INNER = "WFC_CALL_COST_INNER";

/**
 * Where `name` resolves on `PATH`, or null.
 *
 * @param {string} name
 * @param {string} pathVar
 */
function which(name, pathVar) {
	for (const dir of pathVar.split(path.delimiter)) {
		const candidate = path.join(dir, name);
		if (dir && isExecutable(candidate)) return candidate;
	}
	return null;
}

/** @param {string} file */
function isExecutable(file) {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * One shim-recorded start as `basename firstArg`, a `node run-budgeted.js`
 * start as the command it wraps.
 *
 * @param {string} name
 * @param {string[]} args
 * @param {string} root
 * @param {string} cwd
 * @returns {string}
 */
function shellChildOf(name, args, root, cwd) {
	const [first, ...rest] = args;
	if (name === "node" && first && path.basename(first) === RUNNER) {
		const run = parseRun(rest);
		if (run.command)
			return shellChildOf(path.basename(run.command), run.args, root, cwd);
	}
	return first ? `${name} ${shownArg(first, root, cwd)}` : name;
}

/**
 * The shim log's starts: each a count, the binary, then that many arguments,
 * every field NUL-terminated so an argument may hold any other byte.
 *
 * @param {string} log
 */
function* loggedStarts(log) {
	const fields = log.split("\0");
	for (let i = 0; i + 1 < fields.length; ) {
		const count = Number(fields[i]);
		yield {
			name: fields[i + 1] ?? "",
			args: fields.slice(i + 2, i + 2 + count),
		};
		i += 2 + count;
	}
}

/**
 * @typedef {object} ShellOptions
 * @property {string} [cwd]
 * @property {Record<string, string | undefined>} [env] full environment
 * @property {string} [stdin]
 * @property {string[]} [watch] binaries beyond node, python3, git and gh
 * @property {string} [shell] the interpreter (default `sh`)
 * @property {number} [expectStatus]
 * @property {boolean} [allowStderr]
 *
 * @typedef {{ status: number, stdout: string, stderr: string, children: string[] }} ShellCostResult
 */

/**
 * Runs a shell program as a real process with a forwarding shim per watched
 * binary first on PATH, and returns its exit, output and the watched
 * binaries it started, in order.
 *
 * @param {string} scriptPath
 * @param {string[]} [args]
 * @param {ShellOptions} [options]
 * @returns {ShellCostResult}
 */
function shellCallCost(scriptPath, args = [], options = {}) {
	const script = path.resolve(scriptPath);
	const cwd = options.cwd ?? process.cwd();
	const env = { ...(options.env ?? process.env) };
	delete env[INNER];
	const realPath = env.PATH ?? "";
	const shims = fs.mkdtempSync(path.join(os.tmpdir(), "call-cost-shims-"));
	const log = path.join(shims, "starts.log");
	try {
		fs.writeFileSync(log, "");
		for (const name of [...WATCHED, ...(options.watch ?? [])]) {
			const real = which(name, realPath);
			if (!real) continue;
			fs.writeFileSync(
				path.join(shims, name),
				[
					"#!/bin/sh",
					`if [ -z "\${${INNER}:-}" ]; then`,
					`  printf '%s\\0' "$#" ${shellQuote(name)} "$@" >>${shellQuote(log)}`,
					`  ${INNER}=1`,
					`  export ${INNER}`,
					"fi",
					`exec ${shellQuote(real)} "$@"`,
					"",
				].join("\n"),
				{ mode: 0o755 },
			);
		}
		const r = childProcess.spawnSync(options.shell ?? "sh", [script, ...args], {
			cwd,
			env: { ...env, PATH: `${shims}${path.delimiter}${realPath}` },
			input: options.stdin ?? "",
			encoding: "utf8",
		});
		if (r.error) throw r.error;
		const result = {
			status: r.status ?? 1,
			stdout: r.stdout,
			stderr: r.stderr,
		};
		const root = scriptsRootOf(script);
		refuseBroken(
			path.relative(root, script),
			{ ...result, restoreFailures: [] },
			options,
		);
		const children = Array.from(
			loggedStarts(fs.readFileSync(log, "utf8")),
			(start) => shellChildOf(start.name, start.args, root, cwd),
		);
		return { ...result, children };
	} finally {
		fs.rmSync(shims, { recursive: true, force: true });
	}
}

module.exports = { callCost, callCostAsync, shellCallCost };
