// @vitest-environment node
/*
 * Pins replay-notify-reports.js, the reader that injects what the slow
 * SessionStart producers persisted (mantahostels#1976, mantahostels#1949): each
 * report shown once with its age, a stale one dropped, a corrupt one named, and
 * delivery stamps spent only when a report actually reaches a session.
 *
 * The reader is driven end to end: fixture report files in a
 * throwaway state directory, the real script run over them, and its stdout and
 * exit code as the only assertions. Nothing here reaches into a private
 * function.
 *
 * Through `runInProcess` rather than a spawn (§X3): the script is synchronous,
 * has no fd, no timeout and no second process, so none of the three shapes
 * that keep a spawn applies.
 *
 * CLAUDE_CONFIG_DIR and CLAUDE_PROJECT_DIR point into the temp directory: the
 * real config dir otherwise collects stray reports, and a slug shared with a
 * previous run would make two suites read one store.
 *
 * The fixtures are written through notify-report.js itself rather than by
 * hand-spelling paths — a test that computed the filename separately would keep
 * passing after the on-disk format moved. The one exception is the reader's own
 * `shown` record (`shownFile`/`backdateShown` below): the script that owns that
 * format has no requirable export, so its naming is duplicated here (mantahostels#2327).
 *
 * It runs first and synchronously at every SessionStart (`.claude/settings.json`),
 * the only route a slow hook's report takes to the session: loosen a case and
 * those reports vanish, repeat every start, or show a stale reading as current.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRecordFile } from "./lib/notify-report-testkit";
import { runInProcess } from "./lib/run-in-process";
import { useScratchCore } from "./lib/scratch-core-testkit";

const require_ = createRequire(__filename);
// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const notify: any = require_("./lib/notify-report.js");
// biome-ignore lint/suspicious/noExplicitAny: as above
const proc: any = require_("./lib/arbiter-proc.js");
// biome-ignore lint/suspicious/noExplicitAny: as above
const stamps: any = require_("./lib/delivery-stamp.js");
/* The reaper files its reports under its own name (reap-finished-sessions.js). */
const REAPER = "reap-finished-sessions";

const SCRIPT = path.resolve(__dirname, "replay-notify-reports.js");

let dir = "";
const savedEnv = { ...process.env };

