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
	isArgumentTail,
	maskQuotes,
	parseCommand,
	placeSegments,
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

const BLANK = " \\t\\v\\f\\r";

const SP = `[${BLANK}]`;

const NOT_DETACHING = ["&&", "&>", "|&", ">&", "<&"];

const HELD_OP_BASE = 2;

/** @param {number} i */
const heldOp = (i) => String.fromCharCode(HELD_OP_BASE + i);

const DETACHER_MARK = "\x1d";

const TYPED_MARK = `${DETACHER_MARK}\x1e`;

/** @param {string} text */
const unmark = (text) =>
	text
		.replace(new RegExp(`${DETACHER_MARK}(?!\x1e)`, "g"), "")
		.split(TYPED_MARK)
		.join(DETACHER_MARK);

const DETACHER_PATH = "([^\\x00-\\x20\\u2028\\u2029;|&()<>`]*/)?";

const DETACHER_TAIL = "[<>]|\\\\$";

const DETACHER = new RegExp(
	`${DETACHER_MARK}\\\\?(${DETACHER_PATH}(nohup|setsid)(${SP}|${DETACHER_TAIL}|$)|disown([^A-Za-z0-9_.-]|$))`,
	"m",
);

const ESCAPED_AMP = "\x0f";

const REREAD_AMP = "\x10";

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

/**
 * @param {string} text
 * @param {boolean} reread
 * @param {string} literalTo
 * @param {string} detachTo
 */
const holdEscapedAmps = (text, reread, literalTo, detachTo) =>
	mapEscapedAmps(text, (_at, pairs) =>
		reread && pairs % 2 === 0 ? detachTo : literalTo,
	);

/** @param {string} masked @param {boolean} reread */
function hasBareDetachment(masked, reread) {
	if (DETACHER.test(holdEscapedAmps(masked, reread, ESCAPED_AMP, "&")))
		return true;
	return NOT_DETACHING.reduce(
		(t, op) => t.split(op).join("  "),
		holdEscapedAmps(masked, reread, "  ", "&"),
	).includes("&");
}

/** @param {string} text @param {boolean} [reread] @returns {boolean} */
function hasDetachment(text, reread = false) {
	const { masked, spans } = maskQuotes(text);
	return (
		hasBareDetachment(masked, reread) ||
		spans.some((span) =>
			quotedSubstitutions(span).some((sub) => hasDetachment(sub.text)),
		)
	);
}

const STRIP_LEAD = `${DETACHER_MARK}\\\\?`;

const DETACH_REWRITES = /** @type {const} */ ([
	[new RegExp(`${REREAD_AMP}${SP}*(\\\\;|;|$)`, "g"), "$1"],
	[new RegExp(REREAD_AMP, "g"), "\\;"],
	[
		new RegExp(
			`${STRIP_LEAD}${DETACHER_PATH}(nohup|setsid)(${SP}+-[^${BLANK}<>]+)*(${SP}+|$|(?=${DETACHER_TAIL}))`,
			"g",
		),
		"",
	],
	[
		new RegExp(
			`${STRIP_LEAD}disown(?![A-Za-z0-9_.-])(${SP}+[^${BLANK};|&]+)*${SP}*`,
			"g",
		),
		"",
	],
	[new RegExp(`&${SP}*(;|$)`, "g"), "$1"],
	[/&/g, ";"],
]);

/**
 * @param {string} text
 * @param {Map<number, string>} scriptSpans
 * @param {(body: string) => string} stripScript
 * @param {boolean} [reread]
 * @returns {string}
 */
function stripDetachment(text, scriptSpans, stripScript, reread = false) {
	const { masked, spans } = maskQuotes(text);
	const kept = spans.map((span, i) =>
		scriptSpans.get(i) === unmark(span)
			? span.charAt(0) + stripQuotedScript(unmark(span), stripScript)
			: stripSpan(span),
	);
	return trimStart(asWritten(stripBare(masked, reread), kept));
}

const ESCAPED_DOLLAR = "\x12";
const ESCAPED_TICK = "\x11";
/** @type {Record<string, string>} */
const HELD_ESCAPES = { $: ESCAPED_DOLLAR, "`": ESCAPED_TICK };

