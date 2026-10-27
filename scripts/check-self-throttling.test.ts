// @vitest-environment node
/*
 * The dead-window detector's CLI (mantahostels#1404). `HOME` points at a fixture corpus, so
 * the machine's real transcripts are never read.
 *
 * What is pinned here is the split mantahostels#1362 ruled: the session-start path reads a
 * cached sweep and never walks the corpus.
 *
 * It runs by hand as `npm run check:throttling`, its session-start notice off
 * by default: loosen a case and a session start walks the whole transcript
 * corpus, or a rationed week goes unreported before a cut to the agent bill.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hookIsWired, registrationsOf } from "./lib/hook-wiring";

const SCRIPT = path.resolve(__dirname, "check-self-throttling.js");
const HOUR = 36e5;

let dir: string;
const home = () => path.join(dir, "home");
const state = () => path.join(dir, "state.json");
const stamp = () => path.join(dir, "refresh.stamp");
const history = () => path.join(dir, "history.jsonl");

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "throttle-cli-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * `env` overrides go last. `WFC_THROTTLE_NOTICE` is the one most tests set:
 * the session-start notice ships OFF (mantahostels#1404), so a test asserting on what the
 * notice says must turn it on.
 */
const runEnv = (env: Record<string, string> = {}) => ({
	...process.env,
	CLAUDE_PROJECT_DIR: dir,
	HOME: home(),
	// The corpus is read from the seat set, not HOME: without these the
	// run walks the real seats (#379).
	CLAUDE_CONFIG_DIR: path.join(home(), ".claude"),
	WFC_CLAUDE_CONFIG_A: "",
	WFC_CLAUDE_CONFIG_B: "",
	WFC_CLAUDE_CONFIG_C: "",
	WFC_THROTTLE_STATE: state(),
	WFC_THROTTLE_REFRESH_STAMP: stamp(),
	WFC_THROTTLE_HISTORY: history(),
	// "" neutralises an inherited leak (mantahostels#2120): noticeEnabled() only
	// recognises "1"/"0" and falls through to the built-in default for
	// anything else, unlike an unset var, which the leak is not.
	WFC_THROTTLE_NOTICE: "",
	...env,
});
const run = (args: string[], env: Record<string, string> = {}) =>
	spawnSync(process.execPath, [SCRIPT, ...args], {
		encoding: "utf8",
		env: runEnv(env),
	});

/** Up to 10 s for a detached sweep to land `file`. */
const waitForFile = async (file: string) => {
	for (let i = 0; i < 100 && !fs.existsSync(file); i++) await sleep(100);
};

/** The notice forced on, for the tests that are about what it prints. */
const LOUD = { WFC_THROTTLE_NOTICE: "1" };

const readHistoryLines = () =>
	fs
		.readFileSync(history(), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));

/**
 * A fixture corpus in `$HOME/.claude/projects/`: a fortnight of 12-hour days at
 * 60 turns an hour, with one silence of `gapHours` opening `gapAtHour` hours in.
 * `endsAgo` places the whole corpus so its last turn is that many days back.
 */
function writeCorpus({
	gapAtHour,
	gapHours,
	endsAgo = 0,
}: {
	gapAtHour: number;
	gapHours: number;
	endsAgo?: number;
}) {
	const days = 14;
	const base = Date.now() - endsAgo * 864e5 - days * 24 * HOUR;
	const lines: string[] = [];
	for (let h = 0; h < days * 24; h++) {
		if (h % 24 >= 12) continue;
		if (h >= gapAtHour && h < gapAtHour + gapHours) continue;
		for (let n = 0; n < 60; n++)
			lines.push(
				JSON.stringify({
					type: "assistant",
					timestamp: new Date(base + h * HOUR + n * 60_000).toISOString(),
					message: {
						id: `msg_${h}_${n}`,
						usage: { output_tokens: 1, cache_creation_input_tokens: 1 },
					},
				}),
			);
	}
	const project = path.join(home(), ".claude", "projects", "-a-project");
	fs.mkdirSync(project, { recursive: true });
	fs.writeFileSync(path.join(project, "s.jsonl"), `${lines.join("\n")}\n`);
}

/** A silence long and strongly flanked enough to fire, ending `endsAgo` days back. */
const throttled = (endsAgo = 0) =>
	writeCorpus({ gapAtHour: 12 * 24 + 6, gapHours: 24, endsAgo });

