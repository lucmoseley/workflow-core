// @vitest-environment node
/*
 * The refill loop's launch step (#2315): the dispatcher call each batch makes
 * and the records read back from the dispatch ledger after it. The batch
 * cases run a fake dispatcher, a bash script in a temporary directory that
 * writes real ledger lines; the rest touch no disk but the read of
 * dispatch-sessions.sh that pins the member lines a refusal keys on.
 *
 * The resume cases (#3621) drive launchOrResume with the resume and the
 * dispatcher call injected; the adoption cases (#4180), adoptLaunching with
 * the ledger and the job store's answer injected.
 *
 * Loosen one and a loop launch can run outside its repo's gates or on the
 * wrong seat, a batch's launches go unrecorded or mis-stamped, a stale ledger
 * entry pass for a launch, a member it never reached be dropped from the
 * gate queue, or a parked ticket lose its conversation to a fresh launch.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRecentEntries } from "./dispatch-ledger.js";
import {
	adoptLaunching,
	batchesOf,
	dispatchCall,
	launchBatch,
	launchOrResume,
} from "./refill-batch.js";

type LoopLaunch = import("./refill-loop.js").LoopLaunch;

const { readStaggerMs } = require("./refill-batch.js");

describe("readStaggerMs (#3855)", () => {
	const read = (value?: string) =>
		readStaggerMs({ WFC_DISPATCH_STAGGER_SECONDS: value });

	it("holds the dispatcher's default", () => {
		const shell = fs.readFileSync(
			path.join(__dirname, "..", "dispatch-sessions.sh"),
			"utf8",
		);
		const [, seconds] =
			shell.match(
				/STAGGER_SECONDS="\$\{WFC_DISPATCH_STAGGER_SECONDS:-(\d+)\}"/,
			) ?? [];
		expect(read()).toBe(Number(seconds) * 1000);
	});

	it("reads the override, 0 included, and an empty or unreadable one as the default", () => {
		expect(read("5")).toBe(5000);
		expect(read("0")).toBe(0);
		expect(read("")).toBe(read());
		expect(read("soon")).toBe(read());
	});
});

const MIN = 60 * 1000;
const NOW = Date.parse("2026-10-18T12:00:00Z");

const launch = {
	root: "/home/u/design-vault",
	issues: [42],
	prompt: "/implement 42",
	model: "opus" as const,
	seat: "/home/u/.claude3",
	reason: "soonest reset" as const,
};

const entry = (prompt: string, ts: number, jobId: string) => ({
	ts: new Date(ts).toISOString(),
	issues: [],
	model: "opus",
	prompt,
	session: null,
	jobId,
});

/** launchBatch's io with no spawn, the ledger seeded with `entries`, at NOW. */
const seededIo = (
	entries: ReturnType<typeof entry>[],
): Parameters<typeof launchBatch>[1] => ({
	dispatcher: "dispatch.sh",
	env: {},
	run: () => ({ failed: null, out: "" }),
	entriesOf: () => entries,
	now: () => NOW,
});

describe("an overflow member's launch record (#4147)", () => {
	it("keeps its key, the one mark of its seat on a dir a plan seat shares", () => {
		const r = launchBatch(
			[{ ...launch, keyVar: "K2", reason: "overflow" as const }],
			seededIo([entry(launch.prompt, NOW, "j1")]),
		);
		expect(r.launched[0]).toMatchObject({ jobId: "j1", keyVar: "K2" });
	});
});

