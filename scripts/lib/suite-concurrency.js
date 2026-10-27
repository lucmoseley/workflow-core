/*
 * suite-concurrency.js — guard-suite-concurrency.js's core: the suite gate
 * docs/environment.md §6 sets, read off one Bash command. No I/O of its own;
 * lib/suite-concurrency-host.js builds the ports it reads the machine through.
 */

const { denyText, ruleOrFallback } = require("./guard-verdict.js");
const {
	asWritten,
	parseCommand,
	unmask,
	walkCommands,
} = require("./shell-parse.js");
const { QUOTED, carriesVar, literal, unwrap } = require("./shell-words.js");
const { ruleModule } = require("./rule-gates.js");
const {
	SUITE_MAX,
	WHOLE_SUITE_MAX,
	WRAPPER_ARGV0,
	runningSuites,
	suiteRungMb,
} = require("./suite-ladder.js");
const {
	WHOLE_SUITE_WORKERS,
	launchArgv,
	launchTestFileCount,
	weighCarried,
	weighFiles,
} = require("./suite-bounded.js");
const {
	afterSlash,
	isOtherRunner,
	suiteLaunchKind,
} = require("./suite-launch.js");
const { npmCanon } = require("./npm-options.js");
const { isTouchedRun, launchRoute } = require("./launch-route.js");
const { TSC_RUNG_MB, isTscLaunch, tscDenial } = require("./tsc-slot.js");

/**
 * @typedef {import("./suite-launch.js").Launch} Launch
 * @typedef {import("./suite-ladder.js").Running} Running
 * @typedef {import("./shell-parse.js").Command} Command
 * @typedef {{ limb: "count" } | { limb: "memory", mb: number, rungMb: number }} Gate
 * @typedef {import("./guard-entry.js").Decision | ({ deny: string, gate: Gate })} Verdict
 * @typedef {object} SuitePorts
 * @property {() => number | null} availableMb MemAvailable, in MB
 * @property {() => import("./suite-ladder.js").PsRow[] | null} psRows `ps`,
 *   read once a call
 * @property {(pid: number | null) => import("./suite-handoff.js").CarriedWeight | null} carriedOf
 *   the weight process `pid`'s launch record carries (workflow-core#2931)
 * @property {import("./suite-handoff.js").CarriedWeight | null} [launchWeight]
 *   the judged launch's own carried weight, where the queue asks for it
 * @property {() => string[]} runners the host's declared `suiteRunners`
 * @property {(script: string) => boolean} isWrapperScript whether the host's
 *   npm script runs run-vitest.js; yes where it cannot be read
 * @property {() => string | null} declaredTest the host's `commands.test`
 * @property {(argv: string[]) => { plain: boolean } | { fault: string }} fullLaunchPlain
 *   whether a `--full` launch's argv is plain and the read graph renders
 * @property {(line: string) => boolean} appendStanddown one record appended
 *   to the stand-down log; false where it could not be
 * @property {() => string} now gl_when's timestamp
 * @property {string} sessionId the payload's
 * @typedef {import("./shell-parse.js").WalkPorts & SuitePorts &
 *   Pick<import("./kit-context.js").KitContext, "scriptPath" | "corePaths" | "ruleText" | "docPath"> & {
 *   moduleOn: (module: import("./workflow-core-config.js").Module) => boolean,
 *   log: (what: string, detail?: string) => void,
 *   told: (id: string) => boolean,
 *   readLatch: (name: string) => string | null,
 * }} Ctx the kit's context, the part this core reads, and its own ports
 */

/* The id the plain-`--full` limb latches under (workflow-core#181), in the `warn.<id>`
 * namespace and never a rule-text id: the limb composes its own wording. */
const FULL_LIMB_ID = "full-suite-admissible";

/*
 * The limb's fire needle (scripts/guard-fire-needles.json,
 * `full-suite-admissible`, workflow-core#188) keys on `WOULD MEET THE PUSH GATE HERE`.
 * Reword that clause and move the needle with it.
 */
const FULL_LIMB_TEXT =
	"A BARE `npm run test` WOULD MEET THE PUSH GATE HERE, AND THIS `--full` BUYS NOTHING MORE (workflow-core#181). The read graph renders from this tree, so the diff's selection widened by its readers is ADMISSIBLE — and an admissible certificate IS the whole push gate: no whole-suite run is owed (mantahostels#2207). A full run costs ~373 s here (workflow-core#149). Want the whole suite for its own sake? Run it — this is advice, not a refusal.";

/**
 * The build-concurrency fragment, or its fallback where the store cannot give
 * it; the fault is logged.
 * @param {Ctx} ctx
 */
const buildRule = (ctx) =>
	ruleOrFallback(
		ctx,
		"build-concurrency",
		"Never run two builds or two dev servers at once",
		() =>
			ctx.log(
				"rule text build-concurrency unreadable — its fallback line written instead",
			),
	);

const STANDDOWN_LOG = ".suite-standdowns.jsonl";

