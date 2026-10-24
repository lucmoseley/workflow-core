// @vitest-environment node
/*
 * Pins that check-history-trim.js warns when a seat root's history.jsonl has
 * had its oldest line move forward since the last recording, and never on an
 * absent, unreadable or new root.
 *
 * check-history-trim.js is a detector over an unrecoverable loss (mantahostels#2617): a
 * seat root's history.jsonl trimmed is retroactive burn-attribution corpus
 * gone for good. The tests that matter are the ones on when it must NOT fire
 * — a root that is absent, unreadable, or new (no baseline to compare
 * against) is never reported as trimming, matching mantahostels#1742's "absent means
 * unread, not zero" shape for the seat-utilisation sibling this mirrors.
 *
 * Seat roots are directories under a temp HOME, the clock and watch file are
 * pinned by env, and the end-to-end cases run the script in process, so no
 * case reads a real seat's history.
 *
 * It reports through `npm run status` only: loosen a case and either a trim
 * erodes the burn-attribution corpus (mantahostels#2607) unseen, or a missing root
 * raises a false alarm the founder learns to skip.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";
import { seatDirs, seatEnv } from "./lib/seat-testkit";

const SCRIPT = path.resolve(__dirname, "check-history-trim.js");

const {
	readBaseline,
	readRoots,
	recordReading,
	trimmedRoots,
	// eslint-disable-next-line @typescript-eslint/no-var-requires
} = require("./lib/history-trim.js");

/** One seat's reading, through the many-seat reader the checker calls. */
const readRoot = (seatDir: string) => readRoots([seatDir])[0];

let home: string;
const HOUR = 36e5;
const NOW = Date.parse("2026-09-02T12:00:00Z");

/** Write a root's history.jsonl from a list of epoch-ms timestamps. */
const history = (dir: string, timestampsMs: number[]) => {
	fs.mkdirSync(path.join(home, dir), { recursive: true });
	fs.writeFileSync(
		path.join(home, dir, "history.jsonl"),
		timestampsMs
			.map((t) =>
				JSON.stringify({ display: "x", timestamp: t, sessionId: "s" }),
			)
			.join("\n") + (timestampsMs.length > 0 ? "\n" : ""),
	);
};

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "history-trim-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("one seat's reading", () => {
	it("reads the oldest timestamp and the line count", () => {
		history(".claude", [NOW - 5 * HOUR, NOW - 20 * HOUR, NOW - HOUR]);
		const r = readRoot(path.join(home, ".claude"));
		expect(r).toEqual({
			dir: ".claude",
			state: "ok",
			oldestMs: NOW - 20 * HOUR,
			lineCount: 3,
		});
	});

	it("reads a missing file as absent, never as unreadable", () => {
		expect(readRoot(path.join(home, ".claude"))).toEqual({
			dir: ".claude",
			state: "absent",
			oldestMs: null,
			lineCount: null,
		});
	});

	it("reads an empty file as ok with zero lines, not as unreadable", () => {
		history(".claude", []);
		expect(readRoot(path.join(home, ".claude"))).toEqual({
			dir: ".claude",
			state: "ok",
			oldestMs: null,
			lineCount: 0,
		});
	});

	it("reads a file with lines but no parseable timestamp as unreadable", () => {
		fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(home, ".claude", "history.jsonl"),
			'not json at all\n{"display":"x"}\n',
		);
		const r = readRoot(path.join(home, ".claude"));
		expect(r.state).toBe("unreadable");
		expect(r.oldestMs).toBeNull();
	});

	it("reads a real read error as unreadable, distinct from the ENOENT absent case", () => {
		// A directory where history.jsonl should be: readFileSync throws EISDIR,
		// never ENOENT, so this pins the catch's non-ENOENT branch specifically.
		fs.mkdirSync(path.join(home, ".claude", "history.jsonl"), {
			recursive: true,
		});
		expect(readRoot(path.join(home, ".claude"))).toEqual({
			dir: ".claude",
			state: "unreadable",
			oldestMs: null,
			lineCount: null,
		});
	});

	it("skips an unparseable line but still finds the oldest good one", () => {
		fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(home, ".claude", "history.jsonl"),
			`garbage\n${JSON.stringify({ timestamp: NOW - 10 * HOUR })}\n`,
		);
		const r = readRoot(path.join(home, ".claude"));
		expect(r).toEqual({
			dir: ".claude",
			state: "ok",
			oldestMs: NOW - 10 * HOUR,
			lineCount: 2,
		});
	});
});

