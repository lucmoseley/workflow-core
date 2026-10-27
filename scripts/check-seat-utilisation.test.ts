// @vitest-environment node
/*
 * check-seat-utilisation.js fires the spend policy's only upward trigger, so
 * the tests that matter are the ones on when it must NOT fire: a seat that has
 * never run reads as unknown rather than as 0 (mantahostels#1742), a frozen reading past
 * its `resets_at` reads as 0 rather than as the stale number, and a reset less
 * than 24 h away is waited out rather than escalated (mantahostels#1740).
 *
 * The fixture is a fake home holding `.claudeN/.claude.json` files, which is
 * the whole of what the script reads.
 *
 * It is a SessionStart `--notify` hook in `self-plugin/hooks/hooks.json` and
 * the shipped plugin's `hooks/hooks.json`: loosen a case and the notice either
 * prompts a ceiling re-decision on a non-event, or stays silent while every
 * seat's allowance is spent and work has stopped.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";
import { seatDirs, seatEnv } from "./lib/seat-testkit";

const SCRIPT = path.resolve(__dirname, "check-seat-utilisation.js");

const {
	BLOCKED_UTILISATION,
	MIN_HOURS_TO_RESET,
	readSeats,
	recordReading,
	rungOneLogged,
	scopedVerdict,
	verdict,
	// eslint-disable-next-line @typescript-eslint/no-var-requires
} = require("./lib/seat-utilisation.js");

let home: string;

const HOUR = 36e5;
const NOW = Date.parse("2026-08-28T12:00:00Z");

/** One `kind: "weekly_scoped"` bar, as `seat()`'s `scoped` list takes it. */
interface ScopedBarFixture {
	model: string;
	percent: number;
	resetsAt: string;
	severity?: string;
}

/** The host config at the fixture's root, which a run with CLAUDE_PROJECT_DIR
 *  set to `home` reads. */
const hostConfig = (json: string) => {
	fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
	fs.writeFileSync(path.join(home, ".claude", "workflow-core.json"), json);
};

/** Write one seat's `.claude.json`. `cache: null` is a seat that never ran. */
const seat = (
	dir: string,
	cache: {
		sevenDay: number;
		resetsAt: string;
		uuid?: string;
		scoped?: ScopedBarFixture[];
	} | null,
) => {
	fs.mkdirSync(path.join(home, dir), { recursive: true });
	fs.writeFileSync(
		path.join(home, dir, ".claude.json"),
		JSON.stringify({
			cachedUsageUtilization: cache
				? {
						fetchedAtMs: NOW - HOUR,
						accountUuid: cache.uuid ?? `uuid-${dir}`,
						utilization: {
							five_hour: { utilization: 10, resets_at: cache.resetsAt },
							seven_day: {
								utilization: cache.sevenDay,
								resets_at: cache.resetsAt,
							},
							limits: [
								{ kind: "session", percent: 10, resets_at: cache.resetsAt },
								{
									kind: "weekly_all",
									percent: cache.sevenDay,
									severity: "x",
									resets_at: cache.resetsAt,
								},
								...(cache.scoped ?? []).map((b) => ({
									kind: "weekly_scoped",
									percent: b.percent,
									severity: b.severity ?? "x",
									resets_at: b.resetsAt,
									scope: { model: { display_name: b.model, id: null } },
								})),
							],
						},
					}
				: undefined,
		}),
	);
};

/** A reset comfortably outside the 24 h the policy waits out. */
const FAR = new Date(NOW + 72 * HOUR).toISOString();
/** …and one inside it. */
const NEAR = new Date(NOW + 6 * HOUR).toISOString();

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "seat-util-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("the seven-day figure a seat is judged on", () => {
	it("passes a live reading through as the lower bound it is", () => {
		seat(".claude", { sevenDay: 98, resetsAt: FAR });
		const [s] = readSeats(NOW, seatDirs(home));
		expect(s).toMatchObject({ sevenDay: 98, effective: 98, rolled: false });
	});

	it("reads a frozen 100% as 0 once its window has reset", () => {
		const past = new Date(NOW - HOUR).toISOString();
		seat(".claude", { sevenDay: 100, resetsAt: past });
		const [s] = readSeats(NOW, seatDirs(home));
		expect(s).toMatchObject({ sevenDay: 100, effective: 0, rolled: true });
	});

	it("keeps an unreadable figure null rather than inventing one", () => {
		fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(home, ".claude", ".claude.json"),
			JSON.stringify({ cachedUsageUtilization: { utilization: {} } }),
		);
		const [s] = readSeats(NOW, seatDirs(home));
		expect(s).toMatchObject({ sevenDay: null, effective: null, rolled: false });
	});
});