const readState = () => JSON.parse(fs.readFileSync(state(), "utf8"));

describe("--refresh", () => {
	it("sweeps, records the episode, and reports nothing a reader would act on", () => {
		throttled();
		const r = run(["--refresh"]);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toMatch(/SELF-THROTTLING SIGNAL/);
		expect(r.stderr).not.toMatch(/SELF-THROTTLING SIGNAL/);
		const s = readState();
		expect(s.episodes).toHaveLength(1);
		expect(s.episodes[0].hours).toBeGreaterThanOrEqual(20);
		expect(s.episodes[0].beforeRatio).toBeGreaterThanOrEqual(0.65);
		expect(s.fileCount).toBe(1);
	});

	it("is BROKEN when the sweep runs but its state file cannot be written", () => {
		/* Silence here would leave the session-start path reading a stale file
		 * for ever, with nothing anywhere saying why. */
		throttled();
		fs.mkdirSync(state(), { recursive: true });
		const r = run(["--refresh"]);
		expect(r.status).toBe(2);
		expect(`${r.stdout}${r.stderr}`).toMatch(/cached sweep/);
	});
});

describe("--notify", () => {
	it("reports a recent episode on stdout, where a SessionStart hook injects it", () => {
		throttled();
		run(["--refresh"]);
		const r = run(["--notify"], LOUD);
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/SELF-THROTTLING SIGNAL \(1\)/);
		expect(r.stdout).toMatch(/Settings -> Usage/);
		expect(r.stdout).toMatch(/REPORTS ONLY/);
	});

	it("never sweeps the corpus itself — a state file it cannot see means silence", () => {
		throttled();
		run(["--refresh"]);
		const recorded = readState();
		fs.writeFileSync(state(), JSON.stringify({ ...recorded, episodes: [] }));
		expect(run(["--notify"], LOUD).stdout).not.toMatch(/SELF-THROTTLING/);
	});

	it("goes quiet once the episode is older than the reporting window", () => {
		throttled(30);
		run(["--refresh"]);
		expect(readState().episodes).toHaveLength(1);
		expect(run(["--notify"], LOUD).stdout).not.toMatch(/SELF-THROTTLING/);
	});

	it("says nothing and kicks a sweep when there is no state file yet", async () => {
		throttled();
		const r = run(["--notify"], LOUD);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toMatch(/SELF-THROTTLING/);
		await waitForFile(state());
		expect(readState().episodes).toHaveLength(1);
	});

	it("treats a state file older than 48h as saying nothing", () => {
		throttled();
		run(["--refresh"]);
		const s = readState();
		s.sweptAt = new Date(Date.now() - 72 * HOUR).toISOString();
		fs.writeFileSync(state(), JSON.stringify(s));
		expect(run(["--notify"], LOUD).stdout).not.toMatch(/SELF-THROTTLING/);
	});

	it("prints a corrupt cache rather than dying on it", () => {
		/* `episodes()` cannot produce a null ratio, but the notify path reads a file
		 * on disk, and a session-start hook must say something rather than throw. */
		/* Clock-relative, not a fixed ISO date (mantahostels#2184): `--notify` drops any episode
		 * whose `end` is more than REPORT_WINDOW_DAYS behind the real Date.now(),
		 * and the script has no WFC_NOW seam to pin that against, unlike
		 * check-seat-utilisation.js. `29.8 * HOUR` must keep tracking the `hours`
		 * literal below. */
		const end = Date.now() - HOUR;
		fs.writeFileSync(
			state(),
			JSON.stringify({
				sweptAt: new Date().toISOString(),
				episodes: [
					{
						start: new Date(end - 29.8 * HOUR).toISOString(),
						end: new Date(end).toISOString(),
						hours: 29.8,
						beforeRatio: null,
						afterRatio: null,
						busyRate: null,
					},
				],
			}),
		);
		const r = run(["--notify"], LOUD);
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/at \? and \? of the/);
	});

	it("exits 0 even on a finding, so the harness does not judge the hook broken", () => {
		throttled();
		run(["--refresh"]);
		expect(run(["--notify"]).status).toBe(0);
	});

	it("stamps the kick BEFORE spawning, so a concurrent start can see it", () => {
		/* The state file is gitignored, so a fresh checkout has none and every
		 * session start reaches the no-state branch. A stamp written only after
		 * the 10-19s sweep returns is invisible to the ~200 starts that land
		 * meanwhile, and each spawns its own walk (mantahostels#1362). */
		throttled();
		run(["--notify"]);
		expect(fs.existsSync(stamp())).toBe(true);
	});

	it("kicks no second sweep while a stamped one is younger than a day", async () => {
		throttled();
		fs.writeFileSync(stamp(), new Date(Date.now() - 2 * HOUR).toISOString());
		const r = run(["--notify"]);
		expect(r.status).toBe(0);
		await new Promise((res) => setTimeout(res, 1500));
		expect(fs.existsSync(state())).toBe(false);
	});

	it("kicks again once the stamped sweep is over a day old", async () => {
		throttled();
		fs.writeFileSync(stamp(), new Date(Date.now() - 30 * HOUR).toISOString());
		run(["--notify"]);
		await waitForFile(state());
		expect(readState().episodes).toHaveLength(1);
	});

	it("sweeps not at all when it cannot write the stamp that throttles it", async () => {
		/* A read-only or full disk must not sweep: unthrottled is the one
		 * outcome worse than silent. */
		throttled();
		fs.mkdirSync(stamp(), { recursive: true });
		const r = run(["--notify"]);
		expect(r.status).toBe(0);
		await new Promise((res) => setTimeout(res, 1500));
		expect(fs.existsSync(state())).toBe(false);
	});

	it("kicks nothing while another start holds the kick claim (#2098)", () => {
		throttled();
		fs.writeFileSync(`${stamp()}.claim`, "");
		expect(run(["--notify"]).status).toBe(0);
		// The stamp is written before any spawn, so its absence is the proof.
		expect(fs.existsSync(stamp())).toBe(false);
	});

	it("clears a claim a killed start left behind, without taking it", () => {
		throttled();
		const claim = `${stamp()}.claim`;
		fs.writeFileSync(claim, "");
		const old = new Date(Date.now() - 60_000);
		fs.utimesSync(claim, old, old);
		run(["--notify"]);
		expect(fs.existsSync(claim)).toBe(false);
		expect(fs.existsSync(stamp())).toBe(false);
		run(["--notify"]);
		expect(fs.existsSync(stamp())).toBe(true);
	});

	it("lets exactly one of several simultaneous starts kick", async () => {
		throttled();
		// Spawned, not spawnSync: the six starts must overlap.
		const starts = Array.from(
			{ length: 6 },
			() =>
				new Promise((resolve) =>
					spawn(process.execPath, [SCRIPT, "--notify"], {
						env: runEnv(),
					}).on("exit", resolve),
				),
		);
		await Promise.all(starts);
		await waitForFile(state());
		// Real time: a second sweep, had one been kicked, lands just after the first.
		await sleep(1000);
		expect(readHistoryLines()).toHaveLength(1);
	});

	it("prints no raw null for a busy rate a corrupt cache left out", () => {
		// Clock-relative, not a fixed ISO date — see "prints a corrupt cache
		// rather than dying on it" (mantahostels#2184).
		const end = Date.now() - HOUR;
		fs.writeFileSync(
			state(),
			JSON.stringify({
				sweptAt: new Date().toISOString(),
				episodes: [
					{
						start: new Date(end - 29.8 * HOUR).toISOString(),
						end: new Date(end).toISOString(),
						hours: 29.8,
						beforeRatio: 0.82,
						afterRatio: 0.7,
						busyRate: null,
					},
				],
			}),
		);
		const out = run(["--notify"], LOUD).stdout;
		expect(out).toMatch(/SELF-THROTTLING SIGNAL/);
		expect(out).not.toMatch(/null\/h/);
		expect(out).toMatch(/\(\?\/h\)/);
	});
});

