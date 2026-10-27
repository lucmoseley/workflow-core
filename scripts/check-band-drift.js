#!/usr/bin/env node
/*
 * check-band-drift.js — watch for agents narrowing their price bands across
 * the board, the evasion no per-turn guard can see.
 *
 * Usage:  node scripts/check-band-drift.js  [--days <n>] [--json]
 *         npm run status -- --only band-drift
 *
 * WHAT IT IS FOR (workflow-core#472 limb C, specified at workflow-core#486, built at workflow-core#487). The close-
 * rivals limb of scripts/guard-priced-options.js refuses a question whose top
 * two rivals sit close. One way round it is to write narrower bands in general,
 * so that fewer pairs overlap — invisible turn by turn, visible only as a
 * shift across many sessions. This reads the last 14 days of rival questions
 * and compares two readings with BAND_BASELINE:
 *   - the share of questions whose top-two gap is 26-30 points that have
 *     overlapping bands — the band where narrowing takes a pair out of scope;
 *   - the median band half-width of the top option.
 * The same limb refuses a question whose top figure is `LOW_TOP` or less
 * (workflow-core#2228, workflow-core#2519), and the way round that is writing 70, the first step that
 * passes.
 * A third reading, over priced questions of every shape, compares the share
 * whose top figure is exactly `LOW_TOP` + 5 with TOP_BASELINE (workflow-core#2260).
 *
 * ONE PARSER. Every question is read by the guard's own exported `rivalPair`
 * and `topOf`, so a drift report reflects agents' behaviour, never a gap
 * between two parsers.
 *
 * A CHECKER THAT FILES, where every other filer is a scheduled `report-*`
 * script: the corpus is machine-local, so no CI runner could read it, and
 * `npm run status` is the one surface that runs here.
 *
 * FILES, NEVER FAILS. Either band reading below half its baseline files or
 * refreshes one tracking issue through lib/tracking-issue.js, the top-figure
 * share above 1.5 times its baseline another, and the run WARNs. Nothing here
 * is a FAIL: drift is the founder's to judge. scripts/check-cleared-trackers.js
 * reports each issue once its readings recover.
 *
 * TOO FEW QUESTIONS FILES NOTHING. Under MIN_BAND_SAMPLE questions in the
 * 26-30 band, or MIN_TOP_SAMPLE priced tops, the share is noise (workflow-core#487, workflow-core#2260).
 *
 * AN UNREADABLE CORPUS IS A SKIP, never "no drift": the transcripts live under
 * the config seats, outside the repo (lib/check.js's subject-vs-apparatus
 * split). A seat that is simply absent is skipped quietly; a CI runner has
 * none at all and reports SKIP.
 *
 * IMPLICIT:  on `npm run status`, reads 14 days of session transcripts across every seat and files or refreshes one tracking issue when price bands have narrowed by more than half, and another when top figures bunch at 70 by more than half again.
 * JUSTIFIED: fail-safe — band-narrowing spreads across sessions, so no per-turn guard sees it; a run that cannot read the corpus or holds too few questions files nothing rather than guessing.
 * DEFEAT:    --days <n> moves the window on a hand run, and editing lib/band-baseline.js's BAND_BASELINE or TOP_BASELINE moves the thresholds; its comment forbids that without a re-measurement, and nothing enforces it.
 */

const fs = require("node:fs");

const { now, runCheck } = require("./lib/check");
const { configDirs } = require("./lib/arbiter-store");
const { readSeatTranscripts } = require("./lib/project-dirs");
const { mainChainRecords } = require("./lib/transcript");
const { fileOrRefresh } = require("./lib/tracking-issue");
const {
	BAND_BASELINE,
	MIN_BAND_SAMPLE,
	TOP_BASELINE,
	MIN_TOP_SAMPLE,
} = require("./lib/band-baseline");
const { CLOSE_GAP, LOW_TOP, rivalPair, topOf } = require("./lib/close-rivals");
const { splitQuestions } = require("./lib/round-marker");
const { caught } = require("./lib/caught.js");
const { takesLabel } = require("./lib/takes-label");

/* "Below half its baseline" (workflow-core#472 limb C). */
const FLOOR_RATIO = 0.5;
/* "More than half again", workflow-core#472 limb C's distance from baseline rising (workflow-core#2228). */
const CEILING_RATIO = 1.5;
/* The first top figure the low-top test passes as agents price, in steps of 5
 * (workflow-core#2229). */
const FIRST_PASSING_TOP = LOW_TOP + 5;

