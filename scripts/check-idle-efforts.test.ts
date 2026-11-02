// @vitest-environment node
/*
 * check-idle-efforts.test.ts — the idle alarm's program (#3641): that it
 * reads every adopting checkout's tracker once, each checkout's dispatch
 * ledger as the launch log, a live loop's launch stopped on its limit as held,
 * a ticket's park marker at the limit-cap parks' cap as held, loop or no loop,
 * a served checkout's probe hold as holding its tracker, and a stopped loop as
 * serving nothing, and reports through runCheck without gating.
 *
 * Its judgement is lib/idle-efforts.test.ts's; this pins the readings the
 * shell hands it, and that a resume the loop writes through
 * lib/refill-batch.js reads as a launch (#3704). `gh` is a stub injected through WFC_GH and the home
 * directory a temp one, so no real tracker or checkout is read. A break here
 * strands an effort unreported while the core's own tests stay green.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildStartEnv, writeJobRecord } from "./lib/background-start-testkit";
import { ledgerPath, record } from "./lib/dispatch-ledger.js";
import { stubGhScript } from "./lib/gh-stub";
import { readJsonl } from "./lib/jsonl.js";
import { writeParkedBy } from "./lib/parked.js";
import { launchOrResume } from "./lib/refill-batch.js";
import { buildPauseText, PROBE_HELD } from "./lib/refill-decide.js";
import { spawnLoopHolder } from "./lib/refill-loop-testkit";
import { raiseHold } from "./lib/repo-holds.js";
import { runInProcess, runInProcessAsync } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-idle-efforts.js");
const DAY = 24 * 60 * 60 * 1000;

let dir: string;
let home: string;

/* The run reads its clock from WFC_NOW, so a day stamp never crosses midnight
 * mid-test. */
const NOW = Date.parse("2026-10-30T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function checkout(name: string, tracker: string, ledger: object[] = []) {
	const root = path.join(home, name);
	fs.mkdirSync(path.join(root, ".git"), { recursive: true });
	fs.mkdirSync(path.join(root, ".claude", "tmp", "markers", ".pick-next"), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(root, ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, tracker }),
	);
	fs.writeFileSync(
		path.join(
			root,
			".claude",
			"tmp",
			"markers",
			".pick-next",
			"dispatched.jsonl",
		),
		ledger.map((r) => `${JSON.stringify(r)}\n`).join(""),
	);
}

const launch = (n: number, at: number) => ({
	ts: ago(at),
	issues: [n],
	model: "opus",
	prompt: `/implement ${n}`,
	session: null,
	jobId: `job${n}`,
});

const node = (number: number, labels = ["takes:implement"]) => ({
	number,
	title: `issue ${number}`,
	createdAt: ago(10 * DAY),
	body: "",
	labels: { nodes: labels.map((name) => ({ name })) },
	blockedBy: { totalCount: 0, nodes: [] },
	subIssues: { nodes: [] },
});

/** A stub gh answering the issues query per repo, logging each call. */
function stubGh(issues: Record<string, ReturnType<typeof node>[]>) {
	const fixture = path.join(dir, "fixture.json");
	fs.writeFileSync(fixture, JSON.stringify(issues));
	return stubGhScript(
		dir,
		`#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const field = (k) => (argv.find((a) => a.startsWith(k + "=")) || "").slice(k.length + 1);
const repo = field("owner") + "/" + field("name");
fs.appendFileSync(${JSON.stringify(path.join(dir, "calls.log"))}, repo + "\\n");
const fx = JSON.parse(fs.readFileSync(${JSON.stringify(fixture)}, "utf8"));
if (!(repo in fx)) { process.stderr.write("HTTP 404: Could not resolve to a Repository\\n"); process.exit(1); }
process.stdout.write(JSON.stringify([{ data: { repository: { issues: { pageInfo: { hasNextPage: false }, nodes: fx[repo] } } } }]));
`,
	);
}

/** The program over `issues`, whatever it exits. */
async function runProgram(
	issues: Record<string, ReturnType<typeof node>[]>,
	args: string[] = [],
	source = "startup",
) {
	const stub = stubGh(issues);
	const refill = path.join(dir, "refill");
	fs.mkdirSync(refill, { recursive: true });
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...stub.env,
		HOME: home,
		WFC_REFILL_DIR: refill,
		CLAUDE_PROJECT_DIR: dir,
		GITHUB_ACTIONS: "",
		WFC_NOW: new Date(NOW).toISOString(),
	};
	delete env.WFC_DISPATCH_ROOT;
	delete env.WFC_REPO_ROOT;
	return runInProcessAsync(SCRIPT, args, {
		cwd: dir,
		env,
		stdin: JSON.stringify({ hook_event_name: "SessionStart", source }),
	});
}

