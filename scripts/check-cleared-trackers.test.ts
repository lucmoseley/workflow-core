// @vitest-environment node
/*
 * Pins that check-cleared-trackers.js names an open tracking issue whose
 * condition has cleared, stays silent while it holds, reads an unreadable
 * condition as unreadable rather than cleared, and closes nothing
 * (mantahostels#1699, the ticket that found the gap; mantahostels#2297 for
 * the unfiled red suite).
 *
 * The script reports on THIS repo's tracking issues and conditions, so it cannot
 * also be its own fixture. Four injections do the work:
 *
 *   WFC_GH                      — which tracking issues are open, and (for
 *                                    the red-suite tracker's unfiledCondition
 *                                    probe alone, mantahostels#2297) the one sweep a
 *                                    `sweep` fixture describes — both via
 *                                    scripts/lib/gh.js's seam.
 *   cwd                           — every reporter but the manual and cycle ones
 *                                    reads its subject by a path relative to the
 *                                    repo root ("docs/doc-map.md"). Running the
 *                                    script by ABSOLUTE path from a fixture root
 *                                    therefore keeps the real reporters and swaps
 *                                    their subjects.
 *   CLAUDE_PROJECT_DIR          — the cycle log resolves against the host root,
 *                                    at the fixture config's cycleLogPath where
 *                                    one is declared (#438).
 *   WFC_MANUAL_FRESHNESS_MODULE — report-manual-staleness.js's freshness()
 *                                    calls check-manual-freshness.js's SPEC.run()
 *                                    in-process (mantahostels#2062), so swapping its subject
 *                                    needs a module to require, not a cwd-relative
 *                                    file.
 *
 * It reports through `npm run status`, the only close path a tracking issue
 * has: loosen a case and a cleared issue sits open for the next session to
 * read as outstanding, or a live one is called cleared and closed by hand.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	card,
	roadmapHtml,
} from "../.claude/skills/roadmap-edit/scripts/roadmap-fixture";
import {
	LABEL as BAND_LABEL,
	TITLE as BAND_TITLE,
	TOP_TITLE,
} from "./check-band-drift";
import {
	BAND_BASELINE,
	MIN_BAND_SAMPLE,
	MIN_TOP_SAMPLE,
	TOP_BASELINE,
} from "./lib/band-baseline";
import {
	bandQuestions,
	topQuestions,
	writeTranscript,
} from "./lib/band-drift-fixture";
import { stubGhScript } from "./lib/gh-stub";
import {
	LABEL as CYCLE_LABEL,
	TITLE as CYCLE_TITLE,
} from "./report-cycle-review-due";
import {
	BUDGET_WORDS,
	LABEL as MAP_LABEL,
	TITLE as MAP_TITLE,
} from "./report-doc-map-budget";
import {
	LABEL as MANUAL_LABEL,
	TITLE as MANUAL_TITLE,
} from "./report-manual-staleness";
import {
	LABEL as REDSUITE_LABEL,
	TITLE as REDSUITE_TITLE,
} from "./report-red-suite";
import { LABEL as RETRO_LABEL, TITLE as RETRO_TITLE } from "./report-retro-due";
import {
	LABEL as ROADMAP_LABEL,
	TITLE as ROADMAP_TITLE,
} from "./report-roadmap-ceilings";

const SCRIPT = path.resolve(__dirname, "check-cleared-trackers.js");
const TODAY = "2026-08-28";

let dir: string;

/** An open issue the stub will serve under `label`. */
interface OpenIssue {
	number: number;
	title: string;
	label: string;
}

/**
 * The gh call log — every invocation, one per line. The stub serves `issue
 * list` always, and `run list`/`run view` only where a `sweep` fixture is
 * given — the shape report-red-suite.js's readSweeps() reads, shared by both
 * sweepStillRed() and newestSweepRed() (mantahostels#2297).
 */
const GH_LOG = () => path.join(dir, "gh-calls.log");

/** One scheduled-checks.yml sweep and the "Full suite" job inside it. */
interface Sweep {
	runs: {
		databaseId: number;
		headSha: string;
		url: string;
		createdAt: string;
	}[];
	jobs: Record<number, { name: string; conclusion: string }[]>;
}

/**
 * A `gh` serving `open` from `issue list`; with no `sweep`, every `gh run` call
 * fails.
 */
