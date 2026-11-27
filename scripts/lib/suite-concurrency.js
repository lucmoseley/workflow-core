const { denyText, ruleOrFallback } = require("./guard-verdict.js");
const {
	BASH_SPACE,
	asWritten,
	parseCommand,
	unmask,
	walkCommands,
} = require("./shell-parse.js");
const { QUOTED, literal, runText } = require("./shell-words.js");
const {
	SUITE_MAX,
	WHOLE_SUITE_MAX,
	clampedClause,
	isNextRunnerLine,
	reachableRung,
	rungMb,
	runningSuites,
	suiteRungMb,
} = require("./suite-ladder.js");
const {
	bucketOf,
	partKindOfRoute,
	peakClause,
} = require("./part-suite-peak.js");
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
	isWholePytestRun,
	npmScriptOf,
	hasNamedTestFiles,
	pytestPathWords,
	suiteLaunchKind,
	buildIsWrapperScript,
} = require("./suite-launch.js");
const { isNpmRun, npmCanon } = require("./npm-options.js");
const { tscDenial, tscLaunchBin } = require("./tsc-slot.js");
const {
	buildWindowsShortText,
	readWindowsRecorded,
	windowsShortfall,
} = require("./windows-memory.js");
const { trimEndRun, trimRun, trimStartRun } = require("./trim-run.js");
const { treeOrHost } = require("./tree-or.js");

/**
 * @typedef {import("./suite-launch.js").Launch} Launch
 * @typedef {import("./suite-ladder.js").Running} Running
 * @typedef {import("./suite-queue.js").ClimbScope} ClimbScope
 * @typedef {import("./shell-parse.js").Command} Command
 * @typedef {import("./part-suite-peak.js").PartAdmission} PartAdmission
 * @typedef {Extract<PartAdmission, { mode: "peak" }>} PeakAdmission
 * @typedef {{ limb: "count" } | { limb: "memory", mb: number, rungMb: number, ladderMb?: number, climbMb?: number, busy?: number, peak?: import("./part-suite-peak.js").PeakCharge } | import("./gate-wait.js").WindowsHold} Gate
 * @typedef {import("./guard-entry.js").Decision | ({ deny: string, gate: Gate })} Verdict
 * @typedef {object} SuitePorts
 * @property {() => number | null} availableMb
 * @property {() => number | null} totalMb
 * @property {() => import("./windows-memory.js").WindowsRead} windowsMemory
 * @property {(scope: ClimbScope) => number} climbMb
 * @property {(dir: string, bin: string) => number} tscLaunchPeakMb
 * @property {() => import("./suite-ladder.js").PsRow[] | null} psRows
 * @property {(pid: number | null) => import("./suite-handoff.js").CarriedWeight | null} carriedOf
 * @property {() => import("./suite-ladder.js").GateSeats} gateSeats
 * @property {import("./suite-handoff.js").CarriedWeight | null} [launchWeight]
 * @property {number} [partCapMb] - #5802
 * @property {(run: { kind: import("./part-suite-peak.js").PartKind, files: number }) => { peak: import("./part-suite-peak.js").PartPeak | null } | { why: string }} partPeak
 * @property {() => import("./peak-tripwire.js").Fallback | null} tripwire
 * @property {(admission: PartAdmission) => void} [noteAdmission]
 * @property {() => string[]} runners
 * @property {() => string | null} declaredTest
 * @property {(tree: string) => boolean} testProven
 * @property {(argv: string[], tree: string) => { plain: boolean } | { fault: string }} fullLaunchPlain
 * @typedef {import("./shell-parse.js").WalkPorts & SuitePorts &
 *   Pick<import("./kit-context.js").KitContext, "scriptPath" | "corePaths" | "ruleText" | "docPath"> & {
 *   log: (what: string, detail?: string) => void,
 *   told: (id: string) => boolean,
 *   readLatch: (name: string) => string | null,
 *   tree: () => import("./guard-host-ports.js").TreePorts,
 * } & import("./guard-host-ports.js").TreePorts} Ctx
 */

/** @param {Ctx} ctx @returns {string} */
const treeRoot = (ctx) => treeOrHost(ctx).root;