/** The script, run over the fixture store. */
const read = (...args: string[]) => {
	const r = runInProcess(SCRIPT, args, {
		env: { ...process.env },
		cwd: path.resolve(__dirname, ".."),
	});
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

/** A finished report, `agoMs` old. */
const report = (
	checker: string,
	text: string,
	{
		agoMs = 0,
		outcome = "WARN",
		stamp = null as string | null,
		stamps: carriedStamps = undefined as Record<string, string> | undefined,
		durationMs = null as number | null,
		maxAgeMs = null as number | null,
	} = {},
) =>
	notify.writeReport(checker, {
		outcome,
		text,
		stamp,
		stamps: carriedStamps,
		durationMs,
		maxAgeMs,
		finishedAt: new Date(Date.now() - agoMs),
	});

/* Mirrors replay-notify-reports.js's own SILENT_AGE_FLOOR_MS (mantahostels#2327) — the
 * fallback floor for a report with no durationMs of its own. The script has
 * no requirable export — importing it runs it — so the value is duplicated
 * here. */
const SILENT_AGE_FLOOR_MS = 2 * 65_300;

/** Wires `checkers` (script basenames, e.g. "check-ghost-jobs") as persisting
 * SessionStart producers in a fixture .claude/settings.json — the shape mantahostels#2284
 * reads to build its roster. */
const wireRoster = (checkers: string[]) => {
	const settingsDir = path.join(
		process.env.CLAUDE_PROJECT_DIR as string,
		".claude",
	);
	fs.mkdirSync(settingsDir, { recursive: true });
	fs.writeFileSync(
		path.join(settingsDir, "settings.json"),
		JSON.stringify({
			hooks: {
				SessionStart: [
					{
						hooks: checkers.map((name) => ({
							type: "command",
							command:
								"command -v node >/dev/null 2>&1 && WFC_NOTIFY_PERSIST=1 node " +
								`"$CLAUDE_PROJECT_DIR"/scripts/${name}.js --notify || true`,
							timeout: 15,
							async: true,
						})),
					},
				],
			},
		}),
	);
};
/* Every producer these fixtures write a report, run record or shown record
 * for, wired as the roster `beforeEach` — because in the repo a producer that
 * has written a report is one .claude/settings.json wires, and mantahostels#2679 made
 * roster membership the gate on every fault this reader raises. A test about
 * the roster itself overwrites this with its own `wireRoster` call; a test
 * about an UNWIRED producer names one deliberately left out of it. */
const DEFAULT_ROSTER = [
	"ci-status",
	"check-ghost-jobs",
	"check-hook-liveness",
	"check-issue-labels",
	"check-guard-errors",
	"check-cleared-trackers",
	"reap-finished-sessions",
];

/** As `wireRoster`, but for a hook wired with no `WFC_NOTIFY_PERSIST=1` —
 * the ordinary, synchronous shape most SessionStart hooks still use — which
 * mantahostels#2284's roster must not pick up. */
const wireSyncHook = (checker: string) => {
	const settingsDir = path.join(
		process.env.CLAUDE_PROJECT_DIR as string,
		".claude",
	);
	fs.mkdirSync(settingsDir, { recursive: true });
	fs.writeFileSync(
		path.join(settingsDir, "settings.json"),
		JSON.stringify({
			hooks: {
				SessionStart: [
					{
						hooks: [
							{
								type: "command",
								command: `node "$CLAUDE_PROJECT_DIR"/scripts/${checker}.js --notify`,
								timeout: 15,
							},
						],
					},
				],
			},
		}),
	);
};

/** As `wireRoster`, but exec form (mantahostels#2059) — the interpreter as `command`, the
 * script path and the persist markers split into `args` — which mantahostels#2302's
 * migration onto the shared `buildHookCommandLine` join is what lets the roster
 * see at all. */
const wireExecRoster = (checker: string) => {
	const settingsDir = path.join(
		process.env.CLAUDE_PROJECT_DIR as string,
		".claude",
	);
	fs.mkdirSync(settingsDir, { recursive: true });
	fs.writeFileSync(
		path.join(settingsDir, "settings.json"),
		JSON.stringify({
			hooks: {
				SessionStart: [
					{
						hooks: [
							{
								type: "command",
								command: "node",
								args: [
									"WFC_NOTIFY_PERSIST=1",
									`scripts/${checker}.js`,
									"--notify",
								],
								timeout: 15,
								async: true,
							},
						],
					},
				],
			},
		}),
	);
};

/** An open run record for a process that is gone. */
const deadRun = (checker: string, startedAt = new Date().toISOString()) =>
	fs.writeFileSync(
		runRecordFile(checker),
		JSON.stringify({
			checker,
			startedAt,
			pid: 4_194_303,
			procStart: "1",
			bootId: proc.readCurrentBootId(),
		}),
	);

/** An open run record for a producer still running — this very process. */
const liveRun = (checker: string) =>
	fs.writeFileSync(
		runRecordFile(checker),
		JSON.stringify({
			checker,
			startedAt: new Date().toISOString(),
			pid: process.pid,
			procStart: proc.readProcStartOf(process.pid),
			bootId: proc.readCurrentBootId(),
		}),
	);

/** Same naming as replay-notify-reports.js's own shownFile() — duplicated
 * here for the reason SILENT_AGE_FLOOR_MS above is. */
const shownFile = (checker: string) =>
	path.join(
		notify.base(),
		`${checker.replace(/[^A-Za-z0-9_-]/g, "-")}.shown.json`,
	);

/** Backdates what the reader last recorded of `checker` — a never-ran roster
 * member's first-seen wall clock, in particular — so a test can clear the
 * age floor without a real wait. `start` must match the start number the
 * reader already wrote (typically 1, from one prior `read()` call). */
const backdateShown = (checker: string, start: number, agoMs: number) =>
	fs.writeFileSync(
		shownFile(checker),
		JSON.stringify({
			at: new Date(Date.now() - agoMs).toISOString(),
			start,
			digest: "",
		}),
	);

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-reports-"));
	process.env.CLAUDE_CONFIG_DIR = path.join(dir, "claude");
	process.env.CLAUDE_PROJECT_DIR = path.join(dir, "repo");
	delete process.env.WFC_CLAUDE_CONFIG_A;
	delete process.env.WFC_CLAUDE_CONFIG_B;
	delete process.env.WFC_CLAUDE_CONFIG_C;
	delete process.env.WFC_NOTIFY_PERSIST;
	fs.mkdirSync(process.env.CLAUDE_PROJECT_DIR, { recursive: true });
	fs.mkdirSync(notify.base(), { recursive: true });
	useScratchCore(dir);
	wireRoster(DEFAULT_ROSTER);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	process.env = { ...savedEnv };
});

describe("injecting what the producers persisted", () => {
	it("prints each report with its age, and exits 0", () => {
		report("ghost-jobs", "WARN: 2 ghost job(s)\nrun A\n");
		report("hook-liveness", "FAIL: a wired hook is dead\n", {
			agoMs: 4 * 60 * 1000,
		});

		const { status, out } = read("--notify");
		expect(status).toBe(0);
		expect(out).toContain("WARN: 2 ghost job(s)");
		expect(out).toContain("run A");
		expect(out).toContain("FAIL: a wired hook is dead");
		expect(out).toMatch(/ghost-jobs — \d+s ago/);
		expect(out).toMatch(/hook-liveness — 4 min ago/);
	});

	it("says nothing at all when no producer has written", () => {
		const { status, out } = read("--notify");
		expect(status).toBe(0);
		expect(out).toBe("");
	});

	/* The producer writes a file for an OK run with nothing to say, so that
	 * "ran and was quiet" is not read as "never ran" — and the reader must not
	 * turn that empty text into an injected block. */
	it("injects nothing for a report whose text is empty", () => {
		report("ci-status", "", { outcome: "OK" });
		const { out } = read("--notify");
		expect(out).toBe("");
	});

	/* An empty report judged for staleness first would be counted among the
	 * reports dropped as too old, though there was never anything to drop. */
	it("does not count an old empty report as one dropped for staleness", () => {
		report("ci-status", "", {
			outcome: "OK",
			agoMs: notify.DEFAULT_STALE_MS + 60_000,
		});
		expect(read("--notify").out).toBe("");
	});

	it("survives a corrupt report beside good ones, and names it", () => {
		report("ghost-jobs", "WARN: 2 ghost job(s)\n");
		fs.writeFileSync(notify.reportFile("ci-status"), "{ half-writ");

		const { status, out } = read("--notify");
		expect(status).toBe(0);
		expect(out).toContain("WARN: 2 ghost job(s)");
		expect(out).toContain("ci-status");
		expect(out).toContain("will not parse");
	});
});