const DEFAULT_DAYS = 14;
/* The five points past the close-gap floor: pairs the floor no longer catches,
 * so only overlapping bands keep them in the limb's scope, and narrowing takes
 * them out. workflow-core#472's table read this band at 17% overlapping and the next at 0%. */
const GAP_BAND = /** @type {const} */ ([CLOSE_GAP + 1, CLOSE_GAP + 5]);

/* The ceiling on one transcript read: the largest transcript on this machine is
 * 12 MB (mantahostels#1731), and a file over this is counted, never read. */
const FILE_LIMIT = 256 * 1024 * 1024;

const TITLE =
	"Price bands are narrowing — the close-rivals guard may be priced around";
/* The lookup label as well as the disposition: a narrowing is calibration or
 * evasion, and telling them apart is a decision. */
const LABEL = takesLabel("wayfinder");
const TOP_TITLE = `Top figures are bunching at ${FIRST_PASSING_TOP} — the low-top test may be priced around`;

/**
 * @typedef {{
 *   questions: number,
 *   band: number,
 *   overlapping: number,
 *   halfWidths: number[],
 *   tops: number,
 *   atFirstPassingTop: number,
 *   listed: number,
 *   absent: string[],
 *   unreadable: string[],
 *   skippedFiles: number,
 * }} Reading
 */

/**
 * Every question block in the assistant, non-sidechain records of one
 * top-level transcript sent at or after `cutoff`. Only lines carrying a round
 * marker are parsed; `seen` drops a record a resumed session copied in.
 *
 * @param {string} text
 * @param {number} cutoff
 * @param {Set<string>} seen accumulator: each yielded record's uuid is added
 * @returns {Generator<import("./lib/round-marker").QuestionBlock>}
 */
function* questionsIn(text, cutoff, seen) {
	const marked = text
		.split("\n")
		.filter((l) => l.includes("❓"))
		.join("\n");
	for (const record of mainChainRecords(marked, "main")) {
		if (!isFreshAssistantRecord(record, cutoff, seen)) continue;
		if (record.uuid) seen.add(record.uuid);
		for (const t of recordTexts(record.message?.content)) {
			yield* splitQuestions(t);
		}
	}
}

/**
 * An assistant record sent at or after `cutoff` and not already in `seen`.
 *
 * @param {Record<string, any>} record a parsed transcript line, as
 *   lib/transcript.js yields it: unchecked JSON, so its fields stay `any`
 * @param {number} cutoff
 * @param {Set<string>} seen
 */
function isFreshAssistantRecord(record, cutoff, seen) {
	if (record.type !== "assistant") return false;
	if (!(Date.parse(record.timestamp) >= cutoff)) return false;
	if (record.uuid && seen.has(record.uuid)) return false;
	return true;
}

/**
 * @param {unknown} content
 * @returns {string[]}
 */
function recordTexts(content) {
	if (typeof content === "string") return [content];
	if (Array.isArray(content))
		return content
			.filter((c) => c?.type === "text" && typeof c.text === "string")
			.map((c) => c.text);
	return [];
}

/**
 * Read the window across every seat.
 *
 * @param {{ days?: number, at?: number }} [opts]
 * @returns {Reading}
 */
function measure({ days = DEFAULT_DAYS, at = now() } = {}) {
	const cutoff = at - days * 86_400_000;
	const { files, listed, absent, unreadable } = readSeatTranscripts(
		configDirs(),
	);

	/** @type {Reading} */
	const r = {
		questions: 0,
		band: 0,
		overlapping: 0,
		halfWidths: [],
		tops: 0,
		atFirstPassingTop: 0,
		listed,
		absent,
		unreadable,
		skippedFiles: 0,
	};
	const seen = new Set();
	for (const file of files) {
		const text = readWindowFile(file, cutoff, r);
		if (text === null) continue;
		for (const block of questionsIn(text, cutoff, seen)) tallyBlock(r, block);
	}
	return r;
}

/**
 * One transcript's text, or null where it is outside the window, over
 * FILE_LIMIT or unreadable — the last two counted in `r.skippedFiles`.
 *
 * @param {string} file
 * @param {number} cutoff
 * @param {Reading} r accumulator: skippedFiles counts a file over the limit or unreadable
 * @returns {string | null}
 */
