// @vitest-environment node
/*
 * rescue-sessions-takeover.test.ts — `rescue-sessions.js takeover`, driven
 * through its command line (#621, spec #617). Breaking it costs the promise
 * the takeover makes: a session is never stopped without its ticket being
 * adopted, and a ticket is never adopted from a session that is still running.
 *
 * Fixtures: scripts/lib/rescue-testkit.ts. The real script is spawned in a
 * sandbox holding a real git repo and arbiter store, against the kit's fake
 * `claude` oracle, fake `gh` and fabricated `/proc`, so no live session can be
 * stopped by a test.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	commitAll,
	freshSandbox,
	gitRepo,
	issueClaims,
	live,
	store,
} from "./lib/arbiter-testkit";
import dispatchLedger from "./lib/dispatch-ledger";
import {
	EXIT,
	holderRow,
	PID,
	rescueKit,
	SESSION_LIMIT_LINE,
	SHORT,
	SID,
	said,
	WEEKLY_LIMIT_LINE,
	withTracker,
} from "./lib/rescue-testkit";

const CLAIMS_LIB = path.resolve(__dirname, "lib", "arbiter-issue-claims.js");
const N = 621;

const sb = freshSandbox(withTracker);
const {
	plan,
	procRoot,
	transcript,
	lists,
	between,
	proc,
	writeTranscript,
	jobState,
	ghostJob,
	run,
} = rescueKit(sb);

const events = () => path.join(sb.dir, "events");
const snapshotDir = () =>
	path.join(sb.repo, ".claude", "tmp", "rescue", `${N}-${SHORT}`);

/** Every `gh` call logged; a comment logs who holds the claim as it posts. */
const ghBefore = () => [
	`echo "gh $1 $2" >> '${events()}'`,
	'if [ "$1 $2" = "issue comment" ]; then',
	`  "${process.execPath}" -e 'console.log("claim held by " + require(${JSON.stringify(CLAIMS_LIB)}).readIssueClaims(${N}).map((e) => e.record.sessionId).sort().join(","))' >> '${events()}'`,
	`  cat > '${path.join(sb.dir, "comment.md")}'`,
	`  [ -f '${path.join(sb.dir, "comment-fails")}' ] && { echo "HTTP 502" >&2; exit 1; }`,
	"  exit 0",
	"fi",
];

/**
 * A holder whose turn ended on `waiting:` with nothing running — FROZEN —
 * claiming #621, with a job record naming its intent, and a stop that the
 * oracle then reads as `stopped`.
 */
const frozenHolder = () => {
	lists([holderRow()]);
	lists([holderRow({ state: "stopped" })], plan(), "agents-after-stop.json");
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

/** The stop is logged with whether the snapshot was already on disk. */
const takeover = (args: string[] = ["--issue", String(N)]) =>
	run("takeover", args, {
		ghBefore: ghBefore(),
		onStop: [
			`s=no; [ -f '${path.join(snapshotDir(), "index.json")}' ] && s=yes`,
			`echo "stop $2 snapshot=$s" >> '${events()}'`,
		],
	});

const logged = () => {
	try {
		return fs.readFileSync(events(), "utf8").split("\n").filter(Boolean);
	} catch {
		return [];
	}
};
const stopped = () => logged().some((e) => e.startsWith("stop "));
const commented = () => logged().includes("gh issue comment");
const holders = () =>
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
		expect(holders()).toEqual([SID]);
	});
});

