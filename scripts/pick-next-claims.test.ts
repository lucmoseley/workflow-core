// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { IDLE_PAIR_MB } from "./lib/admission.js";
import {
	writeAdopterCheckout,
	writeIssueClaim,
} from "./lib/claim-store-testkit";
import {
	FIXTURE_DRAW,
	type Issue,
	installPickNextHarness,
	kit,
	kitHome,
	roots,
	run,
	sessionProcs,
	stubBrokenRepo,
	stubRepo,
	WORKING_PAIR_KB,
	writeJobState,
} from "./lib/pick-next-testkit";
import { writeSmapsRollup } from "./lib/proc-fake";
import { runInProcess } from "./lib/run-in-process";

const selectionMarker = require("./lib/selection-marker.js");

installPickNextHarness();

describe("admission", () => {
	it("reports the measured headroom and the live session count", async () => {
		kit.oracleSessions = ["self", "a@601", "b@602"];
		kit.procPssKb = { "601": WORKING_PAIR_KB, "602": WORKING_PAIR_KB };
		kit.psOut = [...sessionProcs("a"), ...sessionProcs("b")].join("\n");
		kit.memAvailableKb = 3072 * 1024;
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).toMatch(/available memory\s+3072 MB/);
		expect(r.out).toMatch(/live sessions\s+2 alongside this one \(4 claude/);
		expect(r.out).toMatch(
			new RegExp(
				`session draw\\s+mean ${FIXTURE_DRAW.sessionMeanMb} MB, σ ${FIXTURE_DRAW.sessionSigmaMb} MB`,
			),
		);
		expect(r.out).toMatch(
			/live draw\s+2 live session\(s\): mean 858 MB \+ 1\.645 × σ 218 MB − 1280 MB they already hold/,
		);
		expect(r.out).toMatch(/free slots\s+3/);
		expect(r.out).toMatch(/START ONE NOW/);
	});

	it("holds every slot at the load ceiling, naming the load (#834)", async () => {
		kit.oracleSessions = ["self", "a"];
		kit.psOut = sessionProcs("a").join("\n");
		kit.load1 = 60;
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).toMatch(/cpu load\s+load1 60 is at or above the 48 ceiling/);
		expect(r.out).toMatch(/free slots\s+0/);
		expect(r.out).toMatch(/HOLD — load1 60 is at or above the 48 ceiling/);
		expect(r.out).toMatch(/held to 0 on CPU load/);
	});

	it("holds every slot at the session ceiling, naming it (#2141)", async () => {
		kit.oracleSessions = ["self", "a"];
		kit.psOut = "900 1000 claude bg-pty-host --session a";
		kit.sessionCeiling = "1";
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).toMatch(
			/cpu sessions\s+1 session\(s\) running on the machine against the 1-session CPU ceiling \(#2141\), so 0 slot\(s\) — dispatch refuses/,
		);
		expect(r.out).toMatch(/free slots\s+0/);
		expect(r.out).toMatch(/HOLD — 1 session\(s\) running on the machine/);
	});

	it("leaves the count unknown when the oracle will not answer, never falling back to the scan", async () => {
		kit.oracleFails = true;
		kit.psOut = [...sessionProcs("a"), ...sessionProcs("b")].join("\n");
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/live sessions\s+unknown/);
		expect(r.out).toMatch(/4 claude processes/);
		expect(r.out).not.toMatch(/live sessions\s+2/);
		expect(r.out).toMatch(
			/live draw\s+unknown — the session listing was refused/,
		);
	});

	it("reflects a live failure on the second read rather than the first read's cached success (mantahostels#1946, mantahostels#1960, mantahostels#1983)", async () => {
		kit.oracleSessions = ["self"];
		const first = await run({ issues: [{ number: 1 }] }, [], {
			oracleCache: true,
		});
		expect(first.out).toMatch(/live sessions\s+0 alongside this one/);

		kit.oracleFails = true;
		const second = await run({ issues: [{ number: 1 }] }, [], {
			oracleCache: true,
		});
		expect(second.out).toMatch(/live sessions\s+unknown/);
		expect(second.out).not.toMatch(/live sessions\s+0 alongside this one/);
	});

	it("holds when the headroom is under one slot and sessions are live", async () => {
		kit.oracleSessions = ["self", "a@601"];
		kit.procPssKb = { "601": WORKING_PAIR_KB };
		kit.psOut = sessionProcs("a").join("\n");
		kit.memAvailableKb = 400 * 1024;
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).toMatch(/free slots\s+0/);
		expect(r.out).toMatch(
			/HOLD — -800 MB available after reserving 106 MB for the spare pool, holding 794 \+ 300 MB above earlyoom's kill line, under the 577 MB the live sessions' draw and one more need at p95/,
		);
		expect(r.out).not.toMatch(/START ONE NOW/);
		expect(r.status).toBe(0);
		expect(r.order()).toEqual([1]);
	});

	it("says so and still admits when the headroom cannot be read", async () => {
		kit.memAvailableKb = null;
		kit.oracleSessions = ["self", "a"];
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/available memory\s+unknown/);
		expect(r.out).toMatch(/START ONE NOW — headroom unmeasured/);
	});

	it("says why the process count is missing when `ps` fails, and still counts sessions", async () => {
		kit.psFails = true;
		kit.oracleSessions = ["self", "a"];
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/live sessions\s+1 alongside this one/);
		expect(r.out).toMatch(/process count unavailable: .+/);
		expect(r.out).not.toMatch(/claude processes/);
	});

	it("names the finished-but-resident pool, and the run that frees it now", async () => {
		kit.oracleSessions = ["self", "a", "b"];
		kit.oracleFinished = ["a", "b"];
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).toMatch(/reclaimable\s+2 finished sessions still resident/);
		expect(r.out).toMatch(/`node scripts\/reap-finished-sessions\.js` stops/);
		expect(r.out).not.toMatch(/--dry-run/);
		expect(r.out).toMatch(/reports the MB returned/);
	});

	it("says session, not sessions, for a pool of one", async () => {
		kit.oracleSessions = ["self", "a"];
		kit.oracleFinished = ["a"];
		expect((await run({ issues: [{ number: 1 }] })).out).toMatch(
			/reclaimable\s+1 finished session still resident/,
		);
	});

	it("prints no reclaimable row when nothing has finished", async () => {
		kit.oracleSessions = ["self", "a"];
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).not.toMatch(/reclaimable/);
	});

	it("prints the reclaimable row as unknown when this run has no session id", async () => {
		kit.oracleSessions = ["self", "a"];
		kit.oracleFinished = ["a"];
		kit.oracleSelfId = "";
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).toMatch(
			/reclaimable\s+unknown \(CLAUDE_CODE_SESSION_ID[^)]*\) — some of the memory counted spent above may already be free/,
		);
		const j = (await run({ issues: [{ number: 1 }] }, ["--json"])).json();
		expect(j.admission.reclaimable).toBeNull();
		expect(j.admission.reclaimableError).toMatch(/CLAUDE_CODE_SESSION_ID/);
	});

	it("carries the count into --json, and the refusal where the oracle will not answer", async () => {
		kit.oracleSessions = ["self", "a"];
		kit.oracleFinished = ["a"];
		expect(
			(await run({ issues: [{ number: 1 }] }, ["--json"])).json().admission
				.reclaimable,
		).toBe(1);

		kit.oracleFails = true;
		const j = (await run({ issues: [{ number: 1 }] }, ["--json"])).json();
		expect(j.admission.reclaimable).toBeNull();
		expect(typeof j.admission.reclaimableError).toBe("string");
	});

	it("carries the admission decision into --json", async () => {
		kit.oracleSessions = ["self", "a@601", "b@602"];
		kit.procPssKb = { "601": WORKING_PAIR_KB, "602": WORKING_PAIR_KB };
		kit.psOut = [...sessionProcs("a"), ...sessionProcs("b")].join("\n");
		kit.memAvailableKb = 3072 * 1024;
		const j = (await run({ issues: [{ number: 1 }] }, ["--json"])).json();
		expect(j.admission).toEqual({
			availableMb: 3072,
			availableUnknown: null,
			sessions: 2,
			claudeProcesses: 4,
			claudeProcessesUnknown: null,
			sessionsUnknown: null,
			...FIXTURE_DRAW,
			reclaimable: 0,
			reclaimableError: null,
			reservedMb: IDLE_PAIR_MB,
			reservedError: null,
			budgetMb: 1872,
			drawNeedMb: -63,
			freeSlots: 3,
			admit: true,
			reason: expect.stringContaining("3 free slot"),
		});
	});

	describe("the memory breakdown (#590)", () => {
		const fixture = JSON.parse(
			fs.readFileSync(
				path.join(__dirname, "fixtures", "admission-pre-589.json"),
				"utf8",
			),
		).admit as {
			meminfo: string;
			agents: Array<{ sessionId: string; pid: number; state: string }>;
			ps: string[];
			pss: Record<string, number>;
		};
		const selfSessionId = "self-session-id";

		const machine = (pss = fixture.pss) => {
			kit.meminfoText = fixture.meminfo;
			kit.procCwds = { "112": "/tmp/x/spare" };
			kit.psOut = fixture.ps.join("\n");
			kit.oracleSelfId = selfSessionId;
			kit.oracleSessions = fixture.agents.map((a) => `${a.sessionId}@${a.pid}`);
			kit.oracleFinished = fixture.agents
				.filter((a) => a.state === "done")
				.map((a) => a.sessionId);
			for (const [pid, kb] of Object.entries(pss))
				writeSmapsRollup(path.join(kit.dir, "proc"), pid, kb);
		};
		const breakdownOf = (out: string, indent = "") =>
			(out.match(/^ *memory {13}of [\s\S]*?slot arithmetic .*$/m)?.[0] ?? "")
				.split("\n")
				.map((l) => l.replace(indent, ""));
		const row = (rows: string[], label: string) =>
			rows.find((l) => l.startsWith(`  ${label} `));

		it("prints admission.js's rows, figure for figure", async () => {
			machine();
			const picked = await run({ issues: [{ number: 1 }] });

			const host = path.join(kit.dir, "host");
			fs.mkdirSync(path.join(host, ".claude"), { recursive: true });
			fs.writeFileSync(
				path.join(host, ".claude", "workflow-core.json"),
				JSON.stringify(FIXTURE_DRAW),
			);
			const reap = path.join(kit.dir, "fake-reap.js");
			fs.writeFileSync(
				reap,
				`process.stdout.write(${JSON.stringify(JSON.stringify({ reaped: [{ pss: 0 }], kept: [] }))});\n`,
			);
			const admitted = runInProcess(
				path.resolve(__dirname, "admission.js"),
				["--skip-allowance"],
				{
					cwd: host,
					env: {
						PATH: process.env.PATH,
						HOME: kit.dir,
						WFC_MEMINFO: path.join(kit.dir, "meminfo"),
						WFC_PS: path.join(kit.dir, "ps"),
						WFC_PROC: path.join(kit.dir, "proc"),
						WFC_LOADAVG: path.join(kit.dir, "loadavg"),
						WFC_LOAD_CEILING: "48",
						WFC_SESSION_CEILING: kit.sessionCeiling,
						TMPDIR: kit.dir,
						WFC_CLAUDE_BIN: path.join(kit.dir, "claude"),
						WFC_REAP_SCRIPT: reap,
						CLAUDE_CODE_SESSION_ID: selfSessionId,
						CLAUDE_PROJECT_DIR: host,
						CLAUDE_CONFIG_DIR: path.join(kit.dir, "no-such-config"),
					},
				},
			);

			const ours = breakdownOf(picked.out, "  ");
			const theirs = breakdownOf(admitted.stdout);
			expect(row(ours, "finished")).toMatch(/, 1 taken by the next reap$/);
			expect(row(ours, "slot arithmetic")).toMatch(
				/ = \d+ MB; the live sessions' draw needs \d+ MB of it, and with \d+ more \d+ MB, so \d+ slot\(s\)$/,
			);
			expect(ours).toEqual(theirs);
		});

		it("carries the same rows in --json, as admission.js's memory object", async () => {
			machine();
			const m = (await run({ issues: [{ number: 1 }] }, ["--json"])).json()
				.memory;
			expect(m.totalMb).toBe(10_000);
			expect(m.live).toEqual({ count: 2, mb: 957, unknown: null });
			expect(m.finished).toMatchObject({ count: 1, mb: 410, reapable: 1 });
		});
	});

	it("reads the machine without touching the tracker", async () => {
		const r = await run({ issues: [{ number: 1 }] });
		for (const call of r.calls())
			expect(call).not.toMatch(/(^|\s)(-X|--method)(\s|$)/);
	});
});

