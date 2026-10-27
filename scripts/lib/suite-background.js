/*
 * suite-background.js — the dispatcher core that refuses a suite DETACHED
 * INSIDE THE SHELL — `&`, `nohup`, `setsid`, `disown` — which registers no
 * job, so nothing will ever wake the session, and the `waiting:` turn that
 * follows sits in `working` until the founder notices.
 *
 * AND (workflow-core#1186) A SUITE WITH NO UPPER BOUND WRAPPED IN A SHELL `timeout N`,
 * which kills it at its clock with no result (ruled at workflow-core#1181 Q1–Q4 (A)).
 *   Unbounded is an `npm test`/`npm run test`, `test:changed` or `run-vitest.js`
 * naming no test-file-shaped word, or carrying a bare word that is no flag's
 * value, as lib/suite-bounded.js's launchTestFileCount reads its argv. A named
 * file outranks `--full=<cause>`, run-vitest.js itself then running no whole
 * suite. The watcher, `test:py` and a runner other than vitest are out. Any
 * `N`, any `timeout` flags, queued or not, `run_in_background` or not, a
 * compound command too.
 *   Only a `timeout` among the wrappers `unwrap` took off is read; one after
 * the command word is an argument. Line one is the command with each such
 * `timeout`, its flags and duration dropped (`stripTimeout`), and never adds
 * `--queue`, which stays the count cap's to add. Its escape is
 * `WFC_SUITE_TIMEOUT=<non-empty>`, read like `WFC_SUITE_DETACH` but per
 * segment. A command both detached and timed gets one deny, both stripped.
 *
 * THE THREE LARGER CAUSES OF A STALL are out of this core's reach, which is
 * suites only; they are on mantahostels#2485 and in
 * https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/waiting-stall-forensics.md, and the rates behind the deny
 * below. A FOREGROUND SUITE IS NOT IN SCOPE and is deliberately allowed: a
 * call that overruns its timeout is backgrounded by the harness and notifies
 * (workflow-core#535 §Further Notes). An undetached `run_in_background` suite is allowed
 * too.
 *
 * THE DENY OPENS WITH THE COMMAND TO RUN INSTEAD (workflow-core#519), on workflow-core#482's ruling that
 * the suite refusals buried their fix in ~2 KB of text. So line one is the
 * command less its detachment, in the foreground with `timeout: 600000`
 * (workflow-core#545), and the rest keeps only what changes a later call.
 * `stripDetachment` builds it: the whole command, not the suite segment
 * alone, with `nohup`/`setsid` and their flags and `disown` and its arguments
 * dropped, a trailing `&` dropped and a mid-command one turned into `;`. A
 * heredoc's body and terminator are data (workflow-core#2384), the lines lib/shell-parse.js
 * drops, so `holdHeredocs` sets them aside before the detach test and both
 * re-spellings read the command, and the deny puts them back as typed.
 *
 * THE FIGURES BEHIND IT LIVE HERE, NOT IN THE DENY. A queued suite job IS
 * killed often — 192 of 427 notified `--queue` launches, against 123 of 1,286
 * notified unqueued suite jobs and 238 of 5,589 notified non-suite jobs — but a
 * kill still emits `<status>killed</status>`, where a detached run emits
 * nothing, ever. That notification lies: 70% of the time `bg-run.sh check`
 * still reads RUNNING (mantahostels#2517), so a blind relaunch starts a second
 * suite. Emitting is mostly receiving: 97% of notifications enqueued with a
 * tool call in flight are folded into the next tool result and read, ~92% of
 * those enqueued idle (workflow-core#845, overturning mantahostels#2516's 67.8% drop). The
 * deny still asserts no wake — a kill or a lost notification stays possible.
 *
 * A DENY, NOT A WARN. The mantahostels#908/mantahostels#987 precedent for
 * warning turns on the INPUT being a judgement call — a headroom snapshot that
 * may be stale. This one's input is the command string in hand.
 *
 * SCOPE — both limbs must hold, on the same tool call:
 *   1. some segment is a suite launch, and
 *   2. the command detaches (`detaches`).
 * `run_in_background` is NOT a third limb: setting it alongside a detachment
 * registers a job for the WRAPPER, which exits at once and reports success
 * while the suite runs on unattached.
 *
 * A suite launch is every kind lib/suite-launch.js's suiteLaunchKind knows,
 * `test:py` and the watcher included, so `node --test`, `pytest`, a bare
 * Python test file and a host's declared `suiteRunners` are refused detached
 * too. A WRAPPER STANDING WHERE THE COMMAND WORD IS LOOKED FOR IS STRIPPED
 * FIRST — `nohup`, `setsid`, `env`, `timeout`, `time`, `command`, `stdbuf`,
 * `nice`, `ionice`, `xargs`, `sudo` and `bg-run.sh run <name>` — by
 * lib/shell-words.js's `unwrap` (mantahostels#2524, mantahostels#2552).
 *
 * ITS ESCAPE IS `WFC_SUITE_DETACH=<anything non-empty>` AS A PREFIX ON THE
 * COMMAND — `=0` exempts too — read from the command string rather than from
 * the hook's environment: a hook runs before the command, so an env prefix
 * never reaches it (mantahostels#2486). The escape is read through an `env`
 * prefix too (mantahostels#2524).
 *
 * LIMITS.
 *  - `detaches` is LEXICAL. A detachment inside a script, behind `sh -c`, via
 *    `at`, `systemd-run` or a multiplexer passes unseen — lib/bg-job.js's own
 *    blind spot. A `&` inside a quoted string reads as a detachment, unless
 *    the string is a heredoc's body. The heredoc pass's own residuals hold:
 *    a second heredoc opened on one line, and a `<<-` terminator indented
 *    with tabs, which runs the body to the end of the command. An unquoted
 *    delimiter's body is skipped too, so a `$(… &)` bash would run there is
 *    unseen.
 *  - It cannot see that it is in a SUBAGENT. Detaching is wrong there too.
 *  - The `WFC_SUITE_DETACH` escape is OR-ed across segments, so a command
 *    holding one escaped suite launch and one unescaped detached one is
 *    exempted whole.
 *  - `detaches` reads the WHOLE command string where the launch is read per
 *    segment, so an unrelated detachment anywhere on a command carrying a
 *    suite launch denies it: `sleep 1 & npm run test` is refused.
 *  - THE WRAPPER CLASS IS NOT CLOSED, so a word the strip left standing is
 *    read as the command word and the launch goes unjudged. `sh` is not a
 *    wrapper `unwrap` strips, so `sh -c "…"` stands as itself with its
 *    payload a blanked span; a heredoc's body is dropped as data, leaving only
 *    the opener line's own segments. The rest of the residual is `unwrap`'s
 *    own, listed in its header (lib/shell-words.js).
 *  - `stripDetachment` is as LEXICAL as `detaches`: a `&` inside a quoted
 *    string outside a heredoc is rewritten too, and a detachment it cannot see
 *    is left standing.
 *  - The detachment limb carves out no bounded run. `node scripts/run-vitest.js
 *    foo.test.ts &` is denied like any other; only the timeout limb exempts it.
 *  - A runner other than vitest — `pytest &`, `node --test &` (workflow-core#1528) — meets
 *    the detachment limb alone. The timeout limb reads no bound on one, so
 *    `timeout 60 pytest` passes.
 *  - A `timeout` inside an `env -S` string is unseen by the timeout limb: the
 *    words read are the segment's own, and the string's are one quoted span.
 *    One outside it is seen and stripped, the wrappers ending at that span.
 *  - The bounded reading carries lib/suite-bounded.js's own residuals.
 *  - `stripTimeout` re-joins the segment's words on single spaces, so a timed
 *    segment's own spacing is not kept in line one.
 *
 * IMPLICIT: it refuses a suite launch detached inside the shell, and an
 *   unbounded one wrapped in a shell `timeout`, and says nothing at all on the
 *   pass path.
 * JUSTIFIED: fail-safe — the launch is the last moment at which the wake can
 *   still be arranged, and a session that stalls for want of one never learns
 *   it did; a shell-timed suite killed at its clock leaves no result to read.
 * DEFEAT: `WFC_SUITE_DETACH=1` or `WFC_SUITE_TIMEOUT=1` as a prefix on the
 *   command, one per limb; listing `guard-suite-background` under the host's
 *   `disabled` silences it.
 */

