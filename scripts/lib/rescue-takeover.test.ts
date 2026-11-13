// @vitest-environment node
/*
 * rescue-takeover.test.ts — lib/rescue-takeover.js's takeover, the core
 * behind `rescue-sessions.js takeover` (#621, spec #617), in-process on
 * lib/rescue-core-kit.ts's fake ports (#5157). Breaking it costs the promise
 * the takeover makes: a session is never stopped without its ticket being
 * adopted, and a ticket is never adopted from a session that is still
 * running. rescue-sessions-takeover.test.ts keeps the program's own cases.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	commitAll,
	freshSandbox,
	gitRepo,
	issueClaims,
	live,
	store,
} from "./arbiter-testkit";
import dispatchLedger from "./dispatch-ledger";
import { projectSlug } from "./project-slug.js";
import { rescueCoreKit } from "./rescue-core-kit";
import {
	EXIT,
	holderRow,
	PID,
	SESSION_LIMIT_LINE,
	SHORT,
	SID,
	said,
	WEEKLY_LIMIT_LINE,
	withTracker,
} from "./rescue-testkit";

const N = 621;

const sb = freshSandbox(withTracker);
const {
	plan,
	transcript,
	lists,
	proc,
	removeProc,
	writeTranscript,
	jobState,
	ghostJob,
	world,
	run,
} = rescueCoreKit(sb);

const snapshotDir = () =>
	path.join(sb.repo, ".claude", "tmp", "rescue", `${N}-${SHORT}`);

/* Every `gh` call and stop, in order; a comment logs who holds the claim as
 * it posts, a stop whether the snapshot was already on disk. */
let log: string[] = [];
let posted = "";
beforeEach(() => {
	log = [];
	posted = "";
});
const readLog = () => log;
const readComment = () => posted;

/**
 * A holder whose turn ended on `waiting:` with nothing running — FROZEN —
 * claiming #621, with a job record naming its intent, and a stop that the
 * oracle then reads as `stopped`.
 */
const frozenHolder = () => {
	lists([holderRow()]);
	lists([holderRow({ state: "stopped" })], plan(), true);
	writeTranscript([said("Delegated the suite.\n\nwaiting: the suite run")]);
	jobState({
		state: "working",
		intent: `/implement ${N}`,
		name: "Implement 621",
		cwd: sb.repo,
		inFlight: { tasks: 0, queued: 0 },
	});
	proc(PID, 1, 1000, "claude");
	issueClaims.claimIssue(N, { sessionId: SID });
};

const takeover = (args: string[] = ["--issue", String(N)]) => {
	const { hooks } = world();
	hooks.onGh = ({ args: [verb, sub], input }) => {
		log.push(`gh ${verb} ${sub}`);
		if (`${verb} ${sub}` !== "issue comment") return;
		const held = issueClaims
			.readIssueClaims(N)
			.map((e: { record: { sessionId: string } }) => e.record.sessionId)
			.sort();
		log.push(`claim held by ${held.join(",")}`);
		posted = input ?? "";
	};
	hooks.onStop = ({ job }) => {
		const s = fs.existsSync(path.join(snapshotDir(), "index.json"));
		log.push(`stop ${job} snapshot=${s ? "yes" : "no"}`);
	};
	return run("takeover", args);
};

const stopped = () => readLog().some((e) => e.startsWith("stop "));
const commented = () => readLog().includes("gh issue comment");
const readHolders = () =>
	issueClaims
		.readIssueClaims(N)
		.map((e: { record: { sessionId: string } }) => e.record.sessionId);

describe("takeover: a headless overflow holder (#2608)", () => {
	it("refuses by name with exit 2, sends no `claude stop` and adopts nothing", async () => {
		frozenHolder();
		lists([holderRow({ kind: "headless", id: "0123abcd" })]);
		const r = await takeover();
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("headless-sessions.js stop 0123abcd");
		expect(stopped()).toBe(false);
		expect(readHolders()).toEqual([SID]);
	});
});

describe("takeover: a step that throws (#5157)", () => {
	it("fails with exit 1 and the stack, stopping and adopting nothing", async () => {
		frozenHolder();
		world().ports.sleep = async () => {
			throw new Error("clock broke");
		};
		const r = await takeover();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			"rescue-sessions takeover: failed: Error: clock broke\n",
		);
		expect(stopped()).toBe(false);
		expect(readHolders()).toEqual([SID]);
	});
});

