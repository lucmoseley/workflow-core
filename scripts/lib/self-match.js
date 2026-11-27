const { denyText } = require("./guard-verdict.js");
const { parseCommand, unmask, walkCommands } = require("./shell-parse.js");
const { literal, scanFlags } = require("./shell-words.js");
const { compileEre } = require("./posix-ere.js");
const { SHELL_NAME, pgrepSelects, readPgrepArgs } = require("./pgrep-args.js");

/**
 * @typedef {import("./core-contract.js").CoreContext} CoreContext
 * @typedef {import("./core-contract.js").CoreDecision} CoreDecision
 * @typedef {import("./shell-parse.js").Command} Command
 * @typedef {"line" | "name" | "inverted"} Kind
 * @typedef {{ segment: string, cmd: string, kind: Kind, pattern: string,
 *   mode: string }} Finding
 */

const PS_GREP = /** @type {RegExp} */ (
	compileEre(
		"(^|[;&|(!{\n]|\\b(while|until|if|elif|then|else|do)[[:space:]])[[:space:]]*ps([[:space:]]+[A-Za-z0-9_.,:=+*/-]+)*[[:space:]]*\\|[[:space:]]*[ef]?grep\\b",
	)
);

const COMM_PATH = /** @type {RegExp} */ (compileEre("/comm([^[:alnum:]_]|$)"));

// GNU grep's options that take a value (https://www.gnu.org/software/grep/manual/grep.html)
const GREP_VALUE_FLAGS =
	"-e -f -m -A -B -C -d -D --regexp --file --max-count --after-context --before-context --context --label --binary-files --devices --directories --exclude --include --exclude-dir --exclude-from --group-separator";

const GREP_COMMAND_MODES = /** @type {Record<string, string>} */ ({
	egrep: "E",
	fgrep: "F",
});

const GREP_FLAG_MODES = /** @type {Record<string, string>} */ ({
	"flag:-E": "E",
	"flag:--extended-regexp": "E",
	"flag:-F": "F",
	"flag:--fixed-strings": "F",
	"flag:-G": "B",
	"flag:--basic-regexp": "B",
});

const GREP_UNSURE = new Set([
	"opt:-f",
	"opt:--file",
	"flag:-v",
	"flag:--invert-match",
	"flag:-P",
	"flag:--perl-regexp",
]);

const GREP_ICASE = new Set(["flag:-i", "flag:-y", "flag:--ignore-case"]);

const PID_RECIPE =
	"Match on a pid you captured instead: run the thing in the background, keep its pid (`cmd & echo $! > pidfile`) or read it once from `ps`, then act on that number.";
const RECIPE = `${PID_RECIPE} Where a pattern is genuinely wanted, bracket its first character (\`'[n]ode'\`) so it cannot match its own text, pass \`-A\` to spare this shell and its ancestors, or exclude this shell — $$ or $PPID — and the guard stays out of the way.`;
const NAME_RECIPE = `${PID_RECIPE} Where a name is genuinely wanted, use one \`bash\` does not match, or pass \`-A\` to spare this shell and its ancestors.`;
const INVERTED_HAZARD =
	"selects every process its pattern misses: the harness and nearly everything else, and the shell running it wherever the pattern misses that shell's command line, or without `-f` its name, `bash`. Bracketing the pattern does not escape it — a pattern that misses its own text puts the shell in.";

const PS_GREP_WARNING = `\`ps | grep\` self-matches the shell running it: the Bash tool runs this command line as that shell's own argv, so the pattern is in it — and checking a background job's liveness this way has an extra failure of its own: the harness's own task id for a \`run_in_background\` job (the short id its tool result names) is never in any process's actual command line, so grepping for THAT specific id finds nothing even while the job runs. \`grep -v grep\`, meant to hide the searching grep's self-match, makes it worse: it silently drops a real match too whenever the target's own command line contains the word "grep" — which a liveness-polling loop's usually does.

Check liveness off the job's own completion notification, its output file, or the session's own shell counter — a harness task id is not a process-search pattern. Where a process search is genuinely wanted, bracket the pattern's first character (\`grep '[n]ode'\`) so it cannot match its own text, and the guard stays out of the way. \`docs/agents/verification.md\`'s "Asserting that nothing of yours is still running" has the full rule.`;