const FULL_LIMB_ID = "full-suite-admissible";

const FULL_LIMB_TEXT =
	"THIS `--full` BUYS NOTHING (#181): THE QUEUE LANDER RUNS THE WHOLE SUITE ON EVERY LAND, SO A SESSION OWES ONLY ITS TOUCHED TESTS, A BARE `npm run test`. A full run costs ~373 s here (#149). Want the whole suite for its own sake? Run it — this is advice, not a refusal.";

/** @param {Ctx} ctx */
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

const REAP_GAIN = "330-450 MB";
const cutComment = (/** @type {string} */ s) =>
	s.replace(/[ \t\n\v\f\r]#[\s\S]*$/, "");

/** @param {string[]} words */
const hasFullFlag = (words) =>
	words.some((w) => w === "--full" || w.startsWith("--full="));

/** @param {string[]} words */
const hasQueueFlag = (words) => words.includes("--queue");

/**
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
 * @param {"build" | "dev"} sub
 * @param {import("./suite-ladder.js").PsRow[]} ps
 */
const runningNext = (sub, ps) =>
	ps.filter(({ args }) => isNextRunnerLine(sub, args)).length;

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

/** @param {string} segment @returns {{ lead: string, rest: string }} */
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

const unqueued = (/** @type {string} */ s) =>
	dropTrailingDash(s.replace(" --queue", ""));

/**
 * @param {string} segment
 * @param {string[]} spans
 * @param {string} queueRun
 */
function queuedLaunch(segment, spans, queueRun) {
	const { lead, rest } = splitLead(cutComment(segment));
	const ledBy = trimStartRun(asWritten(lead, spans), BASH_SPACE);
	const out = unqueued(
		trimEndRun(asWritten(trimStartRun(rest, BASH_SPACE), spans), BASH_SPACE),
	);
	return `${ledBy ? `${ledBy} ` : ""}node ${queueRun} -- ${out}`;
}

/**
 * @typedef {object} St
 * @property {Ctx} ctx
 * @property {string[]} spans
 * @property {(w: string) => string} typed
 * @property {import("./suite-launch.js").LaunchPorts} launchPorts
 * @property {() => import("./suite-ladder.js").PsRow[] | null} readPs
 * @property {(scope: ClimbScope) => number} readClimb
 * @property {string} watcherSegment
 * @property {string} trimmedCommand
 * @property {boolean} ruleSubject
 * @property {string[] | null} fullLaunchWords
 * @property {string} memoryKind
 * @property {number} memoryMb
 * @typedef {object} Subject
 * @property {"test" | "build"} kind
 * @property {import("./suite-launch.js").LaunchKind | undefined} launchKind
 * @property {boolean} other
 * @property {boolean} plain
 * @property {boolean} narrowed
 * @property {boolean} part
 * @property {boolean} reaps
 * @property {boolean} queued
 * @property {boolean} countOnly
 * @property {number} workers
 * @property {boolean} vitestPart
 * @property {import("./part-suite-peak.js").PartKind | null} partKind
 * @property {number | null} files
 * @typedef {object} Judged
 * @property {string} segment
 * @property {string[]} words
 * @property {Subject} s
 * @property {number} mb
 * @property {number} readMb
 * @property {number} climbMb
 * @property {ClimbScope} climbScope
 * @property {Running | null} running
 * @property {number} whole
 * @property {number} busy
 * @property {number} watching
 * @property {import("./suite-ladder.js").Reach} reach
 * @property {PeakAdmission | null} peak
 * @property {number | null} capMb
 * @property {number} nth
 * @property {string} lever
 * @property {string} tail
 * @property {string} watchLimb
 * @property {string} waitLever
 * @property {boolean} refusable
 * @property {string} launchText
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
	/** @type {Partial<Record<ClimbScope, number>>} */
	const climb = {};
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
			isWrapperScript: buildIsWrapperScript(() => treeOrHost(ctx), ctx.log),
		},
		readPs: () => {
			if (ps === undefined) ps = ctx.psRows();
			return ps;
		},
		readClimb: (scope) => {
			climb[scope] ??= ctx.climbMb(scope);
			return climb[scope];
		},
		watcherSegment: "",
		trimmedCommand: trimRun(cutComment(command), BASH_SPACE),
		ruleSubject: false,
		fullLaunchWords: null,
		memoryKind: "",
		memoryMb: 0,
	};
}