describe("one sweep per machine, not per repo root (#2098)", () => {
	/* The paths left to their defaults, as a real start has them: two repo
	 * roots under one HOME. */
	const fromRoot = (root: string, env: Record<string, string> = {}) =>
		run(["--notify"], {
			CLAUDE_PROJECT_DIR: root,
			WFC_THROTTLE_STATE: "",
			WFC_THROTTLE_REFRESH_STAMP: "",
			WFC_THROTTLE_HISTORY: "",
			...env,
		});
	const machineState = () =>
		path.join(home(), ".claude", ".self-throttling-state.json");

	it("lets a second repo root read the first's sweep and kick none of its own", async () => {
		throttled();
		const [a, b] = ["a", "b"].map((n) => {
			const root = path.join(dir, n);
			fs.mkdirSync(root);
			return root;
		});
		fromRoot(a);
		await waitForFile(machineState());
		const stampFile = `${machineState()}.refresh`;
		const kicked = fs.readFileSync(stampFile, "utf8");

		const r = fromRoot(b, LOUD);
		expect(r.stdout).toMatch(/SELF-THROTTLING/);
		expect(fs.readFileSync(stampFile, "utf8")).toBe(kicked);
		for (const root of [a, b]) {
			const markers = path.join(root, ".claude", "tmp", "markers");
			if (fs.existsSync(markers))
				expect(fs.readdirSync(markers)).not.toContainEqual(
					expect.stringMatching(/self-throttling/),
				);
		}
	});
});

