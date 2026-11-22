// @vitest-environment node

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildStartEnv, writeJobRecord } from "./lib/background-start-testkit";
import { runRecordFile } from "./lib/notify-report-testkit";
import { runInProcess } from "./lib/run-in-process";
import { useScratchCore } from "./lib/scratch-core-testkit";

const require_ = createRequire(__filename);
const notify = require_("./lib/notify-report.js");
const proc = require_("./lib/arbiter-proc.js");
const stamps = require_("./lib/delivery-stamp.js");
const REAPER = "reap-finished-sessions";

const SCRIPT = path.resolve(__dirname, "replay-notify-reports.js");

let dir = "";

const read = (...args: string[]) => readIn("", ...args);

const readIn = (jobDir: string, ...args: string[]) => {
	const r = runInProcess(SCRIPT, args, {
		env: { ...process.env, ...buildStartEnv(jobDir) },
		cwd: path.resolve(__dirname, ".."),
	});
	expect(r.status).toBe(0);
	return { out: `${r.stdout}${r.stderr}` };
};

const readAtCompaction = () =>
	runInProcess(SCRIPT, ["--notify"], {
		env: { ...process.env, ...buildStartEnv() },
		cwd: path.resolve(__dirname, ".."),
		stdin: JSON.stringify({ source: "compact" }),
	});

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

const SILENT_AGE_FLOOR_MS = 2 * 65_300;

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
const DEFAULT_ROSTER = [
	"ci-status",
	"check-ghost-jobs",
	"check-hook-liveness",
	"check-issue-labels",
	"check-guard-errors",
	"check-cleared-trackers",
	"reap-finished-sessions",
];

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