describe("takeover: the success path", () => {
	it("snapshots, stops, confirms, claims and comments, in that order", async () => {
		frozenHolder();
		const r = await takeover();
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		const steps = r.stdout
			.split("\n")
			.map((l) => l.split(":")[0])
			.filter((s) =>
				["snapshot", "stopped", "confirmed", "claimed", "commented"].includes(
					s,
				),
			);
		expect(steps).toEqual([
			"snapshot",
			"stopped",
			"confirmed",
			"claimed",
			"commented",
		]);
		const log = logged().filter((e) => !e.startsWith("gh api"));
		expect(log).toEqual([
			`stop ${SHORT} snapshot=yes`,
			"gh issue edit",
			"gh issue comment",
			expect.stringMatching(/^claim held by .*sandbox/),
		]);
		expect(holders()).toContain("sandbox");
		for (const f of ["index.json", `${SHORT}.narration.txt`, "RESUMPTION.md"])
			expect(fs.existsSync(path.join(snapshotDir(), f))).toBe(true);
	});

	it("comments the stopped session, its plan, the verdict with its evidence, and the snapshot", async () => {
		frozenHolder();
		await takeover();
		const comment = fs.readFileSync(path.join(sb.dir, "comment.md"), "utf8");
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
		expect(store.heldBy(SID)?.sort()).toEqual(["docs/a.md", "docs/b.md"]);
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
		lists([holderRow()]);
		fs.writeFileSync(
			path.join(two, "on-stop.sh"),
			`cp '${path.join(two, "agents.json")}' '${path.join(plan(), "agents.json")}'\n`,
		);
		jobState({ intent: `/implement ${N}`, cwd: sb.repo }, two);
		const r = await takeover();
		expect(r.status).toBe(0);
		expect(stopped()).toBe(true);
		const comment = fs.readFileSync(path.join(sb.dir, "comment.md"), "utf8");
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
			expect(holders()).toContain("sandbox");
			expect(r.stdout).toContain("Death point:\nA: Now the guard tests.\n");
			const comment = fs.readFileSync(path.join(sb.dir, "comment.md"), "utf8");
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
		expect(holders()).toContain("sandbox");
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
		lists([], plan(), "agents-after-stop.json");
		if (!hostSurvives)
			fs.writeFileSync(
				path.join(plan(), "on-stop.sh"),
				`rm -rf '${path.join(procRoot(), String(PID))}'\n`,
			);
	};
	const comment = () =>
		fs.readFileSync(path.join(sb.dir, "comment.md"), "utf8");

	for (const state of ["done", "failed", "stopped"])
		it(`stops a holder listed ${state} after the snapshot, and waits for its host to exit`, async () => {
			endedListed(state);
			const r = await takeover();
			expect(r.status).toBe(0);
			expect(logged()).toContain(`stop ${SHORT} snapshot=yes`);
			expect(r.stdout).toContain(`stopped: ${SHORT} on`);
			expect(r.stdout).toContain("unlisted, its host exited");
			expect(r.stdout).toContain("your next write takes each");
			expect(holders()).toContain("sandbox");
		});

	it("warns on stderr and still adopts where claude stop fails, saying the claims stay held", async () => {
		endedListed();
		fs.writeFileSync(path.join(plan(), "stop-fails"), "");
		const r = await takeover();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("not stopped: no such job");
		expect(r.stderr).toContain("release --force");
		expect(r.stdout).toContain("held while its host runs");
		expect(comment()).toContain("Ended session, not stopped");
		expect(holders()).toContain("sandbox");
	});

	it("does not confirm an unlisted holder whose host runs on past the ceiling", async () => {
		endedListed("done", true);
		const r = await takeover(["--issue", String(N), "--confirm-within", "0.3"]);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("not confirmed gone 0.3s after it");
		expect(commented()).toBe(true);
		expect(comment()).toContain("Ended session, not stopped");
		expect(holders()).toContain("sandbox");
	});
});

describe("takeover: a stop that does not take leaves the claim untouched", () => {
	it("refuses on a failed claude stop, saying the snapshot is still on disk", async () => {
		frozenHolder();
		fs.writeFileSync(path.join(plan(), "stop-fails"), "");
		const r = await takeover();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("claude stop failed");
		expect(r.stderr).toContain("snapshot is still on disk");
		expect(holders()).toEqual([SID]);
		expect(commented()).toBe(false);
		expect(fs.existsSync(path.join(snapshotDir(), "index.json"))).toBe(true);
	});

	it("refuses when the oracle still lists it live at the confirmation ceiling", async () => {
		frozenHolder();
		fs.rmSync(path.join(plan(), "agents-after-stop.json"));
		const r = await takeover(["--issue", String(N), "--confirm-within", "0.3"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("as live 0.3s after the stop");
		expect(r.stderr).toContain("snapshot is still on disk");
		expect(holders()).toEqual([SID]);
		expect(commented()).toBe(false);
	});

	it("refuses when a third session claimed the ticket meanwhile, naming that session, taking no claim and posting no comment", async () => {
		frozenHolder();
		lists(
			[
				holderRow({ state: "stopped" }),
				{ sessionId: "third", state: "working" },
			],
			plan(),
			"agents-after-stop.json",
		);
		fs.writeFileSync(
			path.join(plan(), "on-stop.sh"),
			`"${process.execPath}" -e 'require(${JSON.stringify(CLAIMS_LIB)}).claimIssue(${N}, { sessionId: "third" })'\n`,
		);
		const r = await takeover();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("held by live session third");
		expect(r.stderr).toContain("A third session took it");
		expect(holders()).not.toContain("sandbox");
		expect(commented()).toBe(false);
	});
});

describe("takeover: refusals before any write", () => {
	const nothingWritten = () => {
		expect(stopped()).toBe(false);
		expect(fs.existsSync(snapshotDir())).toBe(false);
		expect(holders()).not.toContain("sandbox");
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
		fs.writeFileSync(path.join(sb.dir, `closed-${N}`), "");
		const r = await takeover();
		expect(r.status).toBe(EXIT.REFUSED);
		expect(r.stderr).toContain("is closed");
		expect(r.stderr).toContain("Ask the founder");
		nothingWritten();
	});

	it.each([
		[
			"SLOW",
			() => between(`printf 'x\\n' >> '${transcript()}'`),
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
		[
			"UNKNOWN",
			() => fs.rmSync(path.join(procRoot(), String(PID)), { recursive: true }),
			"doubt never stops a session",
		],
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
	const slow = () => between(`printf 'x\\n' >> '${transcript()}'`);
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
			expect(logged()).toContain(`stop ${SHORT} snapshot=yes`);
			expect(holders()).toContain("sandbox");
			const comment = fs.readFileSync(path.join(sb.dir, "comment.md"), "utf8");
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
			expect(holders()).not.toContain("sandbox");
		},
	);

	it("refuses --despite with no --reason, before any write", async () => {
		frozenHolder();
		slow();
		for (const [extra, why] of [
			[[], "--despite needs --reason"],
			/* lib/cli-args.js refuses a valueless flag before takeover runs. */
			[["--reason"], "--reason needs a value"],
			[["--reason", " "], "--despite needs --reason"],
		] as const) {
			const r = await takeover([
				"--issue",
				String(N),
				"--despite",
				"SLOW",
				...extra,
			]);
			expect(r.status).toBe(EXIT.REFUSED);
			expect(r.stderr).toContain(why);
		}
		expect(stopped()).toBe(false);
		expect(fs.existsSync(snapshotDir())).toBe(false);
	});
});

/* #1989 */
describe("takeover: a GHOST is stopped and handed back for re-dispatch", () => {
	const ghostDir = () =>
		path.join(sb.repo, ".claude", "tmp", "rescue", `${N}-${SHORT}`);

	it("keeps its record, stops it and prints the re-dispatch, adopting nothing", async () => {
		ghostJob(`/implement ${N}`);
		lists([], plan(), "agents-after-stop.json");
		const r = await takeover();
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		expect(r.stdout.split(/\s/)[0]).toBe("GHOST");
		expect(logged()).toContain(`stop ${SHORT} snapshot=no`);
		expect(r.stdout).toContain(
			`scripts/dispatch-sessions.sh opus '/implement ${N}'`,
		);
		expect(fs.existsSync(path.join(ghostDir(), `${SHORT}.state.json`))).toBe(
			true,
		);
		expect(holders()).toEqual([]);
		expect(commented()).toBe(false);
	});

	it("adds --force where its own launch is still inside the ledger window, and --no-advisor where it ran with none", async () => {
		ghostJob(`/implement ${N}`);
		jobState({
			state: "working",
			intent: `/implement ${N}`,
			updatedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
			respawnFlags: ["--model", "sonnet"],
		});
		lists([], plan(), "agents-after-stop.json");
		const ledgerFile = dispatchLedger.ledgerPath(sb.repo);
		fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
		fs.writeFileSync(
			ledgerFile,
			`${JSON.stringify({ ts: new Date(Date.now() - 40 * 60_000).toISOString(), issues: [N], model: "sonnet", prompt: `/implement ${N}` })}\n`,
		);
		const r = await takeover();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			`scripts/dispatch-sessions.sh --force --no-advisor sonnet '/implement ${N}'`,
		);
	});

	it("fails, adopting nothing, where claude stop fails", async () => {
		ghostJob(`/implement ${N}`);
		fs.writeFileSync(path.join(plan(), "stop-fails"), "");
		const r = await takeover();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("claude stop failed");
		expect(r.stdout).not.toContain("dispatch-sessions.sh");
		expect(holders()).toEqual([]);
	});
});
