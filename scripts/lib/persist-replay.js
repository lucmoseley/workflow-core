/*
 * persist-replay.js — what scripts/verify-persist-replay.js makes of the runs
 * it launches: which producers it runs, whether each persisted report is
 * sound, whether it says what the live run said, and the delivery stamps it
 * parks between its two phases (mantahostels#1977). The harness's header says why
 * each exists; this module holds the judgement (workflow-core#1370), so it is tested
 * without launching a producer.
 */

const fs = require("node:fs");
const { stampFile } = require("./delivery-stamp.js");
const {
	sessionStartRoster,
	KEY_OVERRIDES,
} = require("./session-start-roster.js");

/**
 * @typedef {{ key: string, script: string, outcomes?: string[],
 *   volatile?: boolean, knownGap?: number, stampKeys?: string[] }} Producer
 *   `stampKeys` is a hand-listed FALLBACK for a producer's delivery-stamp
 *   files beyond the one `stampFile(key)` already names, for a name
 *   `parkStamps` cannot read off the producer's own report (mantahostels#2277).
 * @typedef {{ stdout: string, stderr: string, code: number|null,
 *   killed: boolean, ms: number }} RunOutcome
 */

/** Outcomes `lib/check.js` can produce (mantahostels#155's alphabet). */
const CHECKER_OUTCOMES = ["OK", "SKIP", "WARN", "FAIL", "BROKEN"];

/**
 * What no roster read can derive about a producer: whether its subject moves
 * under it between the two phases (`volatile`), a narrower outcome alphabet
 * than the checker default (`outcomes`), an already-ticketed defect
 * (`knownGap`), or delivery-stamp files beyond the one `stampFile(key)`
 * already names (`stampKeys`). Keyed by report key — `runCheck`'s own `name`,
 * which is NOT the script's filename: every checker below drops the `check-`
 * prefix except `check-cleared-trackers`, which keeps it — so a producer
 * newly wired into the repo's hooks needs an entry here only where its
 * behaviour actually differs from the checker default, never to be added at
 * all.
 *
 * THE REAPER IS THE ONE THAT IS NOT A CHECKER (mantahostels#2152). It routes through no
 * `runCheck` tail — it calls `lib/notify-report.js` directly — so its report
 * carries no checker envelope.
 * @type {Record<string, Omit<Producer, "key" | "script">>}
 */
const PRODUCER_META = {
	"ci-status": {
		/* It reads the live Actions API, where a run can finish, or a neighbour
		 * can push, between the two phases. */
		volatile: true,
	},
	"reap-finished-sessions": {
		/* Its own alphabet, not the checker one: BROKEN where it could judge no
		 * candidate at all, WARN where it had a line, OK where it had none.
		 * SKIP and FAIL are unreachable for it (mantahostels#2152). */
		outcomes: ["OK", "WARN", "BROKEN"],
		/* It stops sessions, so the second run of a pair finds fewer to take. */
		volatile: true,
	},
};

/**
 * Every producer the hooks of `repoRoot` currently wire as a
 * persisting SessionStart hook — `WFC_NOTIFY_PERSIST=1` and `--notify` both
 * reachable on the entry's command line — with `PRODUCER_META`'s overlay
 * applied.
 *
 * THE SET IS DERIVED, DELIBERATELY (mantahostels#2574, on the hand-written table this
 * replaced having gone two producers stale by the time that was noticed, and
 * two more by the time it was fixed — the wiring keeps changing faster than a
 * hand list keeps up). `scripts/lib/session-start-roster.js`'s
 * `sessionStartRoster` is the same join `replay-notify-reports.js` reads its
 * own roster with, so a producer wired there and not here — or read here and
 * not there — cannot happen by construction.
 *
 * THROWS where a `PRODUCER_META` key names no wired producer — a rename or a
 * typo on either side of the map, which would otherwise drop a
 * `volatile`/`outcomes` override with nothing to say so, the mistaken entry
 * reading as applied. Thrown, not warned: a table the harness cannot trust its
 * own annotations against is not one to run at all.
 * @param {string} repoRoot
 * @returns {Producer[]}
 */
