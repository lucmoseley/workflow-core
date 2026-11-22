const { parseCommand, walkCommands } = require("./shell-parse.js");
const { absolute, literal } = require("./shell-words.js");

/**
 * @typedef {{ abs: string, shown: string, interpreter: string | null,
 *   opts: string[], direct: boolean }} Run
 * @typedef {import("./shell-parse.js").WalkPorts & {
 *   isFile: (abs: string) => boolean }} RunPorts
 * @typedef {{ interpreters: Set<string>,
 *   onUnmatched?: (head: string, rest: string[], spans: string[]) => void }} Routes
 */

const SHELL_NAMES = ["bash", "sh", "zsh", "dash", "ksh"];
const SHELLS = new Set(SHELL_NAMES);

const ARG_OPTS = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);

const WRAPPERS = new Map([
	["timeout", new Set(["-s", "--signal", "-k", "--kill-after"])],
	["env", new Set(["-u", "--unset", "-C", "--chdir", "-S"])],
	["nohup", new Set()],
	["nice", new Set(["-n", "--adjustment"])],
	["command", new Set()],
	["exec", new Set(["-a"])],
	["time", new Set(["-f", "--format", "-o", "--output"])],
	["sudo", new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-U"])],
	["xargs", new Set(["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s"])],
]);

/**
 * @param {string} command
 * @param {RunPorts} ports
 * @param {Routes} routes
 * @returns {Run[]}
 */
function scriptRuns(command, ports, routes) {
	const parsed = parseCommand(command);
	/** @type {Run[]} */
	const out = [];
	walkCommands(
		parsed,
		(segment) => out.push(...segmentRuns(segment, parsed.spans, ports, routes)),
		ports,
	);
	return out;
}

/**
 * @param {string[]} words
 */
function unwrap(words) {
	let i = 0;
	for (
		let opts = WRAPPERS.get(words[0] ?? "");
		opts;
		opts = WRAPPERS.get(words[i] ?? "")
	) {
		i++;
		for (let w = words[i]; w !== undefined; w = words[i]) {
			const operand =
				/^\d+(?:\.\d+)?[smhd]?$/.test(w) || /^[A-Za-z_]\w*=/.test(w);
			if (!operand && !w.startsWith("-")) break;
			i += opts.has(w) ? 2 : 1;
		}
	}
	return words.slice(i);
}

/**
 * @param {string[]} words
 * @param {boolean} shell
 * @returns {{ inline: string } | { opts: string[], operands: string[] }}
 */
function interpreterArgs(words, shell) {
	/** @type {string[]} */
	const opts = [];
	let i = 0;
	for (let w = words[i]; w !== undefined; w = words[++i]) {
		if (shell && /^-[a-bd-zA-Z]*c[a-zA-Z]*$/.test(w))
			return { inline: words[i + 1] ?? "" };
		if (w === "--") return { opts, operands: words.slice(i + 1) };
		if (!/^[-+]/.test(w)) break;
		opts.push(w);
		if (shell && ARG_OPTS.has(w)) opts.push(words[++i] ?? "");
	}
	const operands = words
		.slice(i)
		.filter((w, j) => j === 0 || !w.startsWith("-"));
	return { opts, operands };
}

/** @typedef {(word: string | undefined) => { abs: string, shown: string } | null} FileOf */

/**
 * @param {string} name
 * @param {string[]} rest
 * @param {{ file: FileOf, spans: string[], ports: RunPorts, routes: Routes,
 *   redirects: () => import("./shell-parse.js").Redirect[] }} segment
 * @returns {Run[]}
 */
function interpreterRuns(
	name,
	rest,
	{ file, spans, ports, routes, redirects },
) {
	const shell = SHELLS.has(name);
	const args = interpreterArgs(rest, shell);
	if ("inline" in args) {
		const text = literal(args.inline, spans);
		return text.known ? scriptRuns(text.text, ports, routes) : [];
	}
	const scanned = shell ? args.operands.slice(0, 1) : args.operands;
	let found = scanned.map(file).find((f) => f !== null) ?? null;
	if (args.operands.length === 0) {
		const input = redirects().find((r) => r.kind === "read" && r.path);
		if (input && ports.isFile(input.path))
			found = { abs: input.path, shown: input.target };
	}
	return found
		? [{ ...found, interpreter: name, opts: args.opts, direct: false }]
		: [];
}

/**
 * @param {{ words: string[], cwd?: unknown,
 *   redirects: () => import("./shell-parse.js").Redirect[] }} segment
 * @param {string[]} spans
 * @param {RunPorts} ports
 * @param {Routes} routes
 * @returns {Run[]}
 */
function segmentRuns({ words, cwd, redirects }, spans, ports, routes) {
	const [first = "", ...rest] = unwrap(words);
	const head = literal(first, spans);
	if (!head.known) return [];
	const base = typeof cwd === "string" && cwd ? cwd : ports.fallbackCwd;
	/** @type {FileOf} */
	const file = (word) => {
		const lit = literal(word ?? "", spans);
		if (!lit.known || !lit.text) return null;
		const abs = absolute(lit.text, base);
		return ports.isFile(abs) ? { abs, shown: lit.text } : null;
	};
	const name = head.text.slice(head.text.lastIndexOf("/") + 1);
	if (routes.interpreters.has(name))
		return interpreterRuns(name, rest, {
			file,
			spans,
			ports,
			routes,
			redirects,
		});
	if (name === "source" || name === ".") {
		const found = file(rest[0]);
		return found
			? [{ ...found, interpreter: name, opts: [], direct: false }]
			: [];
	}
	const found = head.text.includes("/") ? file(first) : null;
	if (found) return [{ ...found, interpreter: null, opts: [], direct: true }];
	routes.onUnmatched?.(head.text, rest, spans);
	return [];
}

module.exports = { scriptRuns, SHELL_NAMES, SHELLS };