/* What one finished-but-resident session holds (reap-finished-sessions.js). */
const REAP_GAIN = "330-450 MB";
const trimEnd = (/** @type {string} */ s) => s.replace(/[ \t\n\v\f\r]+$/, "");
const trimStart = (/** @type {string} */ s) => s.replace(/^[ \t\n\v\f\r]+/, "");
/* A trailing `#` comment cut, as bash's `${x%%[[:space:]]#*}` cuts it. */
const cutComment = (/** @type {string} */ s) =>
	s.replace(/[ \t\n\v\f\r]#[\s\S]*$/, "");

/**
 * Whether the launch asks for the WHOLE suite (mantahostels#3209), off every
 * word: `--full`, or `--full=<cause>` (workflow-core#182). A quoted one is not the flag.
 * @param {string[]} words
 */
const hasFullFlag = (words) =>
	words.some((w) => w === "--full" || w.startsWith("--full="));

/**
 * Whether the launch asks to QUEUE rather than to run now (mantahostels#2024):
 * the deny obeyed, not escaped. A quoted `--queue` is not the flag.
 * @param {string[]} words
 */
const hasQueueFlag = (words) => words.includes("--queue");

/**
 * Whether `word` is npm's `run` command as npm 11.16.0's cmd-list derefs it:
 * `run`, its aliases `rum`, `urn` and `run-script`, or an abbreviation of one.
 * @param {string} word
 */
const isNpmRun = (word) =>
	["run", "rum", "urn", "ur"].includes(word) ||
	(word.startsWith("run-") && "run-script".startsWith(word));

/**
 * Whether the words launch `next <sub>`: `npm run <sub>`, its flags read as
 * npm reads them wherever they stand; `npx next <sub>`; or `next` by name or
 * path.
 * @param {"build" | "dev"} sub
 * @param {string[]} words
 */
function isNextLaunch(sub, words) {
	const [w0 = "", w1, w2] = words;
	if (w0 === "npx") return w1 === "next" && w2 === sub;
	if (w0 === "next" || w0.endsWith("/next")) return w1 === sub;
	if (w0 !== "npm") return false;
	const canon = npmCanon(words.slice(1));
	const dash = canon.indexOf("--");
	const positional = [
		...(dash < 0 ? canon : canon.slice(0, dash)).filter(
			(w) => !w.startsWith("--"),
		),
		...(dash < 0 ? [] : canon.slice(dash + 1)),
	];
	return isNpmRun(positional[0] ?? "") && positional[1] === sub;
}

/**
 * The `next <sub>` runners `ps` shows: the binary's path, so npm's `sh -c next
 * build` and a line merely quoting the words are not counted. A build also
 * counts by the `next-build (v…)` title it sets on itself; a dev server's
 * parent keeps its path for its life, and the `next-server (v…)` title its
 * child takes is `next start`'s too, so it is not read.
 * @param {"build" | "dev"} sub
 * @param {import("./suite-ladder.js").PsRow[]} ps
 */
function runningNext(sub, ps) {
	const title = sub === "build" ? "^ *next-build \\(v|" : "";
	const runner = new RegExp(`${title}([.]bin|/dist/bin)/next ${sub}( |$)`);
	return ps.filter(({ args }) => runner.test(args) && !WRAPPER_ARGV0.test(args))
		.length;
}

const SHELL_KEYWORDS = [
	"do",
	"then",
	"else",
	"elif",
	"if",
	"while",
	"until",
	"{",
	"!",
];

/**
 * A segment split at its leading assignments: those, and the rest. A shell
 * keyword the segment opens with is dropped from both.
 * @param {string} segment
 * @returns {{ lead: string, rest: string }}
 */
function splitLead(segment) {
	let rest = segment;
	let lead = "";
	for (;;) {
		const ws = /^[ \t\n\v\f\r]*/.exec(rest)?.[0] ?? "";
		const word = /^[^ \t\n\v\f\r]*/.exec(rest.slice(ws.length))?.[0] ?? "";
		if (!SHELL_KEYWORDS.includes(word)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) return { lead, rest };
			lead += ws + word;
		}
		rest = rest.slice(ws.length + word.length);
	}
}

const dropTrailingDash = (/** @type {string} */ s) =>
	s.endsWith(" --") ? s.slice(0, -3) : s;

/** A launch with its `--queue`, and the lone ` --` that leaves, dropped. */
const unqueued = (/** @type {string} */ s) =>
	dropTrailingDash(s.replace(" --queue", ""));

/**
 * The typed launch with scripts/queue-run.js put in front of it (workflow-core#1776),
 * behind the segment's leading assignments, which a spawn cannot take as a
 * command, and ahead of any wrapper, so a `timeout` bounds the run and not the
 * wait. A shell keyword the segment opens with — the `do` of a loop — is
 * dropped, the launch being only what follows it. So is a `--queue`.
 * @param {string} segment
 * @param {string[]} spans
 * @param {string} queueRun
 */
function queuedLaunch(segment, spans, queueRun) {
	const { lead, rest } = splitLead(cutComment(segment));
	const ledBy = trimStart(asWritten(lead, spans));
	const out = unqueued(trimEnd(asWritten(trimStart(rest), spans)));
	return `${ledBy ? `${ledBy} ` : ""}node ${queueRun} -- ${out}`;
}

