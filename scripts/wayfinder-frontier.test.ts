// @vitest-environment node
// full-sweep-only: #5528

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	AS_ROOT,
	freshSandbox,
	listedClaims,
	registerSession,
	SCRIPT,
	store,
} from "./lib/arbiter-testkit";
import { GH_NOT_FOUND, subIssuesAnswer } from "./lib/gh-fake";
import { page, printed, type RouteAnswer, stubGhRoutes } from "./lib/gh-stub";
import { defineTemplate, emptyRepoTemplate } from "./lib/git-fixture";
import { runInProcess, runInProcessAsync } from "./lib/run-in-process.js";

const FRONTIER = path.join(__dirname, "wayfinder-frontier.js");
const emptyRepo = defineTemplate(emptyRepoTemplate);
const sb = freshSandbox((s) => {
	emptyRepo.instantiate(s.repo);
});

const oracle = () => path.join(sb.dir, "bin", "claude");

type Row = string | { sessionId: string; kind: string; state: string };

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

function claimBy(sessionId: string, issue: string) {
	registerSession(sb, sessionId, process.pid);
	runInProcess(SCRIPT, ["claim-issue", issue], {
		cwd: sb.repo,
		env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId },
	});
}

const asAlice = (args: string[] = [], cwd = sb.repo) =>
	runInProcessAsync(FRONTIER, args, {
		cwd,
		env: {
			...process.env,
			CLAUDE_CODE_SESSION_ID: "alice",
			WFC_CLAUDE_BIN: oracle(),
		},
	});

function fakeGh(routes: Record<string, unknown>, fails: string[] = []) {
	const table: Record<string, RouteAnswer> = {};
	for (const p of fails) table[p] = GH_NOT_FOUND;
	for (const [p, rows] of Object.entries(routes))
		if (!fails.includes(p)) table[p] = pageOf(p, rows);
	table["*"] = GH_NOT_FOUND;
	return stubGhRoutes(sb.dir, table, { log: ghLog() }).gh;
}

function pageOf(p: string, rows: unknown): RouteAnswer {
	if (p.endsWith("/sub_issues")) return subIssuesAnswer(rows as unknown[]);
	if (p.endsWith("/dependencies/blocked_by"))
		return page("blockedByPage", rows as unknown[]);
	throw new Error(`no recorded answer for route ${p}`);
}

const ghLog = () => path.join(sb.dir, "gh-argv.log");
const ghCalls = () =>
	fs.readFileSync(ghLog(), "utf8").trim().split("\n").filter(Boolean);