describe("takeover: the success path", () => {
	it("comments the stopped session, its plan, the verdict with its evidence, and the snapshot", async () => {
		frozenHolder();
		await takeover();
		const comment = readComment();
		expect(comment).toContain(SID);
		expect(comment).toContain("Implement 621");
		expect(comment).toContain(`Plan: ${plan()}`);
		expect(comment).toContain("Verdict: FROZEN");
		expect(comment).toContain("oracle: state working");
		expect(comment).toContain(`.claude/tmp/rescue/${N}-${SHORT}`);
	});

	it("prints what the successor resumes from, the file claims marked dirty or clean and left in place", async () => {
		frozenHolder();
		gitRepo(sb);
		fs.writeFileSync(path.join(sb.repo, "docs", "a.md"), "a\n");
		fs.writeFileSync(path.join(sb.repo, "docs", "b.md"), "b\n");
		commitAll(sb);
		const holder = live(sb, SID);
		expect(store.acquire("docs/a.md", holder).verdict).toBe("claimed");
		expect(store.acquire("docs/b.md", holder).verdict).toBe("claimed");
		fs.writeFileSync(path.join(sb.repo, "docs", "a.md"), "edited\n");
		const r = await takeover();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`Adopted #${N} Takeover`);
		expect(r.stdout).toContain(`Intent: /implement ${N}`);
		expect(r.stdout).toContain(
			`Narration: ${path.join(snapshotDir(), `${SHORT}.narration.txt`)}`,
		);
		expect(r.stdout).toContain("Death point:\nA: Delegated the suite.");
		expect(r.stdout).toContain("Commits landed:");
		expect(r.stdout).toContain("Artefacts survived:");
		expect(r.stdout).toContain("docs/a.md — dirty");
		expect(r.stdout).toContain("docs/b.md — clean");
		expect(store.readHeldBy(SID)?.sort()).toEqual(["docs/a.md", "docs/b.md"]);
	});

	it("sends the successor into the dead session's worktree, by cd or a relaunch --into it", async () => {
		frozenHolder();
		const wt = path.join(sb.repo, ".claude", "worktrees", "implement-621");
		fs.mkdirSync(wt, { recursive: true });
		jobState({
			state: "working",
			intent: `/implement ${N}`,
			name: "Implement 621",
			cwd: wt,
			inFlight: { tasks: 0, queued: 0 },
		});
		const r = await takeover();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`Worktree: ${wt}`);
		expect(r.stdout).toContain(
			`cd ${wt}, or relaunch there with scripts/dispatch-sessions.js --into ${wt} <model> <prompt>`,
		);
		expect(
			fs.readFileSync(path.join(snapshotDir(), "RESUMPTION.md"), "utf8"),
		).toContain(`Worktree: ${wt}`);
	});

	it("sends the successor to the main checkout by cd alone, since --into refuses it", async () => {
		frozenHolder();
		const r = await takeover();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`Worktree: ${sb.repo}`);
		expect(r.stdout).toContain(`where its edits sit: cd ${sb.repo}.`);
		expect(r.stdout).not.toContain("--into");
	});

	it("says the worktree is unrecorded, and to continue here, where its record names none", async () => {
		frozenHolder();
		jobState({
			state: "working",
			intent: `/implement ${N}`,
			cwd: "",
			inFlight: { tasks: 0, queued: 0 },
		});
		const r = await takeover();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Worktree: (not recorded");
		expect(r.stdout).toContain("continue its intent in this session.");
	});

	describe("with no job record and no cwd on its row (#4464)", () => {
		const recordless = () => {
			frozenHolder();
			fs.rmSync(path.join(plan(), "jobs", SHORT), { recursive: true });
		};

		it("names the worktree whose project slug its transcript sits under", async () => {
			recordless();
			gitRepo(sb);
			commitAll(sb);
			const wt = path.join(sb.repo, ".claude", "worktrees", "implement-621");
			execFileSync("git", ["worktree", "add", "-q", "--detach", wt], {
				cwd: sb.repo,
			});
			const slugged = path.join(plan(), "projects", projectSlug(wt));
			fs.renameSync(path.dirname(transcript()), slugged);
			const r = await takeover();
			expect(r.status).toBe(0);
			expect(r.stdout).toContain(`Worktree: ${fs.realpathSync(wt)}\n`);
			expect(r.stdout).toContain(`cd ${fs.realpathSync(wt)}, or relaunch`);
		});

		it("names the worktree its transcript's records last ran in, under the main checkout's slug", async () => {
			recordless();
			gitRepo(sb);
			commitAll(sb);
			const wt = path.join(sb.repo, ".claude", "worktrees", "implement-621");
			execFileSync("git", ["worktree", "add", "-q", "--detach", wt], {
				cwd: sb.repo,
			});
			fs.mkdirSync(path.join(wt, "sub"));
			writeTranscript([
				JSON.stringify({ type: "user", cwd: sb.repo }),
				JSON.stringify({ type: "user", cwd: path.join(wt, "sub") }),
				said("Delegated the suite.\n\nwaiting: the suite run"),
			]);
			const r = await takeover();
			expect(r.status).toBe(0);
			expect(r.stdout).toContain(`Worktree: ${fs.realpathSync(wt)}\n`);
		});

		it("marks the main checkout a guess where no listed checkout's slug matches", async () => {
			recordless();
			const r = await takeover();
			expect(r.status).toBe(0);
			expect(r.stdout).toContain(`Worktree: ${sb.repo} (a guess`);
			expect(r.stdout).toContain(
				"continue its intent in the worktree git worktree list shows it worked in.",
			);
			expect(r.stdout).not.toContain("where its edits sit");
		});
	});

	it("snapshots and stops on the plan whose records hold it, where every plan lists it (#1146)", async () => {
		frozenHolder();
		const two = plan(".claude2");
		const storeDir = sb.stateDir();
		fs.renameSync(plan(), two);
		// The holder's records move to the second plan; the arbiter store stays
		// in the first, where every plan's sessions write it (#2400).
		fs.mkdirSync(path.dirname(storeDir), { recursive: true });
		fs.renameSync(path.join(two, path.relative(plan(), storeDir)), storeDir);
		// A union oracle: both plans list the holder, and its stop.
		lists([holderRow()], two);
		lists([holderRow({ state: "stopped" })], two, true);
		lists([holderRow()]);
		world().onSeatStop(two, () => lists([holderRow({ state: "stopped" })]));
		jobState({ intent: `/implement ${N}`, cwd: sb.repo }, two);
		const r = await takeover();
		expect(r.status).toBe(0);
		expect(stopped()).toBe(true);
		const comment = readComment();
		expect(comment).toContain(`Plan: ${two}`);
		expect(
			fs.existsSync(path.join(snapshotDir(), `${SHORT}.transcript.jsonl`)),
		).toBe(true);
	});

	it.each([SESSION_LIMIT_LINE, WEEKLY_LIMIT_LINE])(
		"stops and adopts a session blocked on %s, the line kept out of its death point (#2158)",
		async (limit) => {
			frozenHolder();
			lists([holderRow({ state: "blocked" })]);
			writeTranscript([said("Now the guard tests."), said(limit)]);
			jobState({
				state: "blocked",
				detail: limit,
				intent: `/implement ${N}`,
				cwd: sb.repo,
			});
			const r = await takeover();
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
			expect(stopped()).toBe(true);
			expect(readHolders()).toContain("sandbox");
			expect(r.stdout).toContain("Death point:\nA: Now the guard tests.\n");
			const comment = readComment();
			expect(comment).toContain("Verdict: LIMITED");
		},
	);

	it("adopts an ENDED session's ticket without a stop", async () => {
		frozenHolder();
		lists([]);
		const r = await takeover();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("no stop: listed by no plan");
		expect(stopped()).toBe(false);
		expect(readHolders()).toContain("sandbox");
	});
});

