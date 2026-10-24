// @vitest-environment node
/*
 * Pins the persist-and-replay store a slow SessionStart checker writes to:
 * the report round-trip, the atomic write, and when an open run reads as
 * cancelled (mantahostels#1973, specified at mantahostels#1949).
 *
 * Every test points CLAUDE_CONFIG_DIR and CLAUDE_PROJECT_DIR at throwaway
 * temp directories — the real config dir otherwise gets a stray
 * notify-reports/ tree, and a fixed CLAUDE_PROJECT_DIR from a prior run in
 * this shell would make every run share one slug.
 *
 * replay-notify-reports.js, a `SessionStart` hook, replays these reports, so a
 * loosened case lets a checker's finding be lost when the harness cancels it,
 * or a truncated report be replayed as a whole one.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRecordFile } from "./notify-report-testkit";

// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const notify: any = createRequire(__filename)("./notify-report.js");
// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const arbiterStore: any = createRequire(__filename)("./arbiter-store.js");

let dir = "";
const savedEnv = { ...process.env };

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-report-"));
	process.env.CLAUDE_CONFIG_DIR = path.join(dir, "claude");
	process.env.CLAUDE_PROJECT_DIR = path.join(dir, "repo");
	delete process.env.WFC_CLAUDE_CONFIG_A;
	delete process.env.WFC_CLAUDE_CONFIG_B;
	delete process.env.WFC_CLAUDE_CONFIG_C;
	fs.mkdirSync(process.env.CLAUDE_PROJECT_DIR, { recursive: true });
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	process.env = { ...savedEnv };
});

describe("write / read round-trip", () => {
	it("carries all nine fields intact", () => {
		const finishedAt = new Date("2026-08-30T01:00:00.000Z");
		expect(
			notify.writeReport("check-example", {
				outcome: "WARN",
				text: "two findings",
				finishedAt,
				durationMs: 1234,
				stamp: "sig-abc",
				stamps: { "check-example-sub": "sig-def" },
				owner: "session-a",
				maxAgeMs: 60_000,
			}),
		).toBe(true);

		const report = notify.readReport("check-example");
		expect(report).toEqual({
			checker: "check-example",
			outcome: "WARN",
			text: "two findings",
			at: finishedAt.toISOString(),
			durationMs: 1234,
			stamp: "sig-abc",
			stamps: { "check-example-sub": "sig-def" },
			owner: "session-a",
			maxAgeMs: 60_000,
		});
	});

	/* A report written before #1553 carries none, and a mangled one is no
	 * bound at all: both read as the default. */
	it("reads an absent or non-positive maxAgeMs as none", () => {
		for (const bad of [undefined, 0, -5, "7d", null]) {
			notify.writeReport("check-example", { outcome: "WARN", text: "x" });
			const file = notify.reportFile("check-example");
			const raw = JSON.parse(fs.readFileSync(file, "utf8"));
			raw.maxAgeMs = bad;
			fs.writeFileSync(file, JSON.stringify(raw));
			expect(notify.readReport("check-example").maxAgeMs).toBeNull();
		}
	});

	it("reads a missing, empty or non-string owner as unowned", () => {
		for (const bad of [undefined, "", 5, null]) {
			notify.writeReport("check-example", { outcome: "WARN", text: "x" });
			const file = notify.reportFile("check-example");
			const raw = JSON.parse(fs.readFileSync(file, "utf8"));
			raw.owner = bad;
			fs.writeFileSync(file, JSON.stringify(raw));
			expect(notify.readReport("check-example").owner).toBeNull();
		}
	});

	it("reads a report whose producer had nothing to stamp as an unstampable one", () => {
		notify.writeReport("check-example", { outcome: "WARN", text: "x" });
		expect(notify.readReport("check-example").stamp).toBeNull();
		expect(notify.readReport("check-example").stamps).toEqual({});
	});

	/* mantahostels#2277: a mangled `stamps` must read as empty rather than throw — a crash
	 * here takes down the whole session-start replay, every producer's report
	 * included, not just this one's. */
	it("drops a stamps value that is not a non-empty string, and a stamps that is not an object", () => {
		notify.writeReport("check-example", { outcome: "WARN", text: "x" });
		const file = notify.reportFile("check-example");

		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		raw.stamps = { good: "sig", bad: 5, empty: "", nully: null };
		fs.writeFileSync(file, JSON.stringify(raw));
		expect(notify.readReport("check-example").stamps).toEqual({ good: "sig" });

		raw.stamps = ["not", "an", "object"];
		fs.writeFileSync(file, JSON.stringify(raw));
		expect(notify.readReport("check-example").stamps).toEqual({});

		raw.stamps = null;
		fs.writeFileSync(file, JSON.stringify(raw));
		expect(notify.readReport("check-example").stamps).toEqual({});
	});

	it("writes a file for an OK outcome with empty text, told apart from never-run", () => {
		expect(notify.readReport("never-run")).toBeNull();
		notify.writeReport("check-example", { outcome: "OK" });
		const report = notify.readReport("check-example");
		expect(report.outcome).toBe("OK");
		expect(report.text).toBe("");
	});
});