const mapAsAlice = (n: number, gh: string, args: string[] = []) =>
	runInProcessAsync(FRONTIER, ["--map", String(n), ...args], {
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
	it("names an issue a live session holds a claim on", async () => {
		claimBy("alice", "702");
		fakeClaude(["alice"]);
		const r = await asAlice();
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/^#702\talice\tsince /m);
	});

	it("omits the claim of a session the oracle does not list, so that issue reaches the frontier", async () => {
		claimBy("bob", "633");
		fakeClaude(["alice"]);
		const r = await asAlice();
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("No issues are claimed by a live session.\n");
	});

	it("omits the claim of a session the oracle lists as stopped (#619)", async () => {
		claimBy("bob", "633");
		fakeClaude([
			"alice",
			{ sessionId: "bob", kind: "background", state: "stopped" },
		]);
		const r = await asAlice();
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("No issues are claimed by a live session.\n");
	});

	it("drops only the dead session's claim, keeping the live one beside it", async () => {
		claimBy("alice", "702");
		claimBy("bob", "633");
		fakeClaude(["alice"]);
		const r = await asAlice();
		expect(r.stdout).toMatch(/#702\talice/);
		expect(r.stdout).not.toMatch(/#633\tbob/);
	});

	it("keeps every claim when the oracle cannot be read, and says so", async () => {
		claimBy("bob", "633");
		fakeClaude([], 1);
		const r = await asAlice();
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/^#633\tbob\tsince /m);
		expect(r.stderr).toMatch(/agents --json/);
		expect(r.stderr).toMatch(/may in fact be free/);
	});

	it("keeps every claim when the oracle omits the calling session (mantahostels#437)", async () => {
		claimBy("bob", "633");
		fakeClaude(["carol"]);
		const r = await asAlice();
		expect(r.stdout).toMatch(/^#633\tbob\tsince /m);
		expect(r.stderr).toMatch(/every claim below stands/);
	});

	it("never reports an empty exclusion set for a store it could not read (mantahostels#174)", async () => {
		if (AS_ROOT) return;
		fs.mkdirSync(store.paths.issueClaimsDir(), { recursive: true });
		fs.chmodSync(store.paths.issueClaimsDir(), 0o000);
		try {
			const r = await asAlice();
			expect(r.status).toBe(1);
			expect(r.stderr).toMatch(/unknown — not nothing/);
			expect(r.stdout).not.toMatch(/No issues are claimed/);
		} finally {
			fs.chmodSync(store.paths.issueClaimsDir(), 0o755);
		}
	});

	it("says plainly that nothing is claimed when nothing is", async () => {
		fakeClaude(["alice"]);
		const r = await asAlice();
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("No issues are claimed by a live session.\n");
	});

	it("refuses rather than offering a short frontier on a corrupt claim record (mantahostels#1186)", async () => {
		claimBy("bob", "633");
		fs.writeFileSync(
			path.join(store.paths.issueClaimsDir(), "bogus.json"),
			"not json",
		);
		fakeClaude(["alice", "bob"]);
		const r = await asAlice();
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/could not be read and .* dropped/);
		expect(r.stdout).toBe("");
	});

	it("orders the live claims by issue number", async () => {
		claimBy("alice", "702");
		claimBy("carol", "97");
		claimBy("dave", "645");
		fakeClaude(["alice", "carol", "dave"]);
		const numbers = (await asAlice()).stdout
			.trim()
			.split("\n")
			.map((l) => Number(l.split("\t")[0].slice(1)));
		expect(numbers).toEqual([97, 645, 702]);
	});

	it("keeps every claim when the oracle lists nobody at all", async () => {
		claimBy("bob", "633");
		fakeClaude([]);
		const r = await asAlice();
		expect(r.stdout).toMatch(/^#633\tbob\tsince /m);
		expect(r.stderr).toMatch(/every claim below stands/);
	});

	describe("--numbers, the form the frontier query's shell step consumes", () => {
		it("prints bare issue numbers, one per line, and nothing else", async () => {
			claimBy("alice", "702");
			claimBy("carol", "97");
			fakeClaude(["alice", "carol"]);
			const r = await asAlice(["--numbers"]);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("97\n702\n");
		});

		it("prints nothing at all when nothing is claimed", async () => {
			fakeClaude(["alice"]);
			const r = await asAlice(["--numbers"]);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("");
		});

		it("still exits non-zero on an unreadable store, printing no numbers", async () => {
			if (AS_ROOT) return;
			fs.mkdirSync(store.paths.issueClaimsDir(), { recursive: true });
			fs.chmodSync(store.paths.issueClaimsDir(), 0o000);
			try {
				const r = await asAlice(["--numbers"]);
				expect(r.status).toBe(1);
				expect(r.stdout).toBe("");
			} finally {
				fs.chmodSync(store.paths.issueClaimsDir(), 0o755);
			}
		});
	});

	it("announces a claim store belonging to a different tree (mantahostels#703's shape)", async () => {
		const other = emptyRepo.instantiate(path.join(sb.dir, "elsewhere"));
		fakeClaude(["alice"]);
		const r = await asAlice([], other);
		expect(r.stderr).toMatch(/not the tree you are in/);
		expect(r.stderr).toMatch(/not that nothing is claimed/);
	});

	it("writes no claim of its own, and disturbs none that exist", async () => {
		claimBy("bob", "610");
		const before = JSON.stringify(store.listIssueClaims());
		fakeClaude(["alice"]);
		await asAlice();
		expect(JSON.stringify(store.listIssueClaims())).toBe(before);
		expect(listedClaims().map((c) => c.sessionId)).not.toContain("alice");
	});

	it("refuses an unrecognised argument rather than printing the human format", async () => {
		fakeClaude(["alice"]);
		claimBy("bob", "610");
		const r = await asAlice(["--number"]);
		expect(r.status).toBe(2);
		expect(r.stdout).toBe("");
		expect(r.stderr).toMatch(/unknown flag: --number/);
		expect(r.stderr).toMatch(/usage:/);
	});

	it("prints each claimed issue once, however many sessions claimed it", async () => {
		claimBy("bob", "610");
		claimBy("carol", "610");
		fakeClaude(["alice", "bob", "carol"]);
		expect((await asAlice(["--numbers"])).stdout).toBe("610\n");
	});

	it("--numbers keeps every claim when the oracle cannot be read, and says so", async () => {
		claimBy("bob", "610");
		fakeClaude([], 1);
		const r = await asAlice(["--numbers"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("610\n");
		expect(r.stderr).toMatch(/every claim below stands/);
	});

	describe("--map, the whole frontier query in one call (mantahostels#1145)", () => {
		it("prints the map's open, unblocked, unclaimed children in map order", async () => {
			fakeClaude(["alice"]);
			const gh = fakeGh(
				mapWith(1080, [
					[1145, "open"],
					[1114, "open"],
					[1086, "open"],
				]),
			);
			const r = await mapAsAlice(1080, gh);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("1145\n1114\n1086\n");
		});

		it("drops a child that already has an open blocker", async () => {
			fakeClaude(["alice"]);
			const routes = mapWith(1080, [
				[1145, "open"],
				[1114, "open"],
			]);
			routes[blockedBy(1114)] = [{ number: 1086, state: "open" }];
			const r = await mapAsAlice(1080, fakeGh(routes));
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("1145\n");
		});

		it("keeps a child whose every blocker is closed", async () => {
			fakeClaude(["alice"]);
			const routes = mapWith(1080, [[1145, "open"]]);
			routes[blockedBy(1145)] = [{ number: 1086, state: "closed" }];
			expect((await mapAsAlice(1080, fakeGh(routes))).stdout).toBe("1145\n");
		});

		it("drops a closed child", async () => {
			fakeClaude(["alice"]);
			const gh = fakeGh(
				mapWith(1080, [
					[1145, "open"],
					[1114, "closed"],
				]),
			);
			expect((await mapAsAlice(1080, gh)).stdout).toBe("1145\n");
		});

		it("drops a child a live session holds a claim on", async () => {
			claimBy("bob", "1145");
			fakeClaude(["alice", "bob"]);
			const gh = fakeGh(
				mapWith(1080, [
					[1145, "open"],
					[1114, "open"],
				]),
			);
			expect((await mapAsAlice(1080, gh)).stdout).toBe("1114\n");
		});

		it("keeps a child assigned by a session that has finished (mantahostels#633)", async () => {
			claimBy("bob", "1145");
			fakeClaude(["alice"]);
			const gh = fakeGh(mapWith(1080, [[1145, "open"]]));
			expect((await mapAsAlice(1080, gh)).stdout).toBe("1145\n");
		});

		it("drops a kind:spec child and an unlabelled one, naming each on stderr (#579)", async () => {
			fakeClaude(["alice"]);
			const routes = mapWith(1080, [[1145, "open"]]);
			(routes[subIssues(1080)] as unknown[]).push(
				{ number: 412, state: "open", labels: [{ name: "kind:spec" }] },
				{ number: 483, state: "open", labels: [{ name: "takes:children" }] },
			);
			const r = await mapAsAlice(1080, fakeGh(routes));
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("1145\n");
			expect(r.stderr).toMatch(/#412 is a kind:spec/);
			expect(r.stderr).toMatch(/#483 carries no wayfinder:<type> label/);
			const calls = ghCalls().join("\n");
			expect(calls).not.toContain(blockedBy(412));
			expect(calls).not.toMatch(/i412: issue/);
		});

		it("names a kind:brief child as an expected drop, not a missing label (#579)", async () => {
			fakeClaude(["alice"]);
			const routes = mapWith(1080, [[1145, "open"]]);
			(routes[subIssues(1080)] as unknown[]).push({
				number: 509,
				state: "open",
				labels: [{ name: "kind:brief" }, { name: "takes:children" }],
			});
			const r = await mapAsAlice(1080, fakeGh(routes));
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("1145\n");
			expect(r.stderr).toMatch(/#509 is a kind:brief/);
			expect(r.stderr).not.toMatch(/#509 carries no/);
		});

		it("is silent at exit 0 when every open child is untyped, bar the drop notes (#579)", async () => {
			fakeClaude(["alice"]);
			const gh = fakeGh({
				[subIssues(1080)]: [
					{ number: 412, state: "open", labels: [{ name: "kind:spec" }] },
				],
			});
			const r = await mapAsAlice(1080, gh);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("");
			expect(r.stderr).toMatch(/#412 is a kind:spec/);
		});

		it("keeps a nested map, whose wayfinder:map is a wayfinder label (#579)", async () => {
			fakeClaude(["alice"]);
			const routes = mapWith(1080, [[1145, "open"]]);
			(routes[subIssues(1080)] as { labels: unknown }[])[0].labels = [
				{ name: "wayfinder:map" },
			];
			const r = await mapAsAlice(1080, fakeGh(routes));
			expect(r.stdout).toBe("1145\n");
			expect(r.stderr).toBe("");
		});

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

		it("drops a child gated until a date still ahead", async () => {
			fakeClaude(["alice"]);
			const gh = fakeGh(
				gatedMap("**Gated until:** 2099-01-01 — the corpus is not deep enough"),
			);
			const r = await mapAsAlice(1080, gh);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("1114\n");
		});

		it("keeps a child whose gate date has passed", async () => {
			fakeClaude(["alice"]);
			const gh = fakeGh(
				gatedMap("**Gated until:** 2020-01-01 — long since due"),
			);
			expect((await mapAsAlice(1080, gh)).stdout).toBe("1145\n1114\n");
		});

		it("gates nothing when a body carries both markers, and says so (mantahostels#1333)", async () => {
			fakeClaude(["alice"]);
			const gh = fakeGh(
				gatedMap(
					"**Gated until:** 2099-01-01 — not yet\n\n**Gated on:** the desk replies — abandon if: we ship without them",
				),
			);
			const r = await mapAsAlice(1080, gh);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("1145\n1114\n");
			expect(r.stderr).toMatch(/#1145 carries both/);
		});

		it("gates nothing on both markers even where the date has lapsed (mantahostels#1333)", async () => {
			fakeClaude(["alice"]);
			const gh = fakeGh(
				gatedMap(
					"**Gated until:** 2020-01-01 — long past\n\n**Gated on:** the desk replies — abandon if: we ship without them",
				),
			);
			expect((await mapAsAlice(1080, gh)).stdout).toBe("1145\n1114\n");
		});

		it("drops a child held by a condition gate (mantahostels#2706)", async () => {
			fakeClaude(["alice"]);
			const gh = fakeGh(
				gatedMap(
					"**Gated on:** the affiliate desk replies — abandon if: we ship without them",
				),
			);
			expect((await mapAsAlice(1080, gh)).stdout).toBe("1114\n");
		});

		it("keeps a child whose gate will not parse, and says which (mantahostels#633's shape)", async () => {
			fakeClaude(["alice"]);
			const gh = fakeGh(gatedMap("**Gated until:** next Tuesday sometime"));
			const r = await mapAsAlice(1080, gh);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("1145\n1114\n");
			expect(r.stderr).toMatch(/#1145 carries a \*\*Gated until:\*\* line/);
		});

		it("keeps a child whose condition gate will not parse, and says which (mantahostels#2706)", async () => {
			fakeClaude(["alice"]);
			const gh = fakeGh(gatedMap("**Gated on:** the desk replies"));
			const r = await mapAsAlice(1080, gh);
			expect(r.stdout).toBe("1145\n1114\n");
			expect(r.stderr).toMatch(/#1145 carries a \*\*Gated on:\*\* line/);
		});

		it("spends no extra API call on the gate filter", async () => {
			fakeClaude(["alice"]);
			const gh = fakeGh(
				gatedMap("**Gated until:** 2099-01-01 — the corpus is not deep enough"),
			);
			await mapAsAlice(1080, gh);
			const paths = ghCalls().map((l) => l.split(" ")[1]);
			expect(paths.sort()).toEqual([subIssues(1080), "graphql"].sort());
		});

		it("refuses, printing nothing, when the map's children cannot be read", async () => {
			fakeClaude(["alice"]);
			const gh = fakeGh({}, [subIssues(1080)]);
			const r = await mapAsAlice(1080, gh);
			expect(r.status).toBe(1);
			expect(r.stdout).toBe("");
			expect(r.stderr).toMatch(/could not read the children of #1080/);
			expect(r.stderr).toMatch(/unknown — not empty/);
		});

		it("refuses the whole run when one child's blockers cannot be read, naming the child and printing no frontier", async () => {
			fakeClaude(["alice"]);
			const routes = mapWith(1080, [
				[1145, "open"],
				[1114, "open"],
			]);
			const r = await mapAsAlice(1080, fakeGh(routes, [blockedBy(1114)]));
			expect(r.status).toBe(1);
			expect(r.stdout).toBe("");
			expect(r.stderr).toMatch(/could not read the blockers of #1114/);
		});

		it("never reads the stale issue_dependencies_summary field", async () => {
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
			expect((await mapAsAlice(1080, fakeGh(routes))).stdout).toBe("1145\n");
		});

		it("refuses an unreadable claim store rather than offering a frontier", async () => {
			if (AS_ROOT) return;
			fakeClaude(["alice"]);
			const gh = fakeGh(mapWith(1080, [[1145, "open"]]));
			fs.mkdirSync(store.paths.issueClaimsDir(), { recursive: true });
			fs.chmodSync(store.paths.issueClaimsDir(), 0o000);
			try {
				const r = await mapAsAlice(1080, gh);
				expect(r.status).toBe(1);
				expect(r.stdout).toBe("");
				expect(r.stderr).toMatch(/unknown — not nothing/);
			} finally {
				fs.chmodSync(store.paths.issueClaimsDir(), 0o755);
			}
		});

		it("warns on stderr that every claim stands, and still answers, when the liveness oracle cannot be read", async () => {
			claimBy("bob", "1145");
			fakeClaude([], 1);
			const gh = fakeGh(
				mapWith(1080, [
					[1145, "open"],
					[1114, "open"],
				]),
			);
			const r = await mapAsAlice(1080, gh);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("1114\n");
			expect(r.stderr).toMatch(/every claim below stands/);
		});

		it("refuses outright when the claim store belongs to another tree, printing no frontier", async () => {
			claimBy("bob", "1145");
			fakeClaude(["alice", "bob"]);
			const other = emptyRepo.instantiate(path.join(sb.dir, "elsewhere-map"));
			const gh = fakeGh(
				mapWith(1080, [
					[1145, "open"],
					[1114, "open"],
				]),
			);
			const r = await runInProcessAsync(FRONTIER, ["--map", "1080"], {
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

		it("refuses when it cannot even tell whose tree the claim store is, saying it is not in a git repository and printing no frontier", async () => {
			claimBy("bob", "1145");
			fakeClaude(["alice", "bob"]);
			const nowhere = path.join(sb.dir, "not-a-repo");
			fs.mkdirSync(nowhere, { recursive: true });
			const gh = fakeGh(mapWith(1080, [[1145, "open"]]));
			const r = await runInProcessAsync(FRONTIER, ["--map", "1080"], {
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

		it("refuses a blocker read that exits 0 having printed nothing, and prints no frontier", async () => {
			fakeClaude(["alice"]);
			const gh = stubGhRoutes(sb.dir, {
				graphql: printed(),
				"*": printed(),
			}).gh;
			const r = await mapAsAlice(1080, gh);
			expect(r.status).toBe(1);
			expect(r.stdout).toBe("");
			expect(r.stderr).toMatch(/printed nothing/);
		});

		it("refuses a map with no sub-issues at all rather than calling it clear", async () => {
			fakeClaude(["alice"]);
			const gh = fakeGh({ [subIssues(1080)]: [] });
			const r = await mapAsAlice(1080, gh);
			expect(r.status).toBe(1);
			expect(r.stdout).toBe("");
			expect(r.stderr).toMatch(/no sub-issues at all/);
		});

		it("is silent at exit 0 for a map whose children exist but are all closed", async () => {
			fakeClaude(["alice"]);
			const gh = fakeGh(mapWith(1080, [[1145, "closed"]]));
			const r = await mapAsAlice(1080, gh);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("");
			expect(r.stderr).toBe("");
		});

		it("writes nothing to the tracker — every call it makes is a GET", async () => {
			fakeClaude(["alice"]);
			const gh = fakeGh(mapWith(1080, [[1145, "open"]]));
			await mapAsAlice(1080, gh);
			const calls = ghCalls();
			expect(calls.join("\n")).not.toMatch(/--method|-X POST/);
			expect(calls.join("\n")).not.toMatch(/mutation/);
			expect(calls.length).toBe(2);
		});

		it("refuses --map with no number, and --map with a non-number", async () => {
			fakeClaude(["alice"]);
			const gh = fakeGh({});
			const bare = await runInProcessAsync(FRONTIER, ["--map"], {
				cwd: sb.repo,
				env: { ...process.env, WFC_CLAUDE_BIN: oracle(), WFC_GH: gh },
			});
			expect(bare.status).toBe(2);
			expect(bare.stderr).toMatch(/--map needs a value/);

			const junk = await runInProcessAsync(FRONTIER, ["--map", "wibble"], {
				cwd: sb.repo,
				env: { ...process.env, WFC_CLAUDE_BIN: oracle(), WFC_GH: gh },
			});
			expect(junk.status).toBe(2);
			expect(junk.stdout).toBe("");
			expect(junk.stderr).toMatch(/wants an issue number, not wibble/);
		});

		it("refuses --numbers and --map together rather than guessing", async () => {
			fakeClaude(["alice"]);
			const gh = fakeGh({});
			const r = await mapAsAlice(1080, gh, ["--numbers"]);
			expect(r.status).toBe(2);
			expect(r.stdout).toBe("");
			expect(r.stderr).toMatch(/alternatives, not a pair/);
		});
	});
});