describe("the trigger", () => {
	it("fires when every seat is exhausted with more than 24h to the earliest reset", () => {
		seat(".claude", { sevenDay: 100, resetsAt: FAR });
		seat(".claude2", { sevenDay: 100, resetsAt: FAR });
		const v = verdict(readSeats(NOW, seatDirs(home)), NOW);
		expect(v.fired).toBe(true);
		expect(v.hoursToEarliestReset).toBeGreaterThan(MIN_HOURS_TO_RESET);
	});

	it("does not fire when one seat still has allowance", () => {
		seat(".claude", { sevenDay: 100, resetsAt: FAR });
		seat(".claude2", { sevenDay: 18, resetsAt: FAR });
		expect(verdict(readSeats(NOW, seatDirs(home)), NOW).fired).toBe(false);
	});

	it("does not fire at 99%, the level the seats sat at without work stopping", () => {
		seat(".claude", { sevenDay: 99, resetsAt: FAR });
		seat(".claude2", { sevenDay: 99, resetsAt: FAR });
		const v = verdict(readSeats(NOW, seatDirs(home)), NOW);
		expect(BLOCKED_UTILISATION).toBe(100);
		expect(v.fired).toBe(false);
	});

	it("waits out a reset less than 24h away rather than escalating", () => {
		seat(".claude", { sevenDay: 100, resetsAt: NEAR });
		seat(".claude2", { sevenDay: 100, resetsAt: FAR });
		const v = verdict(readSeats(NOW, seatDirs(home)), NOW);
		expect(v.allExhausted).toBe(true);
		expect(v.fired).toBe(false);
	});

	it("holds the fire on a seat that has never run, and says the panel is needed", () => {
		seat(".claude", { sevenDay: 100, resetsAt: FAR });
		seat(".claude2", { sevenDay: 100, resetsAt: FAR });
		seat(".claude3", null);
		const v = verdict(readSeats(NOW, seatDirs(home)), NOW);
		expect(v.fired).toBe(false);
		expect(v.panelNeeded).toBe(true);
		expect(v.unread.map((s: { dir: string }) => s.dir)).toEqual([".claude3"]);
	});

	it("does not fire on a stale 100% whose window has already reset", () => {
		seat(".claude", {
			sevenDay: 100,
			resetsAt: new Date(NOW - HOUR).toISOString(),
		});
		seat(".claude2", { sevenDay: 100, resetsAt: FAR });
		expect(verdict(readSeats(NOW, seatDirs(home)), NOW).fired).toBe(false);
	});
});

describe("reading the seats", () => {
	it("counts one subscription once however many directories point at it", () => {
		seat(".claude", { sevenDay: 50, resetsAt: FAR, uuid: "same" });
		seat(".claude2", { sevenDay: 50, resetsAt: FAR, uuid: "same" });
		expect(readSeats(NOW, seatDirs(home))).toHaveLength(1);
	});

	it("keeps a half-written .claude.json as an UNREAD seat, never as an absent one", () => {
		fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
		fs.writeFileSync(path.join(home, ".claude", ".claude.json"), '{"cach');
		seat(".claude2", { sevenDay: 50, resetsAt: FAR });
		const seats = readSeats(NOW, seatDirs(home));
		expect(seats.map((s: { dir: string }) => s.dir)).toEqual([
			".claude",
			".claude2",
		]);
		expect(seats[0].unread).toBe(true);
	});

	it("does not fire while a seat the harness is mid-rewrite of cannot be read", () => {
		fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
		fs.writeFileSync(path.join(home, ".claude", ".claude.json"), '{"cach');
		seat(".claude2", { sevenDay: 100, resetsAt: FAR });
		const v = verdict(readSeats(NOW, seatDirs(home)), NOW);
		expect(v.fired).toBe(false);
		expect(v.panelNeeded).toBe(true);
	});

	it("reads limits[], never the seven_day/five_hour keys, where the two disagree (#377)", () => {
		const past = new Date(NOW - HOUR).toISOString();
		fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(home, ".claude", ".claude.json"),
			JSON.stringify({
				cachedUsageUtilization: {
					fetchedAtMs: NOW - HOUR,
					utilization: {
						five_hour: { utilization: 99, resets_at: past },
						seven_day: { utilization: 99, resets_at: past },
						limits: [
							{ kind: "session", percent: 7, resets_at: FAR },
							{ kind: "weekly_all", percent: 41, resets_at: FAR },
						],
					},
				},
			}),
		);
		const [s] = readSeats(NOW, seatDirs(home));
		expect(s).toMatchObject({
			sevenDay: 41,
			fiveHour: 7,
			effective: 41,
			resetsAt: FAR,
			rolled: false,
		});
	});

	it("reads a seat whose seven_day key has no weekly_all bar behind it as unread (#377)", () => {
		fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(home, ".claude", ".claude.json"),
			JSON.stringify({
				cachedUsageUtilization: {
					fetchedAtMs: NOW - HOUR,
					utilization: { seven_day: { utilization: 100, resets_at: FAR } },
				},
			}),
		);
		seat(".claude2", { sevenDay: 100, resetsAt: FAR });
		const v = verdict(readSeats(NOW, seatDirs(home)), NOW);
		expect(v.fired).toBe(false);
		expect(v.unread.map((s: { dir: string }) => s.dir)).toEqual([".claude"]);
	});

	it("treats a cache carrying no seven-day figure as unread, not as zero", () => {
		fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(home, ".claude", ".claude.json"),
			JSON.stringify({ cachedUsageUtilization: { utilization: {} } }),
		);
		seat(".claude2", { sevenDay: 100, resetsAt: FAR });
		const v = verdict(readSeats(NOW, seatDirs(home)), NOW);
		expect(v.fired).toBe(false);
		expect(v.unread).toHaveLength(1);
	});
});