describe("atomic write", () => {
	it("a file broken by a non-atomic direct write is read as corrupt, not as a bad document", () => {
		const file = notify.reportFile("check-example");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const whole = `${JSON.stringify({ checker: "check-example", outcome: "OK", text: "x", at: "2026-01-01T00:00:00.000Z", durationMs: null })}\n`;
		fs.writeFileSync(file, whole.slice(0, Math.floor(whole.length / 2)));
		expect(notify.readReport("check-example")).toBeNull();
	});

	/*
	 * MUTATION (mantahostels#1973, run and reversed): replace atomicWriteJSON's
	 * lib/atomic-write.js call with a direct fs.writeFileSync(file, ...) — the change a
	 * reviewer might propose as "simpler". Every test above still passed: none
	 * of them drives the write path itself under a simulated slow write, so
	 * none can tell a direct write from a temp-then-rename one. This is the
	 * test that catches it: it asserts the MECHANISM — a temp path distinct
	 * from the target is written first, and only a rename onto the target
	 * follows — rather than an outcome a non-atomic write happens to share.
	 * Counting those internal calls is the breach base §X6 allows with a reason.
	 */
	it("writes a temp file distinct from the target and renames it into place", () => {
		const target = notify.reportFile("check-example");
		const writeSpy = vi.spyOn(fs, "writeFileSync");
		const renameSpy = vi.spyOn(fs, "renameSync");
		try {
			expect(notify.writeReport("check-example", { outcome: "OK" })).toBe(true);
			expect(writeSpy).toHaveBeenCalledTimes(1);
			const tmpPath = writeSpy.mock.calls[0][0] as string;
			expect(tmpPath).not.toBe(target);
			expect(renameSpy).toHaveBeenCalledWith(tmpPath, target);
		} finally {
			writeSpy.mockRestore();
			renameSpy.mockRestore();
		}
	});
});

