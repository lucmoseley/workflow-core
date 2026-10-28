// @vitest-environment node
/*
 * guard-session-ceiling.js speaks at Stop when a session crosses a band of the
 * session-context policy — the 200,000-token wind-up notice, the 100-turn band
 * and the 300,000-token tripwire — and stays silent on any path that cannot
 * read a figure (mantahostels#1731; #1178).
 *
 * Black-box: the guard is driven end to end with a payload on stdin, its
 * repo root pointed at a throwaway directory so the counters and breadcrumbs it
 * mints never land in the shared tree. It reads files rather than git state, so
 * the temp directory is a plain `mkdtempSync` one rather than a git repo.
 *
 * It is the only reader of that policy: break it and a session runs past
 * 300,000 tokens with nothing said; loosen the caps and it blocks turn after
 * turn.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStopGuardBlock, type StopRun } from "./lib/stop-guard-testkit";
import { buildBashCall } from "./lib/transcript-testkit";

/* The block counters (`*-nagged-*-<sid>`) live under gr_markers_dir
 * (.claude/tmp/markers), not the throwaway root itself — hook-block.js's
 * counterPath. */
const { markersDir } = createRequire(__filename)("./lib/marker-root.js");

const hookRecord = createRequire(__filename)("./lib/hook-record.js");

const GUARD = path.join(__dirname, "guard-session-ceiling.js");

/* The guard's band edges, restated from guard-session-ceiling.js, which a
 * black-box test cannot import: a drift there turns the at-edge cases red. */
const WIND_UP = 200_000;
const TURN_BAND = 100;
const TRIPWIRE = 300_000;
/* One reading past each edge, for a case about something other than where
 * the edge sits; any value past it serves. PAST_WIND_UP stays short of
 * TRIPWIRE, so only the wind-up band speaks. */
const PAST_WIND_UP = 214_000;
const PAST_TURN_BAND = 140;
const PAST_TRIPWIRE = 480_000;

let dir: string;
let sid: string;

/**
 * A transcript whose turns carry the given standing-context totals, split
 * across the three usage fields so what is asserted is their sum, never one
 * field.
 */
const transcript = (totals: number[], extra: object[] = []): string => {
	const file = path.join(dir, `${sid}.jsonl`);
	const lines = totals.map((t, i) =>
		JSON.stringify({
			type: "assistant",
			timestamp: "2026-08-28T00:00:00Z",
			requestId: `req_${String(i)}`,
			message: {
				usage: {
					input_tokens: 1,
					cache_creation_input_tokens: 1,
					cache_read_input_tokens: t - 2,
				},
			},
		}),
	);
	fs.writeFileSync(
		file,
		`${[...lines, ...extra.map((r) => JSON.stringify(r))].join("\n")}\n`,
	);
	return file;
};

/** One run of the guard, its dispatch ledger redirected with the other roots.
 * The turn defaults to a session-ending one, the only kind a band below the
 * ceiling refuses (#919). */
const run = (over: Partial<StopRun> = {}) => {
	const block = readStopGuardBlock(GUARD, {
		dir,
		sid,
		config: dir,
		transcript: path.join(dir, `${sid}.jsonl`),
		env: { WFC_DISPATCH_ROOT: dir },
		message: "result: done",
		...over,
	});
	/* Read so a returning screen notice, dropped at #1148, fails a test. */
	const notice = (block as { systemMessage?: string } | null)?.systemMessage;
	return {
		blocked: block?.decision === "block",
		reason: block?.reason ?? "",
		notice: notice ?? "",
	};
};

/** Records this session's claim on `issue` through the arbiter's own CLI,
 * so the store path resolves exactly as a live session's does. */
const claim = (issue: number, session = sid) =>
	execFileSync(
		process.execPath,
		[path.join(__dirname, "session-arbiter.js"), "claim-issue", String(issue)],
		{
			cwd: dir,
			stdio: "ignore",
			env: {
				...process.env,
				CLAUDE_CODE_SESSION_ID: session,
				CLAUDE_PROJECT_DIR: dir,
				WFC_REPO_ROOT: dir,
				CLAUDE_CONFIG_DIR: dir,
			},
		},
	);

/** A transcript of `count` distinct responses, each at `ctx` standing context
 * and written as `perResponse` assistant records sharing one request id. */
const turns = (count: number, ctx = 50_000, perResponse = 1) => {
	const lines: string[] = [];
	for (let i = 0; i < count; i++)
		for (let r = 0; r < perResponse; r++)
			lines.push(
				JSON.stringify({
					type: "assistant",
					requestId: `req_${String(i)}`,
					uuid: `u-${String(i)}-${String(r)}`,
					message: {
						usage: { input_tokens: 2, cache_read_input_tokens: ctx - 2 },
					},
				}),
			);
	fs.writeFileSync(path.join(dir, `${sid}.jsonl`), `${lines.join("\n")}\n`);
};

