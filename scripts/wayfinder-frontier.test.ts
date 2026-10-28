// @vitest-environment node
/*
 * The wayfinder frontier drops an assigned issue only where a live session's
 * claim holds it, refuses on any read it cannot complete, and never prints a
 * frontier longer than the truth (mantahostels#702; `--map`, mantahostels#1145).
 *
 * Spawned rather than imported — the frontier query is a shell step in a
 * hash-locked skill, so stdout shape and exit code are the whole interface.
 * Loosen a case and `/wayfinder` offers a held issue as free to start, or a
 * finished session's leftover assignee hides work from it for good.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	AS_ROOT,
	freshSandbox,
	registerSession,
	SCRIPT,
	store,
} from "./lib/arbiter-testkit";
import { GH_NOT_FOUND, subIssuesAnswer } from "./lib/gh-fake";
import { page, printed, type RouteAnswer, stubGhRoutes } from "./lib/gh-stub";

const FRONTIER = path.join(__dirname, "wayfinder-frontier.js");
// `--map` refuses where it cannot confirm the claim store shares the caller's
// tree, so the sandbox repo is a real one.
const sb = freshSandbox((s) => {
	spawnSync("git", ["init", "-q"], { cwd: s.repo });
});

const oracle = () => path.join(sb.dir, "bin", "claude");

type Row = string | { sessionId: string; kind: string; state: string };

/** A `claude agents --json` stand-in listing these sessions — a bare id as live. */
function fakeClaude(rows: Row[], code = 0) {
	fs.mkdirSync(path.join(sb.dir, "bin"), { recursive: true });
	fs.writeFileSync(
		oracle(),
		`#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(
			rows.map((r) => (typeof r === "string" ? { sessionId: r } : r)),
		)}\nJSON\nexit ${code}\n`,
	);
	fs.chmodSync(oracle(), 0o755);
}

/** Record an issue claim the way the working session does — through the CLI. */
function claimBy(sessionId: string, issue: string) {
	registerSession(sb, sessionId, process.pid);
	spawnSync(process.execPath, [SCRIPT, "claim-issue", issue], {
		encoding: "utf8",
		cwd: sb.repo,
		env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId },
	});
}

/** Run the reader as `alice`, who is the live caller in every case below. */
const asAlice = (args: string[] = [], cwd = sb.repo) =>
	spawnSync(process.execPath, [FRONTIER, ...args], {
		encoding: "utf8",
		cwd,
		env: {
			...process.env,
			CLAUDE_CODE_SESSION_ID: "alice",
			WFC_CLAUDE_BIN: oracle(),
		},
	});

/**
 * A `gh api` stand-in wired through WFC_GH. It serves `routes` by API path
 * and gh's recorded 404 on any path in `fails` or absent, consistently, so
 * the command's one retry re-fails rather than papering over a fixture. The
 * batched GraphQL blockers read answers from the same `blockedBy(n)` routes.
 */
function fakeGh(routes: Record<string, unknown>, fails: string[] = []) {
	const table: Record<string, RouteAnswer> = {};
	for (const p of fails) table[p] = GH_NOT_FOUND;
	for (const [p, rows] of Object.entries(routes))
		if (!fails.includes(p)) table[p] = pageOf(p, rows);
	table["*"] = GH_NOT_FOUND;
	return stubGhRoutes(sb.dir, table, { log: ghLog() }).gh;
}

/** `rows` as the one --slurp page gh answers on route `p`. */
function pageOf(p: string, rows: unknown): RouteAnswer {
	if (p.endsWith("/sub_issues")) return subIssuesAnswer(rows as unknown[]);
	if (p.endsWith("/dependencies/blocked_by"))
		return page("blockedByPage", rows as unknown[]);
	throw new Error(`no recorded answer for route ${p}`);
}

/** Every argv the stub gh was called with, one line each. */
const ghLog = () => path.join(sb.dir, "gh-argv.log");
const ghCalls = () =>
	fs.readFileSync(ghLog(), "utf8").trim().split("\n").filter(Boolean);

/** Run `--map <n>` as `alice`, against the stub gh just written. */
const mapAsAlice = (n: number, gh: string, args: string[] = []) =>
	spawnSync(process.execPath, [FRONTIER, "--map", String(n), ...args], {
		encoding: "utf8",
		cwd: sb.repo,
		env: {
			...process.env,
			CLAUDE_CODE_SESSION_ID: "alice",
			WFC_CLAUDE_BIN: oracle(),
			WFC_GH: gh,
			CLAUDE_PROJECT_DIR: sb.repo,
		},
	});