describe("the dispatcher call for one batch", () => {
	const env = {
		PATH: "/usr/bin",
		CLAUDE_CODE_SESSION_ID: "the-starting-session",
		WFC_DISPATCH_ROOT: "/elsewhere",
		CLAUDE_PROJECT_DIR: "/home/u/workflow-core",
		CLAUDE_CONFIG_DIR: "/home/u/.claude2",
	};
	const call = dispatchCall(
		[launch, { ...launch, issues: [43], prompt: "/triage 43" }],
		"/core/scripts/dispatch-sessions.sh",
		env,
	);

	it("runs the dispatcher with each member's model and prompt, in pick order, as its only arguments", () => {
		expect(call.file).toBe("bash");
		expect(call.args).toEqual([
			"/core/scripts/dispatch-sessions.sh",
			"opus",
			"/implement 42",
			"opus",
			"/triage 43",
		]);
	});

	it("runs in the target repo's checkout, as its host root", () => {
		expect(call.cwd).toBe("/home/u/design-vault");
		expect(call.env.CLAUDE_PROJECT_DIR).toBe("/home/u/design-vault");
		expect(call.env.WFC_REPO_ROOT).toBe("/home/u/design-vault");
		expect(call.env.WFC_DISPATCH_ROOT).toBeUndefined();
	});

	it("launches on the picked seat, as no session, naming why for its ledger (#3732)", () => {
		expect(call.env.CLAUDE_CONFIG_DIR).toBe("/home/u/.claude3");
		expect(call.env.WFC_SEAT_REASON).toBe("soonest reset");
		expect(call.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
		expect(call.env.PATH).toBe("/usr/bin");
	});
});

describe("a refused member's reason (#2500)", () => {
	/* Each member line as dispatch-sessions.sh prints it for `prompt`. */
	const printed = (format: RegExp, prompt: string) => {
		const sh = fs.readFileSync(
			path.join(__dirname, "..", "dispatch-sessions.sh"),
			"utf8",
		);
		const lines = [...sh.matchAll(format)].map((m) =>
			String(m[1]).replace("%s", prompt),
		);
		expect(lines).not.toEqual([]);
		return lines;
	};
	const reasonFor = (out: string) =>
		launchBatch([launch], {
			...seededIo([]),
			run: () => ({ failed: null, out }),
		}).refused.map((f) => f.reason);

	it("keys on the REFUSED member line dispatch-sessions.sh prints", () => {
		for (const line of printed(
			/printf '(REFUSED: %s — [^']*)\\n'/g,
			launch.prompt,
		))
			expect(reasonFor(`${line}\n  slots              0 — HOLD`)).toEqual([
				"slots 0 — HOLD",
			]);
	});

	it("keys on the dropped member line dispatch-sessions.sh prints", () => {
		for (const line of printed(/printf '( {2}dropped: %s)\\n'/g, launch.prompt))
			expect(reasonFor(`DROPPING 1 issue(s)\n${line}`)).toEqual([
				"DROPPING 1 issue(s)",
			]);
	});
});