describe("showing a report once", () => {
	it("suppresses a report already shown at an earlier start", () => {
		report("ghost-jobs", "WARN: 2 ghost job(s)\n");

		expect(read("--notify").out).toContain("WARN: 2 ghost job(s)");
		expect(read("--notify").out).toBe("");
	});

	/* mantahostels#1976: a producer that reruns and reprints the same standing finding
	 * writes a new timestamp every start, so only the TEXT can stop the repeat. */
	it("suppresses an identical report from a later run of the producer", () => {
		report("ghost-jobs", "WARN: 2 ghost job(s)\n");
		expect(read("--notify").out).toContain("WARN: 2 ghost job(s)");

		report("ghost-jobs", "WARN: 2 ghost job(s)\n");
		expect(read("--notify").out).toBe("");
	});

	it("shows it again once the producer writes a different one", () => {
		report("ghost-jobs", "WARN: 2 ghost job(s)\n");
		read("--notify");
		report("ghost-jobs", "WARN: 3 ghost job(s)\n");

		expect(read("--notify").out).toContain("WARN: 3 ghost job(s)");
	});

	/* Delivery, not production, sets the once-only stamps (mantahostels#1975): the producer
	 * carries its signature in the report and this is where it is spent. */
	it("suppresses a report whose delivery stamp is already recorded", () => {
		report("ghost-jobs", "WARN: 2 ghost job(s)\n", { stamp: "a,b" });
		stamps.recordDelivery("ghost-jobs", "a,b");

		expect(read("--notify").out).toBe("");
	});

	it("records the stamp itself once it has shown the report", () => {
		report("ghost-jobs", "WARN: 2 ghost job(s)\n", { stamp: "a,b" });
		expect(stamps.readStamp("ghost-jobs")).toBeNull();

		expect(read("--notify").out).toContain("WARN: 2 ghost job(s)");
		expect(stamps.readStamp("ghost-jobs")).toBe("a,b");
	});

	/* A hand run is an inspection, not a delivery: it must not spend what a
	 * session start is owed (mantahostels#1949 story 23). */
	it("a hand run shows everything and consumes nothing", () => {
		report("ghost-jobs", "WARN: 2 ghost job(s)\n", { stamp: "a,b" });

		expect(read().out).toContain("WARN: 2 ghost job(s)");
		expect(stamps.readStamp("ghost-jobs")).toBeNull();
		expect(read().out).toContain("WARN: 2 ghost job(s)");
		expect(read("--notify").out).toContain("WARN: 2 ghost job(s)");
	});

	/* mantahostels#2277: a checker with several stamps — census, manifest, and so on for
	 * check-hook-liveness.js — carries them as `stamps`, a name-to-signature
	 * map, beside the single `stamp` field the other three producers use. */
	describe("a report carrying several stamps", () => {
		it("suppresses a report only once EVERY one of its stamps is recorded", () => {
			report("hook-liveness", "FAIL: 2 hook(s) failing\n", {
				stamps: {
					"hook-liveness-census": "s1",
					"hook-liveness-manifest": "s2",
				},
			});
			stamps.recordDelivery("hook-liveness-census", "s1");
			// One of the two is still unrecorded, so there is genuinely something new.
			expect(read("--notify").out).toContain("FAIL: 2 hook(s) failing");

			stamps.recordDelivery("hook-liveness-manifest", "s2");
			report(
				"hook-liveness",
				"FAIL: 2 hook(s) failing, differently narrated\n",
				{
					stamps: {
						"hook-liveness-census": "s1",
						"hook-liveness-manifest": "s2",
					},
				},
			);
			// Both are now recorded, so the differing narration is the noise the
			// stamps exist to see past — nothing new to say.
			expect(read("--notify").out).toBe("");
		});

		it("records every stamp in the map once it has shown the report", () => {
			report("hook-liveness", "FAIL: 2 hook(s) failing\n", {
				stamps: {
					"hook-liveness-census": "s1",
					"hook-liveness-manifest": "s2",
				},
			});
			expect(stamps.readStamp("hook-liveness-census")).toBeNull();
			expect(stamps.readStamp("hook-liveness-manifest")).toBeNull();

			expect(read("--notify").out).toContain("FAIL: 2 hook(s) failing");
			expect(stamps.readStamp("hook-liveness-census")).toBe("s1");
			expect(stamps.readStamp("hook-liveness-manifest")).toBe("s2");
		});

		/* check-guard-errors.js's actual shape: its own report stamp under
		 * `stamp` (keyed on its report name) plus the INERT warning's under
		 * `stamps` (keyed on a name of its own) — both must be delivered before
		 * the merged report is suppressed. */
		it("merges the single `stamp` field with the `stamps` map into one gate", () => {
			report("guard-errors", "FAIL: 1 guard fail-open(s)\nINERT: platform\n", {
				stamp: "log-sig",
				stamps: { "guard-errors-inert": "inert-sig" },
			});
			stamps.recordDelivery("guard-errors", "log-sig");
			// The INERT half is still unrecorded, so there is genuinely something new.
			expect(read("--notify").out).toContain("FAIL: 1 guard fail-open(s)");

			report(
				"guard-errors",
				"FAIL: 1 guard fail-open(s)\nINERT: platform, renarrated\n",
				{
					stamp: "log-sig",
					stamps: { "guard-errors-inert": "inert-sig" },
				},
			);
			// Both are now recorded — the INERT renarration is nothing new to say.
			expect(read("--notify").out).toBe("");
			expect(stamps.readStamp("guard-errors")).toBe("log-sig");
			expect(stamps.readStamp("guard-errors-inert")).toBe("inert-sig");
		});

		/* A checker with no stamps at all — GUARD-LIBRARY's kind of finding — has
		 * nothing here to gate on: the digest check above is the only suppression
		 * it has ever had, and this must not vacuously suppress it on an empty
		 * map. */
		it("shows an unstamped report every time its text changes", () => {
			report("hook-liveness", "FAIL: the library is unreadable\n");
			expect(read("--notify").out).toContain("FAIL: the library is unreadable");

			report("hook-liveness", "FAIL: the library is unreadable, again\n");
			expect(read("--notify").out).toContain(
				"FAIL: the library is unreadable, again",
			);
		});
	});
});