describe("owed work (mantahostels#1206)", () => {
	it("reports the stranded-claim count, never as a filter or sort input", async () => {
		kit.oracleSessions = ["self"];
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			staleFiles: {
				a: { path: "scripts/a.js", sessionId: "dead-1", hoursAgo: 24 },
			},
		});
		expect(r.out).toMatch(/stranded claims\s+1/);
		expect(r.order()).toEqual([1, 2]);
	});

	it("does not count a claim held by a listed session as stranded", async () => {
		kit.oracleSessions = ["self", "live"];
		const r = await run({
			issues: [{ number: 1 }],
			staleFiles: {
				a: { path: "scripts/a.js", sessionId: "live", hoursAgo: 24 },
			},
		});
		expect(r.out).toMatch(/stranded claims\s+0/);
	});

	it("counts a claim held by a listed-but-finished session, past the threshold", async () => {
		kit.oracleSessions = ["self", "done-1"];
		kit.oracleFinished = ["done-1"];
		const r = await run({
			issues: [{ number: 1 }],
			staleFiles: {
				a: { path: "scripts/a.js", sessionId: "done-1", hoursAgo: 24 },
			},
		});
		expect(r.out).toMatch(/stranded claims\s+1/);
	});

	it("prints unknown for stranded claims, as for live sessions, when this run's own session is not listed", async () => {
		kit.oracleSessions = ["other"];
		const r = await run({
			issues: [{ number: 1 }],
			staleFiles: {
				a: { path: "scripts/a.js", sessionId: "dead-1", hoursAgo: 24 },
			},
		});
		expect(r.out).toMatch(/stranded claims\s+unknown/);
		expect(r.out).toMatch(/live sessions\s+unknown/);
	});

	it("carries the same counts in --json under owedWork", async () => {
		kit.oracleSessions = ["self"];
		const r = await run(
			{
				issues: [{ number: 1 }],
				staleFiles: {
					a: { path: "scripts/a.js", sessionId: "dead-1", hoursAgo: 24 },
				},
			},
			["--json"],
		);
		const j = r.json();
		expect(j.owedWork).toEqual({
			strandedClaims: 1,
			strandedClaimsUnknown: null,
			strandedClaimsCarrying: 0,
			strandedClaimsCarryingUnknown: null,
			strandedWorktrees: 0,
		});
	});

	it("says in --json that git would not name the dirty files, rather than zero", async () => {
		kit.oracleSessions = ["self"];
		stubBrokenRepo();
		const r = await run(
			{
				issues: [{ number: 1 }],
				staleFiles: {
					a: { path: "scripts/a.js", sessionId: "dead-1", hoursAgo: 24 },
				},
			},
			["--json"],
		);
		const j = r.json();
		expect(j.owedWork.strandedClaims).toBe(1);
		expect(j.owedWork.strandedClaimsCarrying).toBeNull();
		expect(j.owedWork.strandedClaimsCarryingUnknown).toMatch(
			/would not report/,
		);
		expect(j.owedWork.strandedClaimsUnknown).toBeNull();
	});

	it("blames the oracle, not git, when the stranded count itself is unknown", async () => {
		kit.oracleFails = true;
		const j = (await run({ issues: [{ number: 1 }] }, ["--json"])).json();
		expect(j.owedWork.strandedClaims).toBeNull();
		expect(j.owedWork.strandedClaimsUnknown).toMatch(/oracle/);
		expect(j.owedWork.strandedClaimsCarryingUnknown).toBeNull();
	});

	it("names how many stranded claims carry uncommitted work", async () => {
		kit.oracleSessions = ["self"];
		stubRepo(["scripts/dirty.js"]);
		const r = await run({
			issues: [{ number: 1 }],
			staleFiles: {
				a: { path: "scripts/dirty.js", sessionId: "dead-1", hoursAgo: 24 },
				b: { path: "scripts/absent.js", sessionId: "dead-2", hoursAgo: 24 },
			},
		});
		expect(r.out).toMatch(/stranded claims\s+2, 1 carrying uncommitted work/);
	});

	it("says how many carry uncommitted work is unknown when git will not answer", async () => {
		kit.oracleSessions = ["self"];
		stubBrokenRepo();
		const r = await run({
			issues: [{ number: 1 }],
			staleFiles: {
				a: { path: "scripts/a.js", sessionId: "dead-1", hoursAgo: 24 },
			},
		});
		expect(r.out).toMatch(/stranded claims\s+1, unknown how many carrying/);
	});

	it("renders the counts with the worktree count unknown where a job store will not read", async () => {
		kit.oracleSessions = ["self"];
		const repo = kit.repoRoot as string;
		const git = (...args: string[]) =>
			spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
				cwd: repo,
			});
		git("commit", "-q", "--allow-empty", "-m", "base");
		const wt = path.join(kit.dir, "dirty-worktree");
		git("worktree", "add", "-q", "--detach", wt, "HEAD");
		fs.writeFileSync(path.join(wt, "half.txt"), "half done");
		writeJobState("j1", { state: "stopped", sessionId: "dead-1" });
		const store = path.join(kitHome(), ".claude", "jobs");
		fs.chmodSync(store, 0o000);
		let r: Awaited<ReturnType<typeof run>>;
		try {
			r = await run({
				issues: [{ number: 1 }],
				staleFiles: {
					a: { path: "scripts/a.js", sessionId: "dead-1", hoursAgo: 24 },
				},
			});
		} finally {
			fs.chmodSync(store, 0o755);
		}
		expect(r.out).toMatch(
			/stranded claims\s+1, \d+ carrying uncommitted work; unknown how many \(a job store would not read\) finished session worktree/,
		);
	});
});

