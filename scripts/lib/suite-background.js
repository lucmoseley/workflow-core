const {
	carriesVar,
	isBareSpan,
	literal,
	readSentinels,
	typedWord,
} = require("./shell-words.js");
const {
	BASH_SPACE,
	asWritten,
	maskQuotes,
	parseCommand,
	quotedSubstitutions,
	walkCommands,
} = require("./shell-parse.js");
const {
	afterSlash,
	suiteLaunchKind,
	buildIsWrapperScript,
	isSnapshotLaunch,
} = require("./suite-launch.js");
const { launchTestFileCount } = require("./suite-bounded.js");
const { endRun, trimEndRun } = require("./trim-run.js");
const {
	MOVED_RUN_WAIT,
	SNAPSHOT_RUN_TIMEOUT_MS,
	SUBAGENT_WAIT,
	WAIT_SLOT,
	withWait,
} = require("./wait-text.js");

/**
 * @typedef {object} BackgroundPorts
 * @property {() => string[]} runners
 * @typedef {import("./core-contract.js").CoreContext & BackgroundPorts} Ctx
 */

const SP = "[ \\t\\v\\f\\r]";

const NOT_DETACHING = ["&&", "&>", "|&", ">&", "<&"];

const DETACHER = /(^|[^A-Za-z0-9_-])(nohup|setsid|disown)([^A-Za-z0-9_.-]|$)/m;

const ESCAPED_AMP = "\x0f";

/**
 * @param {string} text
 * @param {(at: number, backslashPairsBefore: number) => string} to
 */
function mapEscapedAmps(text, to) {
	let pairs = 0;
	let end = -1;
	return text.replace(/\\[^\n]/g, (m, at) => {
		if (at !== end) pairs = 0;
		end = at + m.length;
		if (m === "\\\\") {
			pairs++;
			return m;
		}
		const out = m === "\\&" ? to(at, pairs) : m;
		pairs = 0;
		return out;
	});
}

/** @param {string} text @param {string} to */
const holdEscapedAmps = (text, to) => mapEscapedAmps(text, () => to);

/** @param {string} masked */
function hasBareDetachment(masked) {
	if (DETACHER.test(masked)) return true;
	return NOT_DETACHING.reduce(
		(t, op) => t.split(op).join("  "),
		holdEscapedAmps(masked, "  "),
	).includes("&");
}

/**
 * @param {string} script
 * @returns {string}
 */
const stripScriptEscapedAmps = (script) =>
	mapEscapedAmps(script, (at, pairs) => {
		if (pairs % 2 === 1) return "\\&";
		return /^ *(\\;|$)/.test(script.slice(at + 2)) ? "" : "\\;";
	});

/** @param {string} text @returns {boolean} */
function hasDetachment(text) {
	const { masked, spans } = maskQuotes(text);
	return (
		hasBareDetachment(masked) ||
		spans.some((span) =>
			quotedSubstitutions(span).some((sub) => hasDetachment(sub.text)),
		)
	);
}

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
]);

/**
 * @param {string} text
 * @param {Map<number, string>} [scriptSpans]
 * @returns {string}
 */
function stripDetachment(text, scriptSpans = new Map()) {
	const { masked, spans } = maskQuotes(text);
	const kept = spans.map((span, i) =>
		scriptSpans.get(i) === span
			? span.charAt(0) + stripDetachment(span.slice(1))
			: stripSpan(span),
	);
	return trimStart(asWritten(stripBare(masked), kept));
}

/**
 * @typedef {object} ScriptSource
 * @property {string} text
 * @property {number[]} spanIndices
 */

/** @param {string} text @param {ScriptSource[]} scripts */
const hasDetachedRun = (text, scripts) =>
	hasDetachment(text) || scripts.some((s) => hasDetachment(s.text));

/**
 * @param {string[]} words
 * @param {number[]} wordIndices
 * @param {string[]} spans
 * @returns {ScriptSource}
 */
function buildScriptSource(words, wordIndices, spans) {
	const held = wordIndices.flatMap((i) => words.slice(i, i + 1));
	return {
		text: held.map((w) => literal(w, spans).text).join(" "),
		spanIndices: held.flatMap((word) => quotedSpanIndices(word, spans)),
	};
}

/** @param {string} word */
function spanIndicesIn(word) {
	/** @type {number[]} */
	const found = [];
	readSentinels(word, (_lit, idx) => {
		if (idx !== null) found.push(idx);
		return { text: "", stepPast: true };
	});
	return found;
}