describe("a report too old to be true", () => {
	it("drops a stale report rather than showing it as current", () => {
		report("ci-status", "FAIL: the suite is red\n", {
			agoMs: notify.DEFAULT_STALE_MS + 60_000,
		});

		const { status, out } = read("--notify");
		expect(status).toBe(0);
		expect(out).not.toContain("the suite is red");
		expect(out).toContain("dropped as stale");
		expect(out).toContain("ci-status");
	});

	it("shows one just inside the bound", () => {
		report("ci-status", "FAIL: the suite is red\n", {
			agoMs: notify.DEFAULT_STALE_MS - 60_000,
		});
		expect(read("--notify").out).toContain("the suite is red");
	});

	/* A producer may carry its own maximum age — 7 days, as repo-checks.js's
	 * daily reading does (#1553), which a start now holds back (#2038). */
	describe("a report carrying its own maximum age", () => {
		const hourMs = 3_600_000;
		const weekMs = 7 * 24 * hourMs;

		it("is shown at 5 hours old", () => {
			report("weekly-reading", "WEEKLY (1) — drift gained\n", {
				agoMs: 5 * hourMs,
				maxAgeMs: weekMs,
			});
			const { status, out } = read("--notify");
			expect(status).toBe(0);
			expect(out).toContain("drift gained");
		});

		it("is dropped as stale at 8 days old", () => {
			report("weekly-reading", "WEEKLY (1) — drift gained\n", {
				agoMs: 8 * 24 * hourMs,
				maxAgeMs: weekMs,
			});
			const { status, out } = read("--notify");
			expect(status).toBe(0);
			expect(out).not.toContain("drift gained");
		});

		it("leaves a neighbour without one stale at 4 hours", () => {
			report("weekly-reading", "WEEKLY (1) — drift gained\n", {
				agoMs: 5 * hourMs,
				maxAgeMs: weekMs,
			});
			report("ci-status", "FAIL: the suite is red\n", { agoMs: 5 * hourMs });
			const { status, out } = read("--notify");
			expect(status).toBe(0);
			expect(out).toContain("drift gained");
			expect(out).not.toContain("the suite is red");
		});
	});

	/* Dropping it at a start is the point; hiding it from the founder
	 * diagnosing the store by hand is not. */
	it("a hand run shows it, marked", () => {
		report("ci-status", "FAIL: the suite is red\n", {
			agoMs: notify.DEFAULT_STALE_MS + 60_000,
		});
		const { out } = read();
		expect(out).toContain("the suite is red");
		expect(out).toContain("stale");
	});
});