/**
 * @typedef {object} St what one command's walks share
 * @property {Ctx} ctx
 * @property {string[]} spans
 * @property {(w: string) => string} typed a word as typed: a quoted span put
 *   back where it reads whole, else the masked word, which no launch spelling
 *   matches
 * @property {import("./suite-launch.js").LaunchPorts} launchPorts
 * @property {() => import("./suite-ladder.js").PsRow[] | null} readPs `ps`,
 *   read once a command
 * @property {string} watcherSegment the first segment opening a watcher
 * @property {boolean} escaped whether the command carries the escape
 * @property {string} trimmedCommand the raw command, comment cut and trimmed
 * @property {boolean} ruleSubject whether a test launch earns suite-tree-dirty
 * @property {string[] | null} fullLaunchWords the first `--full` launch's argv
 * @property {string} memoryKind the first build or whole-suite run's name
 * @property {number} memoryMb the MemAvailable read for it
 * @property {boolean} standdownLogged
 *
 * @typedef {object} Subject one launch this guard judges
 * @property {"test" | "build"} kind
 * @property {import("./suite-launch.js").LaunchKind | undefined} launchKind
 * @property {boolean} other a runner other than vitest (workflow-core#330)
 * @property {boolean} plain an npm script not running run-vitest.js
 * @property {boolean} narrowed
 * @property {boolean} part
 * @property {boolean} reaps whether the command reaps for itself on the way
 *   in: npm runs a pre-script for `test` and `test:changed` alone (workflow-core#633)
 * @property {boolean} queued
 * @property {number} workers
 *
 * @typedef {object} Judged a subject against the machine
 * @property {string} segment
 * @property {string[]} words
 * @property {Subject} s
 * @property {number} mb
 * @property {Running | null} running null where `ps` went unread
 * @property {number} whole
 * @property {number} busy
 * @property {number} watching
 * @property {number} floor the rung this launch reaches
 * @property {number} nth
 * @property {string} lever
 * @property {string} tail
 * @property {string} watchLimb
 * @property {string} waitLever
 * @property {boolean} refusable a test launch not queued
 * @property {string} typedLaunch
 */

/**
 * @param {string} command
 * @param {import("./shell-parse.js").Parsed} parsed
 * @param {Ctx} ctx
 * @returns {St}
 */
function buildState(command, parsed, ctx) {
	const { spans } = parsed;
	/** @type {string[] | undefined} */
	let runners;
	/** @type {import("./suite-ladder.js").PsRow[] | null | undefined} */
	let ps;
	return {
		ctx,
		spans,
		typed: (w) => {
			if (!w.includes(QUOTED)) return w;
			const lit = literal(w, spans);
			return lit.known ? lit.text : w;
		},
		launchPorts: {
			runners: () => {
				runners ??= ctx.runners();
				return runners;
			},
			isWrapperScript: ctx.isWrapperScript,
		},
		readPs: () => {
			if (ps === undefined) ps = ctx.psRows();
			return ps;
		},
		watcherSegment: "",
		escaped: false,
		trimmedCommand: trimEnd(trimStart(cutComment(command))),
		ruleSubject: false,
		fullLaunchWords: null,
		memoryKind: "",
		memoryMb: 0,
		standdownLogged: false,
	};
}

/**
 * @param {St} st
 * @param {string[]} words masked, unwrapped
 */
const launchOf = (st, words) =>
	suiteLaunchKind(words.map(st.typed), st.launchPorts);

/** @param {Launch | null} l */
const isTest = (l) => l !== null && l.kind !== "npm-py";

/**
 * THE WATCHER AND THE ESCAPE ARE FOUND BEFORE ANY SEGMENT IS JUDGED
 * (mantahostels#1978, mantahostels#2486): a command gets one message, and a
 * PreToolUse deny stops the whole command, so the escape's unit is the command
 * too. The first watcher wins. The prefix never reaches the hook's
 * environment; that is read for the callers with no command to prefix: a
 * script, a benchmark, CI.
 * @param {St} st
 * @param {import("./shell-parse.js").Parsed} parsed
 */
function prePass(st, parsed) {
	walkCommands(
		parsed,
		(cmd) => {
			const carried = carriesVar(
				"WFC_SUITE_CONCURRENT",
				cmd.leading,
				cmd.words,
				st.spans,
			);
			const words = unwrap(cmd.words, st.spans).words;
			if (words.length === 0) return;
			const launch = launchOf(st, words);
			if (!isTest(launch)) return;
			if (carried) st.escaped = true;
			if (launch?.kind === "npm-watch" && !st.watcherSegment)
				st.watcherSegment = cmd.segment;
		},
		st.ctx,
	);
	if (st.ctx.vars.WFC_SUITE_CONCURRENT) st.escaped = true;
}

/**
 * The words as one string, an npm script launch spelt with `run` whatever
 * its spelling and a trailing lone `--` dropped.
 * @param {St} st
 * @param {string[]} given
 */