describe("one dispatcher call per repo (#2315)", () => {
	/*
	 * A fake dispatcher: per member, in argument order, the word at its place
	 * in FAKE_PLAN says what it does. `launch` writes the member's ledger entry
	 * as dispatch-sessions.sh does, `refuse` skips it as an admission refusal,
	 * printing the re-read under its REFUSED line, `drop` as a duplicate drop,
	 * `die` exits 5 there (a launch timeout, interop wedge or kernel stall),
	 * and `timeout` as a launch timeout, printing its REFUSED line.
	 */
	const fakeDispatcher = `#!/usr/bin/env bash
shift_plan() { plan="\${plan#*,}"; }
plan="$FAKE_PLAN,"
printf '%s\\n' "$*" >> "$FAKE_CALLS"
ledger=.claude/tmp/markers/.pick-next/dispatched.jsonl
mkdir -p "$(dirname "$ledger")"
n=0
while [[ $# -gt 0 ]]; do
  model=$1 prompt=$2; shift 2; n=$((n + 1))
  step="\${plan%%,*}"; shift_plan
  case $step in
    die) exit 5 ;;
    timeout)
      printf '\\n  REFUSED: \`claude\` did not return within 120s. Killed, and NOT recorded as\\n' >&2
      exit 5 ;;
    refuse)
      printf 'REFUSED: %s — not launching this member.\\n' "$prompt" >&2
      printf '  live sessions      6 alongside this one\\n' >&2
      printf '  slots              0 — HOLD: 1840 MB available\\n' >&2
      printf '  Re-read immediately before this spawn (mantahostels#2553).\\n' >&2
      continue ;;
    drop)
      printf 'DROPPING 1 issue(s) in this set are already dispatched or claimed:\\n' >&2
      printf '  #%s — already running\\n' "$n" >&2
      printf 'FAIL: 1 already-dispatched issue(s)\\n' >&2
      printf '  dropped: %s\\n' "$prompt" >&2
      continue ;;
  esac
  printf '{"ts":"%s","issues":[],"model":"%s","prompt":"%s","session":null,"jobId":"job%s"}\\n' \\
    "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" "$model" "$prompt" "$n" >> "$ledger"
  sleep 0.05
done
`;
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "refill-batch-"));
		fs.writeFileSync(path.join(dir, "dispatch.sh"), fakeDispatcher, {
			mode: 0o755,
		});
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	const pick = (repo: string, n: number, onSeat = "/s") => ({
		root: path.join(dir, repo),
		issues: [n],
		prompt: `/implement ${n}`,
		model: "opus" as const,
		seat: onSeat,
		reason: "soonest reset" as const,
	});

	/** One tick's `launches`, batched and launched, each repo's plan its FAKE_PLAN. */
	function settle(
		launches: ReturnType<typeof pick>[],
		plans: Record<string, string>,
	) {
		for (const l of launches) fs.mkdirSync(l.root, { recursive: true });
		const timeouts: number[] = [];
		const seats: (string | undefined)[] = [];
		const tried: string[] = [];
		const refused: [string, string][] = [];
		const launched: LoopLaunch[] = [];
		const io: Parameters<typeof launchBatch>[1] = {
			dispatcher: path.join(dir, "dispatch.sh"),
			env: process.env,
			run: (call) => {
				timeouts.push(call.timeout);
				seats.push(call.env.CLAUDE_CONFIG_DIR);
				const ran = spawnSync(call.file, call.args, {
					cwd: call.cwd,
					encoding: "utf8",
					env: {
						...call.env,
						FAKE_PLAN: plans[path.basename(call.cwd)] ?? "",
						FAKE_CALLS: path.join(dir, "calls"),
					},
					timeout: call.timeout,
				});
				return {
					failed: ran.status === 0 ? null : `exit ${ran.status}`,
					out: `${ran.stdout}${ran.stderr}`.trim(),
				};
			},
			entriesOf: (root) => readRecentEntries(root, 1).entries,
			now: Date.now,
		};
		for (const batch of batchesOf(launches)) {
			const r = launchBatch(batch, io);
			launched.push(...r.launched);
			tried.push(...r.tried.map((l) => l.prompt));
			refused.push(
				...r.refused.map((f): [string, string] => [f.launch.prompt, f.reason]),
			);
		}
		const calls = fs
			.readFileSync(path.join(dir, "calls"), "utf8")
			.trim()
			.split("\n");
		return { calls, timeouts, seats, tried, refused, launched };
	}

	it("makes one call per repo, its members in pick order", () => {
		const r = settle([pick("a", 1), pick("b", 2), pick("a", 3), pick("a", 4)], {
			a: "launch,launch,launch",
			b: "launch",
		});
		expect(r.calls).toEqual([
			"opus /implement 1 opus /implement 3 opus /implement 4",
			"opus /implement 2",
		]);
		expect(r.launched.map((l) => [l.prompt, l.jobId])).toEqual([
			["/implement 1", "job1"],
			["/implement 3", "job2"],
			["/implement 4", "job3"],
			["/implement 2", "job1"],
		]);
	});

	it("stamps each member with its own ledger entry's time, not the call's start", () => {
		const r = settle([pick("a", 1), pick("a", 2)], { a: "launch,launch" });
		const ledger = readRecentEntries(path.join(dir, "a"), 1).entries;
		expect(r.launched.map((l) => l.launchedAt)).toEqual(
			ledger.map((e) => Date.parse(e.ts)),
		);
	});

	it("records every member launched before a non-zero exit", () => {
		const r = settle([pick("a", 1), pick("a", 2), pick("a", 3)], {
			a: "launch,die",
		});
		expect(r.launched.map((l) => l.prompt)).toEqual(["/implement 1"]);
	});

	it("counts only the launched members as tried after a non-zero exit", () => {
		const failed = settle([pick("a", 1), pick("a", 2), pick("a", 3)], {
			a: "launch,die",
		});
		expect(failed.tried).toEqual(["/implement 1"]);
		const passed = settle([pick("b", 4), pick("b", 5)], { b: "launch,refuse" });
		expect(passed.tried).toEqual(["/implement 4", "/implement 5"]);
	});

	it("splits one repo's picks on two seats into a call per seat", () => {
		const r = settle([pick("a", 1, "/s1"), pick("a", 2, "/s2")], {
			a: "launch",
		});
		expect(r.calls).toEqual(["opus /implement 1", "opus /implement 2"]);
		expect(r.seats).toEqual(["/s1", "/s2"]);
	});

	it("times the call out at 10 minutes plus 150 s per member", () => {
		const r = settle([pick("a", 1), pick("a", 2), pick("b", 3)], {
			a: "launch,launch",
			b: "launch",
		});
		expect(r.timeouts).toEqual([10 * MIN + 2 * 150_000, 10 * MIN + 150_000]);
	});

	it("skips a refused member and launches the rest of the batch", () => {
		const r = settle([pick("a", 1), pick("a", 2), pick("a", 3)], {
			a: "launch,refuse,launch",
		});
		expect(r.launched.map((l) => l.prompt)).toEqual([
			"/implement 1",
			"/implement 3",
		]);
	});

	it("gives each member it launched nothing for the dispatcher's reason line (#2500)", () => {
		const r = settle(
			[pick("a", 1), pick("a", 2), pick("a", 3), pick("b", 4), pick("b", 5)],
			{ a: "refuse,drop,launch", b: "launch,die" },
		);
		expect(r.refused).toEqual([
			["/implement 1", "slots 0 — HOLD: 1840 MB available"],
			[
				"/implement 2",
				"DROPPING 1 issue(s) in this set are already dispatched or claimed:",
			],
			["/implement 5", "dispatcher exit 5"],
		]);
	});

	it("never gives a member another member's admission refusal after a failed call", () => {
		const died = settle([pick("a", 1), pick("a", 2)], { a: "refuse,die" });
		expect(died.refused.map(([, why]) => why)).toEqual([
			"slots 0 — HOLD: 1840 MB available",
			"dispatcher exit 5",
		]);
		const timedOut = settle([pick("b", 3), pick("b", 4)], {
			b: "refuse,timeout",
		});
		expect(timedOut.refused[1]).toEqual([
			"/implement 4",
			"REFUSED: `claude` did not return within 120s. Killed, and NOT recorded as",
		]);
	});
});