const { QUOTED, carriesVar, literal, unwrap } = require("./shell-words.js");
const { asWritten, parseCommand, walkCommands } = require("./shell-parse.js");
const { afterSlash, suiteLaunchKind } = require("./suite-launch.js");
const { launchTestFileCount } = require("./suite-bounded.js");

/**
 * @typedef {import("./guard-dispatch.js").CoreContext &
 *   import("./suite-launch.js").LaunchPorts} Ctx
 */

/** `[[:space:]]` within one line. */
const SP = "[ \\t\\v\\f\\r]";

/** The operators that spell an `&` without detaching anything. */
const NOT_DETACHING = ["&&", "&>", "|&", ">&", "<&"];

/** A detacher as a word: `/` may lead it, `.` and `-` may not trail it. */
const DETACHER = /(^|[^A-Za-z0-9_-])(nohup|setsid|disown)([^A-Za-z0-9_.-]|$)/m;

/**
 * Whether the command detaches the work from the tool call. THE BARE `&` IS
 * MATCHED BY SUBTRACTION rather than by parsing: every operator spelling an
 * `&` without detaching anything is blanked first, and any `&` still standing
 * detaches something.
 * @param {string} s
 */
function detaches(s) {
	if (DETACHER.test(s)) return true;
	return NOT_DETACHING.reduce((t, op) => t.split(op).join("  "), s).includes(
		"&",
	);
}