function launchKey(st, given) {
	const words = [...given];
	if (words.at(-1) === "--") words.pop();
	const head = afterSlash(words[0] ?? "");
	if (head === "npm" && words[1] === "t") words[1] = "test";
	if (head === "npm" && words[1] === "run-script") words[1] = "run";
	const launch = launchOf(st, words);
	const key = launch?.script
		? [head, "run", launch.script, ...words.slice(launch.taken)]
		: words;
	return key.join(" ");
}

/**
 * THE HOST'S WHOLE-SUITE LAUNCH (workflow-core#2237): its declared `commands.test` typed
 * with nothing after it but a lone `--`. `npm test`, `npm t` and `npm run
 * test` are one launch. A command running run-vitest.js is no whole suite,
 * bare: that runner selects from the diff. Any further word reads as
 * narrowing, and a declared command holding a quoted word never matches.
 * @param {St} st
 * @param {import("./shell-parse.js").Parsed} parsed
 */
function wholeSuiteLaunch(st, parsed) {
	const declared = (st.ctx.declaredTest() ?? "")
		.split(/[ \t\n]+/)
		.filter(Boolean);
	if (declared.length === 0) return false;
	const key = launchKey(st, declared);
	let found = false;
	walkCommands(
		parsed,
		(cmd) => {
			if (found) return;
			const words = unwrap(cmd.words, st.spans).words;
			if (words.length === 0 || launchKey(st, words) !== key) return;
			const launch = launchOf(st, words);
			if (launch?.kind === "wrapper") return;
			if (launch?.script && st.ctx.isWrapperScript(launch.script)) return;
			found = true;
		},
		st.ctx,
	);
	return found;
}

/**
 * The memory figure for a `test:py` run naming no path (workflow-core#2024). Any word not
 * opening with `-` is read as a path, so a flag's value narrows it.
 * @param {St} st
 * @param {string[]} argv
 */
function notePytestFigure(st, argv) {
	if (st.memoryKind || argv.some((w) => !w.startsWith("-"))) return;
	const mb = st.ctx.availableMb();
	if (mb === null) return;
	st.memoryKind = "full test";
	st.memoryMb = mb;
}

/** @returns {Subject} */
const buildBlankSubject = () => ({
	kind: "test",
	launchKind: undefined,
	other: false,
	plain: false,
	narrowed: false,
	part: false,
	reaps: false,
	queued: false,
	workers: WHOLE_SUITE_WORKERS,
});

/**
 * A test launch as this guard charges it.
 * @param {St} st
 * @param {Launch} launch
 * @param {string[]} words
 * @returns {Subject}
 */
function buildTestSubject(st, launch, words) {
	const s = { ...buildBlankSubject(), launchKind: launch.kind };
	st.ruleSubject = true;
	/* Not vitest (workflow-core#330): no `pretest` reap, no `--full`, and its queue is
	 * scripts/queue-run.js rather than `--queue` (workflow-core#1776). */
	if (launch.kind === "other")
		return { ...s, other: true, queued: launch.queued };
	const files = launchTestFileCount(
		launch,
		words,
		(w) => literal(w, st.spans).text,
	);
	const watch = launch.kind === "npm-watch";
	const weight = launchWeigh(st, launch, words, files);
	if (weight.part) {
		s.workers = weight.workers;
		s.part = true;
	}
	/* `test:watch` runs the whole suite and takes no `--full`. */
	s.narrowed = files !== null || (!watch && !hasFullFlag(words));
	s.reaps = launch.kind === "npm-vitest";
	s.plain = !!launch.script && !st.ctx.isWrapperScript(launch.script);
	/* The FIRST `--full` launch in the command, kept for the limb (workflow-core#181). */
	if (!watch && !st.fullLaunchWords && hasFullFlag(words))
		st.fullLaunchWords = words.slice(launch.taken).map(st.typed);
	return s;
}

/**
 * A test launch's weight: the one the queue hands in, else a touched run's,
 * which takes no whole slot (workflow-core#2935), else its named files'.
 * @param {St} st
 * @param {Launch} launch
 * @param {string[]} words
 * @param {number | null} files
 */
function launchWeigh(st, launch, words, files) {
	if (st.ctx.launchWeight) return weighCarried(st.ctx.launchWeight);
	if (isTouchedLaunch(st, launch, words))
		return weighCarried({ resolvedFiles: files, wholeSlot: false });
	return weighFiles(files);
}

/**
 * Whether a wrapper or npm vitest launch is a touched run (workflow-core#2935), read off
 * its words as run-vitest.js routes them: such a run is never held at the
 * count cap, and a bare one, its selection unresolved, is charged a whole
 * suite's workers on the memory rung.
 * @param {St} st
 * @param {Launch} launch
 * @param {string[]} words
 */
function isTouchedLaunch(st, launch, words) {
	const argv = launchArgv(launch, words);
	if (argv === null || launch.script === "test:changed") return false;
	return isTouchedRun(
		launchRoute(
			argv.map((w) => literal(w, st.spans).text),
			null,
			{ landing: st.ctx.moduleOn("landing") },
		),
	);
}