/** @param {string} word @param {string[]} spans */
function quotedSpanIndices(word, spans) {
	/** @type {number[]} */
	const found = [];
	readSentinels(word, (_lit, idx) => {
		const span = idx === null ? undefined : spans[idx];
		if (idx !== null && (span?.startsWith("'") || span?.startsWith('"')))
			found.push(idx);
		return { text: "", stepPast: true };
	});
	return found;
}

/** @param {string} span */
function stripSpan(span) {
	let out = span;
	for (const { text, from, to } of quotedSubstitutions(span).reverse())
		if (hasDetachment(text))
			out =
				out.slice(0, from) +
				stripDetachment(out.slice(from, to)) +
				out.slice(to);
	return out;
}

/** @param {string} masked */
function stripBare(masked) {
	let s = NOT_DETACHING.reduce(
		(t, op, i) => t.split(op).join(String.fromCharCode(2 + i)),
		holdEscapedAmps(masked, ESCAPED_AMP),
	);
	s = trimEndRun(
		s
			.split("\n")
			.map((line) =>
				trimEndRun(
					DETACH_REWRITES.reduce((l, [re, to]) => l.replace(re, to), line),
					" \t\v\f\r",
				),
			)
			.join("\n"),
		"\n",
	);
	return NOT_DETACHING.reduce(
		(t, op, i) => t.split(String.fromCharCode(2 + i)).join(op),
		s,
	)
		.split(ESCAPED_AMP)
		.join("\\&");
}

/** @param {string} s */
const trimStart = (s) => s.replace(/^[ \t\n\v\f\r]+/, "");

const held = (/** @type {number} */ n) => `\x07${n}\x07`;

/** @param {string} raw @param {number[]} heredocLines */
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

/** @param {string} s @param {Map<number, string>} kept */
function putBackHeredocs(s, kept) {
	let out = s;
	for (const n of [...kept.keys()].sort((a, b) => a - b)) {
		const at = out.indexOf(held(n));
		if (at >= 0)
			out =
				out.slice(0, at) + (kept.get(n) ?? "") + out.slice(at + held(n).length);
	}
	return trimEndRun(out, "\n");
}

/**
 * @param {string} seg
 * @param {[string[], string[]][]} swaps
 */
function swapWords(seg, swaps) {
	const segWords = (seg.split("\n")[0] ?? "").split(/[ \t]+/).filter(Boolean);
	/** @type {string[] | null} */
	let kept = segWords;
	for (const [drop, put] of swaps) kept = kept && swap(kept, drop, put);
	if (kept === null) return null;
	const lead = /^[ \t\n\v\f\r]*/.exec(seg)?.[0] ?? "";
	const trail = endRun(seg, BASH_SPACE);
	return lead + kept.join(" ") + trail;
}

/** @param {string[]} words @param {string[]} drop @param {string[]} put */
function swap(words, drop, put) {
	const at = words.findIndex((_, i) =>
		drop.every((w, j) => words[i + j] === w),
	);
	return at < 0
		? null
		: [...words.slice(0, at), ...put, ...words.slice(at + drop.length)];
}

/** @param {string} body */
const singleQuoted = (body) => `'${body.split("'").join("'\\''")}'`;

const requotedAt = (/** @type {number} */ n) => `\x0e${n}\x0e`;

/** @param {string} text @param {string[]} bodies */
function putBackRequoted(text, bodies) {
	let out = text;
	bodies.forEach((body, n) => {
		out = out.split(requotedAt(n)).join(singleQuoted(body));
	});
	return out;
}

/** @param {string} quote @param {string} body @param {string} untimed */
function fitsQuote(quote, body, untimed) {
	const live = quote === "'" ? "'" : '"\\$`';
	const had = [...body].filter((c) => live.includes(c));
	let at = 0;
	for (const c of untimed)
		if (live.includes(c)) {
			at = had.indexOf(c, at) + 1;
			if (at === 0) return false;
		}
	return true;
}

/** @param {boolean} snapshot */
const fixOpener = (snapshot) =>
	`Run instead, in the foreground with the Bash tool's \`timeout: ${snapshot ? SNAPSHOT_RUN_TIMEOUT_MS : 600_000}\`: `;

const DETACHED_TEXT = `This suite is DETACHED INSIDE THE SHELL — \`&\`, \`nohup\`, \`setsid\` or \`disown\` — so the call registers no job for the run and nothing will ever tell you it ended. \`run_in_background\` with a detachment does not help: the job is then the wrapper shell, which exits at once. An overrun is moved to the background and notifies: then ${WAIT_SLOT} A \`--full=<cause>\` or \`--queue\` run may overrun, so wrap it in \`scripts/bg-run.sh run <name>\` in the same call: a \`killed\` notification often lies, so before relaunching read \`scripts/bg-run.sh check <name>\`, which tells KILLED from DONE. If guard-suite-concurrency refuses the re-issue, no job exists: take its corrected command rather than reporting \`waiting:\`. Genuinely need the detachment? Prefix the command with \`WFC_SUITE_DETACH=1\`.`;