async function run(
	issues: Record<string, ReturnType<typeof node>[]>,
	args?: string[],
	source?: string,
) {
	const r = await runProgram(issues, args, source);
	/* WARN never gates, so every case through here exits 0 (§X3). A bad flag or a
	 * throw is BROKEN, exit 2: runProgram's case below. */
	expect(r.status).toBe(0);
	const log = path.join(dir, "calls.log");
	return {
		out: `${r.stdout}${r.stderr}`,
		stdout: r.stdout,
		calls: fs.existsSync(log)
			? fs.readFileSync(log, "utf8").trim().split("\n")
			: [],
	};
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-efforts-test-"));
	home = path.join(dir, "home");
	fs.mkdirSync(home);
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** The cap refill-decide.js keeps to itself, pinned here. */
const LIMIT_PARK_CAP = 2;

const STOP_LINE =
	"The refill loop is not running, so it serves no tracker. node scripts/refill-loop.js start restarts it.";

const PARKED_LABELS = ["takes:implement", "parked"];

/** `body`, run while a process holds the refill loop's pid lock in `refill`. */
const withLiveLoop = async (refill: string, body: () => Promise<void>) => {
	const holder = spawnLoopHolder(refill);
	try {
		await body();
	} finally {
		holder.kill();
	}
};

const serveCore = () => {
	checkout("core", "o/core");
	const refill = path.join(dir, "refill");
	fs.mkdirSync(refill, { recursive: true });
	fs.writeFileSync(
		path.join(refill, ".refill-loop-control.json"),
		JSON.stringify({
			scope: {
				mode: "normal",
				repos: [path.join(home, "core")],
				goals: {},
			},
			noProgressFrom: NOW,
		}),
	);
	return refill;
};

const raiseCoreHold = (refill: string, kind: "probe" | "park") => {
	vi.stubEnv("WFC_REFILL_DIR", refill);
	raiseHold(path.join(home, "core"), {
		kind,
		act: "repair the checkout",
		issue: 1,
		clearCheck: kind === "probe" ? { probe: true } : { issueClosed: 1 },
		session: null,
		now: NOW,
	});
};

const tearHoldStore = (refill: string) => {
	raiseCoreHold(refill, "park");
	const [store = ""] = fs.readdirSync(path.join(refill, "repo-holds"));
	fs.writeFileSync(path.join(refill, "repo-holds", store, "torn.json"), "{}");
};

/** A live loop's damage of each kind on the served checkout, and what its line says. */
const DAMAGE: [string, (refill: string) => void, string[]][] = [
	[
		"a hold store",
		tearHoldStore,
		["torn.json: not a hold; lift its id or remove the file"],
	],
	[
		"the control file",
		(refill) =>
			fs.writeFileSync(path.join(refill, ".refill-loop-control.json"), "{"),
		[".refill-loop-control.json is damaged (", "until a start rewrites it"],
	],
	[
		"the state file",
		(refill) =>
			fs.writeFileSync(path.join(refill, ".refill-loop-state.json"), "{"),
		[
			".refill-loop-state.json is damaged (",
			"until its next write replaces it",
		],
	],
];

const DAMAGE_SUMMARY =
	"WARN: 1 finding(s): a stopped loop, a damaged loop file, or a tracker with idle efforts or unread";

describe("check-idle-efforts.js", () => {
	it("reads a shared tracker once, its latest launch across checkouts, a held launch as running, and a stopped loop as serving nothing", async () => {
		checkout("core-a", "o/core", [launch(1, 5 * DAY)]);
		checkout("core-b", "o/core", [launch(1, DAY), launch(2, 30 * 60 * 1000)]);
		checkout("prod", "o/product");
		const r = await run({
			"o/core": [node(1), node(2), node(3)],
			"o/product": [node(8, ["takes:implement", "urgent"])],
		});
		expect(r.calls.sort()).toEqual(["o/core", "o/product"]);
		expect(r.out).toContain(STOP_LINE);
		expect(r.out).toContain(
			"o/core: 1 idle past 2 days (the refill loop does not serve it); oldest #3 (issue 3), idle 10.0 days; skip reason: none, the launch filter passes it",
		);
		expect(r.out).toContain("  urgent #8 (issue 8), idle 10.0 days");
		expect(r.out).toContain("WARN:");
	});

	it("reads a limit hold's row as no running launch, so a stopped loop's held ticket still alarms (#3785)", async () => {
		checkout("prod", "o/product", [
			{
				...launch(8, 3 * DAY),
				heldUntil: new Date(Date.now() + 5 * DAY).toISOString(),
			},
		]);
		const r = await run({ "o/product": [node(8)] }, ["--json"]);
		expect(JSON.parse(r.stdout).trackers).toEqual([
			expect.objectContaining({
				repo: "o/product",
				idle: [expect.objectContaining({ number: 8 })],
			}),
		]);
	});

	it("reads a limit hold's row as no launch, so a hold rewritten after a failed resume does not restart its age (#3838)", async () => {
		checkout("prod", "o/product", [
			launch(8, 5 * DAY),
			{
				...launch(8, DAY),
				heldUntil: new Date(NOW + 5 * DAY).toISOString(),
			},
		]);
		const r = await run({ "o/product": [node(8)] }, ["--json"]);
		expect(JSON.parse(r.stdout).trackers).toEqual([
			expect.objectContaining({
				idle: [expect.objectContaining({ number: 8, idleMs: 5 * DAY })],
			}),
		]);
	});

	it("names a live loop's launch held on its limit past 2 days, and leaves a working one and one held under 2 days out (#3838)", async () => {
		const root = path.join(home, "prod");
		checkout("prod", "o/product", [
			launch(1, 9 * DAY),
			launch(2, 9 * DAY),
			launch(3, 9 * DAY),
		]);
		const refill = path.join(dir, "refill");
		fs.mkdirSync(refill, { recursive: true });
		const buildLoopLaunch = (n: number, stoppedFor?: number) => ({
			root,
			issues: [n],
			prompt: `/implement ${n}`,
			seat: "/s1",
			jobId: `job${n}`,
			launchedAt: NOW - 9 * DAY,
			finishedAt: null,
			...(stoppedFor !== undefined && {
				limitHeld: {
					at: NOW - stoppedFor,
					sessionId: "s",
					cwd: root,
					limit: { bar: "weekly", resets: "Fri" },
				},
			}),
		});
		fs.writeFileSync(
			path.join(refill, ".refill-loop-state.json"),
			JSON.stringify({
				launches: [
					buildLoopLaunch(1, 5 * DAY),
					buildLoopLaunch(2, DAY),
					buildLoopLaunch(3),
				],
			}),
		);
		await withLiveLoop(refill, async () => {
			const r = await run({
				"o/product": [node(1), node(2), node(3)],
			});
			expect(r.out).toContain(
				"o/product: 1 idle past 2 days (the refill loop does not serve it); oldest #1 (issue 1), idle 5.0 days; skip reason: stopped on its weekly limit (reset Fri)",
			);
		});
	});

	describe("a parked ticket on its session's full seat, as the loop's state holds it (#3850)", () => {
		const seedHoldInState = () => {
			checkout("prod", "o/product", [launch(8, 4 * DAY)]);
			const refill = path.join(dir, "refill");
			fs.mkdirSync(refill, { recursive: true });
			fs.writeFileSync(
				path.join(refill, ".refill-loop-state.json"),
				JSON.stringify({
					launches: [],
					held: [
						{
							root: path.join(home, "prod"),
							number: 8,
							why: "parked: its session's seat /s2 is full",
							since: NOW - 3 * DAY,
						},
					],
				}),
			);
			return refill;
		};

		it("names it from its start with a live loop", async () => {
			await withLiveLoop(seedHoldInState(), async () => {
				const r = await run({ "o/product": [node(8, PARKED_LABELS)] });
				expect(r.out).toContain(
					"oldest #8 (issue 8), idle 3.0 days; skip reason: parked: its session's seat /s2 is full",
				);
			});
		});

		it("leaves it out with the loop stopped, naming the stop, as no seat is read", async () => {
			seedHoldInState();
			const r = await run({ "o/product": [node(8, PARKED_LABELS)] });
			expect(r.out).toContain(STOP_LINE);
			expect(r.out).toContain("o/product: none idle past 2 days");
		});
	});

	describe("a ticket held at the limit-cap parks' cap (#3840)", () => {
		const held =
			"#8 (issue 8), idle 3.0 days; skip reason: parked: 2 limit-cap";

		/** Session `s`'s real park marker for #8, written 3 days ago: a question park with no `limitParks`. */
		function parkedCheckout(limitParks?: number) {
			checkout("prod", "o/product", [launch(8, 4 * DAY)]);
			const root = path.join(home, "prod");
			writeParkedBy("s", [8], { root, limitParks });
			const when = new Date(NOW - 3 * DAY);
			const marker = path.join(root, ".claude", "tmp", "markers", ".parked-s");
			fs.utimesSync(marker, when, when);
			return marker;
		}

		it("names it with the loop stopped", async () => {
			parkedCheckout(LIMIT_PARK_CAP);
			const r = await run({ "o/product": [node(8, PARKED_LABELS)] });
			expect(r.out).toContain(STOP_LINE);
			expect(r.out).toContain(held);
		});

		it("reports a tracker whose markers will not read as unread, never as no hold", async () => {
			parkedCheckout(LIMIT_PARK_CAP);
			const markers = path.join(home, "prod", ".claude", "tmp", "markers");
			fs.chmodSync(markers, 0o300);
			try {
				const r = await run({ "o/product": [node(8, PARKED_LABELS)] });
				expect(r.out).toMatch(/o\/product: unread — EACCES.*scandir/);
			} finally {
				fs.chmodSync(markers, 0o700);
			}
		});

		it("reports a tracker with one marker that will not read as unread, never as no hold (#3893)", async () => {
			const marker = parkedCheckout(LIMIT_PARK_CAP);
			fs.chmodSync(marker, 0o000);
			try {
				const r = await run({ "o/product": [node(8, PARKED_LABELS)] });
				expect(r.out).toMatch(/o\/product: unread — EACCES.*\.parked-s/);
			} finally {
				fs.chmodSync(marker, 0o600);
			}
		});

		it("still leaves out a parked question, its marker holding no count", async () => {
			parkedCheckout();
			const r = await run({ "o/product": [node(8, PARKED_LABELS)] });
			expect(r.out).toContain("o/product: none idle past 2 days");
		});
	});

	it("emits the same findings under --json", async () => {
		checkout("prod", "o/product");
		const r = await run({ "o/product": [node(8)] }, ["--json"]);
		const json = JSON.parse(r.stdout);
		expect(json.outcome).toBe("WARN");
		expect(json.loopRunning).toBe(false);
		expect(json.trackers).toEqual([
			expect.objectContaining({
				repo: "o/product",
				served: false,
				idle: [expect.objectContaining({ number: 8, skip: null })],
			}),
		]);
	});

	it("names a tracker that will not read as unread, never as none idle, and does not gate", async () => {
		checkout("gone", "o/gone");
		const r = await run({});
		expect(r.out).toContain(
			"o/gone: unread — HTTP 404: Could not resolve to a Repository",
		);
		expect(r.out).not.toContain("none idle");
	});

	it("dates a parked issue resumed by the loop from its resume, not its first launch (#3704)", async () => {
		checkout("core", "o/core", [launch(1, 3 * DAY)]);
		const root = path.join(home, "core");
		const { launched } = launchOrResume(
			[
				{
					root,
					issues: [1],
					prompt: "/implement 1",
					model: "opus",
					seat: "/home/u/.claude2",
					reason: "soonest reset",
					parkedRoute: {
						resume: {
							seat: "/home/u/.claude2",
							sessionId: "s-1",
							cwd: root,
						},
					},
				},
			],
			{
				readActsBefore: () => ({}),
				resume: () => ({
					failed: null,
					jobId: "job1b",
					sessionId: "s-1",
					copy: false,
				}),
				admitResume: () => null,
				stagger: () => undefined,
				recordLaunch: record,
				launchFresh: () => ({ launched: [], refused: [] }),
				log: () => undefined,
				now: () => NOW - DAY,
			},
		);
		expect(readJsonl(ledgerPath(root))?.rows.at(-1)?.ts).toBe(
			new Date(launched[0].launchedAt).toISOString(),
		);
		const r = await run({ "o/core": [node(1)] });
		expect(r.out).toContain("o/core: none idle past 2 days");
	});

	describe("a served checkout's repo hold, read as the loop reads it (#3898)", () => {
		it("names a probe hold beside the oldest of a held checkout, not rank", async () => {
			const refill = serveCore();
			raiseCoreHold(refill, "probe");
			await withLiveLoop(refill, async () => {
				const r = await run({ "o/core": [node(3)] });
				expect(r.out).toContain(`skip reason: ${PROBE_HELD}`);
				expect(r.out).not.toContain("rank");
			});
		});

		const writeLastIdle = (refill: string, idle: string) =>
			fs.writeFileSync(
				path.join(refill, ".refill-loop-state.json"),
				JSON.stringify({
					launches: [],
					lastTick: { at: NOW, summary: `idle: ${idle}`, idle },
				}),
			);

		it("names a pause off its control and how to end it, not rank, ahead of the first paused tick (#3920)", async () => {
			const refill = serveCore();
			const controlPath = path.join(refill, ".refill-loop-control.json");
			const paused = { by: "founder", at: NOW };
			fs.writeFileSync(
				controlPath,
				JSON.stringify({
					...JSON.parse(fs.readFileSync(controlPath, "utf8")),
					paused,
				}),
			);
			await withLiveLoop(refill, async () => {
				const r = await run({ "o/core": [node(3)] });
				expect(r.out).toContain(buildPauseText(paused));
				expect(r.out).toContain("set --resume");
				expect(r.out).not.toContain("rank");
			});
		});

		it("names a last tick's spent seats, not rank, and rank where it only wanted a slot (#3920)", async () => {
			const refill = serveCore();
			await withLiveLoop(refill, async () => {
				writeLastIdle(refill, "every seat is spent; a resume is due");
				const spent = await run({ "o/core": [node(3)] });
				expect(spent.out).toContain("every seat is spent; a resume is due");
				expect(spent.out).not.toContain("rank");
				writeLastIdle(refill, "no free slot");
				const slot = await run({ "o/core": [node(3)] });
				expect(slot.out).toContain("so it waits on rank");
			});
		});

		const writeProbeBrokenRoots = (refill: string, roots: string[]) =>
			fs.writeFileSync(
				path.join(refill, ".refill-loop-state.json"),
				JSON.stringify({ launches: [], probeBrokenRoots: roots }),
			);

		it("names the hold where the tick's probe failed with no hold on file, and rank once it passes again (#3903)", async () => {
			const refill = serveCore();
			writeProbeBrokenRoots(refill, [path.join(home, "core")]);
			await withLiveLoop(refill, async () => {
				const failing = await run({ "o/core": [node(3)] });
				expect(failing.out).toContain(`skip reason: ${PROBE_HELD}`);
				expect(failing.out).not.toContain("rank");

				writeProbeBrokenRoots(refill, []);
				const passing = await run({ "o/core": [node(3)] });
				expect(passing.out).toContain("so it waits on rank");
			});
		});

		it("still names rank in an unheld served checkout", async () => {
			const refill = serveCore();
			await withLiveLoop(refill, async () => {
				const r = await run({ "o/core": [node(3)] });
				expect(r.out).toContain("so it waits on rank");
			});
		});

		it("still names rank under a park hold, which stops no launch", async () => {
			const refill = serveCore();
			raiseCoreHold(refill, "park");
			await withLiveLoop(refill, async () => {
				const r = await run({ "o/core": [node(3)] });
				expect(r.out).toContain("so it waits on rank");
			});
		});

		it("reports a hold store that will not read, never reading it silently as no hold", async () => {
			const refill = serveCore();
			tearHoldStore(refill);
			await withLiveLoop(refill, async () => {
				const r = await run({ "o/core": [node(3)] }, ["--json"]);
				expect(JSON.parse(r.stdout).findings).toContainEqual(
					expect.objectContaining({
						tag: "REFILL-LOOP-FILE-DAMAGED",
						message: expect.stringContaining("torn.json: not a hold"),
					}),
				);
			});
		});
	});

	it.each(DAMAGE)(
		"prints the line for damaged %s on a plain run (#3918)",
		async (_, damage, says) => {
			const refill = serveCore();
			damage(refill);
			await withLiveLoop(refill, async () => {
				const r = await run({ "o/core": [] });
				expect(r.out).toContain("Refill loop file damaged: ");
				for (const text of says) expect(r.out).toContain(text);
				expect(r.out).toContain(DAMAGE_SUMMARY);
			});
		},
	);

	it("hands the damage line to the morning review's --json reader (#3918)", async () => {
		const refill = serveCore();
		fs.writeFileSync(path.join(refill, ".refill-loop-state.json"), "{");
		await withLiveLoop(refill, async () => {
			const r = await run({ "o/core": [] }, ["--json"]);
			expect(JSON.parse(r.stdout).damaged).toEqual([
				expect.stringContaining(".refill-loop-state.json is damaged ("),
			]);
		});
	});

	describe("a tracker whose every served hold store is unread (#3918)", () => {
		it("names no rank where a file in it is torn", async () => {
			const refill = serveCore();
			tearHoldStore(refill);
			await withLiveLoop(refill, async () => {
				const r = await run({ "o/core": [node(3)] });
				expect(r.out).toContain(
					"skip reason: none, the launch filter passes it; a hold store would not read, and the loop reads that as no hold",
				);
				expect(r.out).not.toContain("rank");
			});
		});

		it("names no rank where it will not list", async () => {
			const refill = serveCore();
			raiseCoreHold(refill, "park");
			const [name = ""] = fs.readdirSync(path.join(refill, "repo-holds"));
			const store = path.join(refill, "repo-holds", name);
			fs.chmodSync(store, 0o300);
			try {
				await withLiveLoop(refill, async () => {
					const r = await run({ "o/core": [node(3)] });
					expect(r.out).toMatch(/Refill loop file damaged: .*EACCES/);
					expect(r.out).toContain(
						"repair the directory, as no hold in it reads",
					);
					expect(r.out).not.toContain("lift its id");
					expect(r.out).toContain("the loop reads that as no hold");
					expect(r.out).not.toContain("rank");
				});
			} finally {
				fs.chmodSync(store, 0o700);
			}
		});
	});

	it("is BROKEN on a bad flag, exit 2, reading no tracker", async () => {
		checkout("core", "o/core");
		const r = await runProgram({ "o/core": [node(1)] }, ["--bogus"]);
		expect(r.status).toBe(2);
		expect(r.stdout).toBe("");
		expect(r.stderr).toContain("BROKEN: unknown flag: --bogus");
		expect(r.stderr).toContain(
			"usage: node check-idle-efforts.js [--notify] [--json]",
		);
		expect(fs.existsSync(path.join(dir, "calls.log"))).toBe(false);
	});

	it("is OK where nothing is idle and the loop runs", async () => {
		checkout("core", "o/core", [launch(1, DAY)]);
		const refill = path.join(dir, "refill");
		fs.mkdirSync(refill, { recursive: true });
		await withLiveLoop(refill, async () => {
			const r = await run({ "o/core": [node(1)] });
			expect(r.out).toContain("OK: no effort idle past 2 days.");
		});
	});

	it("warns of a stopped loop on a plain run with nothing idle (#3892)", async () => {
		checkout("core", "o/core", [launch(1, DAY)]);
		const r = await run({ "o/core": [node(1)] });
		expect(r.out).toContain(STOP_LINE);
		expect(r.out).toContain("WARN: 1 finding(s)");
	});
});

describe("at session start (--notify, #3644)", () => {
	// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
	const notify: any = createRequire(__filename)("./lib/notify-report.js");
	// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
	const delivery: any = createRequire(__filename)("./lib/delivery-stamp.js");
	const savedEnv = { ...process.env };
	const oneIdle = { "o/core": [node(3)] };
	const stampPath = () => path.join(notify.base(), "idle-efforts.notified");

	/* Mirrored onto this process, so it and the run agree on where reports
	 * and delivery stamps live. */
	beforeEach(() => {
		const config = path.join(dir, "config");
		const second = path.join(dir, "second");
		process.env.CLAUDE_CONFIG_DIR = config;
		process.env.CLAUDE_PROJECT_DIR = dir;
		process.env.WFC_CLAUDE_CONFIG_A = config;
		process.env.WFC_CLAUDE_CONFIG_B = second;
		process.env.WFC_CLAUDE_CONFIG_C = second;
		process.env.WFC_NOTIFY_PERSIST = "";
		Object.assign(process.env, buildStartEnv());
		checkout("core", "o/core");
	});
	afterEach(() => {
		process.env = { ...savedEnv };
	});

	it("names a finding once a day, and again the next day, with the loop stopped", async () => {
		const first = await run(oneIdle, ["--notify"]);
		expect(first.stdout).toContain(STOP_LINE);
		expect(first.stdout).toContain("o/core: 1 idle past 2 days");

		const again = await run(oneIdle, ["--notify"]);
		expect(again.stdout).toBe("");

		const seen = JSON.parse(fs.readFileSync(stampPath(), "utf8"));
		fs.writeFileSync(
			stampPath(),
			JSON.stringify({ ...seen, day: "2000-01-01" }),
		);
		const nextDay = await run(oneIdle, ["--notify"]);
		expect(nextDay.stdout).toContain("o/core: 1 idle past 2 days");
	});

	it.each(DAMAGE)(
		"prints the line for damaged %s once a day (#3918)",
		async (_, damage, says) => {
			const refill = serveCore();
			damage(refill);
			await withLiveLoop(refill, async () => {
				const first = await run({ "o/core": [] }, ["--notify"]);
				expect(first.stdout).toContain("Refill loop file damaged: ");
				for (const text of says) expect(first.stdout).toContain(text);
				expect(first.stdout).toContain(DAMAGE_SUMMARY);

				const again = await run({ "o/core": [] }, ["--notify"]);
				expect(again.stdout).toBe("");
			});
		},
	);

	it("names a tracker again the same day once it holds a new finding", async () => {
		await run(oneIdle, ["--notify"]);
		const r = await run({ "o/core": [node(3), node(4)] }, ["--notify"]);
		expect(r.stdout).toContain("o/core: 2 idle past 2 days");
	});

	describe("a stopped loop with no unseen idle row (#3892)", () => {
		const nothingIdle = { "o/core": [] };
		const refillDir = () => {
			const refill = path.join(dir, "refill");
			fs.mkdirSync(refill, { recursive: true });
			return refill;
		};

		it("names and stamps it, then nothing that day, then again the next day", async () => {
			const first = await run(nothingIdle, ["--notify"]);
			expect(first.stdout).toContain(STOP_LINE);
			expect(first.stdout).toContain("WARN: 1 finding(s)");
			expect(fs.existsSync(stampPath())).toBe(true);

			expect((await run(nothingIdle, ["--notify"])).stdout).toBe("");

			const { seen } = JSON.parse(delivery.readStamp("idle-efforts"));
			delivery.recordDelivery(
				"idle-efforts",
				JSON.stringify({ day: "2000-01-01", seen }),
			);
			expect((await run(nothingIdle, ["--notify"])).stdout).toContain(
				STOP_LINE,
			);
		});

		it("names it once the day's rows have been shown, and only once", async () => {
			await withLiveLoop(refillDir(), async () => {
				await run(oneIdle, ["--notify"]);
			});
			const stopped = await run(oneIdle, ["--notify"]);
			expect(stopped.stdout).toContain(STOP_LINE);
			expect(stopped.stdout).not.toContain("o/core: 1 idle");
			expect((await run(oneIdle, ["--notify"])).stdout).toBe("");
		});

		it("names a loop that died with no stop written: dead pid, running state", async () => {
			const refill = refillDir();
			const dead = spawnSync(process.execPath, ["-e", ""]);
			fs.writeFileSync(path.join(refill, ".refill-loop.pid"), String(dead.pid));
			fs.writeFileSync(
				path.join(refill, ".refill-loop-state.json"),
				JSON.stringify({ launches: [], held: [] }),
			);
			expect((await run(nothingIdle, ["--notify"])).stdout).toContain(
				STOP_LINE,
			);
		});

		it("names a later run's stop the same day, its control's start having moved", async () => {
			const refill = refillDir();
			const control = (from: number) =>
				fs.writeFileSync(
					path.join(refill, ".refill-loop-control.json"),
					JSON.stringify({
						scope: { mode: "normal", repos: [] },
						noProgressFrom: from,
					}),
				);
			control(NOW - DAY);
			await run(nothingIdle, ["--notify"]);
			expect((await run(nothingIdle, ["--notify"])).stdout).toBe("");
			control(NOW);
			expect((await run(nothingIdle, ["--notify"])).stdout).toContain(
				STOP_LINE,
			);
		});

		it("leaves a stopped loop's damaged control to check-refill-loop-stop.js, keying its stop on the last tick's run (#3927)", async () => {
			const refill = refillDir();
			fs.writeFileSync(path.join(refill, ".refill-loop-control.json"), "{");
			const tickAt = (from: number) =>
				fs.writeFileSync(
					path.join(refill, ".refill-loop-state.json"),
					JSON.stringify({ launchCount: { from, count: 0 } }),
				);
			tickAt(NOW - DAY);
			const first = await run(nothingIdle, ["--notify"]);
			expect(first.stdout).toContain(STOP_LINE);
			expect(first.stdout).not.toContain("Refill loop file damaged");
			expect((await run(nothingIdle, ["--notify"])).stdout).toBe("");
			tickAt(NOW);
			expect((await run(nothingIdle, ["--notify"])).stdout).toContain(
				STOP_LINE,
			);
		});

		it("prints nothing for a live loop", async () => {
			await withLiveLoop(refillDir(), async () => {
				const r = await run(nothingIdle, ["--notify"]);
				expect(r.stdout).toBe("");
				expect(fs.existsSync(stampPath())).toBe(false);
			});
		});

		it("names it at a background job's start but stamps nothing, leaving it for the founder's", async () => {
			Object.assign(process.env, buildStartEnv(path.join(dir, "job")));
			expect((await run(nothingIdle, ["--notify"])).stdout).toContain(
				STOP_LINE,
			);
			expect(fs.existsSync(stampPath())).toBe(false);

			Object.assign(process.env, buildStartEnv());
			expect((await run(nothingIdle, ["--notify"])).stdout).toContain(
				STOP_LINE,
			);
			expect(fs.existsSync(stampPath())).toBe(true);
		});

		it("neither prints nor stamps on a compaction", async () => {
			const r = await run(nothingIdle, ["--notify"], "compact");
			expect(r.stdout).toBe("");
			expect(fs.existsSync(stampPath())).toBe(false);
		});

		it("prints it again through the real reader the next day, its text unchanged", async () => {
			process.env.WFC_NOTIFY_PERSIST = "1";
			const replay = () => {
				const r = runInProcess(
					path.join(__dirname, "replay-notify-reports.js"),
					["--notify"],
					{
						cwd: dir,
						env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: dir },
						stdin: JSON.stringify({
							hook_event_name: "SessionStart",
							source: "startup",
						}),
					},
				);
				expect(r.status).toBe(0);
				return r.stdout;
			};
			await run(nothingIdle, ["--notify"]);
			expect(replay()).toContain(STOP_LINE);
			await run(nothingIdle, ["--notify"]);
			expect(replay()).not.toContain(STOP_LINE);

			const { seen } = JSON.parse(delivery.readStamp("idle-efforts"));
			delivery.recordDelivery(
				"idle-efforts",
				JSON.stringify({ day: "2000-01-01", seen }),
			);
			await run(nothingIdle, ["--notify"]);
			expect(replay()).toContain(STOP_LINE);
		});

		it("reaches the persisted report for the reader to stamp", async () => {
			process.env.WFC_NOTIFY_PERSIST = "1";
			await run(nothingIdle, ["--notify"]);
			const shown = notify.readReport("idle-efforts");
			expect(shown.outcome).toBe("WARN");
			expect(shown.text).toContain(STOP_LINE);
			delivery.recordDelivery("idle-efforts", shown.stamp);
			await run(nothingIdle, ["--notify"]);
			expect(notify.readReport("idle-efforts").text).toBe("");
		});
	});

	it("neither reads, prints nor stamps on a compaction", async () => {
		const r = await run(oneIdle, ["--notify"], "compact");
		expect(r.stdout).toBe("");
		expect(r.calls).toEqual([]);
		expect(fs.existsSync(stampPath())).toBe(false);
		expect((await run(oneIdle, ["--notify"])).stdout).toContain(
			"o/core: 1 idle",
		);
	});

	it("names every finding on a plain run, and stamps nothing", async () => {
		await run(oneIdle, ["--notify"]);
		const r = await run(oneIdle);
		expect(r.out).toContain("o/core: 1 idle past 2 days");
		fs.rmSync(stampPath());
		await run(oneIdle);
		expect(fs.existsSync(stampPath())).toBe(false);
	});

	it("names an unseen finding at a background job's start but stamps nothing, leaving it for the founder's start (#3725)", async () => {
		Object.assign(process.env, buildStartEnv(path.join(dir, "job")));
		const job = await run(oneIdle, ["--notify"]);
		expect(job.stdout).toContain("o/core: 1 idle past 2 days");
		expect(fs.existsSync(stampPath())).toBe(false);

		Object.assign(process.env, buildStartEnv());
		expect((await run(oneIdle, ["--notify"])).stdout).toContain(
			"o/core: 1 idle past 2 days",
		);
		expect(fs.existsSync(stampPath())).toBe(true);
	});

	it("names and stamps a finding at a job he launched from the agents view (#3772)", async () => {
		const job = writeJobRecord(path.join(dir, "his"), "claude");
		Object.assign(process.env, buildStartEnv(job));
		const { stdout } = await run(oneIdle, ["--notify"]);
		Object.assign(process.env, buildStartEnv());
		expect(stdout).toContain("o/core: 1 idle past 2 days");
		expect(fs.existsSync(stampPath())).toBe(true);
	});

	it("stamps nothing at a resume of his own job, which the loop may have woken, and stamps at its start (#3841)", async () => {
		Object.assign(
			process.env,
			buildStartEnv(writeJobRecord(path.join(dir, "his"), "claude")),
		);
		const resume = await run(oneIdle, ["--notify"], "resume");
		expect(resume.stdout).toContain("o/core: 1 idle past 2 days");
		expect(fs.existsSync(stampPath())).toBe(false);

		const start = await run(oneIdle, ["--notify"], "startup");
		expect(start.stdout).toContain("o/core: 1 idle past 2 days");
		expect(fs.existsSync(stampPath())).toBe(true);
	});

	describe("under persist mode", () => {
		beforeEach(() => {
			process.env.WFC_NOTIFY_PERSIST = "1";
		});

		it("carries the signature for the reader, and reports again until the reader stamps it", async () => {
			await run(oneIdle, ["--notify"]);
			expect(fs.existsSync(stampPath())).toBe(false);
			const first = notify.readReport("idle-efforts");
			expect(first.text).toContain("o/core: 1 idle past 2 days");

			expect(first.maxAgeMs).toBe(7 * 24 * 60 * 60 * 1000);

			await run(oneIdle, ["--notify"]);
			const unshown = notify.readReport("idle-efforts");
			expect(unshown.text).toContain("o/core: 1 idle past 2 days");

			delivery.recordDelivery("idle-efforts", unshown.stamp);
			await run(oneIdle, ["--notify"]);
			expect(notify.readReport("idle-efforts").text).toBe("");
		});

		it("carries a damaged file's line for the reader, and names it again until the reader stamps it (#3918)", async () => {
			const refill = serveCore();
			tearHoldStore(refill);
			await withLiveLoop(refill, async () => {
				await run({ "o/core": [] }, ["--notify"]);
				const first = notify.readReport("idle-efforts");
				expect(first.text).toContain("Refill loop file damaged: ");

				await run({ "o/core": [] }, ["--notify"]);
				const unshown = notify.readReport("idle-efforts");
				expect(unshown.text).toContain("Refill loop file damaged: ");

				delivery.recordDelivery("idle-efforts", unshown.stamp);
				await run({ "o/core": [] }, ["--notify"]);
				expect(notify.readReport("idle-efforts").text).toBe("");
			});
		});

		it("leaves a report not yet shown in place on a compaction", async () => {
			await run(oneIdle, ["--notify"]);
			await run(oneIdle, ["--notify"], "compact");
			expect(notify.readReport("idle-efforts").text).toContain(
				"o/core: 1 idle past 2 days",
			);
		});
	});
});