/**
 * What this guard judges in one command's words: a subject, or a verdict
 * reached on the words alone — undefined where the walk goes on.
 * @param {St} st
 * @param {string[]} words
 * @param {string} segment
 * @returns {{ subject: Subject } | { verdict: Verdict | undefined }}
 */
function subjectOf(st, words, segment) {
	const launch = launchOf(st, words);
	if (launch?.kind === "npm-py") {
		notePytestFigure(st, words.slice(launch.taken));
		return { verdict: undefined };
	}
	if (launch) return { subject: buildTestSubject(st, launch, words) };
	if (isNextLaunch("build", words)) {
		const denied = denySecondNext(st, "build", "", segment);
		return denied
			? { verdict: denied }
			: { subject: { ...buildBlankSubject(), kind: "build" } };
	}
	if (isNextLaunch("dev", words))
		return { verdict: denySecondNext(st, "dev", " server", segment) };
	if (isTscLaunch(words)) return { verdict: denyBareTsc(st, segment) };
	return { verdict: undefined };
}

/**
 * A bare `tsc` the type-check slot would hold (workflow-core#3163): denied, line one the
 * same launch through `queue-run.js --tsc`, which waits for the slot. A
 * launch the slot would admit passes; no escape stands the deny down, the
 * queue being the way through.
 * @param {St} st
 * @param {string} segment
 * @returns {Verdict | undefined}
 */
function denyBareTsc(st, segment) {
	const ps = st.readPs();
	const mb = st.ctx.availableMb();
	if (ps === null)
		st.ctx.log("ps unreadable — a `tsc` launch judged as if none were running");
	if (mb === null)
		st.ctx.log(
			"MemAvailable unreadable — a `tsc` launch judged off its count alone",
		);
	const denial = tscDenial(ps, mb);
	if (denial === null) return;
	const launch = queuedLaunch(
		segment,
		st.spans,
		`${st.ctx.scriptPath("queue-run.js")} --tsc`,
	);
	const line = insteadLine(st, typedLaunchOf(st, segment), launch);
	const why =
		denial.limb === "count"
			? "A `tsc` is already running, and the machine runs one at a time (docs/environment.md §6, workflow-core#3163)."
			: `MemAvailable is ${denial.mb} MB, under the ~${TSC_RUNG_MB} MB docs/environment.md §6 says a \`tsc\` needs resting.`;
	return {
		deny: st.ctx.corePaths(
			`${line}\n${why} \`queue-run.js --tsc\` waits for the type-check slot, then runs that command.`,
		),
	};
}

/**
 * A segment's launch as typed: comment cut, quoted spans put back, trimmed.
 * @param {St} st
 * @param {string} segment
 */
const typedLaunchOf = (st, segment) =>
	trimEnd(trimStart(asWritten(cutComment(segment), st.spans)));

/**
 * A deny's line one: the launch to run, as the whole command where the
 * segment is the whole command, else as the launch to swap in (workflow-core#482).
 * @param {St} st
 * @param {string} typed the segment's launch as typed
 * @param {string} launch
 */
const insteadLine = (st, typed, launch) =>
	typed === st.trimmedCommand
		? `Run instead: ${launch}`
		: `Run the command with this launch in place of its own: ${launch}`;

/**
 * Deny where a `next <sub>` is already running. Neither is on the ladder or
 * measured, so the count alone judges, and no escape stands it down.
 * @param {St} st
 * @param {"build" | "dev"} sub
 * @param {string} what
 * @param {string} segment
 * @returns {Verdict | undefined}
 */
function denySecondNext(st, sub, what, segment) {
	const out = st.readPs();
	if (out === null) {
		st.ctx.log(
			`ps unreadable — a \`next ${sub}\` launched without counting running ones`,
		);
		return;
	}
	if (runningNext(sub, out) === 0) return;
	return {
		deny: denyText(
			st.ctx,
			segment,
			`A \`next ${sub}\`${what} is already running, so this would be a second: @CMD@\n\n${buildRule(st.ctx)}`,
		),
	};
}

/**
 * The suites running, for a test launch; null where `ps` went unread, which
 * is judged as if none were running. A build is never counted, being off the
 * ladder.
 * @param {St} st
 * @param {Subject} s
 */
function readRunning(st, s) {
	if (s.kind !== "test") return null;
	const out = st.readPs();
	if (out === null) {
		st.ctx.log(
			"ps unreadable — a suite launch judged as if no suite were running",
		);
		return null;
	}
	return runningSuites(
		out,
		(w) => isOtherRunner(w, st.launchPorts.runners),
		st.ctx.carriedOf,
	);
}

/**
 * The watcher's limb, carried on whichever message fires (mantahostels#1927).
 * @param {St} st
 * @param {string} segment
 */
function watchLimbOf(st, segment) {
	if (!st.watcherSegment) return "";
	const opener =
		st.watcherSegment === segment
			? "This opens a WATCHER"
			: `Another segment of this command opens a WATCHER (\`${unmask(st.watcherSegment)}\`)`;
	return `${opener}, which runs the whole suite now AND holds a full rung for as long as it stays open — it re-runs on any file save, and \`ps\` cannot tell an idle watcher from a running one, so it is counted the whole time. Close it (\`q\` in its terminal) when you stop iterating.`;
}