describe("the daily reading", () => {
	it("records once and then throttles inside 24h", () => {
		const history = path.join(home, "h.jsonl");
		process.env.WFC_SEAT_HISTORY = history;
		try {
			seat(".claude", { sevenDay: 50, resetsAt: FAR });
			const seats = readSeats(NOW, seatDirs(home));
			expect(recordReading(seats, NOW)).toBe("recorded");
			expect(recordReading(seats, NOW + 6 * HOUR)).toBe("throttled");
			expect(recordReading(seats, NOW + 25 * HOUR)).toBe("recorded");
			const lines = fs
				.readFileSync(history, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l));
			expect(lines).toHaveLength(2);
			// The co-indicator is recorded and nothing triggers on it (mantahostels#1737).
			expect(lines[0]).toHaveProperty("commits24h");
		} finally {
			delete process.env.WFC_SEAT_HISTORY;
		}
	});

	it("records a dormant seat's row with its own staleness (mantahostels#2697)", () => {
		const history = path.join(home, "h2.jsonl");
		process.env.WFC_SEAT_HISTORY = history;
		try {
			seat(".claude", { sevenDay: 50, resetsAt: FAR });
			// The seat has not run since NOW - HOUR (fixture default); a reading
			// taken a day later carries that same cache forward.
			const seats = readSeats(NOW + 25 * HOUR, seatDirs(home));
			recordReading(seats, NOW + 25 * HOUR);
			const [line] = fs
				.readFileSync(history, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l));
			expect(line.seats[0].staleHours).toBe(26);
		} finally {
			delete process.env.WFC_SEAT_HISTORY;
		}
	});

	it("records an unread seat's staleHours as null, never as 0 (mantahostels#2697)", () => {
		const history = path.join(home, "h3.jsonl");
		process.env.WFC_SEAT_HISTORY = history;
		try {
			seat(".claude", null);
			seat(".claude2", { sevenDay: 50, resetsAt: FAR });
			const seats = readSeats(NOW, seatDirs(home));
			recordReading(seats, NOW);
			const [line] = fs
				.readFileSync(history, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l));
			const [unread, live] = line.seats;
			expect(unread.staleHours).toBeNull();
			expect(live.staleHours).toBe(1);
		} finally {
			delete process.env.WFC_SEAT_HISTORY;
		}
	});
});

describe("the rung-1 limb", () => {
	const ladder = (log: string) => {
		const p = path.join(home, "ladder.md");
		fs.writeFileSync(
			p,
			`## Re-assessment\n\n### Re-assessment log\n\n${log}\n`,
		);
		process.env.WFC_LADDER = p;
		return p;
	};

	afterEach(() => {
		delete process.env.WFC_LADDER;
	});

	it("reads an empty log as rung 1 unapplied", () => {
		ladder("None yet.");
		expect(rungOneLogged()).toBe(false);
	});

	it("reads a dated line as a re-assessment having happened", () => {
		ladder("- 2026-09-14 · bill reached $600 · rung 1 cut 22% · verdict: hold");
		expect(rungOneLogged()).toBe(true);
	});

	it("is unaffected by a trial declaration correctly placed above the log (mantahostels#2847)", () => {
		/* None of the declaration's field lines is a dated bullet, so it cannot
		 * flip this limb wherever it sits. */
		const p = path.join(home, "ladder-trial.md");
		fs.writeFileSync(
			p,
			[
				"### Seat 3's probation",
				"",
				"#### Gate 2 trial declaration",
				"",
				"- **seat:** `.claude3`",
				"- **account:** `uuid-.claude3`",
				`- **start basis:** \`.claude\` resets \`${TRIAL_START}\` read 1.0h ago`,
				`- **measured window:** \`${TRIAL_START}\` → \`${TRIAL_END}\``,
				"- **seat 3 at declaration:** 7d 62% · resets `2026-09-20T21:00:00Z` · fetched `2026-08-27T00:00:00Z`",
				"",
				"## Re-assessment",
				"",
				"### Re-assessment log",
				"",
				"None yet.",
			].join("\n"),
		);
		process.env.WFC_LADDER = p;
		expect(rungOneLogged()).toBe(false);
	});

	it("stops at the next `## ` heading, so a dated line in a later section is not read as the log", () => {
		/* Guards the `line.startsWith("## ")` break: without it, the later
		 * section's dated bullet would read as rung 1 having happened. */
		ladder("None yet.");
		fs.appendFileSync(
			path.join(home, "ladder.md"),
			"\n## Founder override\n\n- 2026-08-28 something dated, unrelated to rung 1.\n",
		);
		expect(rungOneLogged()).toBe(false);
	});
});

/** A window open at the fixture's NOW, and the basis that justifies its start. */
const TRIAL_START = "2026-08-27T00:00:00Z";
const TRIAL_END = "2026-09-10T00:00:00Z";