function readWindowFile(file, cutoff, r) {
	try {
		const st = fs.statSync(file);
		/* mtime first: a file last written before the window holds nothing
		 * inside it. Each record's own timestamp decides membership. */
		if (!st.isFile() || st.mtimeMs < cutoff) return null;
		if (st.size > FILE_LIMIT) {
			r.skippedFiles++;
			return null;
		}
		return fs.readFileSync(file, "utf8");
	} catch (e) {
		/* Gone since the listing is no file to read; anything else went unread. */
		if (caught(e).code !== "ENOENT") r.skippedFiles++;
		return null;
	}
}

/**
 * @param {Reading} r accumulator: a priced block's top is counted, and a rival
 *   pair counted with its half-width pushed
 * @param {import("./lib/round-marker").QuestionBlock} block
 */
function tallyBlock(r, block) {
	const top = topOf(block);
	if (top) {
		r.tops++;
		if (top.figure === FIRST_PASSING_TOP) r.atFirstPassingTop++;
	}
	const pair = rivalPair(block);
	if (!pair) return;
	r.questions++;
	r.halfWidths.push((pair.top.high - pair.top.low) / 2);
	if (pair.gap >= GAP_BAND[0] && pair.gap <= GAP_BAND[1]) {
		r.band++;
		if (pair.overlap) r.overlapping++;
	}
}

/** @param {number[]} xs */
function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	const upper = s[mid];
	if (upper === undefined) return null;
	if (s.length % 2) return upper;
	const lower = s[mid - 1];
	if (lower === undefined)
		throw new Error(`median: no element ${mid - 1} in ${s.length} values`);
	return (lower + upper) / 2;
}

/**
 * The band reading: the overlap share in GAP_BAND and the top option's median
 * half-width, each low where it is under half its baseline.
 *
 * @param {Reading} r
 */
function bandReading(r) {
	const share = r.band ? r.overlapping / r.band : null;
	const halfWidth = median(r.halfWidths);
	const floors = {
		share: BAND_BASELINE.overlapShare * FLOOR_RATIO,
		halfWidth: BAND_BASELINE.medianHalfWidth * FLOOR_RATIO,
	};
	const shareLow = share !== null && share < floors.share;
	const halfWidthLow = halfWidth !== null && halfWidth < floors.halfWidth;
	return { share, halfWidth, floors, shareLow, halfWidthLow };
}

/**
 * The top-figure reading: the share at FIRST_PASSING_TOP against CEILING_RATIO
 * times its baseline.
 *
 * @param {Reading} r
 */
function topReading(r) {
	const share = r.tops ? r.atFirstPassingTop / r.tops : null;
	const baseline = TOP_BASELINE.atLine / TOP_BASELINE.tops;
	const ceiling = baseline * CEILING_RATIO;
	return { share, baseline, ceiling };
}

const pct = (/** @type {number} */ x) =>
	`${(x * 100).toFixed(1).replace(/\.0$/, "")}%`;

/**
 * The one-line reading both the OK line and the issue body carry.
 *
 * @param {Reading} r
 * @param {ReturnType<typeof bandReading>} v
 * @param {number} [days]
 */
function summary(r, v, days = DEFAULT_DAYS) {
	const [lo, hi] = GAP_BAND;
	const share =
		v.share === null
			? "no questions"
			: `${pct(v.share)} overlapping (baseline ${pct(BAND_BASELINE.overlapShare)}, floor ${pct(v.floors.share)})`;
	const width =
		v.halfWidth === null
			? "no top-option band"
			: `median top-option half-width ±${v.halfWidth} (baseline ±${BAND_BASELINE.medianHalfWidth}, floor ±${v.floors.halfWidth})`;
	const skipped = r.skippedFiles
		? ` ${r.skippedFiles} transcript(s) went unread.`
		: "";
	return `${r.questions} rival question(s) in the last ${days}d; ${r.band} with a ${lo}–${hi}-point gap, ${share}; ${width}.${skipped}`;
}

/**
 * The one-line top-figure reading both the OK line and its issue body carry.
 *
 * @param {Reading} r
 * @param {ReturnType<typeof topReading>} v
 * @param {number} [days]
 */
function buildTopSummary(r, v, days = DEFAULT_DAYS) {
	const share = v.share === null ? "none" : pct(v.share);
	return `${r.tops} priced top(s) in the last ${days}d, ${r.atFirstPassingTop} at exactly ${FIRST_PASSING_TOP}: ${share} (baseline ${pct(v.baseline)}, ceiling ${pct(v.ceiling)}).`;
}