describe("launchBatch's records", () => {
	it("carries a gate judgement's flag into its record and sets none on a ranking launch (#3092)", () => {
		const member = (n: number, prompt: string, over = {}) => ({
			root: "/home/u/wfc",
			issues: [n],
			prompt,
			model: "opus" as const,
			seat: "~/.claude3",
			reason: "soonest reset" as const,
			...over,
		});
		const batch = [
			member(2906, "/triage 2906 — judge", { gate: true as const }),
			member(7, "/implement 7"),
		];
		const r = launchBatch(
			batch,
			seededIo(batch.map((l, i) => entry(l.prompt, NOW, `job${i}`))),
		);
		expect(r.launched.map((l) => l.gate)).toEqual([true, undefined]);
		expect(r.launched[1]).not.toHaveProperty("gate");
	});

	it("takes a ledger entry as a launch only from the injected clock's reading on", () => {
		const member = { ...launch, root: "/home/u/wfc", prompt: "/implement 7" };
		const at = (ts: number) =>
			launchBatch([member], seededIo([entry(member.prompt, ts, "job0")]));
		expect(at(NOW - 1000).launched.map((l) => l.launchedAt)).toEqual([
			NOW - 1000,
		]);
		const stale = at(NOW - 1001);
		expect(stale.launched).toEqual([]);
		expect(stale.refused.map((f) => f.reason)).toEqual([
			"no ledger entry written for it",
		]);
	});
});