describe("end to end", () => {
	const run = (env: Record<string, string>, args: string[] = []) =>
		spawnSync(process.execPath, [SCRIPT, ...args], {
			encoding: "utf8",
			env: {
				...process.env,
				HOME: home,
				...seatEnv(home),
				WFC_SEAT_HISTORY: path.join(home, "h.jsonl"),
				// Pins the subprocess's clock to the fixture's NOW: the script reads
				// the real wall clock otherwise, and FAR/NEAR are computed against
				// this anchor rather than the calendar date the suite runs on.
				WFC_NOW: new Date(NOW).toISOString(),
				...env,
			},
		});

	it("SKIPs where no seat directory exists at all, naming what it could not find", () => {
		const r = run({});
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(/SKIP/);
		// The way out: which directories it looked in, so the reader can check.
		expect(r.stderr).toMatch(/no Claude Code seat directory found/);
		expect(r.stderr).toMatch(/\.claude2/);
	});

	it("never reports 0% where every seat is present but unread", () => {
		fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
		fs.writeFileSync(path.join(home, ".claude", ".claude.json"), "{}");
		const r = run({});
		expect(r.stderr).not.toMatch(/utilisation 0%/);
		expect(r.stderr).toMatch(/read Settings -> Usage/);
	});

	it("prints the seat table and warns when every seat is exhausted", () => {
		seat(".claude", { sevenDay: 100, resetsAt: FAR });
		seat(".claude2", { sevenDay: 100, resetsAt: FAR });
		const r = run({});
		expect(r.stderr).toMatch(/SEATS \(2\)/);
		expect(r.stderr).toMatch(/ALL SEATS EXHAUSTED/);
		// The act is a re-decision, and the notice must never read as a purchase.
		expect(r.stderr).toMatch(/NOT A PURCHASE/);
		expect(r.status).toBe(0);
	});

	describe("--notify, the report route no hook now runs", () => {
		it("says nothing at all while no seat is exhausted", () => {
			seat(".claude", { sevenDay: 50, resetsAt: FAR });
			// A ladder that reads and declares nothing: a missing one is loud by
			// ruling (mantahostels#2871), so silence needs one on disk.
			const ladderFile = path.join(home, "empty-ladder.md");
			fs.writeFileSync(ladderFile, "# Capacity procurement ladder\n");
			const r = run({ WFC_LADDER: ladderFile }, ["--notify"]);
			expect(r.status).toBe(0);
			// Silence, both streams: a session start pays for every line printed.
			expect(r.stdout).toBe("");
			expect(r.stderr).toBe("");
		});

		it("puts the notice on stdout, where a SessionStart hook is read from", () => {
			seat(".claude", { sevenDay: 100, resetsAt: FAR });
			seat(".claude2", { sevenDay: 100, resetsAt: FAR });
			const r = run({}, ["--notify"]);
			expect(r.stdout).toMatch(/ALL SEATS EXHAUSTED/);
			expect(r.stdout).toMatch(/NOT A PURCHASE/);
			// --notify exits 0 whatever it found: a hook must not fail a session.
			expect(r.status).toBe(0);
		});

		it("puts the unread-seat needle on stdout too, and holds the notice", () => {
			seat(".claude", { sevenDay: 100, resetsAt: FAR });
			seat(".claude2", null);
			const r = run({}, ["--notify"]);
			expect(r.stdout).toMatch(/SEAT UNREAD/);
			expect(r.stdout).not.toMatch(/ALL SEATS EXHAUSTED/);
		});

		it("prints no seat table at session start", () => {
			seat(".claude", { sevenDay: 100, resetsAt: FAR });
			seat(".claude2", { sevenDay: 100, resetsAt: FAR });
			expect(run({}, ["--notify"]).stdout).not.toMatch(/SEATS \(/);
		});

		describe("a capacityLadderPath that falls back (#410)", () => {
			const quietDay = (
				config: string | null,
				{ notify = true, pinLadderFile = true } = {},
			) => {
				seat(".claude", { sevenDay: 50, resetsAt: FAR });
				if (config !== null) hostConfig(config);
				const ladderFile = path.join(home, "empty-ladder.md");
				fs.writeFileSync(ladderFile, "# Capacity procurement ladder\n");
				return run(
					{
						CLAUDE_PROJECT_DIR: home,
						...(pinLadderFile ? { WFC_LADDER: ladderFile } : {}),
					},
					notify ? ["--notify"] : [],
				);
			};

			it("puts a refused declaration's warning on stdout", () => {
				const r = quietDay('{"capacityLadderPath": "../ladder.md"}');
				expect(r.stdout).toMatch(
					/^WARN .*"capacityLadderPath" is not a repo-relative path.*\n$/,
				);
				expect(r.stderr).toBe("");
				expect(r.status).toBe(0);
			});

			it("puts an unreadable config's warning on stdout", () => {
				const r = quietDay('{"capacityLadderPath": "x.md",');
				expect(r.stdout).toMatch(
					/^WARN .*read at docs\/capacity-procurement-ladder\.md\n$/,
				);
				expect(r.stderr).toBe("");
				expect(r.status).toBe(0);
			});

			it("puts the warning on stdout where no seat directory exists", () => {
				hostConfig('{"capacityLadderPath": "../ladder.md"}');
				const r = run({ CLAUDE_PROJECT_DIR: home }, ["--notify"]);
				expect(r.stdout).toMatch(/^WARN .*is not a repo-relative path.*\n$/);
				expect(r.status).toBe(0);
			});

			it("adds nothing for a valid declaration or none", () => {
				expect(
					quietDay('{"capacityLadderPath": "docs/machinery/ladder.md"}').stdout,
				).toBe("");
				fs.rmSync(path.join(home, ".claude", "workflow-core.json"));
				expect(quietDay(null).stdout).toBe("");
			});

			it("keeps the warning on stderr without --notify", () => {
				// Unpinned, so the trial reader resolves the path and warns.
				const r = quietDay('{"capacityLadderPath": "../ladder.md"}', {
					notify: false,
					pinLadderFile: false,
				});
				expect(r.stdout).toBe("");
				expect(r.stderr).toMatch(/"capacityLadderPath" is not a repo-relative/);
				expect(r.status).toBe(0);
			});

			it("leaves the warning on stderr under --notify --json, which drops say()", () => {
				seat(".claude", { sevenDay: 50, resetsAt: FAR });
				hostConfig('{"capacityLadderPath": "../ladder.md"}');
				const r = run({ CLAUDE_PROJECT_DIR: home }, ["--notify", "--json"]);
				expect(r.stdout).not.toMatch(/is not a repo-relative path/);
				expect(r.stderr).toMatch(/is not a repo-relative path/);
			});
		});
	});
});

describe("gate 2 — the trial reader (mantahostels#2849)", () => {
	/* The declaration as the ladder carries it, with `over` replacing lines. The
	 * account is the fixture's own `uuid-<dir>` spelling, which is what the
	 * exclusion matches on. */
	const declare = (over: Record<string, string | null> = {}) => {
		const lines: Record<string, string> = {
			seat: "- **seat:** `.claude3`",
			account: "- **account:** `uuid-.claude3`",
			basis:
				`- **start basis:** \`.claude\` resets \`${TRIAL_START}\` read 1.0h ago · ` +
				`\`.claude2\` resets \`${TRIAL_START}\` read 1.0h ago`,
			window: `- **measured window:** \`${TRIAL_START}\` → \`${TRIAL_END}\``,
			baseline:
				"- **seat 3 at declaration:** 7d 62% · resets `2026-09-20T21:00:00Z` · fetched `2026-08-28T11:00:00Z`",
		};
		const p = path.join(home, "ladder-decl.md");
		fs.writeFileSync(
			p,
			[
				"### Seat 3's probation",
				"",
				"#### Gate 2 trial declaration",
				"",
				...Object.entries(lines)
					.map(([k, v]) => (k in over ? over[k] : v))
					.filter((v) => v !== null),
				"",
				"### Founder override",
			].join("\n"),
		);
		return p;
	};

	const run = (ladderPath: string | null, args: string[] = ["--notify"]) =>
		spawnSync(process.execPath, [SCRIPT, ...args], {
			encoding: "utf8",
			env: {
				...process.env,
				HOME: home,
				...seatEnv(home),
				WFC_SEAT_HISTORY: path.join(home, "gate2.jsonl"),
				WFC_NOW: new Date(NOW).toISOString(),
				// The host root is `home`, never the running repo, whose own
				// workflow-core.json would decide what a missing ladder means.
				CLAUDE_PROJECT_DIR: home,
				...(ladderPath ? { WFC_LADDER: ladderPath } : {}),
			},
		});

	/** Seat 3 frozen at the figure the declaration records. */
	const disabledSeat3 = () =>
		seat(".claude3", { sevenDay: 62, resetsAt: "2026-09-20T21:00:00Z" });

	it("warns once on stdout when a notice names a refused ladder path again (#410)", () => {
		hostConfig('{"capacityLadderPath": "../ladder.md"}');
		seat(".claude", { sevenDay: 100, resetsAt: FAR });
		seat(".claude2", { sevenDay: 100, resetsAt: FAR });
		disabledSeat3();
		const r = run(declare());
		expect(r.stdout).toContain(
			"clear the declaration block from docs/capacity-procurement-ladder.md",
		);
		expect(r.stdout.match(/is not a repo-relative path/g)).toHaveLength(1);
		expect(r.stderr).not.toMatch(/is not a repo-relative path/);
	});

	it("fires the trial-failure notice when the two remaining seats are exhausted", () => {
		seat(".claude", { sevenDay: 100, resetsAt: FAR });
		seat(".claude2", { sevenDay: 100, resetsAt: FAR });
		disabledSeat3();
		const r = run(declare());
		expect(r.stdout).toMatch(/GATE 2 TRIAL FAILED/);
		expect(r.stdout).toMatch(/RE-ENABLE SEAT 3 TODAY/);
		expect(r.status).toBe(0);
	});

	it("names the host's declared capacityLadderPath in the notice, not the default (#404)", () => {
		hostConfig('{"capacityLadderPath": "docs/machinery/ladder.md"}');
		seat(".claude", { sevenDay: 100, resetsAt: FAR });
		seat(".claude2", { sevenDay: 100, resetsAt: FAR });
		disabledSeat3();
		const r = run(declare());
		expect(r.stdout).toMatch(/GATE 2 TRIAL FAILED/);
		expect(r.stdout).toContain(
			"clear the declaration block from docs/machinery/ladder.md",
		);
		expect(r.stdout).not.toContain("docs/capacity-procurement-ladder.md");
	});

	it("never prescribes a purchase or a ceiling re-decision on a trial fire (mantahostels#2845)", () => {
		seat(".claude", { sevenDay: 100, resetsAt: FAR });
		seat(".claude2", { sevenDay: 100, resetsAt: FAR });
		disabledSeat3();
		const r = run(declare());
		expect(r.stdout).not.toMatch(/ALL SEATS EXHAUSTED/);
		expect(r.stdout).not.toMatch(/CEILING RE-DECISION/);
		expect(r.stdout).not.toMatch(/map #1732/);
	});

	it("says the ordinary trigger was suppressed, and for how long", () => {
		seat(".claude", { sevenDay: 100, resetsAt: FAR });
		seat(".claude2", { sevenDay: 100, resetsAt: FAR });
		disabledSeat3();
		const r = run(declare());
		expect(r.stdout).toMatch(/SUPPRESSED for this trial/);
		expect(r.stdout).toMatch(
			/2026-08-27 00:00 → 2026-09-10 00:00 UTC \(14 days\)/,
		);
	});

	it("stays silent at session start while the remaining seats have allowance", () => {
		seat(".claude", { sevenDay: 100, resetsAt: FAR });
		seat(".claude2", { sevenDay: 30, resetsAt: FAR });
		disabledSeat3();
		const r = run(declare());
		expect(r.stdout).toBe("");
	});

	it("suppresses the ordinary notice even where the three-seat trigger would fire", () => {
		/* Seat 3 disabled at 100% lets both reads fire at once; the ceiling
		 * re-decision stays suppressed (mantahostels#2845). */
		seat(".claude", { sevenDay: 100, resetsAt: FAR });
		seat(".claude2", { sevenDay: 100, resetsAt: FAR });
		seat(".claude3", { sevenDay: 100, resetsAt: FAR });
		const r = run(
			declare({
				baseline:
					"- **seat 3 at declaration:** 7d 100% · resets `" +
					`${FAR}\` · fetched \`2026-08-28T11:00:00Z\``,
			}),
		);
		expect(r.stdout).toMatch(/GATE 2 TRIAL FAILED/);
		expect(r.stdout).not.toMatch(/ALL SEATS EXHAUSTED/);
	});

	it("says a remaining seat is unread rather than holding the fire in silence", () => {
		// An unreadable live seat holds the trial fire (mantahostels#1742), but never silently (mantahostels#2835).
		seat(".claude", { sevenDay: 100, resetsAt: FAR });
		fs.mkdirSync(path.join(home, ".claude2"), { recursive: true });
		fs.writeFileSync(path.join(home, ".claude2", ".claude.json"), "{}");
		disabledSeat3();
		const r = run(declare());
		expect(r.stdout).toMatch(/SEAT UNREAD \(1\)/);
		expect(r.stdout).toMatch(/the trial has FAILED/);
		expect(r.stdout).not.toMatch(/GATE 2 TRIAL FAILED/);
	});

	it("runs the ordinary trigger loudly where the declared account is absent", () => {
		seat(".claude", { sevenDay: 100, resetsAt: FAR });
		seat(".claude2", { sevenDay: 100, resetsAt: FAR });
		const r = run(declare());
		expect(r.stdout).toMatch(/TRIAL DECLARED, NOT HONOURED/);
		expect(r.stdout).toMatch(/not among the 2 seat\(s\) read/);
		// A SKIP would lose the upward trigger, which is this collector's job.
		expect(r.stdout).toMatch(/ALL SEATS EXHAUSTED/);
		expect(r.status).toBe(0);
	});

	it("runs the ordinary trigger loudly where the declaration is malformed", () => {
		seat(".claude", { sevenDay: 100, resetsAt: FAR });
		seat(".claude2", { sevenDay: 100, resetsAt: FAR });
		/* All three exhausted, so the ORDINARY trigger genuinely has something to
		 * fire on — which is what the fallback has to keep. */
		seat(".claude3", { sevenDay: 100, resetsAt: FAR });
		const r = run(
			declare({
				basis: `- **start basis:** \`.claude\` resets \`${TRIAL_START}\` read 40.0h ago`,
			}),
		);
		expect(r.stdout).toMatch(/TRIAL DECLARED, NOT HONOURED/);
		expect(r.stdout).toMatch(/carried forward/);
		expect(r.stdout).toMatch(/ALL SEATS EXHAUSTED/);
	});

	it("runs the ordinary trigger loudly where the ladder itself cannot be read (mantahostels#2871)", () => {
		/* A missing/unreadable ladder must not read as "no trial declared" — that
		 * would sail past this loud branch on a fortnight that cannot be
		 * replayed. `declare()` is never called, so `WFC_LADDER` names a file
		 * that was never written. */
		hostConfig('{"capacityLadder": true}');
		seat(".claude", { sevenDay: 100, resetsAt: FAR });
		seat(".claude2", { sevenDay: 100, resetsAt: FAR });
		const r = run(path.join(home, "no-such-ladder.md"));
		expect(r.stdout).toMatch(/GATE 2 LADDER UNREADABLE/);
		expect(r.stdout).toMatch(/could not be read/);
		expect(r.stdout).toMatch(/ALL SEATS EXHAUSTED/);
		expect(r.status).toBe(0);
	});

	it("never asserts a declared trial off a ladder it could not read (#735)", () => {
		hostConfig('{"capacityLadder": true}');
		seat(".claude", { sevenDay: 30, resetsAt: FAR });
		const r = run(path.join(home, "no-such-ladder.md"));
		expect(r.stdout).toMatch(/whether a gate 2 trial is declared is unknown/);
		expect(r.stdout).not.toMatch(/TRIAL DECLARED/);
		expect(r.status).toBe(0);
	});

	it("prints no trial notice where the host declares no ladder and keeps none (#735)", () => {
		seat(".claude", { sevenDay: 30, resetsAt: FAR });
		const r = run(path.join(home, "no-such-ladder.md"));
		expect(r.stdout).toBe("");
		expect(r.status).toBe(0);
	});

	it("says the window is pending before it opens, and measures nothing yet", () => {
		seat(".claude", { sevenDay: 100, resetsAt: FAR });
		seat(".claude2", { sevenDay: 100, resetsAt: FAR });
		seat(".claude3", { sevenDay: 100, resetsAt: FAR });
		const r = run(
			declare({
				basis:
					"- **start basis:** `.claude` resets `2026-09-01T00:00:00Z` read 1.0h ago · " +
					"`.claude2` resets `2026-09-01T00:00:00Z` read 1.0h ago",
				window:
					"- **measured window:** `2026-09-01T00:00:00Z` → `2026-09-15T00:00:00Z`",
			}),
		);
		expect(r.stdout).toMatch(/GATE 2 TRIAL PENDING/);
		// Nothing is suppressed before the window opens.
		expect(r.stdout).toMatch(/ALL SEATS EXHAUSTED/);
	});

	describe("once the window has closed", () => {
		const history = (rows: object[]) =>
			fs.writeFileSync(
				path.join(home, "gate2.jsonl"),
				`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
			);
		const row = (at: string, a: number, b: number, three: object = {}) => ({
			at,
			seats: [
				{
					dir: ".claude",
					accountUuid: "uuid-.claude",
					sevenDay: a,
					resetsAt: FAR,
				},
				{
					dir: ".claude2",
					accountUuid: "uuid-.claude2",
					sevenDay: b,
					resetsAt: FAR,
				},
				{
					dir: ".claude3",
					accountUuid: "uuid-.claude3",
					sevenDay: 62,
					resetsAt: "2026-09-20T21:00:00Z",
					fetchedAt: "2026-08-28T11:00:00Z",
					...three,
				},
			],
		});
		/* A window that has closed by the fixture's NOW. */
		const closed = () =>
			declare({
				basis:
					"- **start basis:** `.claude` resets `2026-08-01T00:00:00Z` read 1.0h ago · " +
					"`.claude2` resets `2026-08-01T00:00:00Z` read 1.0h ago",
				window:
					"- **measured window:** `2026-08-01T00:00:00Z` → `2026-08-15T00:00:00Z`",
			});

		beforeEach(() => {
			seat(".claude", { sevenDay: 30, resetsAt: FAR });
			seat(".claude2", { sevenDay: 30, resetsAt: FAR });
			disabledSeat3();
		});

		it("prescribes retiring the seat on a pass, with its coverage", () => {
			history([
				row("2026-08-02T00:00:00Z", 40, 50),
				row("2026-08-09T00:00:00Z", 90, 20),
			]);
			const r = run(closed());
			expect(r.stdout).toMatch(/GATE 2 TRIAL PASSED/);
			expect(r.stdout).toMatch(/RETIRE SEAT 3/);
			expect(r.stdout).toMatch(/COVERAGE — 2 reading\(s\)/);
		});

		it("reports a fire the live session start missed, off the series", () => {
			history([row("2026-08-02T00:00:00Z", 100, 100)]);
			const r = run(closed());
			expect(r.stdout).toMatch(/GATE 2 TRIAL FAILED/);
			expect(r.stdout).toMatch(/RE-ENABLE SEAT 3/);
			expect(r.stdout).not.toMatch(/CEILING RE-DECISION/);
		});

		it("voids where seat 3 carried work inside the window", () => {
			history([row("2026-08-02T00:00:00Z", 40, 40, { sevenDay: 71 })]);
			const r = run(closed());
			expect(r.stdout).toMatch(/GATE 2 TRIAL VOID/);
			expect(r.stdout).toMatch(/Re-declare and re-run/i);
		});
	});
});

describe("weekly_scoped — the tier-drop notice (#298, #304)", () => {
	it("parses a seat's weekly_scoped bars off limits[], dropping this repo's threshold from the shape", () => {
		seat(".claude", {
			sevenDay: 84,
			resetsAt: FAR,
			scoped: [
				{ model: "Fable", percent: 100, resetsAt: FAR, severity: "critical" },
			],
		});
		const [s] = readSeats(NOW, seatDirs(home));
		expect(s.scopedBars).toEqual([
			{
				model: "Fable",
				percent: 100,
				severity: "critical",
				resetsAt: FAR,
				effective: 100,
				rolled: false,
			},
		]);
	});

	it("fires only once every readable seat's bar for a model is over ceiling", () => {
		seat(".claude", {
			sevenDay: 84,
			resetsAt: FAR,
			scoped: [{ model: "Fable", percent: 100, resetsAt: FAR }],
		});
		seat(".claude2", {
			sevenDay: 11,
			resetsAt: FAR,
			scoped: [{ model: "Fable", percent: 12, resetsAt: FAR }],
		});
		seat(".claude3", {
			sevenDay: 99,
			resetsAt: FAR,
			scoped: [{ model: "Fable", percent: 100, resetsAt: FAR }],
		});
		// .claude2 still has headroom on Fable.
		expect(scopedVerdict(readSeats(NOW, seatDirs(home))).fired).toBe(false);
		seat(".claude2", {
			sevenDay: 11,
			resetsAt: FAR,
			scoped: [{ model: "Fable", percent: 100, resetsAt: FAR }],
		});
		const sx = scopedVerdict(readSeats(NOW, seatDirs(home)));
		expect(sx.fired).toBe(true);
		expect(sx.exhausted).toEqual([
			{
				model: "Fable",
				entries: expect.arrayContaining([
					expect.objectContaining({
						seat: expect.objectContaining({ dir: ".claude" }),
					}),
				]),
			},
		]);
	});

	it("never sets fired on the ordinary verdict, allExhausted or panelNeeded", () => {
		seat(".claude", {
			sevenDay: 16,
			resetsAt: FAR,
			scoped: [{ model: "Fable", percent: 100, resetsAt: FAR }],
		});
		seat(".claude2", {
			sevenDay: 20,
			resetsAt: FAR,
			scoped: [{ model: "Fable", percent: 100, resetsAt: FAR }],
		});
		const seats = readSeats(NOW, seatDirs(home));
		expect(verdict(seats, NOW).fired).toBe(false);
		expect(verdict(seats, NOW).allExhausted).toBe(false);
		expect(scopedVerdict(seats).fired).toBe(true);
	});

	it("excludes a seat with no bar at all for that model from its quorum, rather than treating it as spent", () => {
		seat(".claude", {
			sevenDay: 50,
			resetsAt: FAR,
			scoped: [{ model: "Fable", percent: 100, resetsAt: FAR }],
		});
		// .claude2 carries no weekly_scoped bar for any model.
		seat(".claude2", { sevenDay: 50, resetsAt: FAR });
		expect(scopedVerdict(readSeats(NOW, seatDirs(home))).fired).toBe(false);
	});

	it("judges a scoped bar past its OWN resets_at, not weekly_all's", () => {
		const past = new Date(NOW - HOUR).toISOString();
		seat(".claude", {
			sevenDay: 84,
			resetsAt: FAR,
			scoped: [{ model: "Fable", percent: 100, resetsAt: past }],
		});
		const [s] = readSeats(NOW, seatDirs(home));
		expect(s.scopedBars[0].effective).toBe(0);
		expect(s.scopedBars[0].rolled).toBe(true);
	});

	it("holds the fire on a seat unread for its whole cache, exactly as the ordinary trigger does", () => {
		seat(".claude", {
			sevenDay: 84,
			resetsAt: FAR,
			scoped: [{ model: "Fable", percent: 100, resetsAt: FAR }],
		});
		seat(".claude2", null);
		const sx = scopedVerdict(readSeats(NOW, seatDirs(home)));
		expect(sx.fired).toBe(false);
		expect(sx.heldFire).toBe(true);
		expect(sx.unread.map((s: { dir: string }) => s.dir)).toEqual([".claude2"]);
	});

	it("handles N bars: two models, only the fully-exhausted one fires", () => {
		seat(".claude", {
			sevenDay: 50,
			resetsAt: FAR,
			scoped: [
				{ model: "Fable", percent: 100, resetsAt: FAR },
				{ model: "Opus", percent: 40, resetsAt: FAR },
			],
		});
		seat(".claude2", {
			sevenDay: 50,
			resetsAt: FAR,
			scoped: [
				{ model: "Fable", percent: 100, resetsAt: FAR },
				{ model: "Opus", percent: 30, resetsAt: FAR },
			],
		});
		const sx = scopedVerdict(readSeats(NOW, seatDirs(home)));
		expect(sx.exhausted.map((m: { model: string }) => m.model)).toEqual([
			"Fable",
		]);
	});

	describe("end to end", () => {
		// Through the in-process seam, not a fourth spawnSync site.
		const runNotify = (env: Record<string, string> = {}) =>
			runInProcess(SCRIPT, ["--notify"], {
				env: {
					...process.env,
					HOME: home,
					...seatEnv(home),
					WFC_SEAT_HISTORY: path.join(home, "scoped.jsonl"),
					WFC_NOW: new Date(NOW).toISOString(),
					...env,
				},
			});

		/** No trial declared, so `buildCannotHonourNotice` stays out of these fixtures. */
		const emptyLadder = () => {
			const p = path.join(home, "empty-ladder.md");
			fs.writeFileSync(p, "# Capacity procurement ladder\n");
			return p;
		};

		it("warns MODEL-TIER-SPENT and prescribes a tier drop, never a ceiling re-decision", () => {
			seat(".claude", {
				sevenDay: 16,
				resetsAt: FAR,
				scoped: [{ model: "Fable", percent: 100, resetsAt: FAR }],
			});
			seat(".claude2", {
				sevenDay: 20,
				resetsAt: FAR,
				scoped: [{ model: "Fable", percent: 100, resetsAt: FAR }],
			});
			const r = runNotify({ WFC_LADDER: emptyLadder() });
			expect(r.status).toBe(0);
			expect(r.stdout).toMatch(/MODEL TIER SPENT/);
			expect(r.stdout).toMatch(/DROP TIER FOR NOW/);
			expect(r.stdout).not.toMatch(/ALL SEATS EXHAUSTED/);
			expect(r.stdout).not.toMatch(/CEILING RE-DECISION/);
		});

		it("holds the fire in total silence when a seat is unread — no second panel needle", () => {
			seat(".claude", {
				sevenDay: 16,
				resetsAt: FAR,
				scoped: [{ model: "Fable", percent: 100, resetsAt: FAR }],
			});
			seat(".claude2", null);
			const r = runNotify({ WFC_LADDER: emptyLadder() });
			expect(r.status).toBe(0);
			expect(r.stdout).not.toMatch(/MODEL TIER/);
		});

		it("says nothing while a model still has headroom on some seat", () => {
			seat(".claude", {
				sevenDay: 16,
				resetsAt: FAR,
				scoped: [{ model: "Fable", percent: 100, resetsAt: FAR }],
			});
			seat(".claude2", {
				sevenDay: 20,
				resetsAt: FAR,
				scoped: [{ model: "Fable", percent: 12, resetsAt: FAR }],
			});
			const r = runNotify({ WFC_LADDER: emptyLadder() });
			expect(r.status).toBe(0);
			expect(r.stdout).not.toMatch(/MODEL TIER/);
		});
	});
});