/** @param {St} st @param {string[]} words */
const launchOf = (st, words) =>
	suiteLaunchKind(words.map(st.typed), st.launchPorts);

/** @param {St} st @param {import("./shell-parse.js").Parsed} parsed */
function prePass(st, parsed) {
	walkCommands(
		parsed,
		(cmd) => {
			for (const { words } of cmd.runs()) {
				if (words.length === 0) continue;
				const launch = launchOf(st, words);
				if (launch?.kind === "npm-watch" && !st.watcherSegment)
					st.watcherSegment = cmd.segment;
			}
		},
		st.ctx,
	);
}

/** @param {string[]} given */
function launchKey(given) {
	const words = [...given];
	if (words.at(-1) === "--") words.pop();
	const run = npmScriptOf(words);
	const key = run
		? [afterSlash(words[0] ?? ""), "run", run.script, ...words.slice(run.taken)]
		: words;
	return key.join(" ");
}

/** @param {St} st @param {import("./shell-parse.js").Parsed} parsed */
function wholeSuiteLaunch(st, parsed) {
	const declared = (st.ctx.declaredTest() ?? "")
		.split(/[ \t\n]+/)
		.filter(Boolean);
	if (declared.length === 0) return false;
	const key = launchKey(declared);
	let found = false;
	walkCommands(
		parsed,
		(cmd) => {
			if (found) return;
			found = cmd.runs().some(({ words }) => {
				if (words.length === 0 || launchKey(words) !== key) return false;
				const launch = launchOf(st, words);
				if (launch?.kind === "wrapper") return false;
				return !(
					launch?.script && st.launchPorts.isWrapperScript(launch.script)
				);
			});
		},
		st.ctx,
	);
	return found;
}

/** @param {St} st @param {string[]} argv */
function notePytestFigure(st, argv) {
	if (st.memoryKind || pytestPathWords(argv).length > 0) return;
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
	countOnly: false,
	workers: WHOLE_SUITE_WORKERS,
	vitestPart: false,
	partKind: null,
	files: null,
});

/**
 * @param {St} st
 * @param {Launch} launch
 * @param {string[]} words
 * @returns {Subject}
 */
function buildTestSubject(st, launch, words) {
	const s = { ...buildBlankSubject(), launchKind: launch.kind };
	st.ruleSubject = true;
	if (launch.kind === "other")
		return {
			...s,
			other: true,
			queued: launch.queued,
			part:
				!launch.queued &&
				hasNamedTestFiles(words.map((w) => literal(w, st.spans).text)),
		};
	const files = launchTestFileCount(
		launch,
		words,
		(w) => literal(w, st.spans).text,
	);
	const watch = launch.kind === "npm-watch";
	const route = routedLaunch(st, launch, words);
	const weight = launchWeigh(st, route, files);
	if (weight.part) {
		s.workers = weight.workers;
		s.part = true;
		s.vitestPart = true;
		s.partKind = partKindOfRoute(route);
		s.files = st.ctx.launchWeight ? st.ctx.launchWeight.resolvedFiles : files;
	}
	s.narrowed = files !== null || (!watch && !hasFullFlag(words));
	s.reaps = launch.kind === "npm-vitest";
	s.plain = !!launch.script && !st.launchPorts.isWrapperScript(launch.script);
	if (!watch && !st.fullLaunchWords && hasFullFlag(words))
		st.fullLaunchWords = words.slice(launch.taken).map(st.typed);
	return s;
}

/**
 * @param {St} st
 * @param {{ slotFree: boolean } | null} route
 * @param {number | null} files
 */
function launchWeigh(st, route, files) {
	if (st.ctx.launchWeight) return weighCarried(st.ctx.launchWeight);
	if (route?.slotFree)
		return weighCarried({ resolvedFiles: files, wholeSlot: false });
	return weighFiles(files);
}

/**
 * @param {St} st
 * @param {Launch} launch
 * @param {string[]} words
 * @returns {{ kind: string, source: string, slotFree: boolean } | null}
 */