describe("a parked member resumed in place or launched afresh (#3621)", () => {
	type Io = Parameters<typeof launchOrResume>[1];
	type Launch = Parameters<typeof launchOrResume>[0][number];
	const target = {
		seat: "/home/u/.claude2",
		sessionId: "s-1",
		cwd: "/home/u/design-vault",
	};
	const member = (n: number, over: Partial<Launch> = {}): Launch => ({
		...launch,
		issues: [n],
		prompt: `/implement ${n}`,
		...over,
	});
	function run(
		batch: Launch[],
		resume: Io["resume"],
		written = true,
		admit: Io["admitResume"] = () => null,
	) {
		const lines: string[] = [];
		const fresh: Launch[][] = [];
		const resumed: unknown[] = [];
		const recorded: unknown[] = [];
		const staggers: number[] = [];
		const actsReadAfter: number[] = [];
		const out = launchOrResume(batch, {
			readActsBefore: () => {
				actsReadAfter.push(resumed.length);
				return { file: 1 };
			},
			admitResume: admit,
			stagger: () => staggers.push(resumed.length),
			resume: (l, t) => {
				resumed.push(t);
				return resume(l, t);
			},
			recordLaunch: (e) => {
				recorded.push(e);
				return written;
			},
			launchFresh: (b) => {
				fresh.push(b);
				return {
					launched: b.map((l) => ({
						...l,
						jobId: "fresh",
						launchedAt: NOW,
						finishedAt: null,
					})),
					refused: [],
				};
			},
			log: (line) => lines.push(line),
			now: () => NOW,
		});
		return { out, lines, fresh, resumed, recorded, staggers, actsReadAfter };
	}
	const ok: Io["resume"] = () => ({
		failed: null,
		jobId: "j-9",
		sessionId: "s-2",
		copy: false,
	});

	it("notes the acts read before the resume, and on a copy the session it resumed (#3942, #4101)", () => {
		const parked = member(1, { parkedRoute: { resume: target } });
		const woken = run([parked], ok);
		expect(woken.actsReadAfter).toEqual([0]);
		expect(woken.out.launched[0].actsBefore).toEqual({ file: 1 });
		const copied = run([parked], () => ({
			failed: null,
			jobId: "j-9",
			sessionId: "s-copy",
			copy: true,
		}));
		expect(woken.out.launched[0]).not.toHaveProperty("pastSessionIds");
		expect(copied.out.launched[0]).toMatchObject({
			actsBefore: { file: 1 },
			pastSessionIds: [target.sessionId],
		});
	});

	it("resumes a member routed to its parker on the parker's seat, the rest through one dispatcher call", () => {
		const parked = member(1, { parkedRoute: { resume: target } });
		const { out, lines, fresh, resumed } = run([parked, member(2)], ok);
		expect(resumed).toEqual([target]);
		expect(fresh).toEqual([[member(2)]]);
		expect(out.launched[0]).toEqual({
			root: launch.root,
			issues: [1],
			prompt: "/implement 1",
			seat: "/home/u/.claude2",
			reason: "parked session's seat",
			jobId: "j-9",
			launchedAt: NOW,
			finishedAt: null,
			sessionId: "s-2",
			actsBefore: { file: 1 },
		});
		expect(out.launched.map((l) => l.jobId)).toEqual(["j-9", "fresh"]);
		expect(lines).toEqual([
			"resumed parked design-vault /implement 1 as job j-9",
		]);
	});

	it("refuses a resume the re-read refuses and all behind it, resuming and dispatching nothing past it (#3872)", () => {
		const parked = (n: number) =>
			member(n, { parkedRoute: { resume: target } });
		let reads = 0;
		const { out, fresh, resumed, staggers } = run(
			[parked(1), parked(2), member(3)],
			ok,
			true,
			() => (reads++ === 0 ? null : "no free slot"),
		);
		expect(reads).toBe(2);
		expect(resumed).toHaveLength(1);
		expect(staggers).toEqual([1]);
		expect(fresh).toEqual([]);
		expect(out.refused).toEqual([
			{ launch: parked(2), reason: "no free slot" },
			{ launch: member(3), reason: "no free slot" },
		]);
	});

	it("asks no re-read for a member routed afresh, which the dispatcher re-reads itself (#3872)", () => {
		const afresh = member(1, { parkedRoute: { afresh: "no marker" } });
		const { out, fresh } = run([afresh], ok, true, () => {
			throw new Error("re-read asked");
		});
		expect(fresh).toEqual([[afresh]]);
		expect(out.refused).toEqual([]);
	});

	it("writes each resume to the dispatch ledger as a launch of its issues, and logs a write that failed (#3704)", () => {
		const parked = member(1, { parkedRoute: { resume: target } });
		const { recorded } = run([parked, member(2)], ok);
		expect(recorded).toEqual([
			{
				issues: [1],
				model: "opus",
				prompt: "/implement 1",
				root: launch.root,
				jobId: "j-9",
				launchedAt: NOW,
			},
		]);
		const { out, lines } = run([parked], ok, false);
		expect(out.launched.map((l) => l.jobId)).toEqual(["j-9"]);
		expect(lines).toContain(
			"resume of design-vault /implement 1 not written to the dispatch ledger: the idle alarm dates it from its last launch",
		);
	});

	it("makes no dispatcher call where every member resumed, and records no session a copy left unread", () => {
		const parked = member(1, { parkedRoute: { resume: target } });
		const { out, fresh } = run([parked], () => ({
			failed: null,
			jobId: "j-9",
			sessionId: null,
			copy: true,
		}));
		expect(fresh).toEqual([]);
		expect(out.refused).toEqual([]);
		expect(out.launched[0]).not.toHaveProperty("sessionId");
	});

	it("carries a parked member's limit-cap parks on to a fresh launch's record (#3804)", () => {
		const parked = {
			...launch,
			parkedRoute: {
				afresh: "its session's marker names no job",
				limitParks: 1,
			},
		};
		const { launched } = launchBatch(
			[parked],
			seededIo([entry(launch.prompt, NOW, "j-1")]),
		);
		expect(launched[0]).toMatchObject({ limitParks: 1 });
	});

	it("carries a parked member's limit-cap parks on to its resume's record (#3804)", () => {
		const parked = member(1, {
			parkedRoute: { resume: target, limitParks: 1 },
		});
		const { out } = run([parked], ok);
		expect(out.launched[0]).toMatchObject({ jobId: "j-9", limitParks: 1 });
	});

	it("marks a resume parked on an API error or a limit, and no other, as having nothing to repeat (#3949)", () => {
		const resumedOn = (parkCause: string | undefined) =>
			run(
				[
					member(1, {
						parkedRoute: {
							resume: { ...target, ...(parkCause ? { parkCause } : {}) },
						},
					}),
				],
				ok,
			).out.launched[0];
		for (const cause of ["API_ERROR", "LIMIT"])
			expect(resumedOn(cause)).toMatchObject({ nothingToRepeat: true });
		for (const cause of ["PERMISSION", "QUESTION", undefined])
			expect(resumedOn(cause)).not.toHaveProperty("nothingToRepeat");
	});

	it("launches afresh, logged with why, a member routed afresh or whose resume failed", () => {
		const routed = member(1, {
			parkedRoute: { afresh: "its session s-1's marker names no job" },
		});
		const failing = member(2, { parkedRoute: { resume: target } });
		const { out, lines, fresh, resumed } = run([routed, failing], () => ({
			failed: "exit 1",
		}));
		expect(resumed).toEqual([target]);
		expect(fresh).toEqual([[routed, failing]]);
		expect(out.launched.map((l) => l.jobId)).toEqual(["fresh", "fresh"]);
		expect(lines).toEqual([
			"parked design-vault /implement 1 not resumed: its session s-1's marker names no job; launching afresh",
			"parked design-vault /implement 2 not resumed: exit 1; launching afresh",
		]);
	});
});