/** Per-line rewrites, in order, that drop a detachment. */
const DETACH_REWRITES = /** @type {const} */ ([
	[
		new RegExp(
			`(^|[ \\t\\v\\f\\r;|&(])(/[^ \\t\\v\\f\\r]*/)?(nohup|setsid)(${SP}+-[^ \\t\\v\\f\\r]+)*(${SP}+|$)`,
			"g",
		),
		"$1",
	],
	[
		new RegExp(
			`(^|[ \\t\\v\\f\\r;|&(])disown(${SP}+[^ \\t\\v\\f\\r;|&]+)*${SP}*`,
			"g",
		),
		"$1",
	],
	[new RegExp(`&${SP}*(;|$)`, "g"), "$1"],
	[/&/g, ";"],
	[new RegExp(`${SP}+$`), ""],
]);

/**
 * The command as the deny's first line re-issues it. The operators `detaches`
 * blanks are shielded first and put back last, so only a detaching `&` is
 * touched. Its word boundary is narrower than `detaches`': a word it deletes
 * must follow a space, an operator or a `/`-path, where a test may afford to
 * over-match.
 * @param {string} text
 */
function stripDetachment(text) {
	let s = NOT_DETACHING.reduce(
		(t, op, i) => t.split(op).join(String.fromCharCode(2 + i)),
		text,
	);
	s = s
		.split("\n")
		.map((line) =>
			DETACH_REWRITES.reduce((l, [re, to]) => l.replace(re, to), line),
		)
		.join("\n")
		.replace(/\n+$/, "");
	s = NOT_DETACHING.reduce(
		(t, op, i) => t.split(String.fromCharCode(2 + i)).join(op),
		s,
	);
	return trimStart(s);
}

/** @param {string} s */
const trimStart = (s) => s.replace(/^[ \t\n\v\f\r]+/, "");