/** @param {string} w */
const base = (w) => w.slice(w.lastIndexOf("/") + 1);

/** @param {string} glob */
const caseGlob = (glob) =>
	new RegExp(
		`^${glob
			.replace(/[.+^${}()|\\]/g, "\\$&")
			.replace(/\*/g, "[\\s\\S]*")
			.replace(/\?/g, "[\\s\\S]")
			.replace(/\[!/g, "[^")}$`,
	);

const PS_ARMS = /** @type {const} */ ([
	["-C:*", "named"],
	[
		"-p:*|-u:*|-U:*|-g:*|-G:*|-t:*|-s:*|-q:*|--sort:*|--pid:*|--ppid:*|--user:*|--tty:*",
		"skip",
	],
	["-o:*|o:*|--format:*|-*o:*|[a-zA-Z]*o:*", "fields"],
	["*:-C?*", "named"],
	["*:--format=*", "format="],
	["*:-o?*", "-o"],
	["*:-O*|*:O*|*:-[!-]*[fF]*|*:[!-]*", "formatted"],
]).map(([globs, arm]) => ({ re: globs.split("|").map(caseGlob), arm }));

/**
 * @param {string} pattern
 * @param {string} mode
 * @param {string} subject
 */
function couldMatch(pattern, mode, subject) {
	const kind = mode.charAt(0);
	const icase = mode.charAt(1) === "1";
	return pattern
		.split("\n")
		.some((line) => lineCouldMatch(line, kind, icase, subject));
}

/**
 * @param {string} line
 * @param {string} kind
 * @param {boolean} icase
 * @param {string} subject
 */
function lineCouldMatch(line, kind, icase, subject) {
	if (line === "") return true;
	if (kind === "F") {
		const hay = icase ? subject.toLowerCase() : subject;
		return hay.includes(icase ? line.toLowerCase() : line);
	}
	if (kind === "B" && breDiffers(line)) return true;
	const re = compileEre(line, { icase });
	return re === null || re.test(subject);
}

/** @param {string} line */
const breDiffers = (line) =>
	/[\\+?|(){}]/.test(line) ||
	line.startsWith("*") ||
	line.slice(1).includes("^") ||
	line.replace(/\$$/, "").includes("$");

/** @param {string} whole */
function newState(whole) {
	const namesShell = whole.includes("$$") || whole.includes("$PPID");
	const psPiped = !namesShell && PS_GREP.test(whole);
	return {
		whole,
		namesShell,
		claudeNamed: whole.toLowerCase().includes("laude"),
		psPiped,
		wantArgv: psPiped || whole.includes("pgrep") || whole.includes("pkill"),
		commCount: false,
		/** @type {Finding[]} */
		found: [],
		afterPs: false,
		psGreps: 0,
		psGrepUnsure: false,
		/** @type {{ pattern: string, mode: string }[]} */
		grepPatterns: [],
		argvText: "",
	};
}

/** @typedef {ReturnType<typeof newState>} State */

/**
 * @param {State} st
 * @param {string} cmd
 * @param {string[]} args
 * @param {string[]} spans
 */
function judgeGrep(st, cmd, args, spans) {
	let mode = GREP_COMMAND_MODES[cmd] ?? "B";
	let icase = 0;
	let unsure = false;
	let first = "";
	let firstSet = false;
	/** @type {string[]} */
	const patterns = [];
	scanFlags(GREP_VALUE_FLAGS, args, (kind, name, value) => {
		const key = `${kind}:${name}`;
		if (key === "opt:-e" || key === "opt:--regexp") patterns.push(value);
		else if (GREP_UNSURE.has(key) || kind === "dangling") unsure = true;
		else if (key in GREP_FLAG_MODES) mode = GREP_FLAG_MODES[key] ?? mode;
		else if (GREP_ICASE.has(key)) icase = 1;
		else if (kind === "arg" && !firstSet) {
			first = value;
			firstSet = value !== "";
		}
	});
	if (patterns.length === 0) patterns.push(first);
	st.psGreps++;
	for (const p of patterns) {
		const lit = literal(p, spans);
		if (unsure || p === "" || !lit.known) {
			st.psGrepUnsure = true;
			return;
		}
		st.grepPatterns.push({ pattern: lit.text, mode: `${mode}${icase}` });
	}
}