/**
 * An open watcher does not end on its own, so "wait for one to finish" is
 * advice a session cannot take when the neighbours are all watchers.
 * @param {Running | null} running
 */
function waitLeverOf(running) {
	const watching = running?.watchers ?? 0;
	if (watching > 0 && watching === running?.total)
		return "Every one of them is an open watcher, and a watcher never finishes on its own — close one";
	if (watching > 0)
		return `Wait for a one-shot run to finish, or close one of the ${watching} open watchers, which never finish on their own`;
	return "Wait for one to finish";
}

/**
 * @param {St} st
 * @param {{ segment: string, words: string[] }} at the segment and its words,
 *   unwrapped
 * @param {Subject} s
 * @param {number} mb
 * @returns {Judged}
 */
function judgedOf(st, at, s, mb) {
	const { segment, words } = at;
	const running = readRunning(st, s);
	const busy = running?.workers ?? 0;
	const watchLimb = watchLimbOf(st, segment);
	const test = s.kind === "test";
	const queued =
		s.queued ||
		(!(s.other || s.plain) &&
			s.launchKind !== "npm-watch" &&
			hasQueueFlag(words));
	return {
		segment,
		words,
		s,
		mb,
		running,
		whole: running?.whole ?? 0,
		busy,
		watching: running?.watchers ?? 0,
		floor: suiteRungMb(busy + s.workers),
		nth: running ? running.whole + 1 : 1,
		/* Telling a narrowed launcher to narrow the run is a no-op. */
		lever: s.narrowed
			? "since this run is already narrowed as far as it goes"
			: "or narrow the run",
		/* Every warning ends with the command it is about, so the limb goes
		 * before it. */
		tail: watchLimb
			? `. ${watchLimb} The command: ${unmask(segment)}`
			: `: ${unmask(segment)}`,
		watchLimb,
		waitLever: waitLeverOf(running),
		refusable: test && !queued,
		typedLaunch: test ? typedLaunchOf(st, segment) : "",
	};
}

/**
 * A warning: one message a command, and no rule beside it.
 * @param {St} st
 * @param {string} text
 * @returns {Verdict}
 */
const buildWarnVerdict = (st, text) => ({
	injectRules: [],
	prelude: st.ctx.corePaths(text),
});

/**
 * Record one deliberate override of a deny (mantahostels#2183), once per
 * command: a second stand-down in it reads the same `ps` as the first. Its
 * `command` is the segment as the parser rendered it, each quoted span `"…"`.
 * @param {St} st
 * @param {Judged} j
 * @param {"count" | "memory"} limb
 */
function logStanddown(st, j, limb) {
	if (st.standdownLogged) return;
	st.standdownLogged = true;
	const line = JSON.stringify({
		at: st.ctx.now(),
		session: st.ctx.sessionId,
		running: j.whole,
		nth: j.nth,
		limb,
		command: trimEnd(unmask(j.segment)),
	});
	if (!st.ctx.appendStanddown(line))
		st.ctx.log(
			`could not append to ${STANDDOWN_LOG} — one override of the suite deny went uncounted`,
		);
}

/**
 * A watcher's line one: the wait, then the same launch (workflow-core#1927).
 * @param {St} st
 * @param {Judged} j
 * @param {string} watchLever
 */
function watcherFix(st, j, watchLever) {
	const launch = unqueued(j.typedLaunch);
	const how =
		j.typedLaunch === st.trimmedCommand
			? "re-run"
			: "re-run the command with this launch in place of its own";
	return {
		line: `${watchLever}, then ${how}: ${launch} — a watcher never finishes, so no queue takes it.`,
		more: "",
	};
}

/**
 * A queueable launch's line one: the launch with `--queue` — `-- --queue` on
 * an npm launch carrying no `--` — or through scripts/queue-run.js (workflow-core#1776). A
 * compound command's other parts — a `cd` first — still matter.
 * @param {St} st
 * @param {Judged} j
 */
function queueFix(st, j) {
	const viaQueueRun = j.s.other || j.s.plain;
	const flag =
		j.words[0] === "npm" && !j.words.includes("--")
			? " -- --queue"
			: " --queue";
	const launch = viaQueueRun
		? queuedLaunch(j.segment, st.spans, st.ctx.scriptPath("queue-run.js"))
		: `${j.typedLaunch}${flag}`;
	const waits = viaQueueRun ? "`queue-run.js`" : "`--queue`";
	const allWatchers = j.watching > 0 && j.watching === j.running?.total;
	return {
		line: insteadLine(st, j.typedLaunch, launch),
		more: ` ${waits} waits for this gate to open, then runs that command.${allWatchers ? ` ${j.waitLever}, or the queue waits for good.` : ""}`,
	};
}

/**
 * Refuse a refusable launch, line one being the command that waits instead
 * (workflow-core#482, workflow-core#519). `gate` names the limb for the queue's poll (workflow-core#2421); the kit
 * sends the session the deny alone.
 * @param {St} st
 * @param {Judged} j
 * @param {{ gate: Gate, watchLever: string, why: string, waiter: string,
 *   escapeLead: string }} d
 * @returns {Verdict}
 */