describe("a producer that has gone quiet", () => {
	/* Counted in starts rather than hours: the reader's own memory is what
	 * separates a wedged producer from a night away from the machine. Aged
	 * past the floor at creation, so the count alone is not what fires it —
	 * see the age-floor tests below for that half. */
	it("names one that has not finished a run for three starts", () => {
		report("issue-labels", "WARN: 4 label fault(s)\n", {
			agoMs: SILENT_AGE_FLOOR_MS + 1000,
		});

		expect(read("--notify").out).toContain("WARN: 4 label fault(s)");
		expect(read("--notify").out).toBe("");
		expect(read("--notify").out).toBe("");

		const { out } = read("--notify");
		expect(out).toContain("issue-labels has not finished a run for 3");
		expect(out).toContain("producer fault(s)");
	});

	it("says nothing of one that keeps finishing runs", () => {
		for (let i = 0; i < 4; i += 1) {
			report("issue-labels", `WARN: ${i} label fault(s)\n`);
			expect(read("--notify").out).not.toContain("has not finished a run");
		}
	});

	/* mantahostels#2327: parallel background jobs start several sessions inside a
	 * minute. The reported false alarm was a report 72s old, well inside
	 * check-cleared-trackers's own ~65s run time. */
	describe("the age floor (mantahostels#2327)", () => {
		it("does not name a producer wedged from start count alone, while its report is still inside a normal run", () => {
			report("check-cleared-trackers", "WARN: stuck\n", { agoMs: 72_000 });
			for (let i = 0; i < 6; i += 1)
				expect(read("--notify").out).not.toContain("has not finished a run");
		});

		it("still names one once its own measured run time has passed, even at a fraction of the fallback floor", () => {
			// A 10s producer: the 2x margin is 20s, comfortably inside the
			// SILENT_AGE_FLOOR_MS fallback used where no durationMs is known.
			report("ci-status", "FAIL: red\n", { agoMs: 21_000, durationMs: 10_000 });
			read("--notify");
			read("--notify");
			read("--notify");
			const { out } = read("--notify");
			expect(out).toContain("ci-status has not finished a run for 3");
		});

		it("does not name that same fast producer wedged while still inside its own margin", () => {
			report("ci-status", "FAIL: red\n", { agoMs: 15_000, durationMs: 10_000 });
			for (let i = 0; i < 4; i += 1)
				expect(read("--notify").out).not.toContain("has not finished a run");
		});

		/* mantahostels#2342: an implausibly fast reading (under MIN_PLAUSIBLE_DURATION_MS)
		 * must fall back to the same fallback floor a producer with no
		 * durationMs at all gets. */
		it("does not trust an implausibly fast durationMs, falling back to the fallback floor", () => {
			report("check-cleared-trackers", "WARN: stuck\n", {
				agoMs: 72_000,
				durationMs: 200,
			});
			for (let i = 0; i < 6; i += 1)
				expect(read("--notify").out).not.toContain("has not finished a run");
		});

		it("still fires once age clears the fallback floor, for that same fast-fluke reading", () => {
			report("check-cleared-trackers", "WARN: stuck\n", {
				agoMs: SILENT_AGE_FLOOR_MS + 1000,
				durationMs: 200,
			});
			read("--notify");
			read("--notify");
			read("--notify");
			const { out } = read("--notify");
			expect(out).toContain(
				"check-cleared-trackers has not finished a run for 3",
			);
		});

		/* mantahostels#2342: WEDGED is judged off the last COMPLETED report and has no other
		 * route to see a run in progress right now — it must consult the
		 * open-run record itself, the way NEVER-RAN already does. */
		it("does not name a producer wedged while it has a live open run", () => {
			report("check-cleared-trackers", "WARN: stuck\n", {
				agoMs: SILENT_AGE_FLOOR_MS + 1000,
			});
			liveRun("check-cleared-trackers");
			for (let i = 0; i < 6; i += 1)
				expect(read("--notify").out).not.toContain("has not finished a run");
		});

		it("names it once that open run is gone and the last report is still old enough", () => {
			report("check-cleared-trackers", "WARN: stuck\n", {
				agoMs: SILENT_AGE_FLOOR_MS + 1000,
			});
			liveRun("check-cleared-trackers");
			read("--notify");
			fs.rmSync(runRecordFile("check-cleared-trackers"), { force: true });
			read("--notify");
			read("--notify");
			const { out } = read("--notify");
			expect(out).toContain(
				"check-cleared-trackers has not finished a run for 3",
			);
		});

		/* mantahostels#2342: a dead run record — the producer's process is gone, but the
		 * file it opened persists until the CANCELLED loop reports it — must
		 * not suppress WEDGED. */
		it("still names a producer wedged despite a dead run record", () => {
			report("check-cleared-trackers", "WARN: stuck\n", {
				agoMs: SILENT_AGE_FLOOR_MS + 1000,
			});
			deadRun("check-cleared-trackers");
			read("--notify");
			read("--notify");
			read("--notify");
			const { out } = read("--notify");
			expect(out).toContain(
				"check-cleared-trackers has not finished a run for 3",
			);
		});
	});
});

/* mantahostels#2284: notify.list() only sees a checker that has written a report or an
 * open run, so a producer wired at SessionStart but wedged before its first
 * openRun — or never invoked at all — never reaches either loop above. */