/** The sentinel a held heredoc line stands as. */
const held = (/** @type {number} */ n) => `\x07${n}\x07`;

/**
 * The command with each heredoc body or terminator line replaced by a
 * sentinel holding its number, and the lines held.
 * @param {string} raw
 * @param {number[]} heredocLines
 */
function holdHeredocs(raw, heredocLines) {
	const lines = raw.split("\n");
	/** @type {Map<number, string>} */
	const kept = new Map();
	for (const n of heredocLines) {
		kept.set(n, lines[n] ?? "");
		lines[n] = held(n);
	}
	return { text: lines.join("\n"), kept };
}

/**
 * holdHeredocs reversed, on any text its sentinels survived.
 * @param {string} s
 * @param {Map<number, string>} kept
 */
function putBackHeredocs(s, kept) {
	let out = s;
	for (const n of [...kept.keys()].sort((a, b) => a - b)) {
		const at = out.indexOf(held(n));
		if (at >= 0)
			out =
				out.slice(0, at) + (kept.get(n) ?? "") + out.slice(at + held(n).length);
	}
	return out.replace(/\n+$/, "");
}

/** The flags of `timeout` that take the next word. */
const TIMEOUT_VALUE_FLAGS = ["-k", "--kill-after", "-s", "--signal"];

/**
 * The masked segment with every `timeout`, its flags and its duration taken
 * off the wrappers in front of the command word, or null where those
 * wrappers cannot be placed in the segment's text. The segment's outer
 * whitespace and its redirections are kept. The wrappers end at the command
 * word — or, where an `env -S` string was split into the command, at the
 * first quoted word, the string itself.
 * @param {string} seg
 * @param {string} commandWord the unwrapped command's first word
 */
function stripTimeout(seg, commandWord) {
	const segWords = (seg.split("\n")[0] ?? "").split(/[ \t]+/).filter(Boolean);
	const nwrap = segWords.findIndex(
		(w) => w === commandWord || w.includes(QUOTED),
	);
	if (nwrap < 0) return null;
	const kept = keptWrappers(segWords.slice(0, nwrap));
	const lead = /^[ \t\n\v\f\r]*/.exec(seg)?.[0] ?? "";
	const trail = /[ \t\n\v\f\r]*$/.exec(seg)?.[0] ?? "";
	return lead + [...kept, ...segWords.slice(nwrap)].join(" ") + trail;
}

/**
 * The wrapper words with every `timeout`, its flags and its duration dropped.
 * @param {string[]} wrappers
 */
function keptWrappers(wrappers) {
	/** @type {string[]} */
	const kept = [];
	for (let i = 0; i < wrappers.length; i++) {
		const word = wrappers[i] ?? "";
		if (afterSlash(word) !== "timeout") {
			kept.push(word);
			continue;
		}
		while (i + 1 < wrappers.length && (wrappers[i + 1] ?? "").startsWith("-"))
			i += TIMEOUT_VALUE_FLAGS.includes(wrappers[i + 1] ?? "") ? 2 : 1;
		i += 1;
	}
	return kept;
}

const FIX_OPENER =
	"Run instead, in the foreground with the Bash tool's `timeout: 600000`: ";

const DETACHED_TEXT =
	"This suite is DETACHED INSIDE THE SHELL — `&`, `nohup`, `setsid` or `disown` — so the call registers no job for the run and nothing will ever tell you it ended. `run_in_background` with a detachment does not help: the job is then the wrapper shell, which exits at once. An overrun is moved to the background and notifies: then end the turn with NO tool call — a notification arriving mid-call is almost never delivered. A `--full=<cause>` or `--queue` run may overrun, so wrap it in `scripts/bg-run.sh run <name>` in the same call: a `killed` notification often lies, so before relaunching read `scripts/bg-run.sh check <name>`, which tells KILLED from DONE. If guard-suite-concurrency.js refuses the re-issue, no job exists: take its corrected command rather than reporting `waiting:`. Genuinely need the detachment? Prefix the command with `WFC_SUITE_DETACH=1`.";