function denyToQueue(st, j, d) {
	const fix =
		j.s.launchKind === "npm-watch"
			? watcherFix(st, j, d.watchLever)
			: queueFix(st, j);
	const reason = `${fix.line}\n${d.why}${fix.more} ${d.waiter} ${d.escapeLead} Prefix the command with WFC_SUITE_CONCURRENT=1, which is recorded.${j.watchLimb ? ` ${j.watchLimb}` : ""}`;
	return { deny: st.ctx.corePaths(reason), gate: d.gate };
}

/**
 * THE COUNT CAP (workflow-core#2680): one whole suite at a time; a part-suite takes no
 * whole-suite slot. Past it, what the deny let through — a part-suite, a
 * `--queue`, a stand-down (workflow-core#159) — is warned: past the ladder's last rung
 * every launch, but a refusable part-suite short of its own rung goes on to
 * the memory deny; inside the ladder a whole suite past the cap only where
 * its rung is met.
 * @param {St} st
 * @param {Judged} j
 * @returns {Verdict | undefined}
 */
function countVerdict(st, j) {
	if (!j.running) return;
	const { s } = j;
	if (j.nth > WHOLE_SUITE_MAX && j.refusable && !s.part) {
		if (!st.escaped)
			return denyToQueue(st, j, {
				gate: { limb: "count" },
				watchLever: j.waitLever,
				why: `${j.whole} whole suite(s) already running, and the machine runs one at a time (docs/environment.md §6, workflow-core#2680).`,
				waiter:
					s.other || s.plain
						? "Do not write your own waiter."
						: "Do not write your own waiter: one grepping `ps` for `vitest` counts the npm wrapper and every worker as suites, so it can wait for a gap that never comes.",
				escapeLead: `Genuinely need suite ${j.nth} at once?`,
			});
		logStanddown(st, j, "count");
	}
	const pastLadder =
		j.nth > SUITE_MAX && !(j.refusable && s.part && j.mb < j.floor);
	const pastCap = j.nth > WHOLE_SUITE_MAX && !s.part && j.mb >= j.floor;
	if (!pastLadder && !pastCap) return;
	return buildWarnVerdict(
		st,
		s.part
			? `This run's ${s.workers} vitest worker(s) would join ${j.whole} suites on a machine measured to ${SUITE_MAX} (docs/environment.md §6). Past the ladder's last rung nothing has been measured, and neighbour load is what actually sets a suite's wall-clock (mantahostels#1906). ${j.waitLever}, ${j.lever}${j.tail}`
			: `This would be suite ${j.nth} on a machine that runs whole suites one at a time (docs/environment.md §6, workflow-core#2680) — ${j.whole} already going, and neighbour load is what actually sets a suite's wall-clock (mantahostels#1906). ${j.waitLever}, ${j.lever}${j.tail}`,
	);
}

/** @param {Judged} j */
function rungClause(j) {
	if (j.s.part)
		return ` for the ${j.s.workers} vitest worker(s) its named files can occupy, beside ${j.busy} running`;
	if (j.busy > j.whole * WHOLE_SUITE_WORKERS)
		return ` for ${j.busy + j.s.workers} vitest workers, ${j.busy} of them already running`;
	return j.nth > 1 ? ` as suite ${j.nth} of ${SUITE_MAX}` : "";
}

/**
 * THE MEMORY LADDER (workflow-core#2305): a refusable launch short of its rung is sent to
 * the queue, anything else warned. The message names the reap
 * (mantahostels#1930); pretest-reap.js judges the rung for the suite being
 * started (workflow-core#627).
 * @param {St} st
 * @param {Judged} j
 * @returns {Verdict | undefined}
 */
function memoryVerdict(st, j) {
	if (j.mb >= j.floor) return;
	const rung = rungClause(j);
	const reapCmd = `node ${st.ctx.scriptPath("reap-finished-sessions.js")}`;
	if (j.refusable) {
		if (!st.escaped) {
			const reapNote = j.s.reaps
				? "Its `pretest` reaps finished sessions before the wait (`pretest-reap.js`, mantahostels#1840)."
				: `Reaping finished-but-resident sessions (\`${reapCmd}\`) gives back ${REAP_GAIN} each, and may open the gate at once.`;
			return denyToQueue(st, j, {
				gate: { limb: "memory", mb: j.mb, rungMb: j.floor },
				watchLever: `Reap finished sessions (\`${reapCmd}\`) or wait for MemAvailable to reach ~${j.floor} MB`,
				why: `MemAvailable is ${j.mb} MB, under the ~${j.floor} MB docs/environment.md §6 says a test run needs resting${rung}, and earlyoom's SIGTERM line is 8% of the cap.`,
				waiter: `${reapNote} Do not write your own waiter.`,
				escapeLead: "Genuinely need it now?",
			});
		}
		logStanddown(st, j, "memory");
	}
	const reapLever = j.s.reaps
		? "This command reaps finished sessions before vitest starts (`pretest-reap.js`, mantahostels#1840), so this reading does not say what the run will get — launch it and read what the reap prints, remembering it reclaims nothing from a LIVE neighbour"
		: `Reap the finished-but-resident sessions first (\`${reapCmd}\`) and re-read — a stopped session gives back ${REAP_GAIN}, though a shortfall held by LIVE neighbours is reaped by nothing`;
	return buildWarnVerdict(
		st,
		`MemAvailable is ${j.mb} MB, under the ~${j.floor} MB docs/environment.md §6 says a ${j.s.kind} run needs resting${rung} — earlyoom's SIGTERM line is 8% of the cap. ${reapLever}. Only a machine still short after that is a §Machine limits refusal, ${j.lever}${j.tail}`,
	);
}