/**
 * @param {string[]} args
 * @param {string[]} spans
 */
function psCountsComm(args, spans) {
	const f = readPsFormat(args, spans);
	if (f.named) return true;
	if (f.fields === "" && !f.formatted) return true;
	let hasComm = false;
	for (const raw of f.fields.split(/[, \t]/)) {
		const field = (raw.split("=")[0] ?? "").split(":")[0] ?? "";
		if (["comm", "ucomm", "ucmd", "fname"].includes(field)) hasComm = true;
		else if (["args", "cmd", "command"].includes(field)) return false;
	}
	return hasComm;
}

/**
 * @param {string[]} args
 * @param {string[]} spans
 */
function readPsFormat(args, spans) {
	const f = { prev: "", fields: "", formatted: false, named: false };
	for (const word of args) {
		const lit = literal(word, spans);
		if (lit.known) takePsWord(f, lit.text);
		else f.prev = "";
	}
	return f;
}

/**
 * @param {{ prev: string, fields: string, formatted: boolean, named: boolean }} f
 * @param {string} w
 */
function takePsWord(f, w) {
	const arm = psArm(`${f.prev}:${w}`);
	if (arm === "named" && w.toLowerCase().includes("claude")) f.named = true;
	else if (arm === "fields") f.fields += `,${w}`;
	else if (arm === "format=") {
		f.fields += `,${w.slice("--format=".length)}`;
		f.formatted = true;
	} else if (arm === "-o") {
		f.fields += `,${w.slice(2)}`;
		f.formatted = true;
	} else if (arm === "formatted") f.formatted = true;
	f.prev = w;
}

/** @param {string} key */
const psArm = (key) =>
	PS_ARMS.find((a) => a.re.some((re) => re.test(key)))?.arm;

/**
 * @param {State} st
 * @param {Command} c
 * @param {string[]} spans
 */
function judge(st, c, spans) {
	const word = c.words[0];
	if (word === undefined) return;
	const cmd = base(word);
	const args = c.words.slice(1);

	if (st.wantArgv)
		st.argvText += `\n${[cmd, ...args.map((w) => literal(w, spans).text)].join(" ")}`;
	if (st.psPiped) trackPsGrep(st, cmd, args, spans);
	if (st.claudeNamed && cmd === "ps" && psCountsComm(args, spans))
		st.commCount = true;
	if (cmd === "pgrep" || cmd === "pkill") judgePgrep(st, c, cmd, spans);
}

/**
 * @param {State} st
 * @param {string} cmd
 * @param {string[]} args
 * @param {string[]} spans
 */
function trackPsGrep(st, cmd, args, spans) {
	const fed = st.afterPs;
	st.afterPs = false;
	if (cmd === "ps") st.afterPs = true;
	else if (["grep", "egrep", "fgrep"].includes(cmd) && fed) {
		st.afterPs = true;
		judgeGrep(st, cmd, args, spans);
	}
}

/**
 * @param {State} st
 * @param {Command} c
 * @param {string} cmd
 * @param {string[]} spans
 */
function judgePgrep(st, c, cmd, spans) {
	const a = readPgrepArgs(c.words.slice(1));
	const lit = literal(a.pattern, spans);
	if (st.claudeNamed && cmd === "pgrep" && countsClaudeByName(a, lit))
		st.commCount = true;
	if (a.ancestors) return;
	const kind = pgrepKind(a, lit);
	if (kind === null || (st.namesShell && kind !== "inverted")) return;
	const tested = kind === "line" && a.pattern !== "" && lit.known;
	st.found.push({
		segment: c.segment,
		cmd,
		kind,
		pattern: tested ? lit.text : "",
		mode: tested ? `E${a.icase ? 1 : 0}` : "?",
	});
}