const TIMED_TEXT =
	"This suite is WRAPPED IN A SHELL `timeout`, which kills it with no result and no pass/fail marker when the clock runs out — and the clock counts time spent waiting in the `--queue` too. The Bash tool's own timeout does not kill it: an overrun is moved to the background and notifies, and you end the turn with NO tool call. If guard-suite-concurrency.js refuses the re-issue, take its corrected command. A run naming its own test files is not refused. Genuinely need the shell timeout? Prefix the command with `WFC_SUITE_TIMEOUT=1`.";

/**
 * @param {string} command
 * @param {Ctx} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	const parsed = parseCommand(command);
	const { spans } = parsed;
	/** @param {string} w */
	const typed = (w) => {
		if (!w.includes(QUOTED)) return w;
		const lit = literal(w, spans);
		return lit.known ? lit.text : w;
	};
	let foundSuite = false;
	let escaped = false;
	/** @type {{ from: string, to: string }[]} */
	const timed = [];
	walkCommands(
		parsed,
		(cmd) => {
			const { words } = unwrap(cmd.words, spans);
			/* An `env -S` split can leave more words than it took, so none are
			 * read there. */
			const nwrap = cmd.words.length - words.length;
			const isTimed =
				nwrap > 0 &&
				cmd.words.slice(0, nwrap).some((w) => afterSlash(w) === "timeout");
			if (words.length === 0) return;
			const launch = suiteLaunchKind(words.map(typed), ctx);
			if (!launch) return;
			if (carriesVar("WFC_SUITE_DETACH", cmd.leading, cmd.words, spans))
				escaped = true;
			foundSuite = true;
			if (!isTimed || !isUnbounded(launch, words, spans)) return;
			if (carriesVar("WFC_SUITE_TIMEOUT", cmd.leading, cmd.words, spans))
				return;
			let stripped = stripTimeout(cmd.segment, words[0] ?? "");
			if (stripped === null) {
				ctx.log(
					"stripTimeout could not place the wrappers — the deny re-issues the segment as typed",
				);
				stripped = cmd.segment;
			}
			timed.push({
				from: asWritten(cmd.segment, spans),
				to: asWritten(stripped, spans),
			});
		},
		ctx,
	);
	const hold = holdHeredocs(command, parsed.heredocLines);
	const detached = foundSuite && !escaped && detaches(hold.text);
	if (!detached && timed.length === 0) return null;

	let fix = hold.text;
	for (const { from, to } of timed)
		if (from !== "") fix = fix.split(from).join(to);
	if (detached) fix = stripDetachment(fix);
	fix = putBackHeredocs(trimStart(fix), hold.kept);
	if (fix === "") {
		ctx.log(
			"the re-issue came out empty — the deny re-issues the command as typed",
		);
		fix = command;
	}
	let reason = `${FIX_OPENER}${fix}`;
	if (detached) reason += `\n${DETACHED_TEXT}`;
	if (timed.length > 0) reason += `\n${TIMED_TEXT}`;
	return { deny: ctx.corePaths(reason.replace(/\n$/, "")) };
}

/**
 * Whether the launch has no upper bound on its selection: an `npm test`,
 * `npm run test`, `test:changed` or `run-vitest.js` naming no test file. A
 * `--full=<cause>` rides on one of those.
 * @param {import("./suite-launch.js").Launch} launch
 * @param {string[]} words masked, unwrapped
 * @param {string[]} spans
 */
function isUnbounded(launch, words, spans) {
	if (launch.kind !== "wrapper" && launch.kind !== "npm-vitest") return false;
	return (
		launchTestFileCount(launch, words, (w) => literal(w, spans).text) === null
	);
}

module.exports = { field: "command", noun: "suite launch", decide };