const PARENT_OVERRUN = {
	detached:
		"end the turn with NO tool call — a notification arriving mid-call is almost never delivered.",
	timed: "end the turn with NO tool call.",
};

const PARENT_SNAPSHOT_OVERRUN = `keep working on independent work; with none left, end the turn with NO tool call, or in a background job hold it on ${MOVED_RUN_WAIT}.`;

const TIMED_TEXT = `This suite is WRAPPED IN A SHELL \`timeout\`, which kills it with no result and no pass/fail marker when the clock runs out — and the clock counts time spent waiting in the \`--queue\` too. The Bash tool's own timeout does not kill it: an overrun is moved to the background and notifies, and you ${WAIT_SLOT} If guard-suite-concurrency refuses the re-issue, take its corrected command. A run naming its own test files is not refused. Genuinely need the shell timeout? Prefix the command with \`WFC_SUITE_TIMEOUT=1\`.`;

/**
 * @typedef {object} Timed
 * @property {string} from
 * @property {string} to
 * @property {number[]} dropped
 * @property {Map<number, string>} respanned
 * @typedef {{ run: import("./shell-words.js").Unwrapped, wordIndices: number[] }} ScriptRun
 * @typedef {{ respan: number, span: string } | { requote: string[], body: string }} ScriptFix
 */

/**
 * @param {import("./shell-parse.js").Parsed} parsed
 * @param {Ctx} ctx
 * @param {import("./suite-launch.js").LaunchPorts} launchPorts
 */