function routedLaunch(st, launch, words) {
	const argv = launchArgv(launch, words);
	if (argv === null || launch.script === "test:changed") return null;
	if (launch.script && !st.launchPorts.isWrapperScript(launch.script))
		return null;
	const { isTouchedRun, launchRoute } = require("./launch-route.js");
	const route = launchRoute(
		argv.map((w) => literal(w, st.spans).text),
		null,
	);
	return {
		kind: route.kind,
		source: route.source,
		slotFree: isTouchedRun(route),
	};
}

/**
 * @param {St} st
 * @param {string[]} words
 * @param {Command} cmd
 * @returns {{ subject: Subject } | { verdict: Verdict | undefined }}
 */
function subjectOf(st, words, cmd) {
	const { segment } = cmd;
	const launch = launchOf(st, words);
	if (launch?.kind === "npm-py") {
		const argv = words
			.slice(launch.taken)
			.map((w) => literal(w, st.spans).text);
		notePytestFigure(st, argv);
		const whole = isWholePytestRun(argv);
		return whole
			? {
					subject: {
						...buildBlankSubject(),
						launchKind: launch.kind,
						other: true,
						countOnly: true,
					},
				}
			: { verdict: undefined };
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
	const tscBin = tscLaunchBin(words);
	if (tscBin !== null) return { verdict: denyBareTsc(st, cmd, tscBin) };
	return { verdict: undefined };
}

/** @param {St} st @param {Command["cwds"]} cwds @param {string} bin */
function launchDirPeakMb(st, cwds, bin) {
	if (cwds.includes(""))
		st.ctx.log(
			"a `tsc` launch's directory unknown — charged the session tree's compiler",
		);
	return Math.max(
		...cwds.map((dir) => st.ctx.tscLaunchPeakMb(dir || treeRoot(st.ctx), bin)),
	);
}

/**
 * @param {St} st
 * @param {Command} cmd
 * @param {string} bin
 * @returns {Verdict | undefined}
 */
function denyBareTsc(st, { segment, cwds }, bin) {
	const ps = st.readPs();
	const mb = st.ctx.availableMb();
	if (ps === null)
		st.ctx.log("ps unreadable — a `tsc` launch judged as if none were running");
	if (mb === null)
		st.ctx.log(
			"MemAvailable unreadable — a `tsc` launch judged off its count alone",
		);
	const windows = readWindowsRecorded(
		st.ctx.windowsMemory,
		st.ctx.log,
		"a `tsc` launch",
	);
	const denial = tscDenial(ps, mb, mb === null ? 0 : st.readClimb("all"), {
		windows,
		peakMb: launchDirPeakMb(st, cwds, bin),
	});
	if (denial === null) return;
	const launch = queuedLaunch(
		segment,
		st.spans,
		`${st.ctx.scriptPath("queue-run.js")} --tsc`,
	);
	const line = insteadLine(st, typedLaunchOf(st, segment), launch);
	const why = buildTscWhy(denial);
	return {
		deny: st.ctx.corePaths(
			`${line}\n${why} \`queue-run.js --tsc\` waits for the type-check slot, then runs that command.`,
		),
	};
}

/** @param {import("./gate-wait.js").GateDenial} denial */
function buildTscWhy(denial) {
	if (denial.limb === "count")
		return "A `tsc` is already running, and the machine runs one at a time (docs/environment.md §6, #3163).";
	if (denial.limb === "windows") return `${buildWindowsShortText(denial)}.`;
	return `${readingOf(denial.mb, denial.climbMb)}, under the ~${denial.rungMb} MB docs/environment.md §6 says a \`tsc\` needs resting.`;
}

/**
 * @param {number | undefined} mb
 * @param {number | undefined} climbMb
 * @param {ClimbScope} [scope]
 */
const readingOf = (mb, climbMb, scope = "all") =>
	`MemAvailable is ${mb} MB${climbMb ? `, less ${climbMb} MB the queues' running launches ${scope === "off-rung" ? "its rung does not count " : ""}have yet to draw` : ""}`;

/** @param {St} st @param {string} segment */
const typedLaunchOf = (st, segment) =>
	trimRun(asWritten(cutComment(segment), st.spans), BASH_SPACE);

/** @param {St} st @param {string} typed @param {string} launch */
const insteadLine = (st, typed, launch) =>
	typed === st.trimmedCommand
		? `Run instead: ${launch}`
		: `Run the command with this launch in place of its own: ${launch}`;

/**
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

/** @param {St} st @param {Subject} s */
function readRunning(st, s) {
	if (s.kind !== "test") return null;
	const out = st.readPs();
	if (out === null) {
		st.ctx.log(
			"ps unreadable — a suite launch judged as if no suite were running",
		);
		return null;
	}
	const seats = st.ctx.gateSeats();
	if (seats.unread !== null)
		st.ctx.log(
			`${seats.unread} — every runner counted as itself, a gate seat's included`,
		);
	return runningSuites(
		out,
		(w) => isOtherRunner(w, st.launchPorts.runners),
		st.ctx.carriedOf,
		seats,
	);
}

/** @param {St} st @param {string} segment */
function watchLimbOf(st, segment) {
	if (!st.watcherSegment) return "";
	const opener =
		st.watcherSegment === segment
			? "This opens a WATCHER"
			: `Another segment of this command opens a WATCHER (\`${unmask(st.watcherSegment)}\`)`;
	return `${opener}, which runs the whole suite now AND holds a full rung for as long as it stays open — it re-runs on any file save, and \`ps\` cannot tell an idle watcher from a running one, so it is counted the whole time. Close it (\`q\` in its terminal) when you stop iterating.`;
}

/** @param {Running | null} running */
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
 * @param {Subject} s
 * @returns {import("./part-suite-peak.js").PartPeak | { cause: import("./part-suite-peak.js").LadderCause, bucket?: string }}
 */
function peakChargeOf(st, s) {
	if (!s.partKind) return { cause: "untold" };
	const bucket = s.files === null ? null : bucketOf(s.files);
	if (s.files === null || bucket === null) return { cause: "unsized" };
	const wire = st.ctx.tripwire();
	if (wire) {
		if (wire.cause !== "tripped")
			st.ctx.log(
				`${wire.cause === "journal-unread" ? "earlyoom's journal" : "the peak tripwire's state"} unreadable — a part-suite judged on the ladder (#5366)`,
				wire.why,
			);
		return { cause: wire.cause, bucket };
	}
	const read = st.ctx.partPeak({ kind: s.partKind, files: s.files });
	if ("why" in read) {
		st.ctx.log(
			"the run ledger unreadable — a part-suite judged on the ladder (#5366)",
			read.why,
		);
		return { cause: "unread", bucket };
	}
	return read.peak ?? { cause: "thin", bucket };
}

/**
 * @param {St} st
 * @param {Subject} s
 * @param {number} busy
 * @param {{ ladder: boolean, peakRead: import("./part-suite-peak.js").PartPeak | null }} charge
 * @returns {{ rung: number, capMb: number | null }}
 */
function rungOf(st, s, busy, { ladder, peakRead }) {
	if (peakRead) return { rung: rungMb(peakRead.p99Mb), capMb: null };
	const rung = suiteRungMb(busy + s.workers);
	const cap = st.ctx.partCapMb;
	if (!ladder || cap === undefined || rungMb(cap) >= rung)
		return { rung, capMb: null };
	return st.ctx.tripwire()
		? { rung, capMb: null }
		: { rung: rungMb(cap), capMb: cap };
}

/**
 * @param {St} st
 * @param {Subject} s
 * @param {{ busy: number, queued: boolean }} read
 * @returns {Pick<Judged, "climbScope" | "climbMb" | "reach" | "peak" | "capMb">}
 */
function chargeOf(st, s, { busy, queued }) {
	const test = s.kind === "test";
	const charge = test && s.vitestPart ? peakChargeOf(st, s) : null;
	const peakRead = charge && "p99Mb" in charge ? charge : null;
	const { rung, capMb } = rungOf(st, s, busy, {
		ladder: charge !== null && "cause" in charge,
		peakRead,
	});
	const climbScope = test && !peakRead && capMb === null ? "off-rung" : "all";
	const climbMb = queued ? 0 : st.readClimb(climbScope);
	const reach = reachableRung(rung, st.ctx.totalMb());
	if (!charge) return { climbScope, climbMb, reach, peak: null, capMb };
	const figures = { rungMb: reach.rungMb, climbMb };
	if ("cause" in charge) {
		const kind = s.partKind;
		st.ctx.noteAdmission?.({
			mode: "ladder",
			...(kind ? { kind } : {}),
			...charge,
			...figures,
			...(capMb === null ? {} : { capMb }),
		});
		return { climbScope, climbMb, reach, peak: null, capMb };
	}
	/** @type {PeakAdmission} */
	const peak = { mode: "peak", ...charge, ...figures };
	st.ctx.noteAdmission?.(peak);
	return { climbScope, climbMb, reach, peak, capMb };
}

/**
 * @param {St} st
 * @param {{ segment: string, words: string[], scripted: boolean }} at
 * @param {Subject} s
 * @param {number} readMb
 * @returns {Judged}
 */
function judgedOf(st, at, s, readMb) {
	const { segment, words } = at;
	const launchText = runText(at, segment);
	const running = readRunning(st, s);
	const busy = running?.workers ?? 0;
	const watchLimb = watchLimbOf(st, segment);
	const test = s.kind === "test";
	const queued =
		s.queued ||
		(!(s.other || s.plain) &&
			s.launchKind !== "npm-watch" &&
			hasQueueFlag(words));
	const { climbScope, climbMb, reach, peak, capMb } = chargeOf(st, s, {
		busy,
		queued,
	});
	return {
		segment,
		words,
		s,
		mb: readMb - climbMb,
		readMb,
		climbMb,
		climbScope,
		running,
		whole: running?.whole ?? 0,
		busy,
		watching: running?.watchers ?? 0,
		reach,
		peak,
		capMb,
		nth: running ? running.whole + 1 : 1,
		lever: s.narrowed
			? "since this run is already narrowed as far as it goes"
			: "or narrow the run",
		tail: watchLimb
			? `. ${watchLimb} The command: ${unmask(segment)}`
			: `: ${unmask(segment)}`,
		watchLimb,
		waitLever: waitLeverOf(running),
		refusable: test && !queued,
		launchText,
		typedLaunch: test ? typedLaunchOf(st, launchText) : "",
	};
}

/** @param {St} st @param {string} text @returns {Verdict} */
const buildWarnVerdict = (st, text) => ({
	injectRules: [],
	prelude: st.ctx.corePaths(text),
});

/** @param {St} st @param {Judged} j @param {string} watchLever */
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

/** @param {St} st @param {Judged} j */
function queueFix(st, j) {
	const viaQueueRun = j.s.other || j.s.plain;
	const flag =
		j.words[0] === "npm" && !j.words.includes("--")
			? " -- --queue"
			: " --queue";
	const launch = viaQueueRun
		? queuedLaunch(j.launchText, st.spans, st.ctx.scriptPath("queue-run.js"))
		: `${j.typedLaunch}${flag}`;
	const waits = viaQueueRun ? "`queue-run.js`" : "`--queue`";
	const allWatchers = j.watching > 0 && j.watching === j.running?.total;
	return {
		line: insteadLine(st, j.typedLaunch, launch),
		more: ` ${waits} waits for this gate to open, then runs that command.${allWatchers ? ` ${j.waitLever}, or the queue waits for good.` : ""}`,
	};
}

/**
 * @param {St} st
 * @param {Judged} j
 * @param {{ gate: Gate, watchLever: string, why: string, waiter: string }} d
 * @returns {Verdict}
 */
function denyToQueue(st, j, d) {
	const fix =
		j.s.launchKind === "npm-watch"
			? watcherFix(st, j, d.watchLever)
			: queueFix(st, j);
	const reason = `${fix.line}\n${d.why}${fix.more} ${d.waiter}${j.watchLimb ? ` ${j.watchLimb}` : ""}`;
	return { deny: st.ctx.corePaths(reason), gate: d.gate };
}

/** @param {St} st @param {Judged} j @returns {Verdict | undefined} */
function countVerdict(st, j) {
	if (!j.running) return;
	const { s } = j;
	if (j.nth > WHOLE_SUITE_MAX && j.refusable && !s.part)
		return denyToQueue(st, j, {
			gate: { limb: "count" },
			watchLever: j.waitLever,
			why: `${j.whole} whole suite(s) already running, and the machine runs one at a time (docs/environment.md §6, #2680).`,
			waiter:
				s.other || s.plain
					? "Do not write your own waiter."
					: "Do not write your own waiter: one grepping `ps` for `vitest` counts the npm wrapper and every worker as suites, so it can wait for a gap that never comes.",
		});
	const pastLadder =
		j.nth > SUITE_MAX && !(j.refusable && s.part && j.mb < j.reach.rungMb);
	const pastCap = j.nth > WHOLE_SUITE_MAX && !s.part && j.mb >= j.reach.rungMb;
	if (!pastLadder && !pastCap) return;
	return buildWarnVerdict(
		st,
		s.part
			? `This run's ${s.workers} vitest worker(s) would join ${j.whole} suites on a machine measured to ${SUITE_MAX} (docs/environment.md §6). Past the ladder's last rung nothing has been measured, and neighbour load is what actually sets a suite's wall-clock (mantahostels#1906). ${j.waitLever}, ${j.lever}${j.tail}`
			: `This would be suite ${j.nth} on a machine that runs whole suites one at a time (docs/environment.md §6, #2680) — ${j.whole} already going, and neighbour load is what actually sets a suite's wall-clock (mantahostels#1906). ${j.waitLever}, ${j.lever}${j.tail}`,
	);
}

/** @param {Judged} j */
function rungClause(j) {
	if (j.peak) return ` for ${peakClause(j.peak)}`;
	if (j.capMb !== null)
		return ` for a part-suite charged no more than its repo's measured whole-run peak of ${j.capMb} MB (#5802)`;
	if (j.s.part)
		return ` for the ${j.s.workers} vitest worker(s) its named files can occupy, beside ${j.busy} running`;
	if (j.busy > j.whole * WHOLE_SUITE_WORKERS)
		return ` for ${j.busy + j.s.workers} vitest workers, ${j.busy} of them already running`;
	return j.nth > 1 ? ` as suite ${j.nth} of ${SUITE_MAX}` : "";
}

/** @param {St} st @param {Judged} j @returns {Verdict | undefined} */
function memoryVerdict(st, j) {
	if (j.mb >= j.reach.rungMb) return;
	const rung = `${rungClause(j)}${clampedClause(j.reach.ladderMb)}`;
	const reapCmd = `node ${st.ctx.scriptPath("reap-finished-sessions.js")}`;
	if (j.refusable) {
		const reapNote = j.s.reaps
			? "Its `pretest` reaps finished sessions before the wait (`pretest-reap.js`, mantahostels#1840)."
			: `Reaping finished-but-resident sessions (\`${reapCmd}\`) gives back ${REAP_GAIN} each, and may open the gate at once.`;
		return denyToQueue(st, j, {
			gate: {
				limb: "memory",
				mb: j.readMb,
				...j.reach,
				...(j.climbMb > 0 ? { climbMb: j.climbMb } : {}),
				...(j.running ? { busy: j.busy } : {}),
				...(j.peak
					? {
							peak: {
								kind: j.peak.kind,
								bucket: j.peak.bucket,
								p99Mb: j.peak.p99Mb,
								samples: j.peak.samples,
							},
						}
					: {}),
			},
			watchLever: `Reap finished sessions (\`${reapCmd}\`) or wait for MemAvailable to reach ~${j.reach.rungMb} MB`,
			why: `${readingOf(j.readMb, j.climbMb, j.climbScope)}, under the ~${j.reach.rungMb} MB docs/environment.md §6 says a test run needs resting${rung}, and earlyoom's SIGTERM line is 8% of the cap.`,
			waiter: `${reapNote} Do not write your own waiter.`,
		});
	}
	const reapLever = j.s.reaps
		? "This command reaps finished sessions before vitest starts (`pretest-reap.js`, mantahostels#1840), so this reading does not say what the run will get — launch it and read what the reap prints, remembering it reclaims nothing from a LIVE neighbour"
		: `Reap the finished-but-resident sessions first (\`${reapCmd}\`) and re-read — a stopped session gives back ${REAP_GAIN}, though a shortfall held by LIVE neighbours is reaped by nothing`;
	return buildWarnVerdict(
		st,
		`${readingOf(j.readMb, j.climbMb, j.climbScope)}, under the ~${j.reach.rungMb} MB docs/environment.md §6 says a ${j.s.kind} run needs resting${rung} — earlyoom's SIGTERM line is 8% of the cap. ${reapLever}. Only a machine still short after that is a §Machine limits refusal, ${j.lever}${j.tail}`,
	);
}

/** @param {St} st @param {Judged} j @returns {Verdict | undefined} */
function windowsVerdict(st, j) {
	const read = readWindowsRecorded(
		st.ctx.windowsMemory,
		st.ctx.log,
		`a ${j.s.kind} launch`,
	);
	const short = windowsShortfall(read);
	if (!short) return;
	const why = buildWindowsShortText(short);
	if (j.refusable)
		return denyToQueue(st, j, {
			gate: { limb: "windows", ...short },
			watchLever: "Wait for Windows' free memory to recover",
			why: `${why}.`,
			waiter: "Do not write your own waiter.",
		});
	return buildWarnVerdict(
		st,
		`${why}. Wait for it to recover, ${j.lever}${j.tail}`,
	);
}

/** @param {St} st @param {Subject} s @param {number} mb */
function noteMemoryFigure(st, s, mb) {
	if (st.memoryKind || s.narrowed || s.other || s.launchKind === "npm-watch")
		return;
	st.memoryKind = s.kind === "build" ? "build" : "full test";
	st.memoryMb = mb;
}

/** @param {St} st @param {Command} cmd @returns {Verdict | undefined} */
function judge(st, cmd) {
	/** @type {Verdict | undefined} */
	let verdict;
	for (const run of cmd.runs()) {
		verdict = judgeRun(st, cmd, run);
		if (verdict !== undefined) break;
	}
	return verdict;
}

/**
 * @param {St} st
 * @param {Command} cmd
 * @param {import("./shell-words.js").Unwrapped} run
 * @returns {Verdict | undefined}
 */
function judgeRun(st, cmd, { words, scripted }) {
	if (words.length === 0) return;
	const got = subjectOf(st, words, cmd);
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
	const j = judgedOf(st, { segment: cmd.segment, words, scripted }, s, mb);
	const verdict =
		countVerdict(st, j) ??
		(s.countOnly ? undefined : (memoryVerdict(st, j) ?? windowsVerdict(st, j)));
	if (verdict !== undefined) return verdict;
	return st.watcherSegment === cmd.segment
		? buildWarnVerdict(st, `${j.watchLimb} The command: ${unmask(cmd.segment)}`)
		: undefined;
}

/** @param {St} st */
function fullLimb(st) {
	if (!st.fullLaunchWords || st.ctx.told(FULL_LIMB_ID)) return false;
	const full = st.ctx.fullLaunchPlain(st.fullLaunchWords, treeRoot(st.ctx));
	if ("plain" in full) return full.plain;
	st.ctx.log(
		`the plain-\`--full\` check did not run — limb unsaid: ${full.fault || "no message"}`,
	);
	return false;
}

/** @param {St} st @param {boolean} whole @returns {Verdict} */
function injectionOf(st, whole) {
	if (!(st.ruleSubject || whole) && !st.memoryKind) return null;
	const limb = fullLimb(st);
	const prelude = limb ? [FULL_LIMB_TEXT] : [];
	/** @type {string[]} */
	const skip = [];
	if (!st.ruleSubject) skip.push("suite-tree-dirty");
	if (!st.memoryKind) skip.push("memory-figure");
	else if (st.ctx.readLatch("memory-figure") === null)
		prelude.push(
			`BEFORE THIS ${st.memoryKind.toUpperCase()} RUN, MemAvailable reads ${st.memoryMb} MB.`,
		);
	if (!whole || !st.ctx.testProven(treeRoot(st.ctx)))
		skip.push("targeted-runs");
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

module.exports = {
	field: "command",
	noun: "command",
	decide,
	FULL_LIMB_ID,
};