describe("open-run records and cancellation", () => {
	it("a record naming a pid with no /proc entry at all reads as cancelled", () => {
		notify.openRun("check-example");
		const run = notify.readRun("check-example");
		expect(run).not.toBeNull();

		// The same "certainly no process" pid arbiter-proc.test.ts pins for the
		// identical reason: the highest pid Linux's default pid_max allows,
		// vanishingly unlikely to be occupied.
		fs.writeFileSync(
			runRecordFile("check-example"),
			`${JSON.stringify({ ...run, pid: 4_194_303, procStart: "12345" })}\n`,
		);
		expect(notify.isCancelled(notify.readRun("check-example"))).toBe(true);
	});

	it("a record naming this LIVE pid but the WRONG start token reads as cancelled — the recycled-pid case", () => {
		// The pid is real and running (it's this test process), so an
		// existence-only liveness check would wrongly call this "still running".
		// A recycled pid looks exactly like this: the same number, a process
		// that really is alive, and a start-time token that does not match the
		// one recorded when the record was opened.
		notify.openRun("check-example");
		const run = notify.readRun("check-example");
		fs.writeFileSync(
			runRecordFile("check-example"),
			`${JSON.stringify({ ...run, procStart: "999999999" })}\n`,
		);
		expect(notify.isCancelled(notify.readRun("check-example"))).toBe(true);
	});

	it("a record from this live process, with its own real token, is not cancelled", () => {
		notify.openRun("check-example");
		const run = notify.readRun("check-example");
		expect(notify.isCancelled(run)).toBe(false);
	});

	it("a record naming this live pid and its real token, but a DIFFERENT boot, reads as cancelled", () => {
		// A run file lives under `~/.claude*` and survives a reboot, unlike a
		// lock (arbiter-proc.js's holderAlive header). Without the boot check a
		// coincident pid+procStart pair recorded before a reboot would read a
		// producer that never finished as still running, forever.
		notify.openRun("check-example");
		const run = notify.readRun("check-example");
		fs.writeFileSync(
			runRecordFile("check-example"),
			`${JSON.stringify({ ...run, bootId: "a-boot-that-is-not-this-one" })}\n`,
		);
		expect(notify.isCancelled(notify.readRun("check-example"))).toBe(true);
	});

	it("no open record at all is not a cancellation", () => {
		expect(notify.readRun("check-example")).toBeNull();
		expect(notify.isCancelled(null)).toBe(false);
	});

	it("closeRun removes the record; closing twice is not an error", () => {
		notify.openRun("check-example");
		expect(notify.readRun("check-example")).not.toBeNull();
		notify.closeRun("check-example");
		expect(notify.readRun("check-example")).toBeNull();
		expect(() => notify.closeRun("check-example")).not.toThrow();
	});

	/*
	 * MUTATION (mantahostels#1973, run and reversed): change isCancelled's
	 * `!holderAlive(...)` to `return false` unconditionally. The two positive
	 * ("not cancelled") tests still pass — `false` is correct there — but both
	 * negative tests above fail: the no-/proc-entry case and, separately, the
	 * live-pid-wrong-token case, which a weaker mutant (existence-only, no
	 * token comparison) would still pass.
	 */
});

describe("age arithmetic and staleness", () => {
	it("ageMs measures against `now`, and staleness is exposed and configurable", () => {
		const report = {
			checker: "c",
			outcome: "OK",
			text: "",
			at: new Date(0).toISOString(),
			durationMs: null,
		};
		expect(notify.ageMs(report, 10_000)).toBe(10_000);
		expect(notify.isStale(report, 5000, 10_000)).toBe(true);
		expect(notify.isStale(report, 20_000, 10_000)).toBe(false);
	});

	it("an unparseable timestamp reads as unknown age and as stale, never as fresh", () => {
		const report = {
			checker: "c",
			outcome: "OK",
			text: "",
			at: "not a date",
			durationMs: null,
		};
		expect(notify.ageMs(report)).toBeNull();
		expect(notify.isStale(report)).toBe(true);
	});

	it("a null report has no age and is stale", () => {
		expect(notify.ageMs(null)).toBeNull();
		expect(notify.isStale(null)).toBe(true);
	});

	/*
	 * MUTATION (mantahostels#1973, run and reversed): flip isStale's `age > maxAgeMs` to
	 * `age >= maxAgeMs`. Neither the "5 000 / 20 000 against age 10 000" pair
	 * above sits on the boundary, so neither catches it — only the exact-equal
	 * case below does.
	 */
	it("the bound is exact: equal to the limit is not yet stale", () => {
		const report = {
			checker: "c",
			outcome: "OK",
			text: "",
			at: new Date(0).toISOString(),
			durationMs: null,
		};
		expect(notify.isStale(report, 10_000, 10_000)).toBe(false);
		expect(notify.isStale(report, 9999, 10_000)).toBe(true);
	});

	it("the exported default bound is what isStale actually uses when none is given", () => {
		const now = 10_000_000;
		const justInside = {
			checker: "c",
			outcome: "OK",
			text: "",
			at: new Date(now - notify.DEFAULT_STALE_MS + 1).toISOString(),
			durationMs: null,
		};
		const justOutside = {
			checker: "c",
			outcome: "OK",
			text: "",
			at: new Date(now - notify.DEFAULT_STALE_MS - 1).toISOString(),
			durationMs: null,
		};
		expect(notify.isStale(justInside, undefined, now)).toBe(false);
		expect(notify.isStale(justOutside, undefined, now)).toBe(true);
	});
});