const subIssues = (map: number) =>
	`repos/{owner}/{repo}/issues/${map}/sub_issues`;
const blockedBy = (n: number) =>
	`repos/{owner}/{repo}/issues/${n}/dependencies/blocked_by`;

const TASK = [{ name: "wayfinder:task" }];

/** A map whose children are `[number, state]`, none of them blocked, each a decision ticket. */
function mapWith(map: number, children: [number, string][]) {
	const routes: Record<string, unknown> = {
		[subIssues(map)]: children.map(([number, state]) => ({
			number,
			state,
			labels: TASK,
		})),
	};
	for (const [number] of children) routes[blockedBy(number)] = [];
	return routes;
}

describe("wayfinder-frontier — the issues the frontier query may drop (mantahostels#702)", () => {
	it("names an issue a live session holds a claim on", () => {
		claimBy("alice", "702");
		fakeClaude(["alice"]);
		const r = asAlice();
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/^#702\talice\tsince /m);
	});

	it("omits the claim of a session the oracle does not list, so that issue reaches the frontier", () => {
		claimBy("bob", "633");
		fakeClaude(["alice"]);
		const r = asAlice();
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("No issues are claimed by a live session.\n");
	});

	it("omits the claim of a session the oracle lists as stopped (#619)", () => {
		claimBy("bob", "633");
		fakeClaude([
			"alice",
			{ sessionId: "bob", kind: "background", state: "stopped" },
		]);
		const r = asAlice();
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("No issues are claimed by a live session.\n");
	});

	it("drops only the dead session's claim, keeping the live one beside it", () => {
		claimBy("alice", "702");
		claimBy("bob", "633");
		fakeClaude(["alice"]);
		const r = asAlice();
		expect(r.stdout).toMatch(/#702\talice/);
		// A bare /633/ also matches the live claim's timestamp when its
		// millisecond field is 633 (mantahostels#3053).
		expect(r.stdout).not.toMatch(/#633\tbob/);
	});

	it("keeps every claim when the oracle cannot be read, and says so", () => {
		claimBy("bob", "633");
		fakeClaude([], 1);
		const r = asAlice();
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/^#633\tbob\tsince /m);
		expect(r.stderr).toMatch(/agents --json/);
		expect(r.stderr).toMatch(/may in fact be free/);
	});

	it("keeps every claim when the oracle omits the calling session (mantahostels#437)", () => {
		claimBy("bob", "633");
		// A listing missing its own caller is not a listing of what is live, so
		// nothing may be narrowed on it.
		fakeClaude(["carol"]);
		const r = asAlice();
		expect(r.stdout).toMatch(/^#633\tbob\tsince /m);
		expect(r.stderr).toMatch(/every claim below stands/);
	});

	it("never reports an empty exclusion set for a store it could not read (mantahostels#174)", () => {
		if (AS_ROOT) return;
		fs.mkdirSync(store.paths.issueClaimsDir(), { recursive: true });
		fs.chmodSync(store.paths.issueClaimsDir(), 0o000);
		try {
			const r = asAlice();
			expect(r.status).toBe(1);
			expect(r.stderr).toMatch(/unknown — not nothing/);
			expect(r.stdout).not.toMatch(/No issues are claimed/);
		} finally {
			fs.chmodSync(store.paths.issueClaimsDir(), 0o755);
		}
	});

	it("says plainly that nothing is claimed when nothing is", () => {
		fakeClaude(["alice"]);
		const r = asAlice();
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("No issues are claimed by a live session.\n");
	});

	it("refuses rather than offering a short frontier on a corrupt claim record (mantahostels#1186)", () => {
		claimBy("bob", "633");
		fs.writeFileSync(
			path.join(store.paths.issueClaimsDir(), "bogus.json"),
			"not json",
		);
		fakeClaude(["alice", "bob"]);
		const r = asAlice();
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/could not be read and .* dropped/);
		expect(r.stdout).toBe("");
	});

	it("orders the live claims by issue number", () => {
		claimBy("alice", "702");
		claimBy("carol", "97");
		claimBy("dave", "645");
		fakeClaude(["alice", "carol", "dave"]);
		const numbers = asAlice()
			.stdout.trim()
			.split("\n")
			.map((l) => Number(l.split("\t")[0].slice(1)));
		expect(numbers).toEqual([97, 645, 702]);
	});

	it("keeps every claim when the oracle lists nobody at all", () => {
		claimBy("bob", "633");
		fakeClaude([]);
		const r = asAlice();
		expect(r.stdout).toMatch(/^#633\tbob\tsince /m);
		expect(r.stderr).toMatch(/every claim below stands/);
	});

	describe("--numbers, the form the frontier query's shell step consumes", () => {
		it("prints bare issue numbers, one per line, and nothing else", () => {
			claimBy("alice", "702");
			claimBy("carol", "97");
			fakeClaude(["alice", "carol"]);
			const r = asAlice(["--numbers"]);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("97\n702\n");
		});

		it("prints nothing at all when nothing is claimed", () => {
			fakeClaude(["alice"]);
			const r = asAlice(["--numbers"]);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("");
		});

		it("still exits non-zero on an unreadable store, printing no numbers", () => {
			if (AS_ROOT) return;
			fs.mkdirSync(store.paths.issueClaimsDir(), { recursive: true });
			fs.chmodSync(store.paths.issueClaimsDir(), 0o000);
			try {
				const r = asAlice(["--numbers"]);
				expect(r.status).toBe(1);
				expect(r.stdout).toBe("");
			} finally {
				fs.chmodSync(store.paths.issueClaimsDir(), 0o755);
			}
		});
	});

	it("announces a claim store belonging to a different tree (mantahostels#703's shape)", () => {
		// A run from a worktree resolves its store cleanly to the WRONG directory,
		// so an empty frontier there is indistinguishable from a clear one.
		const other = path.join(sb.dir, "elsewhere");
		fs.mkdirSync(other, { recursive: true });
		spawnSync("git", ["init", "-q"], { cwd: other });
		fakeClaude(["alice"]);
		const r = asAlice([], other);
		expect(r.stderr).toMatch(/not the tree you are in/);
		expect(r.stderr).toMatch(/not that nothing is claimed/);
	});

	it("writes no claim of its own, and disturbs none that exist", () => {
		// An empty store would pass on absence alone, so the assertion is made
		// against a store that already holds a claim.
		claimBy("bob", "610");
		const before = JSON.stringify(store.listIssueClaims());
		fakeClaude(["alice"]);
		asAlice();
		expect(JSON.stringify(store.listIssueClaims())).toBe(before);
		expect(
			store
				.listIssueClaims()
				.claims.map((c: { sessionId: string }) => c.sessionId),
		).not.toContain("alice");
	});

	it("refuses an unrecognised argument rather than printing the human format", () => {
		// Ignoring it feeds the human format to a shell step reading bare
		// numbers, which then drops issues named by no one.
		fakeClaude(["alice"]);
		claimBy("bob", "610");
		const r = asAlice(["--number"]);
		expect(r.status).toBe(2);
		expect(r.stdout).toBe("");
		expect(r.stderr).toMatch(/unknown flag: --number/);
		expect(r.stderr).toMatch(/usage:/);
	});

	it("prints each claimed issue once, however many sessions claimed it", () => {
		// The store keeps one record per session per issue, so a shell step would
		// otherwise see the same number twice.
		claimBy("bob", "610");
		claimBy("carol", "610");
		fakeClaude(["alice", "bob", "carol"]);
		expect(asAlice(["--numbers"]).stdout).toBe("610\n");
	});

	it("--numbers keeps every claim when the oracle cannot be read, and says so", () => {
		// The warning is stderr-only, so a caller discarding stderr sees a plain
		// list.
		claimBy("bob", "610");
		fakeClaude([], 1);
		const r = asAlice(["--numbers"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("610\n");
		expect(r.stderr).toMatch(/every claim below stands/);
	});

	describe("--map, the whole frontier query in one call (mantahostels#1145)", () => {
		it("prints the map's open, unblocked, unclaimed children in map order", () => {
			fakeClaude(["alice"]);
			const gh = fakeGh(
				mapWith(1080, [
					[1145, "open"],
					[1114, "open"],
					[1086, "open"],
				]),
			);
			const r = mapAsAlice(1080, gh);
			expect(r.status).toBe(0);
			// Map order, NOT numeric order — the sub-issues endpoint's own order
			// is the order the map lists them.
			expect(r.stdout).toBe("1145\n1114\n1086\n");
		});

		it("drops a child that already has an open blocker", () => {
			// Break `state === "open"` in blockedChildren, or the
			// `!blocked.blocked.has(n)` in frontier, and mantahostels#1114 appears here.
			fakeClaude(["alice"]);
			const routes = mapWith(1080, [
				[1145, "open"],
				[1114, "open"],
			]);
			routes[blockedBy(1114)] = [{ number: 1086, state: "open" }];
			const r = mapAsAlice(1080, fakeGh(routes));
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("1145\n");
		});

		it("keeps a child whose every blocker is closed", () => {
			// A blocked_by list is not itself proof of blockage, so a filter
			// reading length rather than state would drop this one.
			fakeClaude(["alice"]);
			const routes = mapWith(1080, [[1145, "open"]]);
			routes[blockedBy(1145)] = [{ number: 1086, state: "closed" }];
			expect(mapAsAlice(1080, fakeGh(routes)).stdout).toBe("1145\n");
		});

		it("drops a closed child", () => {
			fakeClaude(["alice"]);
			const gh = fakeGh(
				mapWith(1080, [
					[1145, "open"],
					[1114, "closed"],
				]),
			);
			expect(mapAsAlice(1080, gh).stdout).toBe("1145\n");
		});

		it("drops a child a live session holds a claim on", () => {
			claimBy("bob", "1145");
			fakeClaude(["alice", "bob"]);
			const gh = fakeGh(
				mapWith(1080, [
					[1145, "open"],
					[1114, "open"],
				]),
			);
			expect(mapAsAlice(1080, gh).stdout).toBe("1114\n");
		});

		it("keeps a child assigned by a session that has finished (mantahostels#633)", () => {
			claimBy("bob", "1145");
			fakeClaude(["alice"]); // bob is gone
			const gh = fakeGh(mapWith(1080, [[1145, "open"]]));
			expect(mapAsAlice(1080, gh).stdout).toBe("1145\n");
		});

		it("drops a kind:spec child and an unlabelled one, naming each on stderr (#579)", () => {
			fakeClaude(["alice"]);
			const routes = mapWith(1080, [[1145, "open"]]);
			(routes[subIssues(1080)] as unknown[]).push(
				{ number: 412, state: "open", labels: [{ name: "kind:spec" }] },
				{ number: 483, state: "open", labels: [{ name: "takes:children" }] },
			);
			const r = mapAsAlice(1080, fakeGh(routes));
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("1145\n");
			expect(r.stderr).toMatch(/#412 is a kind:spec/);
			expect(r.stderr).toMatch(/#483 carries no wayfinder:<type> label/);
			// No blocker read for a child already dropped.
			const calls = ghCalls().join("\n");
			expect(calls).not.toContain(blockedBy(412));
			expect(calls).not.toMatch(/i412: issue/);
		});

		it("names a kind:brief child as an expected drop, not a missing label (#579)", () => {
			fakeClaude(["alice"]);
			const routes = mapWith(1080, [[1145, "open"]]);
			(routes[subIssues(1080)] as unknown[]).push({
				number: 509,
				state: "open",
				labels: [{ name: "kind:brief" }, { name: "takes:children" }],
			});
			const r = mapAsAlice(1080, fakeGh(routes));
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("1145\n");
			expect(r.stderr).toMatch(/#509 is a kind:brief/);
			expect(r.stderr).not.toMatch(/#509 carries no/);
		});

		it("is silent at exit 0 when every open child is untyped, bar the drop notes (#579)", () => {
			fakeClaude(["alice"]);
			const gh = fakeGh({
				[subIssues(1080)]: [
					{ number: 412, state: "open", labels: [{ name: "kind:spec" }] },
				],
			});
			const r = mapAsAlice(1080, gh);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("");
			expect(r.stderr).toMatch(/#412 is a kind:spec/);
		});

		it("keeps a nested map, whose wayfinder:map is a wayfinder label (#579)", () => {
			fakeClaude(["alice"]);
			const routes = mapWith(1080, [[1145, "open"]]);
			(routes[subIssues(1080)] as { labels: unknown }[])[0].labels = [
				{ name: "wayfinder:map" },
			];
			const r = mapAsAlice(1080, fakeGh(routes));
			expect(r.stdout).toBe("1145\n");
			expect(r.stderr).toBe("");
		});

		/*
		 * The gate filter (mantahostels#2706). `mapWith` gives every child an empty body, so
		 * these set one on the child under test and leave its sibling ungated —
		 * the sibling is what proves the run happened at all rather than
		 * refusing.
		 */
		const gatedMap = (body: string) => {
			const routes = mapWith(1080, [
				[1145, "open"],
				[1114, "open"],
			]);
			routes[subIssues(1080)] = [
				{ number: 1145, state: "open", body, labels: TASK },
				{ number: 1114, state: "open", body: "", labels: TASK },
			];
			return routes;
		};

		it("drops a child gated until a date still ahead", () => {
			// Break the `until?.active` limb in gatedChildren and mantahostels#1145 returns.
			fakeClaude(["alice"]);
			const gh = fakeGh(
				gatedMap("**Gated until:** 2099-01-01 — the corpus is not deep enough"),
			);
			const r = mapAsAlice(1080, gh);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("1114\n");
		});

		it("keeps a child whose gate date has passed", () => {
			// A gate rots by being reached; reading the marker's presence rather
			// than its date would hide this one for good.
			fakeClaude(["alice"]);
			const gh = fakeGh(
				gatedMap("**Gated until:** 2020-01-01 — long since due"),
			);
			expect(mapAsAlice(1080, gh).stdout).toBe("1145\n1114\n");
		});

		/*
		 * One gate line per issue (mantahostels#1333), read through `lib/issue-gate.js`'s
		 * `resolveGate`, which pick-next.js and check-gates.js also call
		 * (mantahostels#2706). Both dates are covered because the naive spelling fails them
		 * for different reasons: an active `until` gates on its own limb, a
		 * lapsed one falls through to the condition.
		 */
		it("gates nothing when a body carries both markers, and says so (mantahostels#1333)", () => {
			fakeClaude(["alice"]);
			const gh = fakeGh(
				gatedMap(
					"**Gated until:** 2099-01-01 — not yet\n\n**Gated on:** the desk replies — abandon if: we ship without them",
				),
			);
			const r = mapAsAlice(1080, gh);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("1145\n1114\n");
			expect(r.stderr).toMatch(/#1145 carries both/);
		});

		it("gates nothing on both markers even where the date has lapsed (mantahostels#1333)", () => {
			fakeClaude(["alice"]);
			const gh = fakeGh(
				gatedMap(
					"**Gated until:** 2020-01-01 — long past\n\n**Gated on:** the desk replies — abandon if: we ship without them",
				),
			);
			expect(mapAsAlice(1080, gh).stdout).toBe("1145\n1114\n");
		});

		it("drops a child held by a condition gate (mantahostels#2706)", () => {
			fakeClaude(["alice"]);
			const gh = fakeGh(
				gatedMap(
					"**Gated on:** the affiliate desk replies — abandon if: we ship without them",
				),
			);
			expect(mapAsAlice(1080, gh).stdout).toBe("1114\n");
		});

		it("keeps a child whose gate will not parse, and says which (mantahostels#633's shape)", () => {
			// FAIL OPEN. Failing closed would hide the issue on a typo with
			// nothing saying so — the hide-forever defect this command exists to
			// prevent. Invert the `malformed` test and mantahostels#1145 vanishes silently.
			fakeClaude(["alice"]);
			const gh = fakeGh(gatedMap("**Gated until:** next Tuesday sometime"));
			const r = mapAsAlice(1080, gh);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("1145\n1114\n");
			expect(r.stderr).toMatch(/#1145 carries a \*\*Gated until:\*\* line/);
		});

		it("keeps a child whose condition gate will not parse, and says which (mantahostels#2706)", () => {
			fakeClaude(["alice"]);
			const gh = fakeGh(gatedMap("**Gated on:** the desk replies"));
			const r = mapAsAlice(1080, gh);
			expect(r.stdout).toBe("1145\n1114\n");
			expect(r.stderr).toMatch(/#1145 carries a \*\*Gated on:\*\* line/);
		});

		it("spends no extra API call on the gate filter", () => {
			// The body arrives with the sub-issues call, so the gate filter needs
			// no call of its own. A per-child body fetch would show up as a
			// `repos/{owner}/{repo}/issues/1145` line in the log.
			fakeClaude(["alice"]);
			const gh = fakeGh(
				gatedMap("**Gated until:** 2099-01-01 — the corpus is not deep enough"),
			);
			mapAsAlice(1080, gh);
			const paths = ghCalls().map((l) => l.split(" ")[1]);
			expect(paths.sort()).toEqual([subIssues(1080), "graphql"].sort());
		});

		it("refuses, printing nothing, when the map's children cannot be read", () => {
			// A 404 on the map would otherwise read as "the frontier is clear".
			fakeClaude(["alice"]);
			const gh = fakeGh({}, [subIssues(1080)]);
			const r = mapAsAlice(1080, gh);
			expect(r.status).toBe(1);
			expect(r.stdout).toBe("");
			expect(r.stderr).toMatch(/could not read the children of #1080/);
			expect(r.stderr).toMatch(/unknown — not empty/);
		});

		it("refuses the whole run when one child's blockers cannot be read, naming the child and printing no frontier", () => {
			// Not "skip that child": a frontier missing an entry is what the
			// caller then works from, and it looks exactly like a correct one.
			fakeClaude(["alice"]);
			const routes = mapWith(1080, [
				[1145, "open"],
				[1114, "open"],
			]);
			const r = mapAsAlice(1080, fakeGh(routes, [blockedBy(1114)]));
			expect(r.status).toBe(1);
			expect(r.stdout).toBe("");
			expect(r.stderr).toMatch(/could not read the blockers of #1114/);
		});

		it("never reads the stale issue_dependencies_summary field", () => {
			// The documented trap: the summary is documented as the open-blocker
			// count and is stale in practice.
			fakeClaude(["alice"]);
			const routes: Record<string, unknown> = {
				[subIssues(1080)]: [
					{
						number: 1145,
						state: "open",
						labels: TASK,
						issue_dependencies_summary: { blocked_by: 3 },
					},
				],
				[blockedBy(1145)]: [],
			};
			expect(mapAsAlice(1080, fakeGh(routes)).stdout).toBe("1145\n");
		});

		it("refuses an unreadable claim store rather than offering a frontier", () => {
			if (AS_ROOT) return;
			fakeClaude(["alice"]);
			const gh = fakeGh(mapWith(1080, [[1145, "open"]]));
			fs.mkdirSync(store.paths.issueClaimsDir(), { recursive: true });
			fs.chmodSync(store.paths.issueClaimsDir(), 0o000);
			try {
				const r = mapAsAlice(1080, gh);
				expect(r.status).toBe(1);
				expect(r.stdout).toBe("");
				expect(r.stderr).toMatch(/unknown — not nothing/);
			} finally {
				fs.chmodSync(store.paths.issueClaimsDir(), 0o755);
			}
		});

		it("warns on stderr that every claim stands, and still answers, when the liveness oracle cannot be read", () => {
			// Claims stand on doubt, so the frontier printed may be SHORTER than
			// the truth — never longer. The warning is the only signal of that,
			// and it is on stderr, which the call form must not redirect away.
			claimBy("bob", "1145");
			fakeClaude([], 1);
			const gh = fakeGh(
				mapWith(1080, [
					[1145, "open"],
					[1114, "open"],
				]),
			);
			const r = mapAsAlice(1080, gh);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("1114\n");
			expect(r.stderr).toMatch(/every claim below stands/);
		});

		it("refuses outright when the claim store belongs to another tree, printing no frontier", () => {
			// `--numbers` only warns here, because its empty claim set drops
			// nothing. A frontier built on that same empty set is LONGER than the
			// truth — it offers work another live session is already doing — so
			// this form refuses instead.
			claimBy("bob", "1145");
			fakeClaude(["alice", "bob"]);
			const other = path.join(sb.dir, "elsewhere-map");
			fs.mkdirSync(other, { recursive: true });
			spawnSync("git", ["init", "-q"], { cwd: other });
			const gh = fakeGh(
				mapWith(1080, [
					[1145, "open"],
					[1114, "open"],
				]),
			);
			const r = spawnSync(process.execPath, [FRONTIER, "--map", "1080"], {
				encoding: "utf8",
				cwd: other,
				env: {
					...process.env,
					CLAUDE_CODE_SESSION_ID: "alice",
					WFC_CLAUDE_BIN: oracle(),
					WFC_GH: gh,
				},
			});
			expect(r.status).toBe(1);
			expect(r.stdout).toBe("");
			expect(r.stderr).toMatch(/not the tree you are in/);
			expect(r.stderr).toMatch(/Refusing/);
		});

		it("refuses when it cannot even tell whose tree the claim store is, saying it is not in a git repository and printing no frontier", () => {
			// The doubt cases used to read as "same tree, nothing claimed", which
			// is the same empty claim set as a wrong store and lengthens the
			// frontier the same way. Run from outside any repository.
			claimBy("bob", "1145");
			fakeClaude(["alice", "bob"]);
			const nowhere = path.join(sb.dir, "not-a-repo");
			fs.mkdirSync(nowhere, { recursive: true });
			const gh = fakeGh(mapWith(1080, [[1145, "open"]]));
			const r = spawnSync(process.execPath, [FRONTIER, "--map", "1080"], {
				encoding: "utf8",
				cwd: nowhere,
				env: {
					...process.env,
					CLAUDE_CODE_SESSION_ID: "alice",
					WFC_CLAUDE_BIN: oracle(),
					WFC_GH: gh,
				},
			});
			expect(r.status).toBe(1);
			expect(r.stdout).toBe("");
			expect(r.stderr).toMatch(/not in a git repository/);
		});

		it("refuses a blocker read that exits 0 having printed nothing, and prints no frontier", () => {
			// An empty stdout parses as `[]`, which on this endpoint is
			// indistinguishable from "no blockers" — a blocked issue reported free.
			fakeClaude(["alice"]);
			const gh = stubGhRoutes(sb.dir, {
				graphql: printed(),
				"*": printed(),
			}).gh;
			const r = mapAsAlice(1080, gh);
			expect(r.status).toBe(1);
			expect(r.stdout).toBe("");
			expect(r.stderr).toMatch(/printed nothing/);
		});

		it("refuses a map with no sub-issues at all rather than calling it clear", () => {
			// The commonest way to get the wrong answer here is the wrong number:
			// a non-map issue has no children, and an empty stdout at exit 0 reads
			// as "nothing is left to do on this map".
			fakeClaude(["alice"]);
			const gh = fakeGh({ [subIssues(1080)]: [] });
			const r = mapAsAlice(1080, gh);
			expect(r.status).toBe(1);
			expect(r.stdout).toBe("");
			expect(r.stderr).toMatch(/no sub-issues at all/);
		});

		it("is silent at exit 0 for a map whose children exist but are all closed", () => {
			// This map really is worked out.
			fakeClaude(["alice"]);
			const gh = fakeGh(mapWith(1080, [[1145, "closed"]]));
			const r = mapAsAlice(1080, gh);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("");
			expect(r.stderr).toBe("");
		});

		it("writes nothing to the tracker — every call it makes is a GET", () => {
			// Reading the canonical blocked_by list back in the same chained
			// command as a POST returns an empty array.
			fakeClaude(["alice"]);
			const gh = fakeGh(mapWith(1080, [[1145, "open"]]));
			mapAsAlice(1080, gh);
			const calls = ghCalls();
			expect(calls.join("\n")).not.toMatch(/--method|-X POST/);
			expect(calls.join("\n")).not.toMatch(/mutation/);
			expect(calls.length).toBe(2); // the map's children, then the batched blockers read
		});

		it("refuses --map with no number, and --map with a non-number", () => {
			fakeClaude(["alice"]);
			const gh = fakeGh({});
			const bare = spawnSync(process.execPath, [FRONTIER, "--map"], {
				encoding: "utf8",
				cwd: sb.repo,
				env: { ...process.env, WFC_CLAUDE_BIN: oracle(), WFC_GH: gh },
			});
			expect(bare.status).toBe(2);
			expect(bare.stderr).toMatch(/--map needs a value/);

			const junk = spawnSync(process.execPath, [FRONTIER, "--map", "wibble"], {
				encoding: "utf8",
				cwd: sb.repo,
				env: { ...process.env, WFC_CLAUDE_BIN: oracle(), WFC_GH: gh },
			});
			expect(junk.status).toBe(2);
			expect(junk.stdout).toBe("");
			expect(junk.stderr).toMatch(/wants an issue number, not wibble/);
		});

		it("refuses --numbers and --map together rather than guessing", () => {
			fakeClaude(["alice"]);
			const gh = fakeGh({});
			const r = mapAsAlice(1080, gh, ["--numbers"]);
			expect(r.status).toBe(2);
			expect(r.stdout).toBe("");
			expect(r.stderr).toMatch(/alternatives, not a pair/);
		});
	});
});
