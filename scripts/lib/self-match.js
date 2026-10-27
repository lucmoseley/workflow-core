/*
 * self-match.js — the PreToolUse dispatcher core that catches a process
 * pattern run through the Bash tool matching the shell running it (#2790).
 *
 * Why: the Bash tool executes every command as `/bin/bash -c '<command>'`, so
 * the pattern is inside the calling shell's OWN argv. `pgrep -f X` and
 * `pkill -f X` match against full command lines, so both find that shell
 * wherever X matches the command's own text — which it does unless written not
 * to: `'[n]ode'` searches for `node`, and the shell's argv holds `[n]ode`.
 * Without `-f` the pattern is tested against process names, and that shell's
 * is `bash`, so `pkill ba` finds it too (#1842).
 *
 * UNDER `-v` THE HAZARD INVERTS (#1847): an inverted pattern selects every
 * process it misses — the harness and nearly everything else, and the shell
 * wherever the pattern misses it — so the bracket recipe, which makes a
 * pattern miss the shell, puts the shell in. Its text offers the pid recipe
 * alone.
 *
 * A SECOND LIMB ON THE SAME HAZARD (mantahostels#2014): `ps ... | grep <pattern>`
 * checking whether a background job is still alive. It self-matches its own
 * searching shell exactly as `pgrep -f` does, and two more failures make a
 * liveness check this way report a live job as gone:
 *   - a `run_in_background` job's HARNESS TASK ID (the short id the tool
 *     result names, e.g. `berl18qst`) is bookkeeping the harness keeps outside
 *     the process — it appears in no process's own argv, so grepping for IT
 *     specifically finds nothing even while the job runs; grepping for text
 *     that genuinely is in the job's own command line still self-matches as
 *     described above;
 *   - the `grep -v grep` idiom, meant to hide the searching grep's own
 *     self-match, silently drops a TRUE positive too whenever the target
 *     process's own command line happens to contain the word "grep" — which a
 *     liveness-polling loop's does, since it is usually built on `grep -q`.
 * `docs/agents/verification.md`'s "Asserting that nothing of yours is still
 * running" names `ps | grep` as the wrong check.
 *
 * A THIRD LIMB, ON A DIFFERENT HAZARD (#2027): a Claude process count matched
 * on `comm`, which for a backgrounded session is its version number, so it
 * finds no session. Read where the command names `claude`: a `pgrep` without
 * `-f` whose pattern selects `claude`, a `ps -C` naming it, a `ps` format
 * listing a `comm` field and no `args` one, a plain `ps` whose default last
 * column is `comm`, or a `/proc/*\/comm` read. It hands over
 * `rule:claude-process-count`, once a session.
 *
 * THE VERDICTS, split on mantahostels#103's rule — deny on a structured fact
 * where the action has no legitimate use, warn where the guard is inferring:
 *   - `pkill -f` is DENIED. It can kill the session, and killing by pid instead
 *     is always available.
 *   - `pgrep -f` is WARNED. Reading is harmless in itself; what it costs is a
 *     wrong answer, and only the caller knows whether a self-match would
 *     change the verdict it is about to draw.
 *   - `ps | grep` is WARNED: one for something other than a liveness check is
 *     ordinary and has no other tell.
 *
 * All three pass when the command carries `$$` or `$PPID`, which is a caller
 * who has already thought about the self-match and excluded it — except an
 * inverted pgrep/pkill, which naming the shell never spares — and where every
 * pattern misses the command's own text (#1782, #1805). `pgrep`/`pkill` also
 * pass under `-A`, which spares the calling shell as an ancestor.
 *
 * LIMITS
 *  - `pgrep`/`pkill` reading matches the parsed command form — a command whose
 *    word is `pgrep` or `pkill`, after any reserved word, `time` or `exec` —
 *    never a substring, so an echo or a heredoc mentioning them passes.
 *    `killall` matches process NAMES rather than command lines, so it does not
 *    self-match and is deliberately absent.
 *  - A `-f` pattern is still judged a self-match under `-v`, which
 *    lib/paste-self-match.js tests inverted (#1814), and when it is absent or
 *    carries an expansion, and when it will not compile, and `-x` is read as a
 *    substring match — each but the first erring towards a verdict where that
 *    module, which refuses a turn, errs towards passing. One that misses the
 *    shell may still match its ancestors — the harness among them — as a bare
 *    `pkill node` may; only `-A` spares those, and this core reads no hazard
 *    but the self-match.
 *  - Without `-f`, a pattern is tested against `bash` alone, the Bash tool's
 *    shell, so `pkill -v bash` passes though it kills the harness. One carrying
 *    an expansion is judged selecting under `-v`, which nearly every pattern
 *    is, and passing without; one that will not compile passes, as pgrep then
 *    kills nothing. Selection by other criteria alone (`pkill -u lucmo`) is not
 *    read.
 *  - The `ps | grep` check is a RAW REGEX over the whole command text — it has
 *    no `-f`-shaped flag to key off, so there is no structured fact to walk.
 *    It looks for `ps` (optionally flagged) piped directly into `grep`,
 *    `egrep` or `fgrep`, immediately or after a shell keyword
 *    (while/until/if/elif/then/else/do), `!`, `{`, a command separator, or a
 *    newline. It does NOT see `ps` piped through an intermediate command
 *    before `grep` (`ps -ef | awk '{print $2}' | grep x`).
 *  - It stays SILENT where the walk finds each grep a `ps` feeds and every
 *    pattern it reads misses the command's own text — as typed after
 *    `/bin/bash -c`, and as `ps` prints each command's words — so the bracket
 *    recipe (`grep '[n]ode'`, #1782) passes. It still warns on a pattern from a
 *    variable or a file, under `-v` or `-P`, a basic regex using a character an
 *    extended one reads differently, and any grep it cannot find — a
 *    `ps | grep` inside a quoted span among them.
 *  - That subject, for both limbs, is the command, not the shell's whole argv:
 *    the harness wraps it in a snapshot `source`, an `eval '…'` re-quoting each
 *    `'`, and a cwd redirect, and `ps -ef` prints user and time columns beside
 *    it. A pattern aimed at those words (`grep '[e]xtglob'`, `grep '[l]ucmo'`)
 *    passes silently yet matches the searching shell. Accepted: the wrapper is
 *    the harness's to change, and a pattern aimed at it is no liveness check.
 *  - It reads the RAW command for the `ps | grep` shape, not the quote-masked
 *    text the walk reads for `pgrep`/`pkill`, so a `ps | grep` shape written
 *    inside a quoted string or heredoc body still warns here
 *    (`echo "run: ps -ef | grep node"`). Accepted: a false positive on this
 *    check costs a warn nobody has to act on.
 *  - A pattern reached through a wrapper (`xargs pkill`, `sudo pkill`) is not
 *    seen: only a command's own first word is read.
 *  - The `$$`/`$PPID` exception is lexical and whole-command, so it clears every
 *    uninverted pgrep/pkill in a compound command once any part of it names
 *    one. Accepted: a caller naming the shell has thought about the self-match.
 *  - The `comm` limb FAILS CLOSED on a rule-store fault — a missing, empty or
 *    oversized claude-process-count fragment refuses the command
 *    (mantahostels#1762).
 *  - The `comm` limb reads `claude` anywhere in the command for the `ps` and
 *    `/proc` shapes, and any `/comm` path in a command naming `/proc/`. A
 *    count built on `pidof`, `killall` or `awk` over `/proc/*\/stat`, or a
 *    `Name:` read from `/proc/*\/status`, is not seen.
 *  - It guards the Bash tool only.
 */