describe("an assignment is real only where a live session claimed it (mantahostels#645)", () => {
	it("excludes an assigned issue whose claim's session is live", async () => {
		kit.oracleSessions = ["self", "alice"];
		const r = await run({
			issues: [{ number: 1, assignees: ["owner"] }, { number: 2 }],
			claims: { 1: "alice" },
		});
		expect(r.order()).toEqual([2]);
		expect(r.out).toMatch(/#1\s+.*claimed by owner/);
	});

	it("names the assignments it decided to ignore, rather than dropping them silently", async () => {
		const r = await run({ issues: [{ number: 1, assignees: ["owner"] }] });
		expect(r.out).toMatch(/ASSIGNED BUT UNCLAIMED \(1\) — treated as takeable/);
		expect(r.out).toMatch(/#1\s+owner/);
		expect(r.out).toMatch(/session-arbiter\.js claim-issue <n>/);
	});

	it("says nothing about unclaimed assignments when there are none", async () => {
		kit.oracleSessions = ["self", "alice"];
		const r = await run({
			issues: [{ number: 1, assignees: ["owner"] }],
			claims: { 1: "alice" },
		});
		expect(r.out).not.toMatch(/ASSIGNED BUT UNCLAIMED/);
	});

	it("keeps every claim standing when the oracle will not answer", async () => {
		kit.oracleFails = true;
		const r = await run({
			issues: [{ number: 1, assignees: ["owner"] }, { number: 2 }],
			claims: { 1: "alice" },
		});
		expect(r.order()).toEqual([2]);
		expect(r.out).toMatch(/CLAIMS DEGRADED/);
		expect(r.out).toMatch(/kept rather than narrowing the live set/);
	});

	it("warns a corrupt claim record apart from a wholly unread store (mantahostels#1186)", async () => {
		kit.oracleSessions = ["self", "alice"];
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			claims: { 1: "alice" },
			corruptClaim: true,
		});
		expect(r.order()).toEqual([2]);
		expect(r.out).toMatch(/CLAIMS DEGRADED/);
		expect(r.out).toMatch(/could not be read, so what is shown as claimed/);
		expect(r.out).not.toMatch(/No claim was read/);
	});

	it("still offers an unclaimed assignment when the oracle will not answer", async () => {
		kit.oracleFails = true;
		const r = await run({ issues: [{ number: 1, assignees: ["owner"] }] });
		expect(r.order()).toEqual([1]);
	});

	it("carries the unclaimed assignments and the degraded read into --json", async () => {
		kit.oracleFails = true;
		const j = (
			await run(
				{
					issues: [
						{ number: 1, assignees: ["owner"] },
						{ number: 2, assignees: ["ada"] },
					],
					claims: { 2: "alice" },
				},
				["--json"],
			)
		).json();
		expect(j.assignedUnclaimed).toEqual([
			{ number: 1, title: "issue 1", assignees: ["owner"] },
		]);
		expect(j.claimsDegraded.claimsKept).toBe(true);
		expect(j.claimsDegraded.why).toMatch(/agents --json/);
	});

	it("pairs a candidate with a live claim that carries no assignee", async () => {
		kit.oracleSessions = ["self", "alice"];
		stubRepo(["scripts/a.js"]);
		const r = await run({
			issues: [
				{ number: 1, body: "`scripts/a.js`" },
				{ number: 2, body: "`scripts/a.js`" },
			],
			claims: { 2: "alice" },
		});
		expect(r.out).toMatch(/in flight: #1 <-> #2 \(claimed by session alice\)/);
	});
});

/* #2310 */
describe("a live claim on an issue's parent holds the issue too", () => {
	const thereUrl = "https://api.github.com/repos/o/there";
	const claudeConfig = () => path.join(kitHome(), ".claude");

	it("excludes a child of a live-claimed map, naming parent and holder", async () => {
		kit.oracleSessions = ["self", "alice"];
		kit.oracleNames = { alice: "Wayfinder 20: chart" };
		const r = await run({
			issues: [
				{ number: 20, labels: ["wayfinder:map"] },
				{ number: 21, parent: 20 },
				{ number: 22 },
			],
			claims: { 20: "alice" },
		});
		expect(r.order()).toEqual([22]);
		expect(r.out).toMatch(
			/#21\s+.*parent map #20 by session Wayfinder 20: chart/,
		);
		expect(r.calls().filter((c) => c.includes("/parent"))).toEqual([]);
	});

	it("offers a child whose live-claimed parent is no map", async () => {
		kit.oracleSessions = ["self", "alice"];
		const r = await run({
			issues: [
				{ number: 20, labels: ["kind:spec"] },
				{ number: 21, parent: 20 },
			],
			claims: { 20: "alice" },
		});
		expect(r.order()).toEqual([21]);
	});

	const thereMap = { url: `${thereUrl}/issues/7`, labels: ["wayfinder:map"] };

	const otherCheckout = (home: string, claims: Record<number, string>) => {
		const at = path.join(home, "there");
		writeAdopterCheckout(at, "o/there");
		for (const [n, sessionId] of Object.entries(claims))
			writeIssueClaim(claudeConfig(), at, Number(n), sessionId);
		return at;
	};

	it("reads a parent in another repo from that repo's own store", async () => {
		kit.oracleSessions = ["self", "alice"];
		const home = path.join(kit.dir, "adopters");
		otherCheckout(home, { 7: "alice" });
		const r = await run(
			{
				parents: { 21: thereMap },
				issues: [
					{ number: 7 },
					{
						number: 21,
						parentUrl: `${thereUrl}/issues/7`,
						repoUrl: "https://api.github.com/repos/o/r",
					},
					{ number: 22 },
				],
			},
			[],
			{ env: { HOME: home } },
		);
		expect(r.order()).toEqual([7, 22]);
		expect(r.out).toMatch(/#21\s+.*parent map o\/there#7 by session alice/);
	});

	it("offers the child with a WARN where the parent repo's store cannot be found", async () => {
		kit.oracleSessions = ["self", "alice"];
		const r = await run(
			{
				parents: { 21: thereMap },
				issues: [
					{
						number: 21,
						parentUrl: `${thereUrl}/issues/7`,
						repoUrl: "https://api.github.com/repos/o/r",
					},
				],
			},
			[],
		);
		expect(r.order()).toEqual([21]);
		expect(r.out).toContain(
			`WARN: no checkout under ${kitHome()} tracks o/there, so the claim on parent o/there#7 was not read.`,
		);
	});
});

describe("a claim is reported the same way to a person and to a machine (mantahostels#708)", () => {
	const sharing = (): Issue[] => {
		stubRepo(["scripts/a.js"]);
		return [
			{ number: 1, body: "`scripts/a.js`" },
			{ number: 2, body: "`scripts/a.js`" },
		];
	};

	it("names the claim's session in --json where there is no assignee to name", async () => {
		kit.oracleSessions = ["self", "alice"];
		const j = (
			await run({ issues: sharing(), claims: { 2: "alice" } }, ["--json"])
		).json();
		expect(j.inFlightCollisions[0].claimedBy).toEqual([]);
		expect(j.inFlightCollisions[0].claimedSession).toBe("alice");
	});

	it("names the holding session rather than printing a bare id", async () => {
		kit.oracleSessions = ["self", "alice"];
		kit.oracleNames = { alice: "Implement 708" };
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			claims: { 1: "alice" },
		});
		expect(r.out).toMatch(/#1\s+.*claimed by session Implement 708/);
	});

	it("hedges the in-flight pair on a degraded read too", async () => {
		kit.oracleFails = true;
		const r = await run({ issues: sharing(), claims: { 2: "alice" } });
		expect(r.out).toMatch(
			/in flight: #1 <-> #2 \(claimed by session alice, liveness unread\)/,
		);
	});
});

describe("which tree the claims came from (mantahostels#703)", () => {
	const elsewhere = () => {
		kit.claimsRepo = fs.mkdtempSync(
			path.join(os.tmpdir(), "pick-next-worktree-"),
		);
		roots.push(kit.claimsRepo);
	};

	it("says so when the claim store resolves outside the pinned repo root", async () => {
		elsewhere();
		const r = await run({ issues: [{ number: 1, assignees: ["owner"] }] });
		expect(r.out).toMatch(/CLAIMS DEGRADED/);
		expect(r.out).toMatch(/not the tree this run's claims are filed under/);
		expect(r.out).toMatch(/Claims filed against .* are invisible/);
	});

	const linkedWorktree = () => {
		const canonical = kit.repoRoot as string;
		spawnSync(
			"git",
			[
				"-c",
				"user.email=t@example",
				"-c",
				"user.name=t",
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				"base",
			],
			{ cwd: canonical },
		);
		const wt = path.join(kit.dir, "linked-worktree");
		spawnSync("git", ["worktree", "add", "-q", "--detach", wt, "HEAD"], {
			cwd: canonical,
		});
		kit.repoRoot = wt;
		kit.noProjectDir = true;
		kit.runCwd = wt;
		kit.claimsRepo = canonical;
		return { canonical: fs.realpathSync(canonical), wt: fs.realpathSync(wt) };
	};

	it("reads the canonical checkout's claims from inside a linked worktree", async () => {
		linkedWorktree();
		kit.oracleSessions = ["self", "alice"];
		const r = await run({
			issues: [{ number: 1, assignees: ["owner"] }, { number: 2 }],
			claims: { 1: "alice" },
		});
		expect(r.order()).not.toContain(1);
		expect(r.out).not.toMatch(/CLAIMS DEGRADED/);
	});

	it("says nothing from the canonical checkout with neither variable set", async () => {
		kit.noProjectDir = true;
		kit.runCwd = kit.repoRoot;
		const r = await run({ issues: [{ number: 1, assignees: ["owner"] }] });
		expect(r.out).not.toMatch(/CLAIMS DEGRADED/);
	});

	it("carries the divergence into --json", async () => {
		elsewhere();
		const j = (await run({ issues: [{ number: 1 }] }, ["--json"])).json();
		expect(j.claimsDegraded.storeElsewhere).toBe(true);
		expect(j.claimsDegraded.why).toMatch(/claim store resolves to/);
	});
});

describe("issues the launcher has already dispatched", () => {
	it("holds a recently dispatched issue out of the frontier", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			dispatched: [{ issues: [2], prompt: "/implement 2" }],
		});
		expect(r.order()).toEqual([1]);
	});

	it("prints the block, the launcher's window and the --force way past it", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			dispatched: [{ issues: [2] }],
		});
		expect(r.out).toContain("ALREADY DISPATCHED (1)");
		expect(r.out).toContain("1h after launching it");
		expect(r.out).toContain("scripts/dispatch-sessions.js --force");
	});

	it("takes the excluded issue out of the frontier count the summary prints", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			dispatched: [{ issues: [2] }],
		});
		expect(r.out).toMatch(/frontier\s+1 —/);
		expect(r.out).toMatch(/dispatched\s+1 held out on a launch in the last 1h/);
	});

	it("carries the ledger read into --json, window and all", async () => {
		const r = await run(
			{
				issues: [{ number: 2 }],
				dispatched: [{ issues: [2], prompt: "/implement 2" }],
			},
			["--json"],
		);
		const d = r.json().alreadyDispatched;
		expect(d.windowHours).toBe(1);
		expect(d.degraded).toBeNull();
		expect(d.issues).toHaveLength(1);
		expect(d.issues[0]).toMatchObject({ number: 2, prompt: "/implement 2" });
	});

	describe("whether the dispatched launch's own job is still alive (mantahostels#3488)", () => {
		it("reads live off a working job the oracle still lists", async () => {
			kit.oracleSessions = ["self", "worker1"];
			writeJobState("job1", { state: "working", sessionId: "worker1" });
			const r = await run(
				{
					issues: [{ number: 2 }],
					dispatched: [{ issues: [2], jobId: "job1" }],
				},
				["--json"],
			);
			expect(r.json().alreadyDispatched.issues[0].liveness).toBe("live");
		});

		it("prints live in the text table's liveness column", async () => {
			kit.oracleSessions = ["self", "worker1"];
			writeJobState("job1", { state: "working", sessionId: "worker1" });
			const r = await run({
				issues: [{ number: 2 }],
				dispatched: [{ issues: [2], jobId: "job1" }],
			});
			expect(r.out).toMatch(/^ {2}#2\s.*\blive\b/m);
		});

		it("reads unknown, never live, where the job id names no readable job record", async () => {
			kit.oracleSessions = ["self"];
			writeJobState("job1", { state: "working", sessionId: "worker1" });
			const r = await run(
				{
					issues: [{ number: 2 }],
					dispatched: [{ issues: [2], jobId: "ghost" }],
				},
				["--json"],
			);
			expect(r.json().alreadyDispatched.issues[0].liveness).toBe("unknown");
			expect(r.json().alreadyDispatched.issues[0].livenessWhy).toMatch(/ghost/);
		});
	});

	it("excludes nothing on a ledger it cannot read, and says so", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			dispatchLedgerUnreadable: true,
		});
		expect(r.order()).toEqual([1, 2]);
		expect(r.out).toContain("DISPATCH LEDGER DEGRADED");
		expect(r.out).toMatch(/dispatched\s+unknown \(/);
	});

	it("says nothing at all when no launch has ever been recorded", async () => {
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).not.toContain("ALREADY DISPATCHED");
		expect(r.out).not.toContain("DISPATCH LEDGER DEGRADED");
		expect(r.out).toMatch(/dispatched\s+0 held out on a launch in the last 1h/);
	});

	describe("keyed on issue and command (#752)", () => {
		it("re-admits an issue relabelled to a different command since its launch", async () => {
			const r = await run({
				issues: [{ number: 2, labels: ["takes:wayfinder"] }],
				dispatched: [{ issues: [2], prompt: "/triage 2" }],
			});
			expect(r.order()).toEqual([2]);
			expect(r.out).not.toContain("ALREADY DISPATCHED");
		});
	});
});