/**
 * A build or a whole-suite run owes a before-and-after reading (workflow-core#2024); a
 * non-vitest runner and a watcher do not. The first such launch in the
 * command is the one the injection reports.
 * @param {St} st
 * @param {Subject} s
 * @param {number} mb
 */
function noteMemoryFigure(st, s, mb) {
	if (st.memoryKind || s.narrowed || s.other || s.launchKind === "npm-watch")
		return;
	st.memoryKind = s.kind === "build" ? "build" : "full test";
	st.memoryMb = mb;
}

/**
 * One command's words judged; undefined where the walk goes on.
 * @param {St} st
 * @param {Command} cmd
 * @returns {Verdict | undefined}
 */
function judge(st, cmd) {
	const words = unwrap(cmd.words, st.spans).words;
	if (words.length === 0) return;
	const got = subjectOf(st, words, cmd.segment);
	if (!("subject" in got)) return got.verdict;
	const s = got.subject;
	const mb = st.ctx.availableMb();
	if (mb === null) {
		st.ctx.log(
			`MemAvailable unreadable — a ${s.kind} launch allowed unchecked`,
		);
		return null;
	}
	noteMemoryFigure(st, s, mb);
	const j = judgedOf(st, { segment: cmd.segment, words }, s, mb);
	const verdict = countVerdict(st, j) ?? memoryVerdict(st, j);
	if (verdict !== undefined) return verdict;
	/* The watcher limb, on the watcher's OWN segment alone. */
	return st.watcherSegment === cmd.segment
		? buildWarnVerdict(st, `${j.watchLimb} The command: ${unmask(cmd.segment)}`)
		: undefined;
}

/**
 * The plain-`--full` limb (workflow-core#181): its latch is tested first and is its own,
 * the check costing a read-graph render, paid once a session. A fault leaves
 * it unsaid, on the record.
 * @param {St} st
 */
function fullLimb(st) {
	if (!st.fullLaunchWords || st.ctx.told(FULL_LIMB_ID)) return false;
	const full = st.ctx.fullLaunchPlain(st.fullLaunchWords);
	if ("plain" in full) return full.plain;
	st.ctx.log(
		`the plain-\`--full\` check did not run — limb unsaid: ${full.fault || "no message"}`,
	);
	return false;
}

/**
 * PRE-EMPTIVE INJECTION (mantahostels#1805): reached only where nothing spoke,
 * so a session told to wait is handed no rule about a run it has not started.
 * Every notice of this guard's own travels as the prelude, ahead of the rules.
 * @param {St} st
 * @param {boolean} whole the host's whole-suite launch
 * @returns {Verdict}
 */
function injectionOf(st, whole) {
	if (!(st.ruleSubject || whole) && !st.memoryKind) return null;
	const limb = fullLimb(st);
	const prelude = limb ? [FULL_LIMB_TEXT] : [];
	/** @type {string[]} */
	const skip = [];
	if (!st.ruleSubject) skip.push("suite-tree-dirty");
	/* The figure goes out only with the rule's first telling, which says the
	 * later readings are the session's own to take. */
	if (!st.memoryKind) skip.push("memory-figure");
	else if (st.ctx.readLatch("memory-figure") === null)
		prelude.push(
			`BEFORE THIS ${st.memoryKind.toUpperCase()} RUN, MemAvailable reads ${st.memoryMb} MB.`,
		);
	if (!whole) skip.push("targeted-runs");
	skip.push(...ruleModule(st.ctx, "suites", ["targeted-runs"]));
	return {
		injectRules: ["targeted-runs", "suite-tree-dirty", "memory-figure"],
		skip,
		...(prelude.length > 0 ? { prelude: prelude.join("\n\n") } : {}),
		...(limb ? { latchAfter: FULL_LIMB_ID } : {}),
	};
}

/**
 * @param {string} command
 * @param {Ctx} ctx
 * @returns {Verdict}
 */
function decide(command, ctx) {
	const parsed = parseCommand(command);
	const st = buildState(command, parsed, ctx);
	prePass(st, parsed);
	const whole = wholeSuiteLaunch(st, parsed);
	/** @type {Verdict | undefined} */
	let verdict;
	walkCommands(
		parsed,
		(cmd) => {
			if (verdict === undefined) verdict = judge(st, cmd);
		},
		ctx,
	);
	return verdict === undefined ? injectionOf(st, whole) : verdict;
}

module.exports = { decide, FULL_LIMB_ID, STANDDOWN_LOG };