describe("cross-config-dir resolution", () => {
	it("resolves to the pinned arbiter store from a non-first seat, with _A named off the sorted-first position (#385)", () => {
		// `seat-z` sorts last of the three, so the rule this replaced — the
		// sorted-first usable config dir — would have picked `claude2`.
		const first = path.join(dir, "seat-z");
		const claudeB = path.join(dir, "claude2");
		const claudeC = path.join(dir, "claude3");
		process.env.WFC_CLAUDE_CONFIG_A = first;
		process.env.WFC_CLAUDE_CONFIG_B = claudeB;
		process.env.WFC_CLAUDE_CONFIG_C = claudeC;

		process.env.CLAUDE_CONFIG_DIR = claudeC;
		const writtenAt = notify.base();
		expect(writtenAt).toBe(
			path.join(arbiterStore.stateDir(), "notify-reports"),
		);
		expect(writtenAt.startsWith(`${first}${path.sep}`)).toBe(true);
		notify.writeReport("check-example", { outcome: "OK", text: "from C" });

		process.env.CLAUDE_CONFIG_DIR = claudeB;
		expect(notify.base()).toBe(writtenAt);
		expect(notify.readReport("check-example").text).toBe("from C");
	});
});

describe("an unwritable store", () => {
	it("falls to the sorted-first config dir that can hold state, which every seat agrees on", () => {
		if (process.getuid && process.getuid() === 0) return;
		const sealed = path.join(dir, "sealed");
		fs.mkdirSync(sealed, { recursive: true, mode: 0o555 });
		const claudeB = path.join(dir, "claude2");
		const claudeC = path.join(dir, "claude3");
		process.env.WFC_CLAUDE_CONFIG_A = path.join(sealed, "claude");
		process.env.WFC_CLAUDE_CONFIG_B = claudeB;
		process.env.WFC_CLAUDE_CONFIG_C = claudeC;

		process.env.CLAUDE_CONFIG_DIR = claudeC;
		const writtenAt = notify.base();
		expect(writtenAt.startsWith(`${claudeB}${path.sep}`)).toBe(true);
		expect(notify.writeReport("check-example", { outcome: "OK" })).toBe(true);

		process.env.CLAUDE_CONFIG_DIR = claudeB;
		expect(notify.base()).toBe(writtenAt);
		expect(notify.readReport("check-example")).not.toBeNull();
	});
});