/**
 * @param {import("./pgrep-args.js").PgrepArgs} a
 * @param {{ text: string, known: boolean }} lit
 */
const countsClaudeByName = (a, lit) =>
	!(a.full || a.invert) &&
	lit.known &&
	a.pattern !== "" &&
	pgrepSelects("claude", lit.text, a) === "selects";

/**
 * @param {import("./pgrep-args.js").PgrepArgs} a
 * @param {{ text: string, known: boolean }} lit
 * @returns {Kind | null}
 */
function pgrepKind(a, lit) {
	if (a.full) return a.invert ? "inverted" : "line";
	if (a.pattern === "") return null;
	const selects = lit.known
		? pgrepSelects(SHELL_NAME, lit.text, a) === "selects"
		: a.invert;
	if (!selects) return null;
	return a.invert ? "inverted" : "name";
}

/**
 * @param {State} st
 * @param {string} subject
 * @returns {{ deny: string, segment: string } | { warning: string }}
 */
function verdict(st, subject) {
	let warning = "";
	for (const f of st.found) {
		if (f.mode !== "?" && !couldMatch(f.pattern, f.mode, subject)) continue;
		if (f.cmd === "pkill")
			return { segment: f.segment, deny: pkillDeny(f.kind) };
		if (warning === "") warning = pgrepWarning(f.kind, unmask(f.segment));
	}
	if (warning === "" && st.psPiped && !psGrepsMiss(st, subject))
		warning = PS_GREP_WARNING;
	return { warning };
}

/**
 * @param {State} st
 * @param {string} subject
 */
const psGrepsMiss = (st, subject) =>
	st.psGreps > 0 &&
	!st.psGrepUnsure &&
	st.grepPatterns.every((g) => !couldMatch(g.pattern, g.mode, subject));

/** @param {Kind} kind */
function pkillDeny(kind) {
	if (kind === "inverted")
		return `@CMD@ is inverted, so it ${INVERTED_HAZARD} It can kill the session itself.\n\n${PID_RECIPE}`;
	if (kind === "name")
		return `@CMD@ matches process names, and its pattern matches \`bash\`, the name of the shell running it, so this kills the session itself.\n\n${NAME_RECIPE}`;
	return `@CMD@ matches the command line of the shell running it, so this can kill the session itself — it did on 2026-08-23, where \`pkill -f 'node -c'\` took down the shell that issued it (exit 144).\n\nThe Bash tool runs every command as \`/bin/bash -c '<command>'\`, which puts the pattern inside the caller's own argv, and this pattern matches that text.\n\n${RECIPE}`;
}

/**
 * @param {Kind} kind
 * @param {string} cmd
 */
function pgrepWarning(kind, cmd) {
	if (kind === "inverted")
		return `${cmd} is inverted, so it ${INVERTED_HAZARD}\n\n${PID_RECIPE}`;
	if (kind === "name")
		return `${cmd} matches process names, and its pattern matches \`bash\`, the name of the shell running it, so it finds that shell as well as whatever you are looking for.\n\n${NAME_RECIPE}`;
	return `${cmd} matches the command line of the shell running it, so it finds itself as well as whatever you are looking for. A loop built on it never exits.\n\n${RECIPE}`;
}

/**
 * @param {string} whole
 * @param {CoreContext} ctx
 * @returns {CoreDecision}
 */
function decide(whole, ctx) {
	const parsed = parseCommand(whole);
	const st = newState(whole);
	walkCommands(parsed, (c) => judge(st, c, parsed.spans), ctx);
	const v = verdict(st, `/bin/bash -c ${whole}${st.argvText}`);
	if ("deny" in v) return { deny: denyText(ctx, v.segment, v.deny) };
	if (st.claudeNamed && whole.includes("/proc/") && COMM_PATH.test(whole))
		st.commCount = true;
	if (st.commCount)
		return {
			injectRules: ["claude-process-count"],
			...(v.warning ? { prelude: ctx.corePaths(v.warning) } : {}),
		};
	return v.warning ? { context: ctx.corePaths(v.warning) } : null;
}

module.exports = { field: "command", noun: "command", decide };