describe("a producer wired but never run", () => {
	it("names a roster member that has never written a report or an open run", () => {
		wireRoster(["check-ghost-jobs"]);

		expect(read("--notify").out).toBe("");
		backdateShown("ghost-jobs", 1, SILENT_AGE_FLOOR_MS + 1000);
		expect(read("--notify").out).toBe("");
		expect(read("--notify").out).toBe("");

		const { out } = read("--notify");
		expect(out).toContain("ghost-jobs is wired at SessionStart");
		expect(out).toContain("never written a report or an open run");
		expect(out).toContain("producer fault(s)");
	});

	/* mantahostels#2327: the same age floor as WEDGED applies here, off the wall clock
	 * this reader captures the first time it sees the roster member. */
	it("does not name a roster member NEVER-RAN from start count alone, inside the age floor", () => {
		wireRoster(["check-ghost-jobs"]);
		for (let i = 0; i < 6; i += 1)
			expect(read("--notify").out).not.toContain(
				"never written a report or an open run",
			);
	});

	it("says nothing about a roster member with an open run", () => {
		wireRoster(["check-ghost-jobs"]);
		liveRun("ghost-jobs");

		for (let i = 0; i < 4; i += 1) expect(read("--notify").out).toBe("");
	});

	it("says nothing once the producer has finally reported", () => {
		wireRoster(["check-ghost-jobs"]);
		read("--notify");
		read("--notify");
		expect(read("--notify").out).toBe("");

		report("ghost-jobs", "WARN: 2 ghost job(s)\n");
		const { out } = read("--notify");
		expect(out).not.toContain("never written a report");
		expect(out).toContain("WARN: 2 ghost job(s)");
	});

	it("stays silent past the bound once it starts reporting", () => {
		wireRoster(["check-ghost-jobs"]);
		expect(read("--notify").out).toBe("");
		backdateShown("ghost-jobs", 1, SILENT_AGE_FLOOR_MS + 1000);
		expect(read("--notify").out).toBe("");
		expect(read("--notify").out).toBe("");
		const { out } = read("--notify");
		expect(out).toContain("never written a report or an open run");

		report("ghost-jobs", "WARN: 2 ghost job(s)\n");
		for (let i = 0; i < 4; i += 1)
			expect(read("--notify").out).not.toContain("never written a report");
	});

	/* The plugin's hooks still read, so the roster is known, and an adopter
	 * may carry no settings file (#940): nothing reaches either stream (#2462). */
	it("says nothing where .claude/settings.json is absent", () => {
		const settings = path.join(
			process.env.CLAUDE_PROJECT_DIR as string,
			".claude",
			"settings.json",
		);
		fs.rmSync(settings);
		for (let i = 0; i < 4; i += 1) {
			const r = runInProcess(SCRIPT, ["--notify"], {
				env: { ...process.env },
				cwd: path.resolve(__dirname, ".."),
			});
			expect(r.stdout).toBe("");
			expect(r.stderr).toBe("");
		}
	});

	it("says nothing where .claude/settings.json will not parse", () => {
		const settingsDir = path.join(
			process.env.CLAUDE_PROJECT_DIR as string,
			".claude",
		);
		fs.mkdirSync(settingsDir, { recursive: true });
		fs.writeFileSync(path.join(settingsDir, "settings.json"), "{ half-writ");
		for (let i = 0; i < 4; i += 1) expect(read("--notify").out).toBe("");
	});

	it("uses check-cleared-trackers's own name, which keeps its check- prefix", () => {
		wireRoster(["check-cleared-trackers"]);
		expect(read("--notify").out).toBe("");
		backdateShown("check-cleared-trackers", 1, SILENT_AGE_FLOOR_MS + 1000);
		expect(read("--notify").out).toBe("");
		expect(read("--notify").out).toBe("");

		const { out } = read("--notify");
		expect(out).toContain("check-cleared-trackers is wired at SessionStart");
	});

	it("ignores a hook wired with no WFC_NOTIFY_PERSIST=1", () => {
		wireSyncHook("check-ghost-jobs");
		for (let i = 0; i < 4; i += 1) expect(read("--notify").out).toBe("");
	});

	it("names a roster member wired in exec form, its markers split into args", () => {
		wireExecRoster("check-ghost-jobs");
		expect(read("--notify").out).toBe("");
		backdateShown("ghost-jobs", 1, SILENT_AGE_FLOOR_MS + 1000);
		expect(read("--notify").out).toBe("");
		expect(read("--notify").out).toBe("");

		const { out } = read("--notify");
		expect(out).toContain("ghost-jobs is wired at SessionStart");
		expect(out).toContain("never written a report or an open run");
	});

	it("carries it in the --json envelope", () => {
		wireRoster(["check-ghost-jobs"]);
		read("--notify");
		backdateShown("ghost-jobs", 1, SILENT_AGE_FLOOR_MS + 1000);
		read("--notify");
		read("--notify");

		const doc = JSON.parse(read("--json").out);
		expect(doc.neverRan.map((r: { checker: string }) => r.checker)).toEqual([
			"ghost-jobs",
		]);
	});
});

/* mantahostels#2679: unwiring a producer leaves its report files on disk, and ungated
 * they age past SILENT_STARTS and are named WEDGED at every start forever. */