describe("the session-start notice, off by default (mantahostels#1404)", () => {
	it("says nothing at a session start even with a fired episode cached", () => {
		/* The founder's ruling: nothing acts on this, no capacity has been cut,
		 * and the one episode it finds is a stop they made themselves. Collect,
		 * do not announce. */
		throttled();
		run(["--refresh"]);
		expect(readState().episodes).toHaveLength(1);
		const r = run(["--notify"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(r.stdout).not.toMatch(/SELF-THROTTLING/);
	});

	it("still sweeps on the silenced path — silencing the notice must not stop the collecting", async () => {
		/* The load-bearing half of the ruling. The readings are perishable, so a
		 * silence that also stopped the sweep would quietly throw away the only
		 * thing mantahostels#1404 was kept for. */
		throttled();
		const r = run(["--notify"]);
		expect(r.stdout).toBe("");
		await waitForFile(state());
		expect(readState().episodes).toHaveLength(1);
		expect(readHistoryLines()).toHaveLength(1);
	});

	it("answers in full when asked directly, whatever the session start does", () => {
		/* `npm run check:throttling` is a question, not an injection. */
		throttled();
		const r = run([], { WFC_THROTTLE_NOTICE: "0" });
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(/CANDIDATE GAPS/);
		expect(`${r.stdout}${r.stderr}`).toMatch(/SELF-THROTTLING SIGNAL/);
	});

	it("does not claim all-clear in --json while it is holding its tongue", () => {
		/* A suppressed episode must not read as "nothing found" to the next
		 * reader — the finding is real, only the announcement is gated. */
		throttled();
		run(["--refresh"]);
		const data = JSON.parse(run(["--notify", "--json"]).stdout);
		expect(data.episodes).toHaveLength(1);
		// `summary`, not `okLine`: the envelope carries the OK line under that name,
		// and an `okLine ?? ""` read asserts nothing at all.
		expect(data.summary).not.toMatch(/no self-throttling/);
	});
});

describe("the reading history", () => {
	it("appends one line per sweep rather than overwriting", () => {
		throttled();
		run(["--refresh"]);
		run(["--refresh"]);
		expect(readHistoryLines()).toHaveLength(2);
		expect(readHistoryLines()[0].episodes).toHaveLength(1);
	});

	it("keeps an episode after the transcripts behind it have aged out", () => {
		/* The reason the history exists: `historyFile` in lib/throttle-paths.js. */
		throttled();
		run(["--refresh"]);
		writeCorpus({ gapAtHour: 0, gapHours: 0 }); // the gap ages out of the corpus
		run(["--refresh"]);

		expect(readState().episodes).toEqual([]); // the live view has lost it
		const lines = readHistoryLines();
		expect(lines).toHaveLength(2);
		expect(lines[0].episodes).toHaveLength(1); // the history has not
		expect(lines[1].episodes).toEqual([]);
		expect(lines[0].episodes[0].hours).toBeGreaterThanOrEqual(20);
	});

	it("records the sweep's own timestamp and corpus size, not just its findings", () => {
		/* A run that found nothing is itself a reading: without it, a gap in the
		 * history cannot be told from a stretch nobody swept. */
		throttled();
		run(["--refresh"]);
		const [line] = readHistoryLines();
		expect(Date.parse(line.sweptAt)).toBeGreaterThan(0);
		expect(line.fileCount).toBe(1);
		expect(line.turnCount).toBeGreaterThan(0);
	});

	it("records the busy rate and every candidate gap, not only what fired", () => {
		/* A fire list is not a baseline. The ladder's question is "how busy was
		 * normal before the cut", so a reading has to carry the rate and the
		 * near-misses, or a no-fire day records nothing comparable at all. */
		throttled();
		run(["--refresh"]);
		const [line] = readHistoryLines();
		expect(line.busyRate).toBeGreaterThan(0);
		expect(line.candidates.length).toBeGreaterThan(line.episodes.length);
		expect(line.candidates[0]).toHaveProperty("beforeRatio");
	});

	it("still carries a busy rate on a day that fired nothing", () => {
		/* The common case, and the one a fire list loses entirely. */
		writeCorpus({ gapAtHour: 0, gapHours: 0 });
		run(["--refresh"]);
		const [line] = readHistoryLines();
		expect(line.episodes).toEqual([]);
		expect(line.busyRate).toBeGreaterThan(0);
	});

	it("names BOTH lost writes when the disk takes neither", () => {
		/* The ordinary failure — read-only or full — fails both at once. A
		 * ctx.broken per write reports only the first, and the one it swallowed
		 * was the unrepairable one. */
		throttled();
		fs.mkdirSync(state(), { recursive: true });
		fs.mkdirSync(history(), { recursive: true });
		const r = run(["--refresh"]);
		expect(r.status).toBe(2);
		const out = `${r.stdout}${r.stderr}`;
		expect(out).toMatch(/cached sweep/);
		expect(out).toMatch(/reading history/);
	});

	it("is BROKEN when the sweep runs but the history cannot be appended", () => {
		/* Louder than the state file's failure, because this is the write no
		 * later run can make good. */
		throttled();
		fs.mkdirSync(history(), { recursive: true });
		const r = run(["--refresh"]);
		expect(r.status).toBe(2);
		expect(`${r.stdout}${r.stderr}`).toMatch(/reading history/);
	});

	it("says so on the live path when the history cannot be appended", () => {
		throttled();
		fs.mkdirSync(history(), { recursive: true });
		const r = run([]);
		expect(r.status).toBe(0);
		expect(`${r.stdout}${r.stderr}`).toMatch(/could not append/);
	});
});

describe("the collector's own health", () => {
	it("reports a stalled collector on a hand run even with the notice off", () => {
		/* `--refresh` runs detached with stdio ignored, so its BROKEN reaches
		 * nobody. With the notice off this is the only place a collection that
		 * has quietly stopped can surface — read before the live sweep's own
		 * append would hide it. */
		throttled();
		run(["--refresh"]);
		const old = Date.now() - 96 * HOUR;
		fs.utimesSync(history(), old / 1000, old / 1000);
		const r = run([]);
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(/COLLECTOR STALLED/);
		expect(r.stderr).toMatch(/96h/);
		// Ends on a WARN, never OK, so `npm run status` shows it (#2038).
		expect(r.stderr.trim().split("\n").pop()).toMatch(/^WARN:/);
	});

	it("leaves a stalled collector off the session start, for npm run status (#2038)", () => {
		throttled();
		run(["--refresh"]);
		const old = Date.now() - 96 * HOUR;
		fs.utimesSync(history(), old / 1000, old / 1000);
		expect(run(["--notify"]).stdout).toBe("");
	});

	it("says nothing while the collector is keeping up", () => {
		throttled();
		run(["--refresh"]);
		expect(run(["--notify"]).stdout).toBe("");
	});

	it("does not cry stalled on a fresh checkout that has swept nothing yet", () => {
		/* No history and no stamp is "not started", not "broken". */
		throttled();
		expect(run([]).stderr).not.toMatch(/COLLECTOR STALLED/);
	});

	it("does cry stalled when a sweep was kicked days ago and never landed", () => {
		throttled();
		fs.writeFileSync(stamp(), new Date(Date.now() - 96 * HOUR).toISOString());
		expect(run([]).stderr).toMatch(/COLLECTOR STALLED/);
	});

	it("announces an ambient override rather than reversing the ruling in silence", () => {
		/* An exported WFC_THROTTLE_NOTICE would otherwise turn the notice back
		 * on at every session start with nothing saying it had. */
		throttled();
		run(["--refresh"]);
		const r = run(["--notify"], LOUD);
		expect(r.stdout).toMatch(/WFC_THROTTLE_NOTICE=1 is overriding/);
	});

	it("says nothing about an override that matches the built-in setting", () => {
		throttled();
		run(["--refresh"]);
		expect(run(["--notify"], { WFC_THROTTLE_NOTICE: "0" }).stdout).not.toMatch(
			/overriding/,
		);
	});

	it("is not itself fooled by an ambient WFC_THROTTLE_NOTICE (mantahostels#2120)", () => {
		// process.env, not `run`'s own env param: pins that the default neutralises
		// what a test never explicitly set, not only what it overrides.
		process.env.WFC_THROTTLE_NOTICE = "1";
		try {
			throttled();
			run(["--refresh"]);
			expect(run(["--notify"]).stdout).not.toMatch(/overriding/);
		} finally {
			delete process.env.WFC_THROTTLE_NOTICE;
		}
	});
});

describe("the live sweep", () => {
	it("WARNs on a corpus carrying an episode and stays green", () => {
		throttled();
		const r = run(["--json"]);
		expect(r.status).toBe(0);
		const data = JSON.parse(r.stdout);
		expect(data.episodes).toHaveLength(1);
		// Every candidate gap is reported too, so the reader sees what was rejected.
		expect(data.candidates.length).toBeGreaterThan(data.episodes.length);
	});

	it("prints every candidate gap with the test it was rejected on", () => {
		/* The live run is the answerable one: the ladder points a reader here to see
		 * what was considered, not only what fired. */
		throttled();
		const out = run([]).stderr;
		expect(out).toMatch(/CANDIDATE GAPS \(\d+\) of 10h or more/);
		// The nights either side of the fired gap are candidates that did not fire.
		expect(out.match(/^ {2}20\d\d-/gm)?.length).toBeGreaterThan(1);
	});

	it("finds nothing in a fortnight of ordinary nights", () => {
		writeCorpus({ gapAtHour: 0, gapHours: 0 });
		const data = JSON.parse(run(["--json"]).stdout);
		expect(data.episodes).toEqual([]);
	});

	it("SKIPs rather than reporting all-clear when there is no corpus at all", () => {
		fs.mkdirSync(home(), { recursive: true });
		const r = run([]);
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(/SKIP/);
		expect(r.stderr).toMatch(/no Claude Code transcripts/);
	});

	it("says so when it sweeps but cannot warm the cache the hook reads", () => {
		throttled();
		fs.mkdirSync(state(), { recursive: true });
		const r = run([]);
		expect(r.status).toBe(0);
		expect(`${r.stdout}${r.stderr}`).toMatch(/could not .*cach/i);
	});

	it("is BROKEN on a bad --days, rather than silently using the default", () => {
		throttled();
		const r = run(["--days", "-3"]);
		expect(r.status).toBe(2);
	});
});

describe("wiring", () => {
	/* A piggyback on an existing entry, never a SessionStart hook of its own,
	 * on CPU cost (mantahostels#1362, mantahostels#1130). */
	it("is reached at SessionStart through the existing detached launcher", () => {
		expect(hookIsWired("SessionStart", "sweep-debts-detached.sh", "")).toBe(
			true,
		);
		const launcher = fs.readFileSync(
			path.resolve(__dirname, "sweep-debts-detached.sh"),
			"utf8",
		);
		expect(launcher).toMatch(/check-self-throttling\.js" --notify/);
	});

	it("adds no SessionStart entry of its own", () => {
		expect(registrationsOf("SessionStart", "check-self-throttling.js")).toEqual(
			[],
		);
	});
});

/*
 * mantahostels#2857 made the episode notice a second reader of gate 2's trial declaration:
 * the chain is the environment override, then a LIVE declared window, then
 * NOTICE_ON_SESSION_START. The failure directions are asymmetric — the notice
 * on outside a trial is noise, and off during one loses a corroborating record
 * on a fortnight that cannot be re-run.
 */
describe("the trial window as an input to the notice (mantahostels#2857)", () => {
	/** A ladder declaring a window around `now`, or `null` for none. */
	const ladder = (start: string, end: string, over: string | null = null) => {
		const p = path.join(dir, "ladder.md");
		fs.writeFileSync(
			p,
			[
				"#### Gate 2 trial declaration",
				"",
				"- **seat:** `.claude3`",
				"- **account:** `acct-3`",
				over ??
					`- **start basis:** \`.claude\` resets \`${start}\` read 1.0h ago`,
				`- **measured window:** \`${start}\` → \`${end}\``,
				"- **seat 3 at declaration:** 7d 62% · resets `2030-01-01T00:00:00Z` · fetched `2020-01-01T00:00:00Z`",
				"",
				"### Next",
			].join("\n"),
		);
		return p;
	};

	const iso = (offsetDays: number) =>
		new Date(Date.now() + offsetDays * 24 * HOUR).toISOString();

	const liveLadder = () => ladder(iso(-3), iso(11));
	const expiredLadder = () => ladder(iso(-30), iso(-16));

	it("turns the notice ON while a window is live, with the constant still off", () => {
		throttled();
		run(["--refresh"]);
		const r = run(["--notify"], { WFC_LADDER: liveLadder() });
		expect(r.stdout).toMatch(/SELF-THROTTLING SIGNAL/);
	});

	it("names the host's declared capacityLadderPath in the notice, not the default (#404)", () => {
		fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, ".claude", "workflow-core.json"),
			'{"capacityLadderPath": "docs/machinery/ladder.md"}',
		);
		throttled();
		run(["--refresh"]);
		const r = run(["--notify"], { WFC_LADDER: liveLadder() });
		expect(r.stdout).toContain("see docs/machinery/ladder.md before acting");
		expect(r.stdout).not.toContain("docs/capacity-procurement-ladder.md");
	});

	it("stays off before the window opens and after it closes", () => {
		throttled();
		run(["--refresh"]);
		expect(
			run(["--notify"], { WFC_LADDER: ladder(iso(3), iso(17)) }).stdout,
		).toBe("");
		expect(run(["--notify"], { WFC_LADDER: expiredLadder() }).stdout).toBe("");
	});

	it("lets the environment override beat a live window, in both directions", () => {
		throttled();
		run(["--refresh"]);
		expect(
			run(["--notify"], { WFC_LADDER: liveLadder(), WFC_THROTTLE_NOTICE: "0" })
				.stdout,
		).not.toMatch(/SELF-THROTTLING SIGNAL/);
		expect(
			run(["--notify"], {
				WFC_LADDER: expiredLadder(),
				WFC_THROTTLE_NOTICE: "1",
			}).stdout,
		).toMatch(/SELF-THROTTLING SIGNAL/);
	});

	it("warns when an export REVERSES a live window, not just the constant, naming the export", () => {
		/* The mutation this test exists for: compare the override against
		 * NOTICE_ON_SESSION_START instead of the resolved state and this goes
		 * silent, because the constant is false and so is the override. */
		throttled();
		run(["--refresh"]);
		const r = run(["--notify"], {
			WFC_LADDER: liveLadder(),
			WFC_THROTTLE_NOTICE: "0",
		});
		expect(r.stdout).toMatch(/WFC_THROTTLE_NOTICE=0 is overriding/);
		expect(r.stdout).toMatch(/while a gate 2 trial window is live/);
	});

	it("says nothing extra about a declaration it cannot honour", () => {
		/* Silent here by ruling (mantahostels#2857 Q3): check-seat-utilisation.js prints the
		 * loud can't-honour line off the same file at the same session start. */
		throttled();
		run(["--refresh"]);
		const r = run(["--notify"], {
			WFC_LADDER: ladder(iso(-3), iso(11), "- **start basis:** rubbish"),
		});
		expect(r.stdout).toBe("");
	});

	it("names the input that decided, in the OK line and in --json", () => {
		throttled();
		run(["--refresh"]);
		const live = JSON.parse(
			run(["--notify", "--json"], { WFC_LADDER: liveLadder() }).stdout,
		);
		expect(live.notice.by).toBe("window");
		const off = JSON.parse(run(["--notify", "--json"]).stdout);
		expect(off.notice.by).toBe("constant");
		expect(off.summary).toMatch(
			/NOTICE_ON_SESSION_START is off; mantahostels#1404/,
		);
		const forced = JSON.parse(
			run(["--notify", "--json"], { WFC_THROTTLE_NOTICE: "0" }).stdout,
		);
		expect(forced.notice.by).toBe("override");
		expect(forced.summary).toMatch(/WFC_THROTTLE_NOTICE=0/);
	});
});