describe("the members of a batch a kill cut off (#4180)", () => {
	type Io = Parameters<typeof adoptLaunching>[1];
	type Launch = Parameters<typeof adoptLaunching>[0]["batch"][number];
	const target = {
		seat: "/home/u/.claude2",
		sessionId: "s-1",
		cwd: "/home/u/design-vault",
	};
	const member = (n: number, over: Partial<Launch> = {}): Launch => ({
		...launch,
		issues: [n],
		prompt: `/implement ${n}`,
		...over,
	});
	const parked = member(1, { parkedRoute: { resume: target } });
	function adopt(
		batch: Launch[],
		{
			entries = [] as ReturnType<typeof entry>[],
			found = null as ReturnType<Io["adoptResumed"]>,
		} = {},
	) {
		const lines: string[] = [];
		const recorded: unknown[] = [];
		const looked: unknown[] = [];
		const launched = adoptLaunching(
			{ at: NOW, batch },
			{
				entriesOf: () => entries,
				sessionOf: () => undefined,
				readActsBefore: () => ({ file: 1 }),
				recordLaunch: (e) => {
					recorded.push(e);
					return true;
				},
				adoptResumed: (_l, t, since) => {
					looked.push([t, since]);
					return found;
				},
				log: (line) => lines.push(line),
			},
		);
		return { launched, lines, recorded, looked };
	}

	it("tracks a member the ledger shows launched since, stamped with its entry, and drops one it does not", () => {
		const { launched, looked } = adopt([member(2), member(3)], {
			entries: [
				entry("/implement 2", NOW + 5000, "j2"),
				entry("/implement 3", NOW - 10 * MIN, "old"),
			],
		});
		expect(launched).toEqual([
			{
				root: launch.root,
				issues: [2],
				prompt: "/implement 2",
				seat: launch.seat,
				reason: launch.reason,
				jobId: "j2",
				launchedAt: NOW + 5000,
				finishedAt: null,
			},
		]);
		expect(looked).toEqual([]);
	});

	it("tracks a parked member's resume the job store shows, writing the ledger row the kill beat", () => {
		const { launched, recorded, looked } = adopt([parked], {
			found: { failed: null, jobId: "c-1", sessionId: "s-c", copy: true },
		});
		expect(looked).toEqual([[target, NOW]]);
		expect(launched).toEqual([
			{
				root: launch.root,
				issues: [1],
				prompt: "/implement 1",
				seat: target.seat,
				reason: "parked session's seat",
				jobId: "c-1",
				launchedAt: NOW,
				finishedAt: null,
				sessionId: "s-c",
				pastSessionIds: ["s-1"],
				actsBefore: { file: 1 },
			},
		]);
		expect(recorded).toEqual([
			expect.objectContaining({ jobId: "c-1", prompt: "/implement 1" }),
		]);
	});

	it("writes no second ledger row for a parked resume the ledger already holds", () => {
		const { launched, recorded } = adopt([parked], {
			entries: [entry("/implement 1", NOW + 3000, "j-9")],
			found: { failed: null, jobId: "j-9", sessionId: "s-1", copy: false },
		});
		expect(recorded).toEqual([]);
		expect(launched[0]).toMatchObject({ jobId: "j-9", launchedAt: NOW + 3000 });
	});

	it("looks in the ledger for a parked member whose resume started nothing, as it then launched afresh", () => {
		const { launched } = adopt([parked], {
			entries: [entry("/implement 1", NOW + 4000, "fresh")],
		});
		expect(launched[0]).toMatchObject({ jobId: "fresh", seat: launch.seat });
	});

	it("says where the job store will not tell, and reads the ledger alone", () => {
		const { launched, lines } = adopt([parked], {
			found: { unread: "EACCES" },
		});
		expect(launched).toEqual([]);
		expect(lines).toEqual([
			"whether parked design-vault /implement 1's resume started a job is unread: EACCES",
		]);
	});
});