const { denyText } = require("./guard-verdict.js");
const { parseCommand, unmask, walkCommands } = require("./shell-parse.js");
const { literal, scanFlags } = require("./shell-words.js");
const { compileEre } = require("./posix-ere.js");
const { SHELL_NAME, pgrepSelects, readPgrepArgs } = require("./pgrep-args.js");

/**
 * @typedef {import("./guard-dispatch.js").CoreContext} CoreContext
 * @typedef {import("./guard-dispatch.js").CoreDecision} CoreDecision
 * @typedef {import("./shell-parse.js").Command} Command
 * @typedef {"line" | "name" | "inverted"} Kind
 * @typedef {{ segment: string, cmd: string, kind: Kind, pattern: string,
 *   mode: string }} Finding a pgrep or pkill that selects by pattern; `mode`
 *   is the grep mode couldMatch reads the pattern in, "?" where it is not
 *   tested
 */

/** `ps … | grep`, as the raw command spells it. */
const PS_GREP = /** @type {RegExp} */ (
	compileEre(
		"(^|[;&|(!{\n]|\\b(while|until|if|elif|then|else|do)[[:space:]])[[:space:]]*ps([[:space:]]+[A-Za-z0-9_.,:=+*/-]+)*[[:space:]]*\\|[[:space:]]*[ef]?grep\\b",
	)
);