function readLaunches(parsed, ctx, launchPorts) {
	const { spans } = parsed;
	/** @param {string} w */
	const typed = (w) => typedWord(w, spans);
	let foundSuite = false;
	let escaped = false;
	let snapshot = true;
	/** @type {Timed[]} */
	const timed = [];
	/** @type {Timed[]} */
	const unescaped = [];
	/** @type {ScriptSource[]} */
	const scripts = [];
	/** @type {string[]} */
	const requoted = [];
	/**
	 * @param {string[]} leading
	 * @param {import("./shell-words.js").Unwrapped} run
	 */
	const noteLaunch = (leading, { words, wrapperWords }) => {
		const launch = suiteLaunchKind(words.map(typed), launchPorts);
		if (!launch) return null;
		if (carriesVar("WFC_SUITE_DETACH", leading, wrapperWords)) escaped = true;
		if (!isSnapshotLaunch(launch, words.map(typed))) snapshot = false;
		foundSuite = true;
		return launch;
	};
	/**
	 * @param {import("./shell-parse.js").Command} cmd
	 * @param {import("./shell-words.js").Unwrapped} first
	 * @param {import("./suite-launch.js").Launch} launch
	 */
	const typedTimeouts = (
		cmd,
		{ words, wrapperWords, typedWrappers },
		launch,
	) => {
		if (!isUnbounded(launch, words, spans)) return [];
		if (carriesVar("WFC_SUITE_TIMEOUT", cmd.leading, wrapperWords)) return [];
		return typedWrappers
			.map((at) => at.map((i) => cmd.words[i] ?? ""))
			.filter(([w = ""]) => afterSlash(literal(w, spans).text) === "timeout");
	};
	/**
	 * @param {import("./shell-parse.js").Command} cmd
	 * @param {ScriptRun} script
	 * @returns {ScriptFix | null}
	 */
	const buildScriptFix = (cmd, { run, wordIndices }) => {
		if (carriesVar("WFC_SUITE_TIMEOUT", cmd.leading, run.wrapperWords))
			return null;
		const words = wordIndices.flatMap((i) => cmd.words.slice(i, i + 1));
		const literals = words.map((w) => literal(w, spans));
		const body = literals.map((l) => l.text).join(" ");
		const inner = readLaunches(parseCommand(body), ctx, launchPorts);
		if (inner.timed.length === 0) return null;
		const untimed = putBackRequoted(
			applyTimed(body, inner.timed, spanShift(inner.timed)),
			inner.requoted,
		);
		const inPlace = respanFix(words, spans, body, untimed);
		if (inPlace) return inPlace;
		if (literals.every((l) => l.known))
			return { requote: words, body: untimed };
		ctx.log(
			"the timed script carries an expansion the re-issue cannot re-quote — its launch is left unjudged",
		);
		return null;
	};
	/**
	 * @param {import("./shell-parse.js").Command} cmd
	 * @param {string[][]} timeouts
	 * @param {ScriptFix[]} fixes
	 */
	const noteTimed = (cmd, timeouts, fixes) => {
		let segment = cmd.segment;
		/** @type {number[]} */
		const dropped = [];
		/** @type {Map<number, string>} */
		const respanned = new Map();
		/** @param {[string[], string[]][]} swaps @param {string[]} gone */
		const rewrite = (swaps, gone) => {
			const swapped = swapWords(segment, swaps);
			if (swapped === null) {
				ctx.log(
					"swapWords could not place the words — the deny re-issues them as typed",
				);
				return false;
			}
			segment = swapped;
			dropped.push(...gone.flatMap(spanIndicesIn));
			return true;
		};
		if (timeouts.length > 0)
			rewrite(
				timeouts.map((t) => [t, []]),
				timeouts.flat(),
			);
		for (const fix of fixes)
			if ("respan" in fix) respanned.set(fix.respan, fix.span);
			else if (
				rewrite([[fix.requote, [requotedAt(requoted.length)]]], fix.requote)
			)
				requoted.push(fix.body);
		timed.push({
			from: asWritten(cmd.segment, spans),
			to: asWritten(segment, spans),
			dropped,
			respanned,
		});
		return segment;
	};
	/**
	 * @param {import("./shell-parse.js").Command} cmd
	 * @param {string} segment
	 * @param {ScriptRun[]} scriptRuns
	 */
	const noteUnescaped = (cmd, segment, scriptRuns) => {
		let seg = segment;
		for (const { wordIndices } of scriptRuns) {
			const words = wordIndices.flatMap((i) => cmd.words.slice(i, i + 1));
			const put = stripScriptEscapedAmps(words.join(" ")).split(" ");
			if (put.join(" ") === words.join(" ")) continue;
			const swapped = swapWords(seg, [[words, put.filter(Boolean)]]);
			if (swapped === null)
				ctx.log(
					"swapWords could not place the script's escaped `&` — the deny re-issues it as typed",
				);
			seg = swapped ?? seg;
		}
		if (seg !== segment)
			unescaped.push({
				from: asWritten(segment, spans),
				to: asWritten(seg, spans),
				dropped: [],
				respanned: new Map(),
			});
	};
	walkCommands(
		parsed,
		(cmd) => {
			const [first, ...later] = cmd.runs();
			/** @type {{ run: import("./shell-words.js").Unwrapped, launch: import("./suite-launch.js").Launch }[]} */
			const launches = [];
			for (const run of first.words.length === 0 ? later : [first, ...later]) {
				const launch = noteLaunch(cmd.leading, run);
				if (launch) launches.push({ run, launch });
			}
			const scriptRuns = distinctScripts(launches.map(({ run }) => run));
			for (const { wordIndices } of scriptRuns)
				scripts.push(buildScriptSource(cmd.words, wordIndices, spans));
			const [timeouts = []] = launches
				.map(({ run, launch }) => typedTimeouts(cmd, run, launch))
				.filter((t) => t.length > 0);
			const fixes = scriptRuns.flatMap((script) => {
				const fix = buildScriptFix(cmd, script);
				return fix ? [fix] : [];
			});
			const segment =
				timeouts.length > 0 || fixes.length > 0
					? noteTimed(cmd, timeouts, fixes)
					: cmd.segment;
			noteUnescaped(cmd, segment, scriptRuns);
		},
		ctx,
	);
	return {
		foundSuite,
		escaped,
		snapshot,
		timed,
		unescaped,
		scripts,
		requoted,
	};
}

/** @param {import("./shell-words.js").Unwrapped[]} runs @returns {ScriptRun[]} */
function distinctScripts(runs) {
	/** @type {Map<string, ScriptRun>} */
	const byWords = new Map();
	for (const run of runs) {
		const { scriptWords } = run;
		if (scriptWords === null) continue;
		const key = scriptWords.join(" ");
		if (!byWords.has(key)) byWords.set(key, { run, wordIndices: scriptWords });
	}
	return [...byWords.values()];
}

/**
 * @param {string} word
 * @param {string[]} spans
 * @returns {number | null}
 */
function soleQuotedSpanIndex(word, spans) {
	let bare = "";
	/** @type {number[]} */
	const found = [];
	const { rest } = readSentinels(word, (lit, idx) => {
		bare += lit;
		const span = idx === null ? undefined : spans[idx];
		if (idx !== null && span !== undefined && !isBareSpan(span))
			found.push(idx);
		return { text: "", stepPast: true };
	});
	const [only, ...more] = found;
	return bare === "" && rest === "" && more.length === 0
		? (only ?? null)
		: null;
}