describe("a producer the repo's hooks no longer wire", () => {
	const unwire = () =>
		wireRoster(DEFAULT_ROSTER.filter((s) => s !== "check-ghost-jobs"));

	it("is never named wedged, however many starts pass", () => {
		unwire();
		report("ghost-jobs", "WARN: 2 ghost job(s)\n", {
			agoMs: SILENT_AGE_FLOOR_MS + 1000,
		});
		for (let i = 0; i < 6; i += 1)
			expect(read("--notify").out).not.toContain("has not finished a run");
	});

	it("still names a wedged producer that is wired", () => {
		unwire();
		report("issue-labels", "WARN: 4 label fault(s)\n", {
			agoMs: SILENT_AGE_FLOOR_MS + 1000,
		});
		read("--notify");
		read("--notify");
		read("--notify");
		expect(read("--notify").out).toContain(
			"issue-labels has not finished a run for 3",
		);
	});

	/* Injection is deliberately NOT gated: a finding written just before the
	 * hook was removed still reached nobody. */
	it("still replays its last report once, while that report is fresh", () => {
		unwire();
		report("ghost-jobs", "WARN: 2 ghost job(s)\n");
		expect(read("--notify").out).toContain("WARN: 2 ghost job(s)");
		expect(read("--notify").out).toBe("");
	});

	it("is not counted among the reports dropped as stale", () => {
		unwire();
		report("ghost-jobs", "WARN: 2 ghost job(s)\n", {
			agoMs: notify.DEFAULT_STALE_MS + 60_000,
		});
		expect(read("--notify").out).not.toContain("dropped as stale");
	});

	it("is not named cut off mid-run by a run record left behind", () => {
		unwire();
		deadRun("ghost-jobs", "2026-08-31T09:00:00.000Z");
		expect(read("--notify").out).not.toContain("was cut off mid-run");
	});

	/* An unreadable report from an unwired producer is a fault about a
	 * producer too. */
	it("is not named UNREADABLE for a report file that will not parse", () => {
		unwire();
		fs.writeFileSync(notify.reportFile("ghost-jobs"), "{ half-writ");
		expect(read("--notify").out).not.toContain("will not parse");
	});

	/* A session start says nothing; the founder reading the store by hand is
	 * told which keys are being ignored, and how to be rid of them. The
	 * assertion is on the joined form: a bare "ghost-jobs" is satisfied by the
	 * injection block's own header. */
	it("is named on a hand run, and carried in the --json envelope", () => {
		unwire();
		report("ghost-jobs", "WARN: 2 ghost job(s)\n");

		expect(read().out).toContain(
			"do not wire as a persisting SessionStart producer: ghost-jobs",
		);

		const doc = JSON.parse(read("--json").out);
		expect(doc.unwired).toEqual(["ghost-jobs"]);
	});

	/* repo-checks.js's daily report is refreshed by the launcher, never by a
	 * hook, so the founder is never told to delete it (#1553). */
	it("never names a repo-checks report", () => {
		unwire();
		report("repo-checks.o.r", "REPO-CHECKS (1) — drift gained\n");
		const { status, out } = read("--json");
		expect(status).toBe(0);
		expect(JSON.parse(out).unwired).toEqual([]);
	});

	/* Counted off the store rather than off the report loop, so a key whose
	 * only file is a leftover run record is named too. */
	it("is counted from a leftover run record alone, with no report at all", () => {
		unwire();
		deadRun("ghost-jobs", "2026-08-31T09:00:00.000Z");
		expect(JSON.parse(read("--json").out).unwired).toEqual(["ghost-jobs"]);
	});
});

/* mantahostels#2679: an absent or half-written .claude/settings.json comes back as an
 * empty roster, indistinguishable from a repo wiring no persisting producer
 * at all. Read as fact it would mark every producer unwired and suppress
 * every fault — so the gate reverts to judging off the store alone. */
describe("a roster that cannot be read at all", () => {
	const breakSettings = () =>
		fs.writeFileSync(
			path.join(
				process.env.CLAUDE_PROJECT_DIR as string,
				".claude",
				"settings.json",
			),
			"{ half-writ",
		);

	it("still names a wedged producer, rather than going quiet", () => {
		breakSettings();
		report("issue-labels", "WARN: 4 label fault(s)\n", {
			agoMs: SILENT_AGE_FLOOR_MS + 1000,
		});
		read("--notify");
		read("--notify");
		read("--notify");
		expect(read("--notify").out).toContain(
			"issue-labels has not finished a run for 3",
		);
	});

	it("still names a producer cut off mid-run", () => {
		breakSettings();
		deadRun("ghost-jobs", "2026-08-31T09:00:00.000Z");
		expect(read("--notify").out).toContain("ghost-jobs was cut off mid-run");
	});

	it("calls nothing unwired, having no roster to say so against", () => {
		breakSettings();
		report("ghost-jobs", "WARN: 2 ghost job(s)\n");
		expect(JSON.parse(read("--json").out).unwired).toEqual([]);
	});
});