/** The outcome of every breadcrumb this guard has left, across sessions. */
const readOutcomes = (): string[] => {
	const crumbDir = hookRecord.recordsDir(dir);
	return fs
		.readdirSync(crumbDir)
		.filter((f) => f.startsWith(".hook-ran-guard-session-ceiling-"))
		.flatMap((f) =>
			fs.readFileSync(path.join(crumbDir, f), "utf8").trim().split("\n"),
		)
		.filter(Boolean)
		.map((l) => JSON.parse(l).outcome);
};

beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ceiling-")));
	sid = `s-${Math.random().toString(36).slice(2)}`;
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("a reading under the wind-up notice", () => {
	it("says nothing, and still exits 0", () => {
		transcript([120_000, 180_000]);
		const seen = run();
		expect(seen.blocked).toBe(false);
	});

	it("is silent one token below the notice", () => {
		transcript([WIND_UP - 1]);
		expect(run().blocked).toBe(false);
	});
});

describe("the 200,000-token wind-up notice (mantahostels#1548, the policy; mantahostels#1731, the reader)", () => {
	it("speaks at the threshold itself, not one token past it", () => {
		transcript([WIND_UP]);
		expect(run().reason).toContain("WIND-UP NOTICE");
	});

	it("gives the reading and the command that reproduces it", () => {
		transcript([214_500]);
		const reason = run().reason;
		expect(reason).toContain("214,500");
		expect(reason).toContain("node scripts/session-context.js");
	});

	it("blocks at every Stop past it, not once — the whole of mantahostels#2601's (D)", () => {
		transcript([120_000, PAST_WIND_UP]);
		for (let i = 0; i < 6; i++) expect(run().blocked).toBe(true);
	});

	it("says in its own text that it repeats, and at what rate", () => {
		transcript([PAST_WIND_UP]);
		const reason = run().reason;
		expect(reason).toContain("AGAIN AND AGAIN FROM HERE ON");
		expect(reason).toContain("every other Stop");
	});

	it("never goes dark with hook-block's last-block notice, having no cap to spend", () => {
		transcript([PAST_WIND_UP]);
		for (let i = 0; i < 4; i++)
			expect(run().reason).not.toContain("last Stop block");
	});

	it("stands down for a turn any Stop guard blocked, and speaks again on the next", () => {
		transcript([PAST_WIND_UP]);
		expect(run({ payload: { stop_hook_active: true } }).blocked).toBe(false);
		expect(run().reason).toContain("WIND-UP NOTICE");
	});

	/* The shape the harness actually produces: the Stop straight after one of
	 * this guard's own blocks carries the flag (mantahostels#2601). */
	it("lands on every other Stop under the harness's own alternation", () => {
		transcript([PAST_WIND_UP]);
		const seen = [
			run().blocked,
			run({ payload: { stop_hook_active: true } }).blocked,
			run().blocked,
			run({ payload: { stop_hook_active: true } }).blocked,
			run().blocked,
		];
		expect(seen).toEqual([true, false, true, false, true]);
	});

	it("passes `waiting:`, `needs input:` and no message with no claim held, and refuses `result:` and an unmarked turn (#919)", () => {
		transcript([PAST_WIND_UP]);
		expect(
			run({ message: "waiting: the suite in the background" }).blocked,
		).toBe(false);
		expect(
			run({ message: "❓ **Q1** which?\n\nneeds input: pick one" }).blocked,
		).toBe(false);
		expect(run({ message: "" }).blocked).toBe(false);
		expect(run().blocked).toBe(true);
		expect(run({ message: "All finished." }).blocked).toBe(true);
	});
});