/**
 * @param {string[]} words
 * @param {string[]} spans
 * @param {string} body
 * @param {string} untimed
 * @returns {{ respan: number, span: string } | null}
 */
function respanFix(words, spans, body, untimed) {
	const [only, ...more] = words;
	if (only === undefined || more.length > 0) return null;
	const at = soleQuotedSpanIndex(only, spans);
	const span = at === null ? undefined : spans[at];
	if (at === null || span === undefined || span.slice(1) !== body) return null;
	const quote = span.charAt(0);
	return fitsQuote(quote, body, untimed)
		? { respan: at, span: quote + untimed }
		: null;
}

/**
 * @typedef {{ indexAfterDrops: (i: number) => number, respanned: Map<number, string> }} SpanShift
 * @param {Timed[]} timed
 * @returns {SpanShift}
 */
function spanShift(timed) {
	const dropped = timed.flatMap((t) => t.dropped);
	/** @param {number} i */
	const indexAfterDrops = (i) => i - dropped.filter((d) => d < i).length;
	/** @type {Map<number, string>} */
	const respanned = new Map();
	for (const t of timed)
		for (const [i, span] of t.respanned)
			respanned.set(indexAfterDrops(i), span);
	return { indexAfterDrops, respanned };
}

/** @param {string} text @param {Timed[]} timed @param {SpanShift} shift */
function applyTimed(text, timed, { respanned }) {
	let fix = text;
	for (const { from, to } of timed) fix = fix.split(from).join(to);
	if (respanned.size === 0) return fix;
	const { masked, spans } = maskQuotes(fix);
	return asWritten(
		masked,
		spans.map((span, i) => respanned.get(i) ?? span),
	);
}

/**
 * @param {string} command
 * @param {Ctx} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	const parsed = parseCommand(command);
	const { spans } = parsed;
	const { foundSuite, escaped, snapshot, timed, unescaped, scripts, requoted } =
		readLaunches(parsed, ctx, {
			runners: ctx.runners,
			isWrapperScript: buildIsWrapperScript(ctx.tree, ctx.log),
		});
	const hold = holdHeredocs(command, parsed.heredocLines);
	const detached = foundSuite && !escaped && hasDetachedRun(hold.text, scripts);
	if (!detached && timed.length === 0) return null;

	const shift = spanShift(timed);
	const { indexAfterDrops, respanned } = shift;
	let fix = applyTimed(
		hold.text,
		detached ? [...timed, ...unescaped] : timed,
		shift,
	);
	if (detached)
		fix = stripDetachment(
			fix,
			new Map(
				scripts.flatMap((s) =>
					s.spanIndices.flatMap((i) => {
						const at = indexAfterDrops(i);
						return spans
							.slice(i, i + 1)
							.map((span) => [at, respanned.get(at) ?? span]);
					}),
				),
			),
		);
	fix = putBackRequoted(
		fix,
		detached ? requoted.map((body) => stripDetachment(body)) : requoted,
	);
	fix = putBackHeredocs(trimStart(fix), hold.kept);
	if (fix === "") {
		ctx.log(
			"the re-issue came out empty — the deny re-issues the command as typed",
		);
		fix = command;
	}
	let reason = `${fixOpener(snapshot)}${fix}`;
	if (snapshot && ctx.agent)
		reason += `\nPast ${SNAPSHOT_RUN_TIMEOUT_MS / 1000} s the run moves to the background; then ${SUBAGENT_WAIT}`;
	const subagentOverrun = snapshot
		? "hold your turn on it as the line above says, never ending it."
		: SUBAGENT_WAIT;
	/** @param {keyof typeof PARENT_OVERRUN} kind */
	const overrun = (kind) => {
		if (ctx.agent) return subagentOverrun;
		return snapshot ? PARENT_SNAPSHOT_OVERRUN : PARENT_OVERRUN[kind];
	};
	if (detached) reason += `\n${withWait(DETACHED_TEXT, overrun("detached"))}`;
	if (timed.length > 0) reason += `\n${withWait(TIMED_TEXT, overrun("timed"))}`;
	return { deny: ctx.corePaths(reason.replace(/\n$/, "")) };
}

/**
 * @param {import("./suite-launch.js").Launch} launch
 * @param {string[]} words
 * @param {string[]} spans
 */
function isUnbounded(launch, words, spans) {
	if (launch.kind !== "wrapper" && launch.kind !== "npm-vitest") return false;
	return (
		launchTestFileCount(launch, words, (w) => literal(w, spans).text) === null
	);
}

module.exports = { field: "command", noun: "suite launch", decide };