describe("a producer cut off mid-run", () => {
	it("names an open run record whose process is gone", () => {
		deadRun("ghost-jobs", "2026-08-31T09:00:00.000Z");

		const { status, out } = read("--notify");
		expect(status).toBe(0);
		expect(out).toContain("ghost-jobs was cut off mid-run");
		expect(out).toContain("2026-08-31T09:00:00.000Z");
	});

	/* mantahostels#2331: the ceiling on an `async` SessionStart entry is not enforced
	 * (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/async-hook-timeout-enforcement.md). So a cancellation has
	 * one cause, and a reader sent after the timeout number would be sent after
	 * a number that does nothing. */
	it("blames the dead process, and never a timeout", () => {
		deadRun("ghost-jobs", "2026-08-31T09:00:00.000Z");

		const { out } = read("--notify");
		expect(out).toContain("its process is gone");
		/* Every spelling of the wrong cause, not just the word `timeout`: the
		 * failure this pins is a reader sent to raise the number, however the
		 * text spells it. */
		expect(out).not.toMatch(
			/time[d\s-]?out|time limit|ceiling|settings\.json|raise/i,
		);
	});

	it("says nothing about a producer still running", () => {
		liveRun("ghost-jobs");
		expect(read("--notify").out).toBe("");
	});

	/* mantahostels#1976: the reaper reports its own cancellation in the text this reader
	 * injects, so naming it here too would say it twice. A rename of the
	 * reaper's report fails reap-finished-sessions.test.ts, which reads the
	 * report under this same literal. */
	it("leaves the reaper's cancellation to the reaper", () => {
		deadRun(REAPER, "2026-08-31T09:00:00.000Z");
		expect(read("--notify").out).toBe("");
	});

	it("still carries it in the --json envelope, which nobody double-reports to", () => {
		deadRun(REAPER, "2026-08-31T09:00:00.000Z");
		const doc = JSON.parse(read("--json").out);
		expect(doc.cancelled.map((r: { checker: string }) => r.checker)).toEqual([
			REAPER,
		]);
	});
});

describe("--json", () => {
	it("prints one parseable document and no report text", () => {
		report("ghost-jobs", "WARN: 2 ghost job(s)\n");
		deadRun("ci-status");

		const { out } = read("--json");
		expect(out).not.toContain("WARN: 2 ghost job(s)");
		const doc = JSON.parse(out);
		expect(doc.checker).toBe("replay-notify-reports");
		expect(doc.injected.map((r: { checker: string }) => r.checker)).toEqual([
			"ghost-jobs",
		]);
		expect(doc.cancelled.map((r: { checker: string }) => r.checker)).toEqual([
			"ci-status",
		]);
	});

	/* --json prints no report, so nothing was delivered and nothing may be
	 * marked as having been. */
	it("consumes nothing", () => {
		report("ghost-jobs", "WARN: 2 ghost job(s)\n", { stamp: "a,b" });
		read("--json");
		expect(stamps.readStamp("ghost-jobs")).toBeNull();
		expect(read("--notify").out).toContain("WARN: 2 ghost job(s)");
	});
});

/* The reader must never become a producer: its own report file would be read
 * by the next start's reader, and the session that ran it would see nothing. */
describe("persist mode", () => {
	it("is refused, writing no report of its own, so an inherited variable cannot silence the reader", () => {
		report("ghost-jobs", "WARN: 2 ghost job(s)\n");

		const r = runInProcess(SCRIPT, ["--notify"], {
			env: { ...process.env, WFC_NOTIFY_PERSIST: "1" },
			cwd: path.resolve(__dirname, ".."),
		});
		expect(r.stdout).toContain("WARN: 2 ghost job(s)");
		expect(notify.readReport("replay-notify-reports")).toBeNull();
	});
});

/* No starting session acts on these, so a start holds their text back and
 * `npm run status` reads it through --status (#2038). */
describe("reports a session start holds back", () => {
	const held = () => {
		report(REAPER, "REAPED (1) — a finished session\n");
		report(
			"reconcile-plugin",
			"workflow-core: deferring the v1.2.3 materialise\n",
		);
		report("repo-checks.o.r", "REPO-CHECKS (1) — drift gained\n");
		report("ghost-jobs", "WARN: 2 ghost job(s)\n");
	};

	it("injects none of them at session start, and still injects the rest", () => {
		held();
		const { status, out } = read("--notify");
		expect(status).toBe(0);
		expect(out).not.toContain("REAPED (1)");
		expect(out).not.toContain("deferring the v1.2.3");
		expect(out).not.toContain("drift gained");
		expect(out).toContain("WARN: 2 ghost job(s)");
	});

	it("shows them alone under --status, as a warning", () => {
		held();
		read("--notify");
		const { status, out } = read("--status");
		expect(status).toBe(0);
		expect(out).toContain("REAPED (1)");
		expect(out).toContain("deferring the v1.2.3");
		expect(out).toContain("drift gained");
		expect(out).not.toContain("ghost job(s)");
		expect(out).toMatch(/^WARN: 3 held-back report\(s\)$/m);
	});

	it("never names a stale held report among the drops at session start", () => {
		wireRoster([REAPER]);
		report(REAPER, "REAPED (1) — a finished session\n", {
			agoMs: 5 * 3_600_000,
		});
		expect(read("--notify").out).not.toContain(REAPER);
	});

	it("ends --status on its OK line where none is on disk", () => {
		report("ghost-jobs", "WARN: 2 ghost job(s)\n");
		expect(read("--status").out).toMatch(
			/OK: no held-back report on disk\.\s*$/,
		);
	});

	/* Exit 0 despite the refusal: lib/check.js holds every --notify run at 0. */
	it("refuses --status beside --notify", () => {
		const { status, out } = read("--status", "--notify");
		expect(out).toContain("BROKEN: --status is a hand run; drop --notify.");
		expect(status).toBe(0);
	});
});