describe("what the mantahostels#1528 review caught", () => {
	it("prints a held issue once, under its own block and not under EXCLUDED", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			dispatched: [{ issues: [2] }],
		});
		const excluded = r.out.split("\nEXCLUDED\n")[1] ?? "";
		expect(r.out).toContain("ALREADY DISPATCHED (1)");
		expect(excluded).not.toMatch(/^#2\s/m);
		expect(excluded).toContain("1 more excluded as already dispatched");
	});

	it("counts only the dispatch-held issues in --json, not every ledger hit", async () => {
		kit.oracleSessions = ["self", "s1"];
		const r = await run(
			{
				issues: [{ number: 2, assignees: ["someone"] }, { number: 3 }],
				claims: { 2: "s1" },
				dispatched: [{ issues: [2, 3] }],
			},
			["--json"],
		);
		expect(
			r
				.json()
				.alreadyDispatched.issues.map((i: { number: number }) => i.number),
		).toEqual([3]);
	});

	it("reads the ledger WFC_DISPATCH_ROOT names, as the launcher does", async () => {
		const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "pick-next-led-"));
		roots.push(elsewhere);
		fs.mkdirSync(
			path.join(elsewhere, ".claude", "tmp", "markers", ".pick-next"),
			{ recursive: true },
		);
		fs.writeFileSync(
			path.join(
				elsewhere,
				".claude",
				"tmp",
				"markers",
				".pick-next",
				"dispatched.jsonl",
			),
			`${JSON.stringify({
				ts: new Date().toISOString(),
				issues: [2],
				model: "opus",
				prompt: "/implement 2",
				session: "gone",
			})}\n`,
		);
		vi.stubEnv("WFC_DISPATCH_ROOT", elsewhere);
		const r = await run({ issues: [{ number: 1 }, { number: 2 }] });
		expect(r.order()).toEqual([1]);
		expect(r.out).toContain("ALREADY DISPATCHED (1)");
	});
});