/**
 * @typedef {{
 *   drifted: boolean,
 *   summary: string,
 *   findings: string[],
 *   baseline: string,
 *   decide: string,
 *   clearsWhen: string,
 *   data: Record<string, number | null>,
 * }} Assessment
 * @typedef {{
 *   kind: "unread" | "insufficient" | "drift" | "steady",
 *   summary: string,
 *   body: string,
 *   shortfall: string,
 *   data: Record<string, number | null>,
 * }} WatchReading
 * @typedef {{
 *   title: string,
 *   code: string,
 *   headline: string,
 *   prefix: string,
 *   sample: { count: (r: Reading) => number, min: number, noun: string },
 *   assess: (r: Reading, days: number) => Assessment,
 * }} Watch
 */

/** @type {Watch} */
const BAND_WATCH = {
	title: TITLE,
	code: "BAND-DRIFT",
	headline: "price bands have narrowed",
	prefix: "",
	sample: {
		count: (r) => r.band,
		min: MIN_BAND_SAMPLE,
		noun: `question(s) with a ${GAP_BAND[0]}–${GAP_BAND[1]}-point gap`,
	},
	assess(r, days) {
		const v = bandReading(r);
		return {
			drifted: v.shareLow || v.halfWidthLow,
			summary: summary(r, v, days),
			findings: [
				v.shareLow &&
					`- Overlap share in the ${GAP_BAND[0]}–${GAP_BAND[1]}-point band is ${pct(Number(v.share))}, under half the ${pct(BAND_BASELINE.overlapShare)} baseline.`,
				v.halfWidthLow &&
					`- Median top-option half-width is ±${v.halfWidth}, under half the ±${BAND_BASELINE.medianHalfWidth} baseline.`,
			].filter((l) => typeof l === "string"),
			baseline: `Baseline: ${pct(BAND_BASELINE.overlapShare)} overlap and ±${BAND_BASELINE.medianHalfWidth} median half-width, over ${BAND_BASELINE.questions} questions (${BAND_BASELINE.band} in the band), window ${BAND_BASELINE.window}, measured ${BAND_BASELINE.date} (workflow-core#487, on workflow-core#472's ruling).`,
			decide:
				"Narrower bands take close rival pairs out of the close-rivals limb of `scripts/guard-priced-options.js` (workflow-core#472, workflow-core#486). Decide whether this is agents pricing more precisely or pricing around the guard, and what, if anything, changes.",
			clearsWhen: "once both readings are back above half their baseline",
			data: { overlapShare: v.share, medianHalfWidth: v.halfWidth },
		};
	},
};

/** @type {Watch} */
const TOP_WATCH = {
	title: TOP_TITLE,
	code: "TOP-BUNCHING",
	headline: `top figures are bunching at ${FIRST_PASSING_TOP}`,
	prefix: "Top figures: ",
	sample: { count: (r) => r.tops, min: MIN_TOP_SAMPLE, noun: "priced top(s)" },
	assess(r, days) {
		const v = topReading(r);
		return {
			drifted: v.share !== null && v.share > v.ceiling,
			summary: buildTopSummary(r, v, days),
			findings: [],
			baseline: `Baseline: ${TOP_BASELINE.atLine} of ${TOP_BASELINE.tops} priced tops at ${FIRST_PASSING_TOP}, every round shape, window ${TOP_BASELINE.window}, before the low-top test was live (workflow-core#2519).`,
			decide: `The close-rivals limb of \`scripts/guard-priced-options.js\` refuses a round whose top figure is ${LOW_TOP} or less (workflow-core#2228, workflow-core#2519); ${FIRST_PASSING_TOP} is the first figure that passes. Decide whether more rounds topping at ${FIRST_PASSING_TOP} is agents pricing more confidently or pricing around the test, and what, if anything, changes.`,
			clearsWhen: "once the share is back at or under its ceiling",
			data: { topShare: v.share },
		};
	},
};

/**
 * What a watch's reading says: `unread` where no seat could be listed,
 * `insufficient` under its minimum sample, else `drift` or `steady`.
 *
 * @param {Watch} watch
 * @param {Reading} r
 * @param {number} days
 * @returns {WatchReading}
 */
function readWatch(watch, r, days) {
	const a = watch.assess(r, days);
	const { count, min, noun } = watch.sample;
	/** @type {WatchReading["kind"]} */
	let kind;
	if (!r.listed) kind = "unread";
	else if (count(r) < min) kind = "insufficient";
	else kind = a.drifted ? "drift" : "steady";
	return {
		kind,
		summary: a.summary,
		body: buildIssueBody(a),
		shortfall: `${count(r)} ${noun} in the last ${days}d, under the ${min} a reading needs`,
		data: a.data,
	};
}