describe("readRoots", () => {
	it("reads every seat directory it is given", () => {
		history(".claude", [NOW]);
		history(".claude3", [NOW]);
		const roots: { dir: string; state: string }[] = readRoots(seatDirs(home));
		expect(roots.map((r) => r.dir)[0]).toBe(".claude");
		expect(roots.find((r) => r.dir === ".claude2")?.state).toBe("absent");
		expect(roots.find((r) => r.dir === ".claude3")?.state).toBe("ok");
	});
});

describe("trimmedRoots", () => {
	it("reports nothing with no baseline at all — the first-ever run", () => {
		history(".claude", [NOW - 5 * HOUR]);
		const roots = readRoots(seatDirs(home));
		expect(trimmedRoots(roots, null)).toEqual([]);
	});

	it("reports nothing where the baseline itself could not be read", () => {
		history(".claude", [NOW - 5 * HOUR]);
		const roots = readRoots(seatDirs(home));
		expect(trimmedRoots(roots, undefined)).toEqual([]);
	});

	it("reports nothing where the oldest timestamp held steady or moved back", () => {
		const baseline = {
			".claude": {
				dir: ".claude",
				state: "ok",
				oldestMs: NOW - 20 * HOUR,
				lineCount: 5,
			},
		};
		history(".claude", [NOW - 20 * HOUR]); // unchanged
		expect(trimmedRoots(readRoots(seatDirs(home)), baseline)).toEqual([]);
	});

	it("reports a root whose oldest timestamp moved forward — the trim signature", () => {
		const baseline = {
			".claude": {
				dir: ".claude",
				state: "ok",
				oldestMs: NOW - 20 * HOUR,
				lineCount: 5,
			},
		};
		history(".claude", [NOW - 3 * HOUR]); // the old lines are gone
		const trimmed = trimmedRoots(readRoots(seatDirs(home)), baseline);
		expect(trimmed).toEqual([
			{
				dir: ".claude",
				priorOldestMs: NOW - 20 * HOUR,
				newOldestMs: NOW - 3 * HOUR,
			},
		]);
	});

	it("never reports a root the baseline never read as ok — a prior unread carries no signal", () => {
		const baseline = {
			".claude": {
				dir: ".claude",
				state: "unreadable",
				oldestMs: null,
				lineCount: null,
			},
		};
		history(".claude", [NOW - HOUR]);
		expect(trimmedRoots(readRoots(seatDirs(home)), baseline)).toEqual([]);
	});

	it("never reports a root currently absent or unreadable, whatever the baseline says", () => {
		const baseline = {
			".claude": {
				dir: ".claude",
				state: "ok",
				oldestMs: NOW - 20 * HOUR,
				lineCount: 5,
			},
		};
		// no history.jsonl written at all this time: absent
		expect(trimmedRoots(readRoots(seatDirs(home)), baseline)).toEqual([]);
	});
});