const stubGh = (open: OpenIssue[], sweep: Sweep | null = null) => {
	fs.writeFileSync(path.join(dir, "issues.json"), JSON.stringify(open));
	fs.writeFileSync(path.join(dir, "sweep.json"), JSON.stringify(sweep));
	return stubGhScript(
		dir,
		`#!/usr/bin/env node
const fs = require("node:fs");
const open = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, "issues.json"))}, "utf8"));
const sweep = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, "sweep.json"))}, "utf8"));
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(GH_LOG())}, argv.join(" ") + "\\n");
if (argv[0] === "issue" && argv[1] === "list") {
  const label = argv[argv.indexOf("--label") + 1];
  process.stdout.write(JSON.stringify(
    open.filter((i) => i.label === label).map((i) => ({ number: i.number, title: i.title })),
  ));
  process.exit(0);
}
if (argv[0] === "run" && argv[1] === "list" && sweep) {
  process.stdout.write(JSON.stringify(sweep.runs));
  process.exit(0);
}
if (argv[0] === "run" && argv[1] === "view" && sweep) {
  const jobs = sweep.jobs[Number(argv[2])] || [];
  process.stdout.write(JSON.stringify(jobs));
  process.exit(0);
}
process.stderr.write("gh: this stub does not serve: " + argv.join(" ") + "\\n");
process.exit(1);
`,
	);
};

/** Every gh invocation this fixture has seen. */
const ghCalls = () =>
	fs.existsSync(GH_LOG())
		? fs.readFileSync(GH_LOG(), "utf8").trim().split("\n").filter(Boolean)
		: [];

/** A cycle log whose single open cycle ends on `end`. */
const cycleLog = (end: string) =>
	`# Cycle log\n\n## Cycle 1 — 2026-08-27 → ${end}\n\n**Status:** open\n\nBody.\n`;

/** A doc map whose §B measures roughly `words` words. */
const docMap = (words: number) =>
	`# Doc map\n\n## Section A\n\nx\n\n## Section B\n\n${"word ".repeat(Math.round(words))}\n\n## Section C\n\nx\n`;

/**
 * A stub freshness checker: exit 1 is stale, 0 is fresh, 2 is BROKEN. It touches
 * a marker first, so a run that asked can be told from one that did not. Shaped
 * as check-manual-freshness.js's exported SPEC, which is what freshness() calls
 * (mantahostels#2062).
 */
const RAN_MARKER = () => path.join(dir, "freshness-ran");
const FRESHNESS_STUB = () => path.join(dir, "scripts/manual-freshness-stub.js");

const freshnessStub = (exit: number, say = "manual report line") =>
	[
		'module.exports = { SPEC: { name: "manual-freshness", usage: "stub", valueFlags: [], run(ctx) {',
		`  require("node:fs").writeFileSync(${JSON.stringify(RAN_MARKER())}, "");`,
		// ctx.say() alongside ctx.fail()/ctx.warn(), as the real checker's
		// fail()/warn() helpers do — freshness() reads its report off say()'s
		// captured text, not off the finding messages alone (mantahostels#2062).
		`  if (${exit} === 1) { ctx.fail("FRESHNESS", ${JSON.stringify(say)}); ctx.say(${JSON.stringify(say)}); }`,
		`  if (${exit} === 2) ctx.broken(${JSON.stringify(say)});`,
		"} } };",
	].join("\n");

/**
 * A fixture root where, by default, every condition still holds — so any test
 * that expects a CLEARED finding has to clear exactly one of them itself.
 */
const fixture = ({
	cycleEnd = "2026-11-29",
	mapWords = BUDGET_WORDS * 1.2, // over budget: the condition still holds
	freshnessExit = 1,
	noSectionB = false,
	noCycleLog = false,
	cycleLogPath = "",
} = {}) => {
	fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
	fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
	if (cycleLogPath) {
		fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, ".claude/workflow-core.json"),
			JSON.stringify({ cycleLogPath }),
		);
	}
	const logFile = path.join(dir, cycleLogPath || "docs/cycle-log.md");
	if (!noCycleLog) {
		fs.mkdirSync(path.dirname(logFile), { recursive: true });
		fs.writeFileSync(logFile, cycleLog(cycleEnd));
	}
	fs.writeFileSync(
		path.join(dir, "docs/doc-map.md"),
		noSectionB ? "# Doc map\n\n## Section A\n\nx\n" : docMap(mapWords),
	);
	fs.writeFileSync(FRESHNESS_STUB(), freshnessStub(freshnessExit));
};