/** A `comm` path, for the `/proc/*\/comm` read. */
const COMM_PATH = /** @type {RegExp} */ (compileEre("/comm([^[:alnum:]_]|$)"));

/**
 * GNU grep's value-taking flags (`grep --help`), so a value is never read as
 * the pattern: `grep -m 1 node` searches for node, not 1.
 */
const GREP_VALUE_FLAGS =
	"-e -f -m -A -B -C -d -D --regexp --file --max-count --after-context --before-context --context --label --binary-files --devices --directories --exclude --include --exclude-dir --exclude-from --group-separator";

/** The grep a command word names, B being basic. */
const GREP_COMMAND_MODES = /** @type {Record<string, string>} */ ({
	egrep: "E",
	fgrep: "F",
});

/** The flags that set the grep mode, as `<kind>:<name>`. */
const GREP_FLAG_MODES = /** @type {Record<string, string>} */ ({
	"flag:-E": "E",
	"flag:--extended-regexp": "E",
	"flag:-F": "F",
	"flag:--fixed-strings": "F",
	"flag:-G": "B",
	"flag:--basic-regexp": "B",
});

/** A grep reading a pattern this core cannot test: inverted, from a file, or Perl. */
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

/**
 * A bash case pattern — `*`, `?` and bracket classes — as an anchored RegExp.
 * @param {string} glob
 */
const caseGlob = (glob) =>
	new RegExp(
		`^${glob
			.replace(/[.+^${}()|\\]/g, "\\$&")
			.replace(/\*/g, "[\\s\\S]*")
			.replace(/\?/g, "[\\s\\S]")
			.replace(/\[!/g, "[^")}$`,
	);

/** The format arms a `ps` word is read through, over `<prev>:<word>`, first match winning. */
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
 * Whether pattern `pattern`, read in grep mode `mode` (B, E or F, then 1 for
 * -i), could match `subject`. Errs towards yes: a basic regex using a
 * character whose meaning differs from an extended one is never translated,
 * only answered yes, and so is a pattern that will not compile.
 * @param {string} pattern
 * @param {string} mode
 * @param {string} subject
 */
function couldMatch(pattern, mode, subject) {
	const kind = mode.charAt(0);
	const icase = mode.charAt(1) === "1";
	/* grep reads each line of a pattern as a pattern of its own. */
	return pattern
		.split("\n")
		.some((line) => lineCouldMatch(line, kind, icase, subject));
}

/**
 * Whether one line of a grep pattern could match `subject`, as couldMatch
 * reads it: an empty line matches every line.
 * @param {string} line
 * @param {string} kind B, E or F
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

/**
 * Whether a basic regex uses a character an extended one reads differently.
 * @param {string} line
 */
const breDiffers = (line) =>
	/[\\+?|(){}]/.test(line) ||
	line.startsWith("*") ||
	line.slice(1).includes("^") ||
	line.replace(/\$$/, "").includes("$");

/**
 * Every judgement one walk gathers, read after it.
 * @param {string} whole
 */