describe("takeover: an ENDED holder still listed is stopped too (#623)", () => {
	/**
	 * Listed in `state`, its host running; the stop unlists it and, unless
	 * `hostSurvives`, ends the host.
	 */
	const endedListed = (state = "done", hostSurvives = false) => {
		frozenHolder();
		lists([holderRow({ state })]);
		lists([], plan(), true);
		if (!hostSurvives) world().onSeatStop(plan(), () => removeProc(PID));
	};

	for (const state of ["done", "failed", "stopped"])
		it(`stops a holder listed ${state} after the snapshot, and waits for its host to exit`, async () => {
			endedListed(state);
			const r = await takeover();
			expect(r.status).toBe(0);
			expect(readLog()).toContain(`stop ${SHORT} snapshot=yes`);
			expect(r.stdout).toContain(`stopped: ${SHORT} on`);
			expect(r.stdout).toContain("unlisted, its host exited");
			expect(r.stdout).toContain("your next write takes each");
			expect(readHolders()).toContain("sandbox");
		});

	it("warns on stderr and still adopts where claude stop fails, saying the claims stay held", async () => {
		endedListed();
		world().stopFails(plan());
		const r = await takeover();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("not stopped: exit 1: no such job");
		expect(r.stderr).toContain("the next write to each takes it");
		expect(r.stdout).toContain("held while its host runs");
		expect(readComment()).toContain("Ended session, not stopped");
		expect(readHolders()).toContain("sandbox");
	});

	it("does not confirm an unlisted holder whose host runs on past the ceiling", async () => {
		endedListed("done", true);
		const r = await takeover(["--issue", String(N), "--confirm-within", "0.3"]);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("not confirmed gone 0.3s after it");
		expect(commented()).toBe(true);
		expect(readComment()).toContain("Ended session, not stopped");
		expect(readHolders()).toContain("sandbox");
	});
});

