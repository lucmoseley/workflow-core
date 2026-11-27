const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { withoutLateEpipe } = require("./child-failure.js");
const { relativeUnder } = require("./is-under.js");
const { splitRunArgv } = require("./run-budgeted-argv.js");
const { runInProcess, runInProcessAsync } = require("./run-in-process.js");
const { shellQuote } = require("./sh-quote.js");

/** @typedef {import("./run-in-process.js").RunOptions} RunOptions */
/** @typedef {import("./run-in-process.js").RunResult} RunResult */

/**
 * @typedef {object} CostOptions
 * @property {number} [expectStatus]
 * @property {boolean} [allowStderr]
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

/** @param {string} script */
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
 * @param {string} route
 * @param {unknown[]} argv
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
 * @param {string[]} children
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

/** @param {string} root */
function loadedUnder(root) {
	return Object.keys(require.cache)
		.filter((k) => !k.includes(NODE_MODULES) && !HARNESS.has(k))
		.flatMap((k) => relativeUnder(root, k) || [])
		.sort();
}

/**
 * @param {string} label
 * @param {{ status: number, stdout: string, stderr: string }} r
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
	const root = scriptsRootOf(script);
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
const RUN_BUDGETED_NAME = "run-budgeted.js";
const INNER = "WFC_CALL_COST_INNER";

/**
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
 * @param {string} name
 * @param {string[]} args
 * @param {string} root
 * @param {string} cwd
 * @returns {string}
 */
function shellChildOf(name, args, root, cwd) {
	const [first, ...rest] = args;
	if (!first) return name;
	const shown = `${name} ${shownArg(first, root, cwd)}`;
	if (name !== "node" || path.basename(first) !== RUN_BUDGETED_NAME)
		return shown;
	const { command, args: wrapped } = splitRunArgv(rest);
	return command
		? `${shown} ${shellChildOf(path.basename(command), wrapped, root, cwd)}`
		: shown;
}

/** @param {string} log */
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
 * @property {Record<string, string | undefined>} [env]
 * @property {string} [stdin]
 * @property {string[]} [watch]
 * @property {number} [expectStatus]
 * @property {boolean} [allowStderr]
 * @typedef {{ status: number, stdout: string, stderr: string, children: string[] }} ShellCostResult
 */

/**
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
		const r = withoutLateEpipe(
			childProcess.spawnSync("sh", [script, ...args], {
				cwd,
				env: { ...env, PATH: `${shims}${path.delimiter}${realPath}` },
				input: options.stdin ?? "",
				encoding: "utf8",
			}),
		);
		if (r.error) throw r.error;
		const result = {
			status: r.status ?? 1,
			stdout: r.stdout,
			stderr: r.stderr,
		};
		const root = scriptsRootOf(script);
		refuseBroken(path.relative(root, script), result, options);
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