function persistingProducers(repoRoot) {
	const producers = sessionStartRoster(repoRoot, {
		keyOverrides: KEY_OVERRIDES,
	}).map(({ key, script }) => ({ key, script, ...(PRODUCER_META[key] ?? {}) }));
	const wired = new Set(producers.map((p) => p.key));
	const orphaned = Object.keys(PRODUCER_META).filter((k) => !wired.has(k));
	if (orphaned.length > 0)
		throw new Error(
			`PRODUCER_META names ${orphaned.join(", ")}, which the repo's hooks wire as no persisting producer — a stale or misspelt key`,
		);
	return producers;
}

/**
 * Every part of a report that moves between two runs of the same finding.
 * Ordered longest-pattern-first where two could match the same span, so the
 * duration rule below does not eat the seconds out of an ISO timestamp the
 * first rule would have taken whole.
 * @param {string} text
 */
function mask(text) {
	return (
		String(text)
			.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<ts>")
			.replace(/\d{4}-\d{2}-\d{2}/g, "<date>")
			.replace(
				/\b\d+(\.\d+)?\s*(ms|s|m|h|d|min|minute|minutes|hour|hours|day|days)\b/gi,
				"<dur>",
			)
			.replace(/\bpid\s*\d+/gi, "pid <n>")
			/* HOW MANY SESSIONS THE CORPUS HELD — the right-hand figure in
			 * check-hook-liveness.js's census line, which grows with every session
			 * started on the machine while the left one does not. Anchored on
			 * `in <n> of` and nothing wider: the second figure is the only session
			 * count in any of these reports that is a corpus size rather than a
			 * finding, so `of N session(s)` alone would also swallow the reaper's
			 * count of sessions it stopped. */
			.replace(/\b(in \d+ of )\d+ session\(s\)/g, "$1<n> session(s)")
			/* A HEX LETTER IS REQUIRED, so a run id or an issue number keeps its
			 * digits: an all-decimal token of the same length is a figure the
			 * comparison must be able to see change. */
			.replace(/\b(?=[0-9a-f]{7,40}\b)[0-9a-f]*[a-f][0-9a-f]*\b/g, "<sha>")
			.replace(/[ \t]+$/gm, "")
			.replace(/\n{2,}/g, "\n")
			.trim()
	);
}

/**
 * Every way a persisted report can be malformed, as a list of reasons — empty
 * where it is sound. Checked against the run window rather than merely parsed:
 * a report left by an earlier run of the day is a producer that wrote nothing
 * this time, and reads identically to a fresh one unless the date is tested.
 *
 * @param {Pick<Producer, "key"|"outcomes">} producer
 * @param {import("./notify-report.js").Report|null} report
 * @param {{ from: number, to: number }} window
 */
function faultsIn(producer, report, window) {
	if (!report) return ["no report file, or one too malformed to read back"];
	const bad = [];
	const allowed = producer.outcomes ?? CHECKER_OUTCOMES;
	if (report.checker !== producer.key)
		bad.push(
			`report names checker "${report.checker}", expected "${producer.key}"`,
		);
	if (!allowed.includes(report.outcome))
		bad.push(
			`outcome "${report.outcome}" is outside its alphabet (${allowed.join("/")})`,
		);
	if (typeof report.text !== "string") bad.push("text is not a string");
	const at = Date.parse(report.at);
	if (Number.isNaN(at)) {
		bad.push(`unparseable timestamp "${report.at}"`);
	} else if (at < window.from - 1000 || at > window.to + 1000) {
		/* One second of slack each side: the producer stamps its own finish, and
		 * two clocks reading the same instant may disagree by less than a tick. */
		bad.push(
			`report is from ${report.at}, outside this run — the producer wrote nothing`,
		);
	}
	if (report.durationMs !== null && typeof report.durationMs !== "number")
		bad.push("durationMs is neither a number nor null");
	return bad;
}

/**
 * What the harness makes of one producer, given both phases.
 * @param {Omit<Producer, "script">} producer
 * @param {{
 *   persistRun: RunOutcome,
 *   controlRun: RunOutcome|null,
 *   report: import("./notify-report.js").Report|null,
 *   runOpen: boolean,
 *   window: { from: number, to: number },
 *   stampSeen: boolean,
 * }} phases `runOpen`: whether an open run record was left behind.
 *   `stampSeen`: whether the delivery store already covers the persisted
 *   report's own stamp — the only thing that explains a live run saying
 *   nothing about a finding the persisted report carries
 */