describe("the 100-turn band (mantahostels#2601's (B), mantahostels#2619)", () => {
	it("is silent one turn below the band", () => {
		turns(TURN_BAND - 1);
		expect(run().blocked).toBe(false);
	});

	it("speaks at the threshold itself, and gives the count", () => {
		turns(TURN_BAND);
		const reason = run().reason;
		expect(reason).toContain("100 model responses");
		expect(reason).toContain("100-TURN NOTICE");
	});

	it("says the ticket in hand is finished, not handed to a fresh session", () => {
		turns(PAST_TURN_BAND);
		const reason = run().reason;
		expect(reason).toContain("not a limit and not a stop");
		expect(reason).toContain("Finish the ticket in hand");
		expect(reason).toContain(
			"Never leave the ticket in hand's remaining steps to a fresh session",
		);
		expect(reason).not.toContain("token bands have not spoken");
	});

	it("counts responses, not records — 40 responses of 3 records apiece is 40 turns", () => {
		turns(40, 50_000, 3);
		expect(run().blocked).toBe(false);
	});

	it("blocks three times and then stops — mantahostels#2619's cap", () => {
		turns(PAST_TURN_BAND);
		expect(run().blocked).toBe(true);
		expect(run().blocked).toBe(true);
		expect(run().blocked).toBe(true);
		expect(run().blocked).toBe(false);
	});

	it("tells the session it will fire again, so the first block does not read as the only one (mantahostels#2619)", () => {
		turns(PAST_TURN_BAND);
		const reason = run().reason;
		expect(reason).toContain("THIS FIRES AGAIN");
		expect(reason).toContain("`waiting:` and `needs input:` pass");
	});

	it("says on the third that it was the last, so the silence after is not read as compliance (mantahostels#2619)", () => {
		turns(PAST_TURN_BAND);
		run();
		run();
		expect(run().reason).toContain("last Stop block");
	});

	it("writes its own counter, so it spends neither token band's allowance", () => {
		turns(PAST_TURN_BAND);
		run();
		expect(
			fs.existsSync(
				path.join(markersDir(dir), `.session-ceiling-nagged-turns-${sid}`),
			),
		).toBe(true);
	});

	it("passes `waiting:` and `needs input:`, refusing only a turn that would end the session (#919)", () => {
		turns(PAST_TURN_BAND);
		expect(
			run({ message: "waiting: the suite in the background" }).blocked,
		).toBe(false);
		expect(
			run({ message: "❓ **Q1** which?\n\nneeds input: pick one" }).blocked,
		).toBe(false);
		expect(run({ message: "All finished." }).blocked).toBe(true);
	});

	it("spends no block on a passed turn, so three session-ending Stops still hear all three (#919)", () => {
		turns(PAST_TURN_BAND);
		run({ message: "waiting: the suite" });
		run({ message: "waiting: the suite" });
		const seen = [
			run(),
			run({ payload: { stop_hook_active: true } }),
			run({ message: "All finished." }),
			run({ payload: { stop_hook_active: true } }),
			run(),
		];
		expect(seen.map((s) => s.blocked)).toEqual([
			true,
			false,
			true,
			false,
			true,
		]);
		expect(seen[4].reason).toContain("last Stop block");
	});

	it("passes a turn with no message to read, failing open (#919)", () => {
		turns(PAST_TURN_BAND);
		expect(run({ message: "" }).blocked).toBe(false);
		expect(
			fs.existsSync(
				path.join(markersDir(dir), `.session-ceiling-nagged-turns-${sid}`),
			),
		).toBe(false);
	});

	it("yields to the token bands, so at most one demand reaches a turn", () => {
		turns(PAST_TURN_BAND, PAST_WIND_UP);
		expect(run().reason).toContain("Standing context");
		turns(PAST_TURN_BAND, PAST_TRIPWIRE);
		expect(run().reason).toContain("TRIPWIRE");
	});
});

describe("the 300,000-token tripwire (#1178 Q3 (B), which made the ceiling one)", () => {
	it("speaks at the threshold itself", () => {
		transcript([TRIPWIRE]);
		expect(run().reason).toContain("TRIPWIRE in docs/effort-guide.md");
	});

	it("says compaction did not fire and names the setting to check", () => {
		transcript([PAST_TRIPWIRE]);
		const reason = run().reason;
		expect(reason).toContain("autocompaction did not fire");
		expect(reason).toContain("`autoCompactWindow`");
		expect(reason).toContain(".claude/settings.json");
	});

	it("tells the session to commit and end its turn, and names no successor launch", () => {
		claim(17);
		transcript([PAST_TRIPWIRE]);
		const reason = run().reason;
		expect(reason).toContain("Commit what exists");
		expect(reason).toContain("end your turn");
		expect(reason).not.toContain("successor");
		/* The quoted founder-deliverable rule says "the ticket in hand" and
		 * "HAND-OVER"; the guard's own words must name no hand-off. */
		const rule = fs
			.readFileSync(
				path.join(__dirname, "..", "docs/agents/rules/founder-deliverable.txt"),
				"utf8",
			)
			.trim();
		expect(reason).toContain(rule);
		expect(reason.replace(rule, "")).not.toContain("hand");
	});

	it("speaks once: the next session-ending Stop hears the wind-up band, and a `waiting:` one passes", () => {
		transcript([PAST_TRIPWIRE]);
		expect(run().reason).toContain("TRIPWIRE");
		for (let i = 0; i < 3; i++) {
			const reason = run().reason;
			expect(reason).not.toContain("TRIPWIRE");
			expect(reason).toContain("WIND-UP NOTICE");
			expect(reason).toContain(PAST_TRIPWIRE.toLocaleString("en-GB"));
		}
		expect(run({ message: "waiting: the suite" }).blocked).toBe(false);
	});

	it("refuses a `waiting:` turn on its one block, as the TRIPWIRE band that reads no marker (#919)", () => {
		transcript([TRIPWIRE]);
		expect(run({ message: "waiting: the suite" }).reason).toContain("TRIPWIRE");
		expect(run({ message: "waiting: the suite" }).blocked).toBe(false);
	});

	it("still speaks after the wind-up notice has been spent", () => {
		transcript([PAST_WIND_UP]);
		expect(run().reason).toContain("WIND-UP NOTICE");
		transcript([PAST_WIND_UP, PAST_TRIPWIRE]);
		expect(run().reason).toContain("TRIPWIRE");
	});

	it("skips straight past the notice where the first reading is already over it", () => {
		transcript([482_576]);
		const reason = run().reason;
		expect(reason).toContain("TRIPWIRE");
		expect(reason).toContain("482,576");
	});

	it("speaks to a session that ran park-blocked.sh too, which the wind-up band never does", () => {
		transcript([PAST_TRIPWIRE]);
		fs.writeFileSync(
			path.join(markersDir(dir), `.parked-blocked-${sid}`),
			"{}",
		);
		expect(run().reason).toContain("TRIPWIRE");
		expect(run().blocked).toBe(false);
	});

	it("writes each band its own counter, so neither spends the other's allowance", () => {
		transcript([PAST_WIND_UP]);
		run();
		expect(
			fs.existsSync(
				path.join(markersDir(dir), `.session-ceiling-nagged-windup-${sid}`),
			),
		).toBe(true);
		transcript([PAST_WIND_UP, PAST_TRIPWIRE]);
		run();
		expect(
			fs.existsSync(
				path.join(markersDir(dir), `.session-ceiling-nagged-hard-${sid}`),
			),
		).toBe(true);
	});
});