const shownFile = (checker: string) =>
	path.join(
		notify.base(),
		`${checker.replace(/[^A-Za-z0-9_-]/g, "-")}.shown.json`,
	);

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
	vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(dir, "claude"));
	const repo = path.join(dir, "repo");
	vi.stubEnv("CLAUDE_PROJECT_DIR", repo);
	vi.stubEnv("WFC_CLAUDE_CONFIG_A", undefined);
	vi.stubEnv("WFC_CLAUDE_CONFIG_B", undefined);
	vi.stubEnv("WFC_CLAUDE_CONFIG_C", undefined);
	vi.stubEnv("WFC_NOTIFY_PERSIST", undefined);
	fs.mkdirSync(repo, { recursive: true });
	fs.mkdirSync(notify.base(), { recursive: true });
	useScratchCore(dir);
	wireRoster(DEFAULT_ROSTER);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("injecting what the producers persisted", () => {
	it("prints each report with its age, and exits 0", () => {
		report("ghost-jobs", "WARN: 2 ghost job(s)\nrun A\n");
		report("hook-liveness", "FAIL: a wired hook is dead\n", {
			agoMs: 4 * 60 * 1000,
		});

		const { out } = read("--notify");
		expect(out).toContain("WARN: 2 ghost job(s)");
		expect(out).toContain("run A");
		expect(out).toContain("FAIL: a wired hook is dead");
		expect(out).toMatch(/ghost-jobs — \d+s ago/);
		expect(out).toMatch(/hook-liveness — 4 min ago/);
	});

	it("says nothing at all when no producer has written", () => {
		const { out } = read("--notify");
		expect(out).toBe("");
	});

	it("injects nothing for a report whose text is empty", () => {
		report("ci-status", "", { outcome: "OK" });
		const { out } = read("--notify");
		expect(out).toBe("");
	});

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

		const { out } = read("--notify");
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

	it("a hand run shows everything and consumes nothing", () => {
		report("ghost-jobs", "WARN: 2 ghost job(s)\n", { stamp: "a,b" });

		expect(read().out).toContain("WARN: 2 ghost job(s)");
		expect(stamps.readStamp("ghost-jobs")).toBeNull();
		expect(read().out).toContain("WARN: 2 ghost job(s)");
		expect(read("--notify").out).toContain("WARN: 2 ghost job(s)");
	});

	describe("a report carrying several stamps", () => {
		it("suppresses a report only once EVERY one of its stamps is recorded", () => {
			report("hook-liveness", "FAIL: 2 hook(s) failing\n", {
				stamps: {
					"hook-liveness-census": "s1",
					"hook-liveness-manifest": "s2",
				},
			});
			stamps.recordDelivery("hook-liveness-census", "s1");
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

		it("merges the single `stamp` field with the `stamps` map into one gate", () => {
			report("guard-errors", "FAIL: 1 guard fail-open(s)\nINERT: platform\n", {
				stamp: "log-sig",
				stamps: { "guard-errors-inert": "inert-sig" },
			});
			stamps.recordDelivery("guard-errors", "log-sig");
			expect(read("--notify").out).toContain("FAIL: 1 guard fail-open(s)");

			report(
				"guard-errors",
				"FAIL: 1 guard fail-open(s)\nINERT: platform, renarrated\n",
				{
					stamp: "log-sig",
					stamps: { "guard-errors-inert": "inert-sig" },
				},
			);
			expect(read("--notify").out).toBe("");
			expect(stamps.readStamp("guard-errors")).toBe("log-sig");
			expect(stamps.readStamp("guard-errors-inert")).toBe("inert-sig");
		});

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

		const { out } = read("--notify");
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

	describe("a report carrying its own maximum age", () => {
		const hourMs = 3_600_000;
		const weekMs = 7 * 24 * hourMs;

		it("is shown at 5 hours old", () => {
			report("weekly-reading", "WEEKLY (1) — drift gained\n", {
				agoMs: 5 * hourMs,
				maxAgeMs: weekMs,
			});
			const { out } = read("--notify");
			expect(out).toContain("drift gained");
		});

		it("is dropped as stale at 8 days old", () => {
			report("weekly-reading", "WEEKLY (1) — drift gained\n", {
				agoMs: 8 * 24 * hourMs,
				maxAgeMs: weekMs,
			});
			const { out } = read("--notify");
			expect(out).not.toContain("drift gained");
		});

		it("leaves a neighbour without one stale at 4 hours", () => {
			report("weekly-reading", "WEEKLY (1) — drift gained\n", {
				agoMs: 5 * hourMs,
				maxAgeMs: weekMs,
			});
			report("ci-status", "FAIL: the suite is red\n", { agoMs: 5 * hourMs });
			const { out } = read("--notify");
			expect(out).toContain("drift gained");
			expect(out).not.toContain("the suite is red");
		});
	});

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

	describe("the age floor (mantahostels#2327)", () => {
		it("does not name a producer wedged from start count alone, while its report is still inside a normal run", () => {
			report("check-cleared-trackers", "WARN: stuck\n", { agoMs: 72_000 });
			for (let i = 0; i < 6; i += 1)
				expect(read("--notify").out).not.toContain("has not finished a run");
		});

		it("still names one once its own measured run time has passed, even at a fraction of the fallback floor", () => {
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

	it("is not named UNREADABLE for a report file that will not parse", () => {
		unwire();
		fs.writeFileSync(notify.reportFile("ghost-jobs"), "{ half-writ");
		expect(read("--notify").out).not.toContain("will not parse");
	});

	it("is named on a hand run, and carried in the --json envelope", () => {
		unwire();
		report("ghost-jobs", "WARN: 2 ghost job(s)\n");

		expect(read().out).toContain(
			"do not wire as a persisting SessionStart producer: ghost-jobs",
		);

		const doc = JSON.parse(read("--json").out);
		expect(doc.unwired).toEqual(["ghost-jobs"]);
	});

	it("never names a repo-checks report", () => {
		unwire();
		report("repo-checks.o.r", "REPO-CHECKS (1) — drift gained\n");
		const { out } = read("--json");
		expect(JSON.parse(out).unwired).toEqual([]);
	});

	it("is counted from a leftover run record alone, with no report at all", () => {
		unwire();
		deadRun("ghost-jobs", "2026-08-31T09:00:00.000Z");
		expect(JSON.parse(read("--json").out).unwired).toEqual(["ghost-jobs"]);
	});
});

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

		const { out } = read("--notify");
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
		expect(out).not.toMatch(
			/time[d\s-]?out|time limit|ceiling|settings\.json|raise/i,
		);
	});

	it("says nothing about a producer still running", () => {
		liveRun("ghost-jobs");
		expect(read("--notify").out).toBe("");
	});

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

	it("consumes nothing", () => {
		report("ghost-jobs", "WARN: 2 ghost job(s)\n", { stamp: "a,b" });
		read("--json");
		expect(stamps.readStamp("ghost-jobs")).toBeNull();
		expect(read("--notify").out).toContain("WARN: 2 ghost job(s)");
	});
});

describe("a notice for the founder alone (#3707)", () => {
	const idle = () =>
		report("idle-efforts", "IDLE-EFFORTS (1) — o/r: 1 idle\n", {
			stamp: "o/r@2026-10-30",
		});

	it("is shown again the next day with the same text, past an empty report between (#3892)", () => {
		const standing = (stamp: string) =>
			report("idle-efforts", "IDLE-EFFORTS (1) — standing\n", { stamp });
		standing("day-1");
		expect(read("--notify").out).toContain("IDLE-EFFORTS (1)");
		report("idle-efforts", "");
		read("--notify");
		standing("day-1");
		expect(read("--notify").out).not.toContain("IDLE-EFFORTS (1)");
		standing("day-2");
		expect(read("--notify").out).toContain("IDLE-EFFORTS (1)");
		expect(stamps.readStamp("idle-efforts")).toBe("day-2");
	});

	it("is neither shown nor stamped at a background job's start", () => {
		idle();
		const { out } = readIn(path.join(dir, "job"), "--notify");
		expect(out).not.toContain("IDLE-EFFORTS (1)");
		expect(stamps.readStamp("idle-efforts")).toBeNull();
	});

	it("goes on his screen and in context, another report in context alone (#3776)", () => {
		idle();
		report("ci-status", "CI-STATUS (1) — red\n");
		const r = read("--notify");
		const { systemMessage, hookSpecificOutput } = JSON.parse(r.out);
		expect(systemMessage).toContain("IDLE-EFFORTS (1) — o/r: 1 idle");
		expect(systemMessage).not.toContain("CI-STATUS (1)");
		expect(hookSpecificOutput.hookEventName).toBe("SessionStart");
		expect(hookSpecificOutput.additionalContext).toContain("IDLE-EFFORTS (1)");
		expect(hookSpecificOutput.additionalContext).toContain("CI-STATUS (1)");
	});

	it("is shown and stamped at the next interactive start the same day", () => {
		idle();
		readIn(path.join(dir, "job"), "--notify");
		expect(read("--notify").out).toContain("IDLE-EFFORTS (1)");
		expect(stamps.readStamp("idle-efforts")).not.toBeNull();
		expect(read("--notify").out).not.toContain("IDLE-EFFORTS (1)");
	});

	it("is shown and stamped at a job he launched from the agents view (#3772)", () => {
		idle();
		const job = writeJobRecord(path.join(dir, "his"), "claude");
		expect(readIn(job, "--notify").out).toContain("IDLE-EFFORTS (1)");
		expect(stamps.readStamp("idle-efforts")).not.toBeNull();
	});

	it("is neither shown nor stamped at a plain `claude --bg` job (#3772)", () => {
		idle();
		const job = writeJobRecord(path.join(dir, "loops"), "bg");
		expect(readIn(job, "--notify").out).not.toContain("IDLE-EFFORTS (1)");
		expect(stamps.readStamp("idle-efforts")).toBeNull();
	});

	it("is neither shown nor stamped at a compaction, and waits for the next start (#3772)", () => {
		idle();
		const compaction = readAtCompaction();
		expect(`${compaction.stdout}${compaction.stderr}`).not.toContain(
			"IDLE-EFFORTS (1)",
		);
		expect(stamps.readStamp("idle-efforts")).toBeNull();
		expect(read("--notify").out).toContain("IDLE-EFFORTS (1)");
	});

	it("still reaches a compaction where it is no founder notice", () => {
		report("ghost-jobs", "WARN: 2 ghost job(s)\n");
		const compaction = readAtCompaction();
		expect(compaction.stdout).toContain("WARN: 2 ghost job(s)");
	});

	it("still reaches a background job's start where it is no founder notice", () => {
		report("ghost-jobs", "WARN: 2 ghost job(s)\n");
		expect(readIn(path.join(dir, "job"), "--notify").out).toContain(
			"WARN: 2 ghost job(s)",
		);
	});
});

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
		const { out } = read("--notify");
		expect(out).not.toContain("REAPED (1)");
		expect(out).not.toContain("deferring the v1.2.3");
		expect(out).not.toContain("drift gained");
		expect(out).toContain("WARN: 2 ghost job(s)");
	});

	it("shows them alone under --status, as a warning", () => {
		held();
		read("--notify");
		const { out } = read("--status");
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

	it("refuses --status beside --notify", () => {
		const { out } = read("--status", "--notify");
		expect(out).toContain("BROKEN: --status is a hand run; drop --notify.");
	});
});