const run = (
	open: OpenIssue[],
	args: string[] = [],
	sweep: Sweep | null = null,
) => {
	const gh = stubGh(open, sweep);
	const r = spawnSync("node", [SCRIPT, ...args], {
		cwd: dir,
		encoding: "utf8",
		env: {
			...process.env,
			...gh.env,
			CYCLE_TODAY: TODAY,
			RETRO_TODAY: TODAY,
			WFC_MANUAL_FRESHNESS_MODULE: FRESHNESS_STUB(),
			CLAUDE_PROJECT_DIR: dir,
			// The band-drift condition reads transcripts: never the real corpus.
			CLAUDE_CONFIG_DIR: SEAT(),
			WFC_CLAUDE_CONFIG_A: SEAT(),
			WFC_CLAUDE_CONFIG_B: SEAT(),
			WFC_CLAUDE_CONFIG_C: SEAT(),
		},
	});
	return { ...r, out: `${r.stdout}${r.stderr}` };
};

const CYCLE_ISSUE = { number: 1205, title: CYCLE_TITLE, label: CYCLE_LABEL };
const MANUAL_ISSUE = { number: 1700, title: MANUAL_TITLE, label: MANUAL_LABEL };
const MAP_ISSUE = { number: 1079, title: MAP_TITLE, label: MAP_LABEL };
const ROADMAP_ISSUE = {
	number: 3334,
	title: ROADMAP_TITLE,
	label: ROADMAP_LABEL,
};

/** Writes docs/reference-roadmap.html under the fixture root — `fixture()`
 * above writes no roadmap by default, so the roadmap-ceilings tracker's own
 * tests supply one directly. */
const writeRoadmap = (cards: Parameters<typeof card>[0][]) =>
	fs.writeFileSync(
		path.join(dir, "docs/reference-roadmap.html"),
		roadmapHtml(cards.map((c) => card(c))),
	);
const REDSUITE_ISSUE = {
	number: 2299,
	title: REDSUITE_TITLE,
	label: REDSUITE_LABEL,
};

const RETRO_ISSUE = { number: 1001, title: RETRO_TITLE, label: RETRO_LABEL };

/** A config setting N and a run record whose one weekly run is on `date`. */
const writeRetro = (date: string) => {
	fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".claude/workflow-core.json"),
		JSON.stringify({ retro: { weeklyCount: 3 } }),
	);
	fs.mkdirSync(path.join(dir, "docs/data"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, "docs/data/retro-runs.jsonl"),
		`${JSON.stringify({ date, mode: "weekly" })}\n`,
	);
};
const BAND_ISSUE = { number: 490, title: BAND_TITLE, label: BAND_LABEL };
const TOP_ISSUE = { number: 2329, title: TOP_TITLE, label: BAND_LABEL };
const SEAT = () => path.join(dir, "seat");

const writeBandCorpus = (n: number, overlapping: number) =>
	writeTranscript(
		path.join(SEAT(), "projects", "-p"),
		bandQuestions(n, overlapping),
	);

const writeTopCorpus = (n: number, atLine: number) =>
	writeTranscript(path.join(SEAT(), "projects", "-p"), topQuestions(n, atLine));

