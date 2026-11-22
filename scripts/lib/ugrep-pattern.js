const { parseCommand, walkCommands } = require("./shell-parse.js");
const { literal, scanFlags } = require("./shell-words.js");

const LATCH = "ugrep-pattern";

const UGREP_VALUE_FLAGS =
	"-A -B -C -D -J -K -M -N -O -d -e -f -g -m -t --regexp --file --max-count --after-context --before-context --context --directories --devices --jobs --range --file-magic --neg-regexp --file-extension --file-type --glob --iglob --include --exclude --exclude-dir --exclude-from --include-dir --include-from --binary-files --and --andnot --not";

const GNU_HANDOFF =
	/^(?:-[\s\S]*-(?:filter|pager|view|format-open|config)|---|-@|-[Zz]|-[^-][\s\S]*[Zz]|--null$|--null-data$)/;

const ERE_REPEAT = /(?:^|[^\\])\{(?:[0-9]+,[0-9]*|,[0-9]+)\}/;
const BRE_REPEAT = /\\\{(?:[0-9]+,[0-9]*|,[0-9]+)\\\}/;

const MODE_FLAGS = new Map([
	["-P", "perl"],
	["--perl-regexp", "perl"],
	["-F", "fixed"],
	["--fixed-strings", "fixed"],
	["-E", "ere"],
	["--extended-regexp", "ere"],
	["-G", "bre"],
	["--basic-regexp", "bre"],
]);

const PATTERN_OPTS = ["-e", "--regexp", "--and", "--andnot", "--not"];
const FILE_OPTS = ["-f", "--file"];

const NOTE_HEAD =
	'`grep` here is Claude Code\'s bundled ugrep, and a bounded repeat in its pattern — `.{0,80}`, say — can make it refuse the pattern with `exceeds complexity limits` or stall on a long line (#1021). A refused pattern exits 2, not 1: exit 2 is no verdict, never "no match".';
const NOTE_SILENCED =
	" This command discards stderr, which is what hides the refusal.";
const NOTE_TAIL =
	"\n\nRe-spell it as the same command with `-P` in place of `-E`, or added where there is neither, every other flag kept and the backslashes taken off a `\\{N,M\\}`. A pattern of literals, `.`, bracket classes and bounded repeats prints what the refused command would have; an alternation, or a basic-mode `( ) | + ?`, can match differently under `-P`. Or use `rg` or python. Warned once a session; docs/agents/tool-output.md.";

/**
 * @typedef {import("./kit-context.js").KitContext} UgrepContext
 * @typedef {import("./guard-entry.js").Decision} Decision
 * @typedef {import("./shell-parse.js").Command} Command
 * @typedef {import("./shell-parse.js").Redirect} Redirect
 * @typedef {{ fires: boolean, silenced: boolean }} Verdict
 */

/**
 * @param {string} command
 * @param {UgrepContext} ctx
 * @returns {Decision}
 */
function decide(command, ctx) {
	if (ctx.told(LATCH)) return null;
	const parsed = parseCommand(command);
	/** @type {Verdict} */
	const verdict = { fires: false, silenced: false };
	walkCommands(
		parsed,
		(cmd) => {
			if (!judge(cmd.words, parsed.spans)) return;
			verdict.fires = true;
			if (silencesStderr(cmd.redirects())) verdict.silenced = true;
		},
		ctx,
	);
	if (!verdict.fires) return null;
	return {
		injectRules: [],
		prelude: ctx.corePaths(note(verdict.silenced)),
		latchAfter: LATCH,
	};
}

/**
 * @param {boolean} silenced
 */
const note = (silenced) =>
	`${NOTE_HEAD}${silenced ? NOTE_SILENCED : ""}${NOTE_TAIL}`;

/** @param {string[]} words @param {string[]} spans */
function judge(words, spans) {
	const [head, ...args] = words;
	if (literal(head ?? "", spans).text !== "grep") return false;
	if (args.some((w) => handsOff(w, spans))) return false;
	const scan = scanPatterns(args);
	if (scan.mode.has("perl") || scan.mode.has("fixed")) return false;
	const repeat = scan.ere ? ERE_REPEAT : BRE_REPEAT;
	return scan.patterns.some((p) => {
		const { text, known } = literal(p, spans);
		return known && repeat.test(text);
	});
}

/** @param {string} word @param {string[]} spans */
function handsOff(word, spans) {
	const { text, known } = literal(word, spans);
	return known && GNU_HANDOFF.test(text);
}

/** @param {string[]} args */
function scanPatterns(args) {
	/** @type {Set<string>} */
	const mode = new Set();
	let ere = false;
	let byFlag = false;
	/** @type {string[]} */
	const patterns = [];
	/** @type {string[]} */
	const bare = [];
	scanFlags(UGREP_VALUE_FLAGS, args, (kind, name, value) => {
		if (kind === "flag") {
			const m = MODE_FLAGS.get(name);
			if (m) mode.add(m);
			if (m === "ere" || m === "bre") ere = m === "ere";
		} else if (kind === "arg") bare.push(value);
		else if (kind === "opt") byFlag = takeOpt(name, value, patterns) || byFlag;
	});
	if (!byFlag && bare.length > 0) patterns.push(bare[0] ?? "");
	return { mode, ere, patterns };
}

/** @param {string} name @param {string} value @param {string[]} patterns */
function takeOpt(name, value, patterns) {
	if (PATTERN_OPTS.includes(name)) patterns.push(value);
	return PATTERN_OPTS.includes(name) || FILE_OPTS.includes(name);
}

/** @param {Redirect[]} redirects */
function silencesStderr(redirects) {
	let silenced = false;
	let nullOut = false;
	for (const r of redirects) {
		const writes = r.kind === "truncate" || r.kind === "append";
		if (r.fd === "1") nullOut = writes && r.path === "/dev/null";
		else if (discardsStderr(r, writes, nullOut)) silenced = true;
	}
	return silenced;
}

/** @param {Redirect} r @param {boolean} writes @param {boolean} nullOut */
function discardsStderr({ fd, kind, path, target }, writes, nullOut) {
	if ((fd === "&" || fd === "2") && writes && path === "/dev/null") return true;
	if (fd !== "2") return false;
	return kind === "close" || (kind === "copy" && nullOut && target === "1");
}

module.exports = { field: "command", noun: "command", decide };