/** @param {Assessment} a */
function buildIssueBody(a) {
	return [
		"Filed and refreshed by `scripts/check-band-drift.js` whenever `scripts/status-report.js` runs; nothing here was written by hand.",
		"",
		"## Reading",
		"",
		a.summary,
		"",
		...(a.findings.length > 0 ? [...a.findings, ""] : []),
		a.baseline,
		"",
		"## What to decide",
		"",
		a.decide,
		"",
		`\`scripts/check-cleared-trackers.js\` reports this issue ${a.clearsWhen}.`,
	].join("\n");
}

/**
 * Whether a watch's tracked condition still holds, for scripts/check-cleared-
 * trackers.js. Throws where the reading cannot judge it — no seat listed, or
 * too small a sample — so the tracker reads unreadable, never cleared.
 *
 * @param {Watch} watch
 * @returns {() => { held: boolean, detail: string }}
 */
const conditionOf = (watch) => () => {
	const r = measure();
	const w = readWatch(watch, r, DEFAULT_DAYS);
	if (w.kind === "unread")
		throw new Error("no transcript directory could be read");
	if (w.kind === "insufficient") throw new Error(`only ${w.shortfall}`);
	return { held: w.kind === "drift", detail: w.summary };
};

/**
 * File or refresh one tracking issue, off the baseline's own window only.
 *
 * @param {{ title: string, body: string }} issue
 * @param {number} days
 * @returns {string}
 */
function fileDrift(issue, days) {
	if (days !== DEFAULT_DAYS)
		return `Not filed: --days ${days} is not the ${DEFAULT_DAYS}-day window the baseline was read over.`;
	try {
		return fileOrRefresh({ ...issue, label: LABEL, labels: [LABEL] });
	} catch (e) {
		return `Filing failed: ${String(caught(e).message || e).split("\n")[0]}`;
	}
}

const SPEC = {
	name: "band-drift",
	usage: "node check-band-drift.js [--days <n>] [--json]",
	valueFlags: ["--days"],
	/** @param {import("./lib/check").CheckContext} ctx */
	run(ctx) {
		const days = ctx.has("--days") ? Number(ctx.value("--days")) : DEFAULT_DAYS;
		if (!Number.isFinite(days) || days <= 0)
			ctx.usageError("--days must be a positive number.");

		const r = measure({ days });
		const band = readWatch(BAND_WATCH, r, days);
		const top = readWatch(TOP_WATCH, r, days);
		const data = {
			windowDays: days,
			questions: r.questions,
			band: r.band,
			overlapping: r.overlapping,
			...band.data,
			kind: band.kind,
			tops: r.tops,
			atFirstPassingTop: r.atFirstPassingTop,
			...top.data,
			topKind: top.kind,
			absentDirs: r.absent,
			unreadableDirs: r.unreadable,
			skippedFiles: r.skippedFiles,
		};

		if (band.kind === "unread")
			ctx.skip(
				`no transcript directory could be read (${[...r.unreadable, ...r.absent.map((d) => `${d} (absent)`)].join("; ")}), so band drift is unknown — not steady.`,
			);
		if (r.unreadable.length > 0) {
			const msg = `${r.unreadable.length} transcript director(ies) could not be read (${r.unreadable.join("; ")}), so their questions went unread.`;
			ctx.say(msg);
			ctx.warn("UNREADABLE-TRANSCRIPT-DIR", msg);
		}

		/** @type {string[]} */
		const readingLines = [];
		let drifted = false;
		for (const [watch, w] of /** @type {const} */ ([
			[BAND_WATCH, band],
			[TOP_WATCH, top],
		])) {
			if (w.kind === "insufficient")
				readingLines.push(
					`${watch.prefix}insufficient sample — ${w.shortfall}; filed nothing.`,
				);
			else if (w.kind === "steady")
				readingLines.push(`${watch.prefix}${w.summary}`);
			else {
				drifted = true;
				const filed = fileDrift({ title: watch.title, body: w.body }, days);
				const msg = `${watch.headline}: ${w.summary} ${filed}`;
				ctx.say(msg);
				ctx.warn(watch.code, msg);
			}
		}

		if (drifted) {
			for (const line of readingLines) ctx.say(line);
			return { data };
		}
		return { okLine: readingLines.join(" "), data };
	},
};

if (require.main === module) runCheck(SPEC);

module.exports = {
	TITLE,
	TOP_TITLE,
	LABEL,
	trackerCondition: conditionOf(BAND_WATCH),
	topTrackerCondition: conditionOf(TOP_WATCH),
};