/** One "Full suite" sweep, judged the given way, at a fixed run id. */
const sweepFixture = (conclusion: "failure" | "success"): Sweep => ({
	runs: [
		{
			databaseId: 9001,
			headSha: "abc1234",
			url: "https://example.test/runs/9001",
			createdAt: "2026-08-31T13:06:00Z",
		},
	],
	jobs: { 9001: [{ name: "Full suite", conclusion }] },
});

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "cleared-trackers-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("check-cleared-trackers", () => {
	it("reports a tracking issue whose condition has cleared", () => {
		fixture({ cycleEnd: "2026-11-29" });
		const r = run([CYCLE_ISSUE]);
		expect(r.out).toContain("CLEARED TRACKER (");
		expect(r.out).toContain("#1205");
		expect(r.out).toContain("cycle 1 runs to 2026-11-29");
		expect(r.status).toBe(0); // WARN, never gating
		expect(r.out).toContain("Nothing closes it for you");
		expect(r.out).toContain("**Outstanding:**");
	});

	it("is silent about a tracking issue whose condition still holds", () => {
		fixture({ cycleEnd: "2026-08-01" }); // ended before TODAY — review is due
		const r = run([CYCLE_ISSUE]);
		expect(r.out).not.toContain("CLEARED TRACKER (");
		expect(r.out).toContain("every condition still standing");
		expect(r.out).toContain("#1205");
	});

	it("never evaluates a condition whose tracking issue is not open", () => {
		// True of `condition` on every tracker here — the red-suite tracker's
		// SEPARATE `unfiledCondition` is the one deliberate exception (mantahostels#2297),
		// covered by its own tests below, and this fixture supplies no sweep
		// so that probe (which would throw) is never reached either.
		fixture({ cycleEnd: "2026-11-29" });
		const r = run([]);
		expect(r.out).not.toContain("CLEARED TRACKER (");
		expect(r.out).toContain("no tracking issue is open");
	});

	it("reports an unreadable condition as unreadable, never as cleared", () => {
		fixture({ noCycleLog: true });
		const r = run([CYCLE_ISSUE]);
		expect(r.out).toContain("UNREADABLE CONDITION (");
		expect(r.out).not.toContain("CLEARED TRACKER (");
		expect(r.out).toContain("#1205");
		expect(r.status).toBe(0); // WARN, never FAIL or BROKEN
		// The summary line must not call this a clearance — lib/check.js counts
		// every WARN finding, so the noun is what carries the distinction.
		expect(r.out).not.toContain("cleared tracker(s)");
	});

	it("reads the cycle log at the host's declared cycleLogPath (#438)", () => {
		fixture({
			cycleEnd: "2026-11-29",
			cycleLogPath: "docs/machinery/cycle-log.md",
		});
		const r = run([CYCLE_ISSUE]);
		expect(r.status).toBe(0);
		expect(r.out).toContain("cycle 1 runs to 2026-11-29");
		expect(r.out).not.toContain("UNREADABLE CONDITION (");
	});

	it("does not read a doc map with no §B heading as under budget", () => {
		// sectionBWords returns 0 for such a map, and 0 is under budget.
		fixture({ noSectionB: true });
		const r = run([MAP_ISSUE]);
		expect(r.out).toContain("UNREADABLE CONDITION (");
		expect(r.out).not.toContain("CLEARED TRACKER (");
	});

	it("reports the weekly-retro tracker cleared once a weekly run is recorded inside 7 days", () => {
		fixture();
		writeRetro("2026-08-25");
		const r = run([RETRO_ISSUE]);
		expect(r.out).toContain("CLEARED TRACKER (");
		expect(r.out).toContain(RETRO_TITLE);
	});

	it("does not report the weekly-retro tracker cleared while the last weekly run is 7 days old", () => {
		fixture();
		writeRetro("2026-08-21");
		const r = run([RETRO_ISSUE]);
		expect(r.out).not.toContain("CLEARED TRACKER (");
		expect(r.out).not.toContain("UNREADABLE CONDITION (");
	});

	it("reports the roadmap-ceilings tracker cleared once every card is under ceiling", () => {
		fixture();
		writeRoadmap([{ id: "fine" }]);
		const r = run([ROADMAP_ISSUE]);
		expect(r.out).toContain("CLEARED TRACKER (");
		expect(r.out).toContain(ROADMAP_TITLE);
	});

	it("does not report the roadmap-ceilings tracker cleared while a card is over ceiling", () => {
		fixture();
		writeRoadmap([{ id: "over", b: new Array(260).fill("w").join(" ") }]);
		const r = run([ROADMAP_ISSUE]);
		expect(r.out).not.toContain("CLEARED TRACKER (");
	});

	// mantahostels#3352: a capOk row is a ratified floor, not work.
	it("reports the roadmap-ceilings tracker cleared when every over-ceiling row is capOk-exempt", () => {
		fixture();
		writeRoadmap([
			{ id: "over", b: new Array(260).fill("w").join(" "), capOk: { b: 3368 } },
		]);
		const r = run([ROADMAP_ISSUE]);
		expect(r.out).toContain("CLEARED TRACKER (");
		expect(r.out).toContain(ROADMAP_TITLE);
	});

	it("reports the roadmap-ceilings tracker unreadable when the roadmap is missing", () => {
		fixture(); // writes no docs/reference-roadmap.html
		const r = run([ROADMAP_ISSUE]);
		expect(r.out).toContain("UNREADABLE CONDITION (");
		expect(r.out).not.toContain("CLEARED TRACKER (");
	});

	it("reports the band-drift tracker cleared once the overlap share recovers", () => {
		fixture();
		const n = MIN_BAND_SAMPLE + 20;
		writeBandCorpus(n, Math.ceil(n * BAND_BASELINE.overlapShare));
		const r = run([BAND_ISSUE]);
		expect(r.out).toContain("CLEARED TRACKER (");
		expect(r.out).toContain(BAND_TITLE);
	});

	it("does not report the band-drift tracker cleared while bands stay narrow", () => {
		fixture();
		writeBandCorpus(MIN_BAND_SAMPLE + 20, 0);
		const r = run([BAND_ISSUE]);
		expect(r.out).not.toContain("CLEARED TRACKER (");
		expect(r.out).toContain("every condition still standing");
	});

	it("reports the band-drift tracker unreadable, never cleared, on too small a sample", () => {
		fixture();
		const n = MIN_BAND_SAMPLE - 1;
		writeBandCorpus(n, n);
		const r = run([BAND_ISSUE]);
		expect(r.out).toContain("UNREADABLE CONDITION (");
		expect(r.out).not.toContain("CLEARED TRACKER (");
	});

	it("reports the top-figure tracker cleared once the share at 70 falls back", () => {
		fixture();
		const n = MIN_TOP_SAMPLE + 20;
		writeTopCorpus(
			n,
			Math.floor((n * TOP_BASELINE.atLine) / TOP_BASELINE.tops),
		);
		const r = run([TOP_ISSUE]);
		expect(r.out).toContain("CLEARED TRACKER (");
		expect(r.out).toContain(TOP_TITLE);
	});

	it("does not report the top-figure tracker cleared while tops bunch at 70", () => {
		fixture();
		const n = MIN_TOP_SAMPLE + 20;
		writeTopCorpus(n, n);
		const r = run([TOP_ISSUE]);
		expect(r.out).not.toContain("CLEARED TRACKER (");
		expect(r.out).toContain("every condition still standing");
	});

	it("reports the top-figure tracker unreadable, never cleared, on too small a sample", () => {
		fixture();
		writeTopCorpus(MIN_TOP_SAMPLE - 1, 0);
		const r = run([TOP_ISSUE]);
		expect(r.out).toContain("UNREADABLE CONDITION (");
		expect(r.out).not.toContain("CLEARED TRACKER (");
	});

	it("reads the manual tracker off the freshness checker's exit code", () => {
		fixture({ freshnessExit: 0 }); // fresh — the condition has cleared
		expect(run([MANUAL_ISSUE]).out).toContain("CLEARED TRACKER (");

		fixture({ freshnessExit: 1 }); // still stale
		expect(run([MANUAL_ISSUE]).out).not.toContain("CLEARED TRACKER (");

		fixture({ freshnessExit: 2 }); // BROKEN — the checker could not answer
		const broken = run([MANUAL_ISSUE]);
		expect(broken.out).toContain("UNREADABLE CONDITION (");
		expect(broken.out).not.toContain("CLEARED TRACKER (");
	});

	it("covers several reporters in one run", () => {
		fixture({ cycleEnd: "2026-11-29", mapWords: 10, freshnessExit: 0 }); // 10 words: under budget, so cleared
		const r = run([CYCLE_ISSUE, MANUAL_ISSUE, MAP_ISSUE]);
		for (const n of ["#1205", "#1700", "#1079"]) expect(r.out).toContain(n);
		expect(r.out).toContain("CLEARED TRACKER (3)");
	});

	it("writes nothing to the tracker — it reports, and closes nothing", () => {
		// The ruling at mantahostels#1699 was for a checker expressly over a closer.
		fixture({ cycleEnd: "2026-11-29", mapWords: 10, freshnessExit: 0 });
		const r = run(
			[CYCLE_ISSUE, MANUAL_ISSUE, MAP_ISSUE],
			[],
			sweepFixture("success"),
		);
		expect(r.out).toContain("CLEARED TRACKER (3)");
		const calls = ghCalls();
		// Counted against the reporters the checker actually holds, not a literal:
		// registering a fourth tracker (mantahostels#2030) broke a hard-coded 3 while the
		// property under test — that every call is a READ — was untouched.
		expect(calls.length).toBeGreaterThanOrEqual(3);
		for (const c of calls)
			expect(c.startsWith("issue list ") || c.startsWith("run ")).toBe(true);
	});

	it("reports a red suite with no open ci-red issue as CONDITION-UNFILED (mantahostels#2297)", () => {
		fixture();
		const r = run([], [], sweepFixture("failure"));
		expect(r.out).toContain("CONDITION UNFILED (1)");
		expect(r.out).toContain(REDSUITE_TITLE);
		expect(r.out).toContain("No open issue tracks it");
		expect(r.out).toContain(
			"File it by hand — node scripts/report-red-suite.js",
		);
		expect(r.status).not.toBe(0); // FAIL, not WARN — nobody was told
		// Pins the fix's own point (mantahostels#2297): this probe reads the SINGLE newest
		// sweep, never sweepStillRed()'s ~31-call RUN_WINDOW walk — one "issue
		// list" per tracker (8) plus one "run list" and one "run view".
		expect(ghCalls().length).toBe(10);
	});

	it("says nothing about a green suite with no ci-red issue open (mantahostels#2297)", () => {
		fixture();
		const r = run([], [], sweepFixture("success"));
		expect(r.out).not.toContain("CONDITION UNFILED (");
	});

	it("uses the expensive condition, never the cheap unfiled probe, once the issue is open (mantahostels#2297)", () => {
		fixture();
		// No sweep fixture: newestSweepRed() would throw if called at all, and
		// sweepStillRed() (the expensive `condition`) throws the same way here —
		// the assertion is that ONLY the latter runs when the issue is open.
		const r = run([REDSUITE_ISSUE]);
		expect(r.out).not.toContain("CONDITION UNFILED (");
		expect(r.out).toContain("UNREADABLE CONDITION (");
	});

	it("fails open to silence when the red-suite probe itself is unreadable (mantahostels#2297)", () => {
		fixture();
		// No sweep fixture and no open issue: the probe throws, and — unlike the
		// open-issue path above — there is no issue to report it against, so it
		// must not surface as a finding of any kind.
		const r = run([]);
		expect(r.out).not.toContain("CONDITION UNFILED (");
		expect(r.out).not.toContain(REDSUITE_TITLE);
	});

	it("does not evaluate a condition when no tracking issue is open", () => {
		// Order alone changes no output, so the pin is the call: the freshness
		// checker must never run where nothing was filed about it.
		fixture({ freshnessExit: 0 });
		run([]);
		expect(fs.existsSync(RAN_MARKER())).toBe(false);

		run([MANUAL_ISSUE]);
		expect(fs.existsSync(RAN_MARKER())).toBe(true);
	});

	it("reports the same cleared tracker on every run, having no stamp", () => {
		// Deliberate at mantahostels#1699.
		fixture({ cycleEnd: "2026-11-29" });
		expect(run([CYCLE_ISSUE], ["--notify"]).stdout).toContain("#1205");
		expect(run([CYCLE_ISSUE], ["--notify"]).stdout).toContain("#1205");
	});

	it("skips rather than reports when gh cannot be reached", () => {
		fixture();
		const gh = stubGhScript(dir, "", { failing: true });
		const r = spawnSync("node", [SCRIPT], {
			cwd: dir,
			encoding: "utf8",
			env: { ...process.env, ...gh.env, CYCLE_TODAY: TODAY },
		});
		expect(`${r.stdout}${r.stderr}`).toContain("SKIP");
		expect(r.status).toBe(0);
	});

	it("prints nothing under --notify when there is nothing to say", () => {
		fixture();
		const r = run([MANUAL_ISSUE], ["--notify"]);
		expect(r.stdout.trim()).toBe("");
		expect(r.stderr.trim()).toBe(""); // a session start pays for both streams
		expect(r.status).toBe(0);
	});

	it("puts a cleared tracker on stdout under --notify, so a session reads it", () => {
		fixture({ cycleEnd: "2026-11-29" });
		const r = run([CYCLE_ISSUE], ["--notify"]);
		expect(r.stdout).toContain("#1205");
		expect(r.status).toBe(0);
	});
});