describe("takeover: a stop that does not take leaves the claim untouched", () => {
	it("refuses on a failed claude stop, saying the snapshot is still on disk", async () => {
		frozenHolder();
		world().stopFails(plan());
		const r = await takeover();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("claude stop failed");
		expect(r.stderr).toContain("snapshot is still on disk");
		expect(readHolders()).toEqual([SID]);
		expect(commented()).toBe(false);
		expect(fs.existsSync(path.join(snapshotDir(), "index.json"))).toBe(true);
	});

	it("refuses when the oracle still lists it live at the confirmation ceiling", async () => {
		frozenHolder();
		world().keepsListingAfterStop(plan());
		const r = await takeover(["--issue", String(N), "--confirm-within", "0.3"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("as live 0.3s after the stop");
		expect(r.stderr).toContain("snapshot is still on disk");
		expect(readHolders()).toEqual([SID]);
		expect(commented()).toBe(false);
	});

	it("names the listing's refusal, not a live holder, where the stop's listing omits this session (#3525)", async () => {
		frozenHolder();
		world().listsRaw(plan(), [holderRow({ state: "stopped" })], true);
		const r = await takeover(["--issue", String(N), "--confirm-within", "0.3"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			"the listing would not read 0.3s after the stop",
		);
		expect(r.stderr).toContain("does not list this very session");
		expect(readHolders()).toEqual([SID]);
	});

	it("refuses when a third session claimed the ticket meanwhile, naming that session, taking no claim and posting no comment", async () => {
		frozenHolder();
		lists(
			[
				holderRow({ state: "stopped" }),
				{ sessionId: "third", state: "working" },
			],
			plan(),
			true,
		);
		world().onSeatStop(plan(), () =>
			issueClaims.claimIssue(N, { sessionId: "third" }),
		);
		const r = await takeover();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("held by live session third");
		expect(r.stderr).toContain("A third session took it");
		expect(readHolders()).not.toContain("sandbox");
		expect(commented()).toBe(false);
	});
});

describe("takeover: refusals before any write", () => {
	const nothingWritten = () => {
		expect(stopped()).toBe(false);
		expect(fs.existsSync(snapshotDir())).toBe(false);
		expect(readHolders()).not.toContain("sandbox");
	};

	it("refuses this session's own id, saying to check the id", async () => {
		frozenHolder();
		const r = await takeover(["--session", "sandbox"]);
		expect(r.status).toBe(EXIT.REFUSED);
		expect(r.stderr).toContain("is this session — check the id");
		nothingWritten();
	});

	it("refuses a ticket with several holders, naming the other holder", async () => {
		frozenHolder();
		issueClaims.claimIssue(N, { sessionId: "other-session" });
		const r = await takeover();
		expect(r.status).toBe(EXIT.REFUSED);
		expect(r.stderr).toContain("other-session");
		nothingWritten();
	});

	it("refuses a session holding several tickets unless --issue names one", async () => {
		frozenHolder();
		issueClaims.claimIssue(622, { sessionId: SID });
		const r = await takeover(["--session", SID]);
		expect(r.status).toBe(EXIT.REFUSED);
		expect(r.stderr).toMatch(/#621, #622|#622, #621/);
		nothingWritten();
	});

	it("refuses a closed ticket, saying to ask the founder", async () => {
		frozenHolder();
		world().close(N);
		const r = await takeover();
		expect(r.status).toBe(EXIT.REFUSED);
		expect(r.stderr).toContain("is closed");
		expect(r.stderr).toContain("Ask the founder");
		nothingWritten();
	});

	it.each([
		[
			"SLOW",
			() =>
				world().between(plan(), () => fs.appendFileSync(transcript(), "x\n")),
			"still working",
		],
		[
			"ASKING",
			() => writeTranscript([said("❓ Q1\n\nneeds input: which plan")]),
			"Answer its question",
		],
		[
			"DONE",
			() => writeTranscript([said("Shipped.\n\nresult: done")]),
			"Release its claim or close #621",
		],
		["UNKNOWN", () => removeProc(PID), "doubt never stops a session"],
	])(
		"refuses on %s with the probe's exit code and what to do next",
		async (verdict, arrange, next) => {
			frozenHolder();
			arrange();
			const r = await takeover();
			expect(r.stdout.split(/\s/)[0]).toBe(verdict);
			expect(r.status).toBe(EXIT[verdict]);
			expect(r.stderr).toContain(`not taking over: ${verdict}`);
			expect(r.stderr).toContain(next);
			nothingWritten();
		},
	);
});

describe("takeover --despite: the founder overrules SLOW or ASKING (#622)", () => {
	const slow = () =>
		world().between(plan(), () => fs.appendFileSync(transcript(), "x\n"));
	const asking = () =>
		writeTranscript([said("❓ Q1\n\nneeds input: which plan")]);

	it.each([
		["SLOW", slow],
		["ASKING", asking],
	])(
		"--despite %s stops, claims and records the overruled verdict with the reason",
		async (verdict, arrange) => {
			frozenHolder();
			arrange();
			const r = await takeover([
				"--issue",
				String(N),
				"--despite",
				verdict,
				"--reason",
				"founder: stuck for an hour",
			]);
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
			expect(r.stdout.split(/\s/)[0]).toBe(verdict);
			expect(readLog()).toContain(`stop ${SHORT} snapshot=yes`);
			expect(readHolders()).toContain("sandbox");
			const comment = readComment();
			expect(comment).toContain(`Verdict: ${verdict}`);
			expect(comment).toContain("overruled with --despite");
			expect(comment).toContain("oracle: state working");
			expect(comment).toContain(
				"Reason for overruling: founder: stuck for an hour",
			);
		},
	);

	it("still refuses a verdict other than the one --despite names", async () => {
		frozenHolder();
		asking();
		const r = await takeover([
			"--issue",
			String(N),
			"--despite",
			"SLOW",
			"--reason",
			"stuck",
		]);
		expect(r.status).toBe(EXIT.ASKING);
		expect(r.stderr).toContain("not taking over: ASKING");
		expect(r.stderr).toContain("--despite ASKING");
		expect(stopped()).toBe(false);
	});

	it.each([
		["UNKNOWN", "doubt never stops a session"],
		["DONE", "its work finished"],
		["FROZEN", "takes SLOW or ASKING"],
	])(
		"refuses --despite %s outright, before any write, saying why it cannot be overruled",
		async (verdict, why) => {
			frozenHolder();
			const r = await takeover([
				"--issue",
				String(N),
				"--despite",
				verdict,
				"--reason",
				"x",
			]);
			expect(r.status).toBe(EXIT.REFUSED);
			expect(r.stderr).toContain(why);
			expect(stopped()).toBe(false);
			expect(fs.existsSync(snapshotDir())).toBe(false);
			expect(readHolders()).not.toContain("sandbox");
		},
	);
});

/* #1989 */
describe("takeover: a GHOST is stopped and handed back for re-dispatch", () => {
	/** A sonnet ghost with no advisor, its own launch `minutes` back on the fake clock. */
	const launchedAgo = (minutes: number) => {
		ghostJob(`/implement ${N}`);
		jobState({
			state: "working",
			intent: `/implement ${N}`,
			updatedAt: new Date(world().ports.now() - 60 * 60_000).toISOString(),
			respawnFlags: ["--model", "sonnet"],
		});
		lists([], plan(), true);
		const ledgerFile = dispatchLedger.ledgerPath(sb.repo);
		fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
		fs.writeFileSync(
			ledgerFile,
			`${JSON.stringify({ ts: new Date(world().ports.now() - minutes * 60_000).toISOString(), issues: [N], model: "sonnet", prompt: `/implement ${N}` })}\n`,
		);
	};

	it("adds --force where its own launch is still inside the ledger window, and --no-advisor where it ran with none", async () => {
		launchedAgo(40);
		const r = await takeover();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			`scripts/dispatch-sessions.js --force --no-advisor sonnet '/implement ${N}'`,
		);
	});

	it("adds no --force once its own launch has left the ledger window", async () => {
		launchedAgo(120);
		const r = await takeover();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			`scripts/dispatch-sessions.js --no-advisor sonnet '/implement ${N}'`,
		);
	});

	it("fails, adopting nothing, where claude stop fails", async () => {
		ghostJob(`/implement ${N}`);
		world().stopFails(plan());
		const r = await takeover();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("claude stop failed");
		expect(r.stdout).not.toContain("dispatch-sessions.js");
		expect(readHolders()).toEqual([]);
	});
});