function judge(
	producer,
	{ persistRun, controlRun, report, runOpen, window, stampSeen },
) {
	const faults = faultsIn(producer, report, window);
	if (persistRun.killed)
		faults.push(`killed at the harness timeout after ${persistRun.ms} ms`);
	/* THE POINT OF PERSIST MODE. An async hook's stdout is discarded, so a
	 * producer still writing there under the variable is reporting to nobody. */
	if (persistRun.stdout.trim())
		faults.push(
			`printed ${persistRun.stdout.trim().length} bytes to stdout under persist mode`,
		);
	if (runOpen)
		faults.push(
			"left its open run record behind — the reader will call it cancelled",
		);

	const { match, diff } = compareRuns(
		producer,
		{ controlRun, report, stampSeen },
		faults,
	);
	return {
		key: producer.key,
		outcome: report?.outcome ?? null,
		bytes: report?.text.length ?? 0,
		persistMs: persistRun.ms,
		controlMs: controlRun?.ms ?? null,
		exit: persistRun.code,
		match,
		diff,
		faults,
	};
}

/**
 * How the persisted report compares with the control run's live one.
 * @param {Omit<Producer, "script">} producer
 * @param {{
 *   controlRun: RunOutcome|null,
 *   report: import("./notify-report.js").Report|null,
 *   stampSeen: boolean,
 * }} runs
 * @param {string[]} faults accumulator: each fault is pushed here
 * @returns {{match: string, diff: {persisted: string, control: string}|null}}
 */
function compareRuns(producer, { controlRun, report, stampSeen }, faults) {
	if (controlRun?.killed) {
		/* An empty stdout from a control run that was cut off is not a checker
		 * with nothing to say, and every limb below would read it as one. */
		faults.push(
			`its control run was killed after ${controlRun.ms} ms — nothing to compare against`,
		);
		return { match: "control run killed", diff: null };
	}
	if (!controlRun || !report) return { match: "not compared", diff: null };
	const a = mask(report.text);
	const b = mask(controlRun.stdout);
	if (report.text.trim() === controlRun.stdout.trim())
		return { match: "identical", diff: null };
	if (a === b) return { match: "same finding", diff: null };
	if (a && !b && stampSeen) return { match: "stamp-held live", diff: null };
	const diff = { persisted: a, control: b };
	/* A gap with an open ticket is reported by number and not counted:
	 * failing on it would leave this harness red until that ticket lands,
	 * which teaches a reader to ignore its verdict. */
	if (producer.knownGap)
		return { match: `differs (known: #${producer.knownGap})`, diff };
	if (!producer.volatile)
		faults.push(
			"persisted report does not match the same checker's live report",
		);
	return { match: "differs", diff };
}

/**
 * Move every producer's delivery stamp out of the way and hand back the
 * restore. See the header: phase B is a real delivery, and without this it
 * both spends the founder's stamps and reads the ones it is about to spend.
 *
 * PARKS THREE SOURCES OF NAMES per producer: `stampFile(key)`, any hand-listed
 * `stampKeys`, and every name phase A's own report says it wrote under
 * `stamps` (mantahostels#2574). `reports` is optional so a caller with no phase-A
 * report yet still parks the static names.
 *
 * Never throws. A stamp that cannot be read is left where it is and reported
 * by the comparison itself, as a live run that says nothing.
 * @param {Producer[]} producers
 * @param {Record<string, import("./notify-report.js").Report|null>} [reports]
 */
function parkStamps(producers, reports = {}) {
	/** @type {[string, string|null][]} */
	const held = [];
	for (const p of producers) {
		const fromReport = Object.keys(reports[p.key]?.stamps ?? {});
		for (const key of new Set([p.key, ...(p.stampKeys ?? []), ...fromReport])) {
			const file = stampFile(key);
			let text = null;
			try {
				text = fs.readFileSync(file, "utf8");
			} catch {
				/* never stamped, or unreadable: either way there is nothing to put back */
			}
			try {
				fs.rmSync(file, { force: true });
				held.push([file, text]);
			} catch {
				/* could not clear it — the comparison reads the suppression instead */
			}
		}
	}
	return () => {
		for (const [file, text] of held) {
			try {
				if (text === null) fs.rmSync(file, { force: true });
				else fs.writeFileSync(file, text);
			} catch {
				/* a stamp that cannot be put back costs one repeated report */
			}
		}
	};
}

module.exports = { persistingProducers, judge, parkStamps };