describe("in a plugin install (#1452)", () => {
	const bands: [string, () => void][] = [
		["wind-up", () => transcript([PAST_WIND_UP])],
		["turns", () => turns(PAST_TURN_BAND)],
		["tripwire", () => transcript([TRIPWIRE])],
	];

	it.each(bands)(
		"the %s block names effort-guide.md at the plugin root",
		(_, set) => {
			const root = path.join(dir, "plugin");
			fs.mkdirSync(path.join(root, "docs"), { recursive: true });
			fs.writeFileSync(path.join(root, "docs", "effort-guide.md"), "");
			set();
			const { reason } = run({
				env: { WFC_DISPATCH_ROOT: dir, WFC_SCRIPT_ROOT: root },
			});
			expect(reason).toContain(`in ${root}/docs/effort-guide.md`);
			expect(reason).not.toMatch(/(?<!\/)docs\/effort-guide\.md/);
		},
	);
});

describe("no hand-off in any band (#1178 Q1 (A) and Q4 (B))", () => {
	/** Every band's first block and a repeat, read for one session. */
	const everyBand = () => {
		const seen: string[] = [];
		turns(PAST_TURN_BAND);
		seen.push(run().reason, run().reason);
		transcript([PAST_WIND_UP]);
		seen.push(run().reason, run().reason);
		transcript([PAST_WIND_UP, PAST_TRIPWIRE]);
		seen.push(run().reason, run().reason);
		return seen;
	};

	it("gives a single-claim holder no successor, no 250,000 forecast and no hand-on (#62's limb gone)", () => {
		claim(17);
		const seen = everyBand();
		for (const reason of seen) {
			expect(reason).not.toBe("");
			expect(reason).not.toContain("successor");
			expect(reason).not.toContain("250,000");
			expect(reason).not.toMatch(/hand (it|#17|the member)/);
			expect(reason).not.toContain("handed off");
		}
	});

	it("never tells a session not to compact, or that a compaction means it overran", () => {
		const seen = everyBand();
		for (const reason of seen) {
			expect(reason).not.toMatch(/do not compact/i);
			expect(reason).not.toContain("overran");
			expect(reason).not.toContain("2.25x");
		}
	});

	it("tells the wind-up and turn bands to finish the unit in flight through a compaction, start no new one, and end", () => {
		transcript([PAST_WIND_UP]);
		const windUp = run().reason;
		expect(windUp).toContain("Finish the unit of work in flight");
		expect(windUp).toContain("even if a compaction fires");
		expect(windUp).toContain("start no new one");
		expect(windUp).toContain("The next unit goes to a fresh session");
		expect(windUp).toContain("the cheap move is to finish and end");
		turns(PAST_TURN_BAND);
		const turnBand = run().reason;
		expect(turnBand).toContain("Finish the ticket in hand");
		expect(turnBand).toContain("even if a compaction fires");
		expect(turnBand).toContain("then end");
		expect(turnBand).toContain("rules out is STARTING a different ticket");
	});

	it("gives a claim holder the same wind-up text as anyone, refusing `result:` and passing `waiting:`", () => {
		claim(17);
		transcript([PAST_WIND_UP]);
		const seen = run({ message: "Done.\n\nresult: shipped the guard" });
		expect(seen.blocked).toBe(true);
		expect(seen.reason).toContain("Finish the unit of work in flight");
		expect(
			run({ message: "waiting: the suite in the background" }).blocked,
		).toBe(false);
	});

	it("reads the marker that governs, the latest, not one quoted earlier", () => {
		transcript([PAST_WIND_UP]);
		expect(
			run({ message: "waiting: an earlier line\n\nresult: done" }).blocked,
		).toBe(true);
	});

	it("goes quiet on the wind-up band once park-blocked.sh's local record exists", () => {
		transcript([PAST_WIND_UP]);
		fs.writeFileSync(
			path.join(markersDir(dir), `.parked-blocked-${sid}`),
			JSON.stringify({ outcome: "blocked", issue: 17, session: sid }),
		);
		expect(run({ message: "result: blocked" }).blocked).toBe(false);
	});

	it("is not silenced by a neighbour's record", () => {
		transcript([PAST_WIND_UP]);
		fs.writeFileSync(
			path.join(markersDir(dir), ".parked-blocked-someone-else"),
			"{}",
		);
		expect(run({ message: "result: done" }).blocked).toBe(true);
	});

	it("is not silenced by its parent's record on a subagent transcript", () => {
		const sub = path.join(dir, "subagents");
		fs.mkdirSync(sub);
		const file = path.join(sub, "agent-a1.jsonl");
		fs.writeFileSync(
			file,
			`${JSON.stringify({ type: "assistant", isSidechain: true, message: { usage: { input_tokens: PAST_WIND_UP } } })}\n`,
		);
		fs.writeFileSync(
			path.join(markersDir(dir), `.parked-blocked-${sid}`),
			"{}",
		);
		expect(run({ transcript: file }).reason).toContain("WIND-UP NOTICE");
	});
});

describe("waiting for the session's own background work (#1179)", () => {
	/** A background command launched in this session, and — where `settled` —
	 * the notification that says it came back. */
	const launch = (id: string, description: string, settled = false) => {
		const records = [
			JSON.stringify(
				buildBashCall("sleep 9", id, {
					input: { description, run_in_background: true },
				}),
			),
		];
		if (settled)
			records.push(
				JSON.stringify({
					type: "queue-operation",
					content: `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n</task-notification>`,
				}),
			);
		fs.appendFileSync(
			path.join(dir, `${sid}.jsonl`),
			`${records.join("\n")}\n`,
		);
	};

	it("lists every launch still out at the wind-up band, by its description, and says to wait for it", () => {
		transcript([PAST_WIND_UP]);
		launch("toolu_a", "Run the suite");
		launch("toolu_b", "Watch the artefact");
		launch("toolu_c", "Already back", true);
		const reason = run().reason;
		expect(reason).toContain("- Run the suite (background command, toolu_a)");
		expect(reason).toContain(
			"- Watch the artefact (background command, toolu_b)",
		);
		expect(reason).not.toContain("Already back");
		expect(reason).toContain("end this turn on `waiting:`");
		expect(reason).toContain("End on `result:` only when nothing is still out");
	});

	it("lists them at the 100-turn band and the tripwire too", () => {
		turns(PAST_TURN_BAND);
		launch("toolu_a", "Run the suite");
		expect(run().reason).toContain(
			"- Run the suite (background command, toolu_a)",
		);
		transcript([PAST_TRIPWIRE]);
		launch("toolu_a", "Run the suite");
		const reason = run().reason;
		expect(reason).toContain("TRIPWIRE");
		expect(reason).toContain("- Run the suite (background command, toolu_a)");
	});

	it("refuses `result:` with a launch out and passes `waiting:`, at the wind-up and turn bands", () => {
		transcript([PAST_WIND_UP]);
		launch("toolu_a", "Run the suite");
		expect(run({ message: "waiting: the suite" }).blocked).toBe(false);
		expect(run().blocked).toBe(true);
		turns(PAST_TURN_BAND);
		launch("toolu_a", "Run the suite");
		expect(run({ message: "waiting: the suite" }).blocked).toBe(false);
		expect(run().blocked).toBe(true);
	});

	it("keeps the turn band's cap of three with a launch out", () => {
		turns(PAST_TURN_BAND);
		launch("toolu_a", "Run the suite");
		expect([run(), run(), run(), run()].map((r) => r.blocked)).toEqual([
			true,
			true,
			true,
			false,
		]);
	});

	it("speaks at the wind-up band despite park-blocked.sh's record while a launch is out", () => {
		transcript([PAST_WIND_UP]);
		launch("toolu_a", "Run the suite");
		fs.writeFileSync(
			path.join(markersDir(dir), `.parked-blocked-${sid}`),
			JSON.stringify({ outcome: "blocked", issue: 17, session: sid }),
		);
		expect(run({ message: "result: blocked" }).reason).toContain(
			"- Run the suite (background command, toolu_a)",
		);
	});

	it("says nothing of background work where none is out, as after #1199", () => {
		transcript([PAST_WIND_UP]);
		launch("toolu_c", "Already back", true);
		const reason = run().reason;
		expect(reason).toContain("WIND-UP NOTICE");
		expect(reason).not.toContain("background work");
		turns(PAST_TURN_BAND);
		expect(run().reason).not.toContain("background work");
	});

	it("fails open on a record the transcript readers throw on, with a launch out", () => {
		transcript([PAST_WIND_UP]);
		launch("toolu_a", "Run the suite");
		/* A bare `null` record throws in every reader, the launch reader included. */
		fs.appendFileSync(path.join(dir, `${sid}.jsonl`), "null\n");
		expect(run().blocked).toBe(false);
	});

	it("fails open on a transcript it cannot read, with a launch out", () => {
		const file = transcript([PAST_WIND_UP]);
		launch("toolu_a", "Run the suite");
		fs.chmodSync(file, 0o000);
		expect(run().blocked).toBe(false);
	});
});

describe("the inventory step on every band (#985, on #958's spec)", () => {
	const full = "A FOUNDER-FACING ITEM lives in an open issue";
	const pointer =
		"The full rule: `scripts/lib/rule-text.sh founder-deliverable`.";

	it("gives the wind-up the full rule on its first block and the pointer on every repeat", () => {
		transcript([PAST_WIND_UP]);
		const first = run().reason;
		expect(first).toContain("take the inventory");
		/* #958 ruled this wording; its pieces are lib/inventory-format.js's (#1249). */
		expect(first).toContain(
			"Then end with the inventory directly above the status line: `waits on you:`, then one `- #N (what to do)` line per item, or the single line `waits on you: nothing`. In a background job, also end the status line with `— waits on you: #N, #M` or `— nothing waits on you`.",
		);
		expect(first).toContain(full);
		for (let i = 0; i < 2; i++) {
			const repeat = run().reason;
			expect(repeat).toContain("take the inventory");
			expect(repeat).toContain(pointer);
			expect(repeat).not.toContain(full);
		}
	});

	it("asks for a state comment only on an issue still open, and says what passes the repeat", () => {
		transcript([PAST_WIND_UP]);
		const reason = run().reason;
		expect(reason).toContain("If the issue you were working is still open");
		expect(reason).toContain(
			"`waiting:` and `needs input:` pass and spend no block",
		);
	});

	it("gives the 100-turn band the same step, full once and then the pointer", () => {
		turns(PAST_TURN_BAND);
		const first = run().reason;
		expect(first).toContain("take the inventory");
		expect(first).toContain(full);
		const repeat = run().reason;
		expect(repeat).toContain("take the inventory");
		expect(repeat).toContain(pointer);
		expect(repeat).not.toContain(full);
	});

	it("gives the tripwire's one block the full rule, and the wind-up block after it the pointer", () => {
		transcript([PAST_TRIPWIRE]);
		const first = run().reason;
		expect(first).toContain("take the inventory");
		expect(first).toContain(full);
		const after = run().reason;
		expect(after).toContain("take the inventory");
		expect(after).toContain(pointer);
		expect(after).not.toContain(full);
	});

	it("gives a tripwire heard after the wind-up the full rule still, its own block being a first", () => {
		transcript([PAST_WIND_UP]);
		run();
		transcript([PAST_WIND_UP, PAST_TRIPWIRE]);
		expect(run().reason).toContain(full);
	});

	it("prints a short fallback, never nothing, where the rule store cannot be read", () => {
		const empty = path.join(dir, "no-rules");
		fs.mkdirSync(empty);
		transcript([PAST_WIND_UP]);
		const reason = run({
			env: {
				WFC_DISPATCH_ROOT: dir,
				WFC_RULES_DIR: empty,
				WFC_RULES_FALLBACK_DIR: empty,
			},
		}).reason;
		expect(reason).toContain("take the inventory");
		expect(reason).toContain("`**Close when:**`");
		expect(reason).toContain(
			"the rule could not be read from docs/agents/rules/founder-deliverable.txt",
		);
	});
});

describe("an ending that already carries the inventory (#1786)", () => {
	const inventoried = "Done.\n\nwaits on you: nothing\nresult: done";
	const counter = (band: string) =>
		path.join(markersDir(dir), `.session-ceiling-nagged-${band}-${sid}`);

	it("ends past 100 turns without a block, writing no counter and crumbing the stand-down", () => {
		turns(PAST_TURN_BAND);
		expect(run({ message: inventoried }).blocked).toBe(false);
		expect(fs.existsSync(counter("turns"))).toBe(false);
		expect(readOutcomes()).toEqual(["inventory-stand-down"]);
	});

	it("ends past 200,000 tokens without a block, writing no counter", () => {
		transcript([PAST_WIND_UP]);
		expect(run({ message: inventoried }).blocked).toBe(false);
		expect(fs.existsSync(counter("windup"))).toBe(false);
	});

	it("holds a background job to the status-line tail the inventory guard asks of it", () => {
		turns(PAST_TURN_BAND);
		expect(run({ message: inventoried, job: true }).blocked).toBe(true);
		expect(
			run({
				message: "waits on you: nothing\nresult: done — nothing waits on you",
				job: true,
			}).blocked,
		).toBe(false);
	});

	it("is blocked while a launch of its own is still out", () => {
		turns(PAST_TURN_BAND);
		fs.appendFileSync(
			path.join(dir, `${sid}.jsonl`),
			`${JSON.stringify(
				buildBashCall("sleep 9", "toolu_a", {
					input: { description: "Run the suite", run_in_background: true },
				}),
			)}\n`,
		);
		expect(run({ message: inventoried }).blocked).toBe(true);
	});

	it.each([
		["no inventory", "result: done"],
		["a bold header", "**waits on you:** nothing\nresult: done"],
		["an item on the header line", "waits on you: #12 (send it)\nresult: done"],
		["the block below the status line", "result: done\nwaits on you: nothing"],
		["no status marker", "waits on you: nothing"],
	])("is blocked on %s", (_, message) => {
		turns(PAST_TURN_BAND);
		expect(run({ message }).blocked).toBe(true);
	});

	it("still hears the tripwire's one block", () => {
		transcript([PAST_TRIPWIRE]);
		const first = run({ message: inventoried });
		expect(first.blocked).toBe(true);
		expect(first.reason).toContain("TRIPWIRE in docs/effort-guide.md");
		expect(run({ message: inventoried }).blocked).toBe(false);
		expect(readOutcomes()).toEqual(["message", "inventory-stand-down"]);
	});
});

describe("what the reading is taken from", () => {
	it("reads the last turn rather than the peak, so a compacted session is under again", () => {
		transcript([PAST_TRIPWIRE, 15_000]);
		expect(run().blocked).toBe(false);
	});

	it("ignores a sidechain turn, a subagent's context being its own and not this session's", () => {
		transcript(
			[120_000],
			[
				{
					type: "assistant",
					isSidechain: true,
					message: { usage: { cache_read_input_tokens: 900_000 } },
				},
			],
		);
		expect(run().blocked).toBe(false);
	});

	it("survives a half-written final line", () => {
		const file = transcript([PAST_TRIPWIRE]);
		fs.appendFileSync(file, '{"type":"assistant","message":{"usa');
		expect(run().blocked).toBe(true);
	});

	it("finds the last usage record in a file too large to read whole", () => {
		const file = path.join(dir, `${sid}.jsonl`);
		const filler = `${JSON.stringify({ type: "user", pad: "x".repeat(4096) })}\n`;
		const chunk = filler.repeat(400);
		for (let i = 0; i < 11; i++) fs.appendFileSync(file, chunk);
		expect(fs.statSync(file).size).toBeGreaterThan(16 * 1024 * 1024);
		fs.appendFileSync(
			file,
			`${JSON.stringify({ type: "assistant", message: { usage: { input_tokens: PAST_TRIPWIRE } } })}\n`,
		);
		expect(run().reason).toContain(PAST_TRIPWIRE.toLocaleString("en-GB"));
	});
});

describe("every path that cannot read a figure (mantahostels#103 §6, the fail-open rule)", () => {
	it("stays out of a block loop another Stop guard opened", () => {
		transcript([PAST_TRIPWIRE]);
		expect(run({ payload: { stop_hook_active: true } }).blocked).toBe(false);
	});

	it("is silent on a transcript holding no usage record, which is not a low reading", () => {
		fs.writeFileSync(
			path.join(dir, `${sid}.jsonl`),
			`${JSON.stringify({ type: "user", message: { content: "hi" } })}\n`,
		);
		expect(run().blocked).toBe(false);
	});

	it("is silent, exit 0, on a payload that is not JSON", () => {
		const seen = run({ stdin: "not json" });
		expect(seen.blocked).toBe(false);
	});

	it("is silent on a payload carrying no session id", () => {
		expect(
			run({ stdin: JSON.stringify({ hook_event_name: "Stop" }) }).blocked,
		).toBe(false);
	});

	it("is silent where the named transcript is absent and none can be found", () => {
		transcript([PAST_TRIPWIRE]);
		expect(run({ transcript: path.join(dir, "absent.jsonl") }).blocked).toBe(
			false,
		);
	});

	it("leaves a breadcrumb on every invocation, so going blind is visible (mantahostels#872)", () => {
		transcript([PAST_TRIPWIRE]);
		run();
		run({ stdin: "not json" });
		expect(readOutcomes()).toContain("message");
		expect(readOutcomes()).toContain("no-payload");
	});
});

describe("autocompactions (#1032)", () => {
	const boundary = (uuid: string, trigger = "auto") => ({
		type: "system",
		subtype: "compact_boundary",
		uuid,
		isSidechain: false,
		compactMetadata: { trigger, preTokens: 288_000, postTokens: 28_000 },
	});
	const compactionSet = () =>
		path.join(markersDir(dir), `.session-ceiling-compactions-${sid}`);
	const setKeys = () =>
		fs.readFileSync(compactionSet(), "utf8").trim().split("\n");

	/* The model hears of a new one from inject-compaction-count.js (#1148). */
	it("counts them below every band, blocking nothing and saying nothing", () => {
		transcript([28_000], [boundary("c1"), boundary("c2")]);
		const seen = run();
		expect(seen.blocked).toBe(false);
		expect(seen.notice).toBe("");
		expect(setKeys()).toEqual(["c1", "c2"]);
	});

	it("settles the pending key the compact-time hook wrote with the boundary it stood for", () => {
		fs.writeFileSync(compactionSet(), "c1\npending:2026-10-10T00:00:00Z\n");
		transcript([28_000], [boundary("c1"), boundary("c2")]);
		run();
		expect(setKeys()).toEqual(["c1", "c2"]);
	});

	it("keeps a boundary counted after it scrolls out of the tail", () => {
		const file = transcript([28_000], [boundary("c1")]);
		run();
		const filler = `${JSON.stringify({ type: "user", pad: "x".repeat(4096) })}\n`;
		const chunk = filler.repeat(400);
		for (let i = 0; i < 11; i++) fs.appendFileSync(file, chunk);
		expect(fs.statSync(file).size).toBeGreaterThan(16 * 1024 * 1024);
		fs.appendFileSync(
			file,
			[
				boundary("c2"),
				{ type: "assistant", message: { usage: { input_tokens: 28_000 } } },
			]
				.map((r) => `${JSON.stringify(r)}\n`)
				.join(""),
		);
		run();
		expect(setKeys()).toEqual(["c1", "c2"]);
	});

	it("records a boundary on a Stop it cannot otherwise judge", () => {
		fs.writeFileSync(
			path.join(dir, `${sid}.jsonl`),
			`${JSON.stringify(boundary("c1"))}\n`,
		);
		expect(run().blocked).toBe(false);
		expect(fs.readFileSync(compactionSet(), "utf8")).toBe("c1\n");
	});

	it("never counts the same boundary twice, and says nothing new on a re-read", () => {
		transcript([28_000], [boundary("c1"), boundary("c2")]);
		run();
		const again = run();
		expect(again.notice).toBe("");
		expect(setKeys()).toEqual(["c1", "c2"]);
	});

	it("rides a band's block with the count, opening no block of its own", () => {
		turns(PAST_TURN_BAND);
		fs.appendFileSync(
			path.join(dir, `${sid}.jsonl`),
			`${JSON.stringify(boundary("c1"))}\n`,
		);
		const seen = run();
		expect(seen.reason).toContain("TURN NOTICE");
		expect(seen.reason).toContain("autocompacted 1 time.");
		expect(seen.notice).toBe("");
		expect(run({ message: "waiting: the suite" }).blocked).toBe(false);
	});

	it("counts a subagent's own boundaries without writing them into its parent's set (#1785)", () => {
		fs.writeFileSync(compactionSet(), "c1\npending:2026-10-10T00:00:00Z\n");
		const sub = path.join(dir, "subagents");
		fs.mkdirSync(sub);
		const file = path.join(sub, "agent-a1.jsonl");
		fs.writeFileSync(
			file,
			[
				{ ...boundary("s1"), isSidechain: true },
				{
					type: "assistant",
					isSidechain: true,
					message: { usage: { input_tokens: 28_000 } },
				},
			]
				.map((r) => `${JSON.stringify(r)}\n`)
				.join(""),
		);
		run({ transcript: file });
		expect(setKeys()).toEqual(["c1", "pending:2026-10-10T00:00:00Z"]);
	});

	it("leaves a manual /compact uncounted", () => {
		transcript([28_000], [boundary("m1", "manual")]);
		run();
		expect(fs.existsSync(compactionSet())).toBe(false);
	});

	it("says nothing of compaction where the session made none", () => {
		turns(PAST_TURN_BAND);
		const seen = run();
		expect(seen.reason).not.toContain("autocompacted");
		expect(seen.notice).toBe("");
		expect(fs.existsSync(compactionSet())).toBe(false);
	});
});

describe("the measured-at stamp (mantahostels#2626)", () => {
	/* The stamp is read by a hand re-measure and by nothing else, so the one way
	 * it can rot silently is the measure script being renamed out from under it. */
	it("names a re-measure command whose script is still on disk", () => {
		const source = fs.readFileSync(
			path.join(__dirname, "guard-session-ceiling.js"),
			"utf8",
		);
		const scripts = [...source.matchAll(/remeasure: node (\S+)/g)].map((m) =>
			String(m[1]),
		);
		expect(scripts.length).toBeGreaterThan(0);
		for (const script of scripts) {
			const full = path.join(__dirname, "..", script);
			expect(fs.existsSync(full) ? script : `missing: ${full}`).toBe(script);
		}
	});
});