/** @param {string} body */
const decodeDoubleQuoted = (body) =>
	body.replace(/\\([\\"$`])/g, (_, c) => HELD_ESCAPES[c] ?? c);

/** @param {string} text */
const encodeDoubleQuoted = (text) =>
	text
		.replace(/[\\"]/g, (c) => `\\${c}`)
		.split(ESCAPED_DOLLAR)
		.join("\\$")
		.split(ESCAPED_TICK)
		.join("\\`");

/**
 * @param {string} span
 * @param {(body: string) => string} stripScript
 */
function stripQuotedScript(span, stripScript) {
	const body = span.slice(1);
	if (span.charAt(0) !== '"' || body.replace(/\\[\s\S]/g, "").includes('"'))
		return stripScript(body);
	return encodeDoubleQuoted(stripScript(decodeDoubleQuoted(body)));
}

/**
 * @typedef {object} ScriptSource
 * @property {number[]} spanIndices
 * @property {boolean} detached
 */

/** @param {string} text @param {ScriptSource[]} scripts @param {boolean} reread */
const hasDetachedRun = (text, scripts, reread) =>
	hasDetachment(text, reread) || scripts.some((s) => s.detached);

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
				stripDetachment(out.slice(from, to), new Map(), (body) => body) +
				out.slice(to);
	return out;
}

/** @param {string} masked @param {boolean} reread */
function stripBare(masked, reread) {
	let s = NOT_DETACHING.reduce(
		(t, op, i) => t.split(op).join(heldOp(i)),
		holdEscapedAmps(masked, reread, ESCAPED_AMP, REREAD_AMP),
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
	return NOT_DETACHING.reduce((t, op, i) => t.split(heldOp(i)).join(op), s)
		.split(ESCAPED_AMP)
		.join("\\&");
}

/** @param {string} s */
const trimStart = (s) => s.replace(/^[ \t\n\v\f\r]+/, "");

// guess, #5898: past shell-parse.js's STAND_IN_BASE stand-ins
const HELD_LINE_MARK_BASE = 0xe1_00;

/** @param {string} raw */
function markAbsentFrom(raw) {
	let code = HELD_LINE_MARK_BASE;
	while (raw.includes(String.fromCharCode(code))) code++;
	return String.fromCharCode(code);
}

/** @param {string} raw @param {number[]} heredocLines */
function holdHeredocs(raw, heredocLines) {
	const mark = markAbsentFrom(raw);
	const lines = raw.split("\n");
	/** @type {Map<string, string>} */
	const kept = new Map();
	for (const n of heredocLines) {
		const token = `${mark}${n}${mark}`;
		kept.set(token, lines[n] ?? "");
		lines[n] = token;
	}
	return { text: lines.join("\n"), kept };
}

/** @param {string} s @param {Map<string, string>} kept */
function putBackHeredocs(s, kept) {
	let out = s;
	for (const [token, line] of kept) {
		const at = out.indexOf(token);
		if (at >= 0) out = out.slice(0, at) + line + out.slice(at + token.length);
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
 * @property {number} segIdx
 * @property {string} to
 * @property {number[]} dropped
 * @property {Map<number, string>} respanned
 * @typedef {{ run: import("./shell-words.js").Unwrapped, wordIndices: number[] }} ScriptRun
 * @typedef {{ respan: number, span: string } | { requote: string[], body: string }} ScriptFix
 * @typedef {object} ScriptRead
 * @property {import("./shell-words.js").Unwrapped} run
 * @property {string[]} words
 * @property {number[]} wordIndices
 * @property {ReturnType<typeof literal>[]} literals
 * @property {string} body
 * @property {import("./shell-parse.js").Parsed} parsedBody
 * @property {ReturnType<typeof readLaunches>} inner
 * @property {ScriptSource} source
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
	let reread = false;
	/** @type {Timed[]} */
	const timed = [];
	/** @type {ScriptSource[]} */
	const scripts = [];
	/** @type {string[]} */
	const requoted = [];
	/** @type {Detacher[]} */
	const detachers = [];
	/**
	 * @param {import("./shell-parse.js").Command} cmd
	 * @param {{ run: import("./shell-words.js").Unwrapped }[]} launches
	 * @param {ScriptRead[]} scriptReads
	 */
	const noteDetachers = (cmd, launches, scriptReads) => {
		const ats = [
			...launches.flatMap(({ run }) =>
				run.typedWrappers.flatMap(([at]) =>
					at !== undefined && isDetacherWord(cmd.words[at], "nohup|setsid")
						? [at]
						: [],
				),
			),
			...scriptReads.flatMap((script) => scriptDetacherAts(script, spans)),
		];
		const disownAt = cmd.words.findIndex((w) => !DISOWN_PREFIX.includes(w));
		if (isDetacherWord(cmd.words[disownAt], "disown")) ats.push(disownAt);
		for (const at of ats) {
			const start = cmd.starts[at];
			if (start === undefined) continue;
			detachers.push({
				segIdx: cmd.segIdx,
				from: asWritten(cmd.segment.slice(0, start), spans).length,
				word: asWritten(cmd.words[at] ?? "", spans),
			});
		}
	};
	/**
	 * @param {string[]} leading
	 * @param {import("./shell-words.js").Unwrapped} run
	 */
	const noteLaunch = (leading, { words, wrapperWords, watched }) => {
		const launch = suiteLaunchKind(words.map(typed), launchPorts);
		if (!launch) return null;
		if (watched) reread = true;
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
	 * @returns {ScriptRead}
	 */
	const readScript = (cmd, { run, wordIndices }) => {
		const words = wordIndices.flatMap((i) => cmd.words.slice(i, i + 1));
		const literals = words.map((w) => literal(w, spans));
		const body = literals.map((l) => l.text).join(" ");
		const parsedBody = parseCommand(body);
		const inner = readLaunches(parsedBody, ctx, launchPorts);
		/** @type {ScriptSource} */
		const source = {
			spanIndices: words.flatMap((word) => quotedSpanIndices(word, spans)),
			detached:
				!inner.escaped &&
				hasDetachedRun(
					markDetachers(body, parsedBody, inner.detachers),
					inner.scripts,
					inner.reread,
				),
		};
		return {
			run,
			words,
			wordIndices,
			literals,
			body,
			parsedBody,
			inner,
			source,
		};
	};
	/**
	 * @param {import("./shell-parse.js").Command} cmd
	 * @param {ScriptRead} script
	 * @returns {ScriptFix | null}
	 */
	const buildScriptFix = (
		cmd,
		{ run, words, literals, body, parsedBody, inner },
	) => {
		if (carriesVar("WFC_SUITE_TIMEOUT", cmd.leading, run.wrapperWords))
			return null;
		if (inner.timed.length === 0) return null;
		const untimed = putBackRequoted(
			applyTimed(
				{ text: body, parsed: parsedBody },
				inner.timed,
				spanShift(inner.timed),
				ctx,
			),
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
			segIdx: cmd.segIdx,
			to: asWritten(segment, spans),
			dropped,
			respanned,
		});
	};
	walkCommands(
		parsed,
		(cmd) => {
			if (isArgumentTail(parsed, cmd.segIdx)) return;
			const [first, ...later] = cmd.runs();
			/** @type {{ run: import("./shell-words.js").Unwrapped, launch: import("./suite-launch.js").Launch }[]} */
			const launches = [];
			for (const run of first.words.length === 0 ? later : [first, ...later]) {
				const launch = noteLaunch(cmd.leading, run);
				if (launch) launches.push({ run, launch });
			}
			const scriptRuns = distinctScripts(launches.map(({ run }) => run)).map(
				(script) => readScript(cmd, script),
			);
			for (const { source } of scriptRuns) scripts.push(source);
			noteDetachers(cmd, launches, scriptRuns);
			const [timeouts = []] = launches
				.map(({ run, launch }) => typedTimeouts(cmd, run, launch))
				.filter((t) => t.length > 0);
			const fixes = scriptRuns.flatMap((script) => {
				const fix = buildScriptFix(cmd, script);
				return fix ? [fix] : [];
			});
			if (timeouts.length > 0 || fixes.length > 0)
				noteTimed(cmd, timeouts, fixes);
		},
		ctx,
	);
	return {
		foundSuite,
		escaped,
		snapshot,
		timed,
		reread,
		scripts,
		requoted,
		detachers,
	};
}

const DISOWN_PREFIX = ["builtin", "command"];

/** @param {string | undefined} word @param {string} names */
const isDetacherWord = (word, names) =>
	word !== undefined &&
	new RegExp(`^\\\\?${DETACHER_PATH}(${names})$`).test(word);

/**
 * @param {ScriptRead} script
 * @param {string[]} spans
 * @returns {number[]}
 */
function scriptDetacherAts(
	{ words, wordIndices, literals, body, parsedBody, inner },
	spans,
) {
	const offsets = detacherOffsets(body, parsedBody, inner.detachers);
	let start = 0;
	return literals.flatMap((lit, j) => {
		const at = start;
		start += lit.text.length + 1;
		const word = words[j] ?? "";
		const bare = quotedSpanIndices(word, spans).length === 0;
		return bare && offsets.includes(at) ? wordIndices.slice(j, j + 1) : [];
	});
}

/**
 * @typedef {{ segIdx: number, from: number, word: string }} Detacher
 * @param {string} text
 * @param {import("./shell-parse.js").Parsed} parsed
 * @param {Detacher[]} detachers
 * @returns {number[]}
 */
function detacherOffsets(text, parsed, detachers) {
	const places = placeSegments(parsed, text);
	return detachers.flatMap(({ segIdx, from, word }) => {
		const textAt = places[segIdx]?.textAt ?? [];
		const typed = textAt
			.slice(from, from + word.length)
			.map((i) => text.charAt(i))
			.join("");
		return typed === word ? textAt.slice(from, from + 1) : [];
	});
}

/**
 * @param {string} text
 * @param {import("./shell-parse.js").Parsed} parsed
 * @param {Detacher[]} detachers
 */
function markDetachers(text, parsed, detachers) {
	const marks = new Set(detacherOffsets(text, parsed, detachers));
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const c = text.charAt(i);
		if (marks.has(i)) out += DETACHER_MARK;
		out += c === DETACHER_MARK ? TYPED_MARK : c;
	}
	return out;
}

/**
 * @param {ScriptSource[]} scripts
 * @param {string[]} spans
 * @param {(i: number, span: string) => [number, string]} [entry]
 */
const buildScriptSpanMap = (scripts, spans, entry = (i, span) => [i, span]) =>
	new Map(
		scripts.flatMap((s) =>
			s.spanIndices.flatMap((i) =>
				spans.slice(i, i + 1).map((span) => entry(i, span)),
			),
		),
	);

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

/**
 * @param {{ text: string, parsed: import("./shell-parse.js").Parsed }} source
 * @param {Timed[]} timed
 * @param {SpanShift} shift
 * @param {Pick<Ctx, "log">} ctx
 */
function applyTimed({ text, parsed }, timed, { respanned }, ctx) {
	const places = placeSegments(parsed, text);
	let fix = text;
	let end = text.length;
	for (const edit of timed
		.map((t) => placedEdit(text, places[t.segIdx] ?? null, t.to))
		.sort((x, y) => (y?.from ?? -1) - (x?.from ?? -1))) {
		if (edit === null || edit.to > end) {
			ctx.log(
				"a timed launch has no place of its own in the typed command — the deny re-issues it as typed",
			);
			continue;
		}
		fix = fix.slice(0, edit.from) + edit.put + fix.slice(edit.to);
		end = edit.from;
	}
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
	const launchPorts = {
		runners: ctx.runners,
		isWrapperScript: buildIsWrapperScript(ctx.tree, ctx.log),
	};
	const {
		foundSuite,
		escaped,
		snapshot,
		timed,
		reread,
		scripts,
		requoted,
		detachers,
	} = readLaunches(parsed, ctx, launchPorts);
	const hold = holdHeredocs(command, parsed.heredocLines);
	const detached =
		foundSuite &&
		!escaped &&
		hasDetachedRun(
			markDetachers(hold.text, parsed, detachers),
			scripts,
			reread,
		);
	if (!detached && timed.length === 0) return null;

	const shift = spanShift(timed);
	const { indexAfterDrops, respanned } = shift;
	const quiet = { ...ctx, log: () => undefined };
	/** @param {string} body @returns {string} */
	const stripScript = (body) => {
		const inner = readMarked(body, quiet, launchPorts);
		return stripDetachment(
			inner.marked,
			buildScriptSpanMap(inner.scripts, inner.parsed.spans),
			stripScript,
			inner.reread,
		);
	};
	let fix = applyTimed({ text: hold.text, parsed }, timed, shift, ctx);
	if (detached)
		fix = unmark(
			stripDetachment(
				readMarked(fix, quiet, launchPorts).marked,
				buildScriptSpanMap(scripts, spans, (i, span) => {
					const at = indexAfterDrops(i);
					return [at, respanned.get(at) ?? span];
				}),
				stripScript,
				reread,
			),
		);
	fix = putBackRequoted(
		fix,
		detached ? requoted.map((body) => unmark(stripScript(body))) : requoted,
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
 * @param {string} text
 * @param {Ctx} ctx
 * @param {Parameters<typeof readLaunches>[2]} launchPorts
 */
function readMarked(text, ctx, launchPorts) {
	const parsed = parseCommand(text);
	const { detachers, scripts, reread } = readLaunches(parsed, ctx, launchPorts);
	return {
		marked: markDetachers(text, parsed, detachers),
		parsed,
		scripts,
		reread,
	};
}

/**
 * @param {string} text
 * @param {import("./shell-parse.js").Place | null} place
 * @param {string} rewrite
 */
function placedEdit(text, place, rewrite) {
	if (place === null) return null;
	if (place.backtick && !rewrite.endsWith("$")) return null;
	const put = place.backtick ? rewrite.slice(0, -1) : rewrite;
	const { textAt } = place;
	const typed = textAt.map((at) => text.charAt(at)).join("");
	const shorter = Math.min(typed.length, put.length);
	let head = 0;
	while (head < shorter && typed[head] === put[head]) head++;
	let tail = 0;
	while (tail < shorter - head && typed.at(-1 - tail) === put.at(-1 - tail))
		tail++;
	return {
		from: textAt[head] ?? place.to,
		to: textAt[typed.length - tail] ?? place.to,
		put: put.slice(head, put.length - tail),
	};
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