describe("degradation on failure", () => {
	it("an unwritable state directory costs a report, never a throw", () => {
		const root = path.join(dir, "sealed");
		fs.mkdirSync(root, { recursive: true, mode: 0o555 });
		if (process.getuid && process.getuid() === 0) {
			// root ignores the permission bit; the guarantee is untestable here.
			return;
		}
		// Every candidate config dir nests under the same sealed ancestor, so
		// canHoldState's walk-up finds no writable one for ANY of them — the
		// single-plan fallback candidates (.claude2, .claude3) are otherwise
		// writable via their own creatable parent, which would silently pick
		// one of those instead of exercising the failure path this test wants.
		process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
		process.env.WFC_CLAUDE_CONFIG_A = path.join(root, "claude");
		process.env.WFC_CLAUDE_CONFIG_B = path.join(root, "claude2");
		process.env.WFC_CLAUDE_CONFIG_C = path.join(root, "claude3");
		expect(() =>
			notify.writeReport("check-example", { outcome: "OK" }),
		).not.toThrow();
		expect(notify.writeReport("check-example", { outcome: "OK" })).toBe(false);
		expect(() => notify.readReport("check-example")).not.toThrow();
		expect(notify.readReport("check-example")).toBeNull();
	});

	it("a corrupt report file reads as absent, not as a throw", () => {
		const file = notify.reportFile("check-example");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "{not json");
		expect(() => notify.readReport("check-example")).not.toThrow();
		expect(notify.readReport("check-example")).toBeNull();
	});

	it("a missing report file reads as absent, not as a throw", () => {
		expect(() => notify.readReport("nothing-here")).not.toThrow();
		expect(notify.readReport("nothing-here")).toBeNull();
	});

	it("a missing or corrupt run record both read as no run in progress", () => {
		expect(notify.readRun("nothing-here")).toBeNull();
		const file = runRecordFile("check-example");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "{not json");
		expect(notify.readRun("check-example")).toBeNull();
	});

	it("well-formed JSON of the wrong shape is rejected by both readers, not just torn JSON", () => {
		fs.mkdirSync(path.dirname(notify.reportFile("check-example")), {
			recursive: true,
		});
		fs.writeFileSync(
			notify.reportFile("check-example"),
			`${JSON.stringify({ checker: "check-example", outcome: "OK" })}\n`, // missing text/at
		);
		expect(notify.readReport("check-example")).toBeNull();

		fs.writeFileSync(
			runRecordFile("check-example"),
			`${JSON.stringify({ checker: "check-example", pid: 123 })}\n`, // missing startedAt
		);
		expect(notify.readRun("check-example")).toBeNull();
	});

	it("a store that cannot be resolved at all still yields a usable, in-sandbox base, never a throw", () => {
		// A spy, because no real seam reaches base()'s catch (#684): stateDir()'s
		// helpers catch and log their own errors and hostRoot() fails open to the
		// cwd, so no environment a test can build makes it throw.
		const spy = vi.spyOn(arbiterStore, "stateDir").mockImplementation(() => {
			throw new Error("registry unreadable");
		});
		try {
			expect(() =>
				notify.writeReport("check-example", { outcome: "OK" }),
			).not.toThrow();
			// The fallback must still respect CLAUDE_CONFIG_DIR — a sandboxed test
			// (or a sandboxed arbiter suite) must never fall through to the
			// founder's real ~/.claude.
			expect(notify.reportFile("check-example").startsWith(dir)).toBe(true);
			expect(notify.readReport("check-example")).not.toBeNull();
		} finally {
			spy.mockRestore();
		}
	});
});

/* The listing the replay reader (mantahostels#1976) opens the directory with: it has to
 * know which checkers have written before it can read any of them. */
describe("list", () => {
	it("names every checker with a report or an open run record, once, sorted", () => {
		notify.writeReport("ghost-jobs", { outcome: "OK" });
		notify.writeReport("ci-status", { outcome: "WARN", text: "red" });
		notify.openRun("ci-status");
		notify.openRun("reap-finished-sessions");

		expect(notify.list()).toEqual([
			"ci-status",
			"ghost-jobs",
			"reap-finished-sessions",
		]);
	});

	it("ignores anything that is not a record, and an absent directory", () => {
		fs.mkdirSync(notify.base(), { recursive: true });
		fs.writeFileSync(path.join(notify.base(), "replay-starts.json"), "{}");
		fs.writeFileSync(path.join(notify.base(), "ghost-jobs.shown.json"), "{}");
		fs.writeFileSync(path.join(notify.base(), "ci-status.notified"), "sig");
		expect(notify.list()).toEqual([]);

		fs.rmSync(notify.base(), { recursive: true, force: true });
		expect(notify.list()).toEqual([]);
	});
});