function newState(whole) {
	const namesShell = whole.includes("$$") || whole.includes("$PPID");
	const psPiped = !namesShell && PS_GREP.test(whole);
	return {
		whole,
		namesShell,
		/* "laude", so a bracketed `[c]laude` still names it. */
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
 * Record one grep that a `ps` feeds: its patterns as grep reads them, or
 * `psGrepUnsure` where it reads one this core cannot test — inverted, from a
 * file, Perl-flavoured, or carrying an expansion.
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
 * Whether a `ps`'s arguments select or print processes by `comm`: `-C` naming
 * claude, an output format listing a `comm` field without an `args` one, or
 * no format at all where the default's last column is `comm` — UNIX-style
 * options only, without `-f` or `-F`. `-O` and BSD words print args by default.
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
 * What a `ps`'s arguments say of its format, read word by word through
 * PS_ARMS.
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

/** @param {string} key `<prev>:<word>` */
const psArm = (key) =>
	PS_ARMS.find((a) => a.re.some((re) => re.test(key)))?.arm;

/**
 * One command the walk hands over.
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
 * Follow a pipe out of `ps`: a grep fed by a fed grep is judged too, so a
 * trailing `grep -v grep` still warns.
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
 * @param {string} cmd pgrep or pkill
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
 * Whether a pgrep counts by name, its pattern selecting `claude`.
 * @param {import("./pgrep-args.js").PgrepArgs} a
 * @param {{ text: string, known: boolean }} lit
 */
const countsClaudeByName = (a, lit) =>
	!(a.full || a.invert) &&
	lit.known &&
	a.pattern !== "" &&
	pgrepSelects("claude", lit.text, a) === "selects";

/**
 * Which hazard a pgrep or pkill carries, or null where it selects nothing the
 * shell is: without `-f` its pattern must select `bash`, or carry an
 * expansion under `-v`.
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
 * The warning the walk's findings earn, or the deny a pkill does.
 * @param {State} st
 * @param {string} subject what a pattern self-matches against
 * @returns {{ deny: string, segment: string } | { warning: string }}
 *   a deny's `@CMD@` stands for its segment, spliced once its paths resolve
 */
function verdict(st, subject) {
	let warning = "";
	for (const f of st.found) {
		if (f.mode !== "?" && !couldMatch(f.pattern, f.mode, subject)) continue;
		if (f.cmd === "pkill")
			return { segment: f.segment, deny: pkillDeny(f.kind) };
		/* First one wins: a compound command full of pgreps has one thing
		 * wrong with it, not four. A later pkill still denies. */
		if (warning === "") warning = pgrepWarning(f.kind, unmask(f.segment));
	}
	if (warning === "" && st.psPiped && !psGrepsMiss(st, subject))
		warning = PS_GREP_WARNING;
	return { warning };
}

/**
 * Whether the walk found every grep a `ps` feeds and each pattern misses.
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
 * @param {string} cmd the segment as written
 */
function pgrepWarning(kind, cmd) {
	if (kind === "inverted")
		return `${cmd} is inverted, so it ${INVERTED_HAZARD}\n\n${PID_RECIPE}`;
	if (kind === "name")
		return `${cmd} matches process names, and its pattern matches \`bash\`, the name of the shell running it, so it finds that shell as well as whatever you are looking for.\n\n${NAME_RECIPE}`;
	return `${cmd} matches the command line of the shell running it, so it finds itself as well as whatever you are looking for. A loop built on it never exits.\n\n${RECIPE}`;
}

/**
 * @param {string} whole the command
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
	/* The rule rides with any warning, in the one envelope the hook may
	 * print; once told, the warning goes alone. */
	if (st.commCount)
		return {
			injectRules: ["claude-process-count"],
			...(v.warning ? { prelude: ctx.corePaths(v.warning) } : {}),
		};
	return v.warning ? { context: ctx.corePaths(v.warning) } : null;
}

module.exports = { field: "command", noun: "command", decide };