describe("the band no command opens — §5's third accounting term (mantahostels#1626)", () => {
	const block = (out: string) =>
		out.split("RUN SUMMARY")[1]?.split("\nAdvisory only")[0] ?? "";

	it("prints the row at zero, so the term is never read as unowed", async () => {
		const r = await run({
			issues: [{ number: 1, labels: ["takes:implement"] }],
		});
		expect(block(r.out)).toMatch(/no command +0/);
	});

	it("counts nothing for a takes:human issue an open blocker excluded", async () => {
		const r = await run({
			issues: [
				{ number: 1, labels: ["takes:implement"] },
				{ number: 2, labels: ["takes:human"] },
			],
			deps: { 2: [{ number: 9, state: "open" }] },
		});
		expect(r.out).toMatch(/#2\s+\S*\s*blocked by #9/);
		expect(block(r.out)).toMatch(/frontier +1/);
		expect(block(r.out)).toMatch(/no command +0/);
	});

	it("names no rotted container where the band is takes:human alone", async () => {
		const r = await run({
			issues: [
				{ number: 1, labels: ["takes:implement"] },
				{ number: 2, labels: ["takes:human"] },
			],
		});
		expect(block(r.out)).not.toMatch(/rotted containers/);
	});

	it("counts the whole frontier, never the --limit slice", async () => {
		const r = await run(
			{
				issues: [
					{ number: 1, labels: ["takes:implement"] },
					{ number: 2, labels: ["takes:human"] },
					{ number: 3, labels: ["takes:human"] },
				],
			},
			["--limit", "1"],
		);
		expect(block(r.out)).toMatch(/no command +2/);
	});

	it("joins several rotted containers, which is the measured case", async () => {
		const r = await run({
			issues: [
				{ number: 1, labels: ["takes:implement"] },
				{ number: 2, labels: ["takes:children"] },
				{ number: 3, labels: ["takes:children"] },
				{ number: 4, labels: ["takes:children"] },
			],
		});
		expect(block(r.out)).toMatch(/no command +3/);
		expect(block(r.out)).toMatch(/rotted containers: #2, #3, #4/);
	});

	it("prints the row under --no-log, which mints no marker", async () => {
		const r = await run(
			{
				issues: [
					{ number: 1, labels: ["takes:implement"] },
					{ number: 2, labels: ["takes:human"] },
				],
			},
			["--no-log"],
		);
		expect(block(r.out)).toMatch(/no command +1/);
	});

	it("carries the count and the rotted numbers in --json", async () => {
		const r = await run(
			{
				issues: [
					{ number: 1, labels: ["takes:implement"] },
					{ number: 2, labels: ["takes:human"] },
					{ number: 3, labels: ["takes:children"] },
				],
			},
			["--json"],
		);
		expect(r.json().summary.noCommand).toBe(2);
		expect(r.json().summary.rottedContainers).toEqual([3]);
	});

	it("records the count on the marker the guard pins against", async () => {
		const r = await run(
			{
				issues: [
					{ number: 1, labels: ["takes:implement"] },
					{ number: 2, labels: ["takes:human"] },
				],
			},
			[],
			{ ownRepo: true },
		);
		expect(r.status).toBe(0);
		expect(
			selectionMarker.read(kit.repoRoot, kit.oracleSelfId)?.noCommand,
		).toBe(1);
	});
});