describe("the watch-file reading", () => {
	it("records once and then throttles inside the window", () => {
		const watch = path.join(home, "w.jsonl");
		history(".claude", [NOW - HOUR]);
		const roots = readRoots(seatDirs(home));
		expect(recordReading(roots, NOW, watch)).toBe("recorded");
		expect(recordReading(roots, NOW + 6 * HOUR, watch)).toBe("throttled");
		expect(recordReading(roots, NOW + 25 * HOUR, watch)).toBe("recorded");
		const lines = fs.readFileSync(watch, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
	});

	it("round-trips through readBaseline as the newest recorded line", () => {
		const watch = path.join(home, "w.jsonl");
		history(".claude", [NOW - 20 * HOUR]);
		recordReading(readRoots(seatDirs(home)), NOW, watch);
		history(".claude", [NOW - 3 * HOUR]);
		recordReading(readRoots(seatDirs(home)), NOW + 25 * HOUR, watch);
		const baseline = readBaseline(watch);
		expect(baseline?.[".claude"].oldestMs).toBe(NOW - 3 * HOUR);
	});

	it("reads no baseline where the watch file does not exist", () => {
		expect(readBaseline(path.join(home, "nope.jsonl"))).toBeNull();
	});

	it("reads undefined, never null, where the watch file exists but its newest line will not parse", () => {
		const watch = path.join(home, "w.jsonl");
		fs.writeFileSync(watch, "not json at all\n");
		expect(readBaseline(watch)).toBeUndefined();
	});

	it("reads undefined where the watch file cannot be read at all", () => {
		const watch = path.join(home, "w.jsonl");
		fs.mkdirSync(watch); // a directory in its place: EISDIR, never ENOENT
		expect(readBaseline(watch)).toBeUndefined();
	});
});

describe("end to end", () => {
	const run = (env: Record<string, string>, args: string[] = []) =>
		runInProcess(SCRIPT, args, {
			env: {
				...process.env,
				HOME: home,
				...seatEnv(home),
				WFC_HISTORY_TRIM_WATCH: path.join(home, "w.jsonl"),
				WFC_NOW: new Date(NOW).toISOString(),
				...env,
			},
		});

	it("SKIPs where no seat root holds a history.jsonl at all", () => {
		const r = run({});
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(/SKIP/);
		expect(r.stderr).toMatch(/no Claude Code seat directory/);
	});

	it("is OK on a first-ever run — nothing to compare against yet", () => {
		history(".claude", [NOW - 5 * HOUR]);
		const r = run({});
		expect(r.status).toBe(0);
		expect(r.stderr).not.toMatch(/HISTORY TRIMMED/);
		expect(r.stderr).toMatch(/baseline/);
	});

	it("warns and names the root when the oldest line has moved forward", () => {
		const watch = path.join(home, "w.jsonl");
		history(".claude", [NOW - 40 * HOUR]);
		run({ WFC_HISTORY_TRIM_WATCH: watch });
		history(".claude", [NOW - 2 * HOUR]);
		const r = run({
			WFC_HISTORY_TRIM_WATCH: watch,
			WFC_NOW: new Date(NOW + 25 * HOUR).toISOString(),
		});
		expect(r.stderr).toMatch(/HISTORY TRIMMED \(1\)/);
		expect(r.stderr).toMatch(/\.claude/);
		expect(r.status).toBe(0); // WARN never gates
	});

	it("never fires where a root is unreadable rather than trimmed", () => {
		const watch = path.join(home, "w.jsonl");
		history(".claude", [NOW - 40 * HOUR]);
		run({ WFC_HISTORY_TRIM_WATCH: watch });
		fs.writeFileSync(path.join(home, ".claude", "history.jsonl"), "garbage\n");
		const r = run({
			WFC_HISTORY_TRIM_WATCH: watch,
			WFC_NOW: new Date(NOW + 25 * HOUR).toISOString(),
		});
		expect(r.stderr).not.toMatch(/HISTORY TRIMMED/);
		expect(r.stderr).toMatch(/unreadable/);
		expect(r.status).toBe(0);
	});

	it("names a root new — present now, absent from the baseline — never as trimmed", () => {
		const watch = path.join(home, "w.jsonl");
		history(".claude", [NOW - 40 * HOUR]);
		run({ WFC_HISTORY_TRIM_WATCH: watch }); // baseline knows only .claude
		history(".claude", [NOW - 40 * HOUR]); // unchanged
		history(".claude2", [NOW - 3 * HOUR]); // a seat provisioned since
		const r = run({
			WFC_HISTORY_TRIM_WATCH: watch,
			WFC_NOW: new Date(NOW + 25 * HOUR).toISOString(),
		});
		expect(r.stderr).toMatch(/NEW ROOT\(S\) \(1\)/);
		expect(r.stderr).toMatch(/\.claude2/);
		expect(r.stderr).not.toMatch(/HISTORY TRIMMED/);
	});

	it("BROKENs, never silently re-baselining, where the watch file exists but its newest line will not parse", () => {
		const watch = path.join(home, "w.jsonl");
		fs.writeFileSync(watch, "not json\n");
		history(".claude", [NOW - HOUR]);
		const r = run({ WFC_HISTORY_TRIM_WATCH: watch });
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/could not read the prior recording/);
	});

	describe("the dirtied() notice (mantahostels#2665)", () => {
		/*
		 * mantahostels#2665: status-report.js's verdict() drops a clean checker's body when
		 * its LAST line is its own OK:. Both a landed append and a failed one
		 * leave a reader something to act on, so both must survive that — see
		 * lib/check.js's dirtied().
		 */
		it("names the watch file and says it needs committing where the reading landed", () => {
			const watch = path.join(home, "w.jsonl");
			history(".claude", [NOW - 5 * HOUR]);
			const r = run({ WFC_HISTORY_TRIM_WATCH: watch });
			expect(r.status).toBe(0);
			const lines = r.stderr.trim().split("\n");
			expect(lines.at(-1)).toBe(
				`${watch} gained a new reading — needs committing.`,
			);
		});

		it("stays silent on a throttled run — nothing was attempted", () => {
			const watch = path.join(home, "w.jsonl");
			history(".claude", [NOW - 5 * HOUR]);
			run({ WFC_HISTORY_TRIM_WATCH: watch }); // first run: recorded
			const r = run({
				WFC_HISTORY_TRIM_WATCH: watch,
				WFC_NOW: new Date(NOW + 6 * HOUR).toISOString(), // inside the throttle window
			});
			expect(r.status).toBe(0);
			expect(r.stderr.trim().split("\n").at(-1)).toMatch(/^OK:/);
			expect(r.stderr).not.toMatch(/needs committing|reading is lost/);
		});

		it("says the reading is lost where the append failed — the watch file's directory does not exist", () => {
			const watch = path.join(home, "no-such-dir", "w.jsonl");
			history(".claude", [NOW - 5 * HOUR]);
			const r = run({ WFC_HISTORY_TRIM_WATCH: watch });
			expect(r.status).toBe(0);
			const lines = r.stderr.trim().split("\n");
			expect(lines.at(-1)).toBe(
				`${watch} could not be appended to just now — today's reading is lost.`,
			);
		});
	});

	describe("--notify, held ready for a hook nothing wires yet", () => {
		it("says nothing while nothing has trimmed", () => {
			history(".claude", [NOW - 5 * HOUR]);
			const r = run({}, ["--notify"]);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("");
			expect(r.stderr).toBe("");
		});

		it("puts the trimming notice on stdout under --notify, not stderr", () => {
			const watch = path.join(home, "w.jsonl");
			history(".claude", [NOW - 40 * HOUR]);
			run({ WFC_HISTORY_TRIM_WATCH: watch });
			history(".claude", [NOW - 2 * HOUR]);
			const r = run(
				{
					WFC_HISTORY_TRIM_WATCH: watch,
					WFC_NOW: new Date(NOW + 25 * HOUR).toISOString(),
				},
				["--notify"],
			);
			expect(r.stdout).toMatch(/HISTORY TRIMMED/);
			expect(r.status).toBe(0);
		});
	});
});
