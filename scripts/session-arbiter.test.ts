// @vitest-environment node

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AgentsAnswer,
	buildAgentsBranch,
	buildListedRow,
	buildUnrecordedRow,
} from "./lib/agents-stop-fake";
import {
	AS_ROOT,
	commitAll,
	core,
	fakeGh,
	freshSandbox,
	ghCallCount,
	gitRepo,
	listedLocks,
	live,
	proc,
	registerSession,
	removeSandbox,
	SCRIPT,
	store,
} from "./lib/arbiter-testkit";
import { writeClaudeStub } from "./lib/claude-stub";
import { commandPath } from "./lib/command-path-testkit";
import { coreFile } from "./lib/core-path-testkit";
import { throughFullPipe } from "./lib/full-pipe-testkit";
import { printed as ghPrinted } from "./lib/gh-stub";
import { writeFaultyGit } from "./lib/git-fault-fake";
import { runCore } from "./lib/guard-core-testkit";
import { keptSpawn } from "./lib/kept-spawn.js";
import { buildRunIo, releaseClaimsRow } from "./lib/post-commit-steps.js";
import { runInProcess } from "./lib/run-in-process";
import { shellQuote } from "./lib/sh-quote.js";
import { writeSystemdRun } from "./lib/systemd-run-fake";

const { gh } = createRequire(__filename)("./lib/gh.js");
const hookRecord = createRequire(__filename)("./lib/hook-record.js");
const markerRoot = createRequire(__filename)("./lib/marker-root.js");
const oracleCache = createRequire(__filename)("./lib/oracle-cache.js");
const { claudeBin: claudePrimitive, listedSessionIds } = createRequire(
	__filename,
)("./lib/agent-liveness.js");
const { attributeDirty } = createRequire(__filename)("./lib/own-selection.js");

const sb = freshSandbox();
const buildOracleKey = (bin: string) =>
	JSON.stringify([bin, fs.realpathSync(sb.home)]);

const CLOSED = { "*": ghPrinted('{"state":"CLOSED"}\n') };

const writeOracle = (bin: string, answer: AgentsAnswer, callLog?: string) => {
	fs.mkdirSync(path.dirname(bin), { recursive: true });
	return writeClaudeStub(bin, [buildAgentsBranch(answer, {}, callLog)]);
};

const cli = (args: string[], env: Record<string, string> = {}) =>
	runInProcess(SCRIPT, args, { cwd: sb.repo, env: { ...process.env, ...env } });

const out = (args: string[]) => {
	const r = runInProcess(SCRIPT, args, { cwd: sb.repo });
	if (r.status !== 0)
		throw new Error(
			`session-arbiter.js ${args.join(" ")} exited ${r.status}\n${r.stdout}${r.stderr}`,
		);
	return r.stdout;
};

const readRecoveredBlob = (context: string, prune = false) => {
	const sha = context.match(/git cat-file -p ([0-9a-f]{40,64})/)?.[1];
	expect(sha).toBeTruthy();
	if (prune) execFileSync("git", ["gc", "--prune=now", "-q"], { cwd: sb.repo });
	return execFileSync("git", ["cat-file", "-p", sha as string], {
		cwd: sb.repo,
		encoding: "utf8",
	});
};

const readRefs = () =>
	execFileSync(
		"git",
		["for-each-ref", "--format=%(refname)", "refs/arbiter/"],
		{
			cwd: sb.repo,
			encoding: "utf8",
		},
	)
		.split("\n")
		.filter(Boolean);

const inRepo = (rel: string) => path.join(sb.repo, rel);

const listedPaths = () => listedLocks().map((l) => l.path);

describe("the sandbox's isolation from the machine (mantahostels#1902)", () => {
	const sandboxOf = (name: string) => path.join(sb.dir, "stubs", name);

	it("answers the liveness oracle with no shim of the case's own, rather than refusing", () => {
		const listed = listedSessionIds();
		expect(listed.why).toBeUndefined();
		expect([...listed.ids]).toEqual(["sandbox"]);
	});

	it("routes an unstubbed gh call to a stub that refuses", () => {
		const unstubbed = sandboxOf("bin/gh");
		expect(process.env.WFC_GH).toBe(unstubbed);
		const r = spawnSync(unstubbed, ["issue", "view", "1"], {
			encoding: "utf8",
		});
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain("unstubbed gh call");
	});

	it("still lets fakeGh take the gh seam from the default", () => {
		const stub = fakeGh(sb, CLOSED);
		expect(process.env.WFC_GH).toBe(stub);
		expect(ghCallCount(sb)).toBe(0);
	});

	const refusalOf = (bin: string, stubVar: string) =>
		`arbiter sandbox: bare ${bin} call off ${stubVar}: --version`;

	describe.each([
		{
			bin: "gh",
			stubVar: "WFC_GH",
			belt: path.join(__dirname, "lib/arbiter-belt/gh"),
		},
		{
			bin: "claude",
			stubVar: "WFC_CLAUDE_BIN",
			belt: path.join(__dirname, "lib/arbiter-belt/claude"),
		},
	])(
		"a bare $bin, which no var routes, stops at the PATH belt (#4089, #4103)",
		({ bin, stubVar, belt }) => {
			const refusal = refusalOf(bin, stubVar);

			it("resolves the bare name to the tracked belt", () => {
				expect(commandPath(bin)).toBe(belt);
			});

			it("refuses a literal spawn and a child shell's own call, and answers none of the stub", () => {
				const spawned = spawnSync(bin, ["--version"], { encoding: "utf8" });
				expect(spawned.status).toBe(1);
				expect(spawned.stdout).toBe("");
				expect(spawned.stderr).toContain(refusal);
				const shell = spawnSync("sh", ["-c", `${bin} --version`], {
					encoding: "utf8",
				});
				expect(shell.status).toBe(1);
				expect(shell.stderr).toContain(refusal);
			});

			it("still refuses a detached child calling after its sandbox is gone", async () => {
				const child = spawn("sh", ["-c", `read -r _; ${bin} --version`], {
					detached: true,
					stdio: ["pipe", "ignore", "pipe"],
				});
				let stderr = "";
				child.stderr.on("data", (chunk) => {
					stderr += chunk;
				});
				const closed = new Promise((resolve) => child.on("close", resolve));
				removeSandbox(sb.dir);
				child.stdin.end("go\n");
				expect(await closed).toBe(1);
				expect(stderr).toContain(refusal);
			});
		},
	);

	it("refuses each primitive's own fallback once its var is gone", () => {
		vi.stubEnv("WFC_GH", undefined);
		expect(() => gh(["--version"])).toThrow(refusalOf("gh", "WFC_GH"));
		vi.stubEnv("WFC_CLAUDE_BIN", undefined);
		const r = spawnSync(claudePrimitive(), ["--version"], { encoding: "utf8" });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(refusalOf("claude", "WFC_CLAUDE_BIN"));
	});

	it("answers none of a fakeGh, so a caller off the var fails its test rather than passing it", () => {
		fakeGh(sb, CLOSED);
		const r = spawnSync("gh", ["--version"], { encoding: "utf8" });
		expect(r.status).toBe(1);
		expect(r.stdout).toBe("");
		expect(ghCallCount(sb)).toBe(0);
	});

	it("stubs claude at WFC_CLAUDE_BIN alone, never on PATH", () => {
		expect(process.env.WFC_CLAUDE_BIN).toBe(sandboxOf("claude"));
		expect(process.env.PATH?.split(path.delimiter)).not.toContain(
			path.dirname(sandboxOf("claude")),
		);
	});
});

describe("the CLI, as the hook and the scripts invoke it", () => {
	it("says nothing about an unguarded path", () => {
		expect(out(["check", inRepo("app/page.tsx")])).toBe("");
	});

	it("says nothing when the file is free", () => {
		registerSession(sb, "a", process.pid);
		expect(out(["check", inRepo("docs/other.md"), "a"])).toBe("");
	});

	it("lets the write through on a held file, warning of the merge conflict and naming the holder (#4249)", () => {
		registerSession(sb, "alice", process.pid);
		store.acquire("docs/doc-map.md", store.identify("alice"));
		registerSession(sb, "bob", process.pid);
		const json = JSON.parse(out(["check", inRepo("docs/doc-map.md"), "bob"]));
		expect(json.hookSpecificOutput.permissionDecision).toBeUndefined();
		const said = json.hookSpecificOutput.additionalContext;
		expect(said).toContain("docs/doc-map.md is also held by session alice");
		expect(said).toContain("likely meet a merge conflict");
		expect(store.readHeldBy("bob")).toEqual([]);
		expect(store.readHeldBy("alice")).toEqual(["docs/doc-map.md"]);
	});

	it("lets a script go on with exit 0 on a held file, warning and naming the holder (#4249)", () => {
		registerSession(sb, "alice", process.pid);
		store.acquire("docs/roadmap-digest.md", store.identify("alice"));
		registerSession(sb, "bob", process.pid);

		const held = cli(["claim", inRepo("docs/roadmap-digest.md"), "bob"]);
		expect(held.status).toBe(0);
		expect(held.stderr).toContain(
			"docs/roadmap-digest.md is also held by session alice",
		);

		expect(cli(["claim", inRepo("docs/free.md"), "bob"]).status).toBe(0);
	});

	it("exits 2 with usage on an unknown subcommand", () => {
		const r = cli(["frobnicate"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("usage");
	});

	it("exits 0 when its registry is unreachable, but says the write is unprotected", () => {
		const r = cli(["check", inRepo("docs/doc-map.md"), "a"], {
			CLAUDE_CONFIG_DIR: "/dev/null/nope",
		});
		expect(r.status).toBe(0);
		const json = JSON.parse(r.stdout);
		expect(json.hookSpecificOutput.permissionDecision).toBeUndefined();
		expect(json.hookSpecificOutput.additionalContext).toMatch(
			/store is unreadable/,
		);
	});

	it("the hook fails open when the arbiter hangs", () => {
		vi.stubEnv("CLAUDE_CONFIG_DIR", "/proc/nonexistent/nope");
		const file = inRepo("docs/doc-map.md");
		const r = runCore(
			"guard-file-claim",
			{
				session_id: "a",
				tool_name: "Edit",
				tool_input: { file_path: file },
			},
			{ root: sb.repo },
		);
		expect(r.output).toBeNull();
		expect(r.logs).toEqual([
			`arbiter timed out on ${file} — write allowed unchecked`,
		]);
	}, 40_000);
});

describe("logging once across PROCESSES, not once per process", () => {
	it("says a sessionless run takes no claims once, not on every write", () => {
		for (let i = 0; i < 2; i++) {
			cli(["check", inRepo("docs/doc-map.md"), ""], {
				CLAUDE_CODE_SESSION_ID: "",
			});
		}
		const lines = fs
			.readFileSync(store.errorLog(), "utf8")
			.split("\n")
			.filter(Boolean);
		expect(lines.length).toBe(1);
	});
});

describe("the release CLI, as the skill loops invoke it", () => {
	const run = (args: string[], sid: string) =>
		cli(args, { CLAUDE_CODE_SESSION_ID: sid });
	const docMap = () => inRepo("docs/doc-map.md");
	const liveId = (name: string) => {
		const { sessionId } = live(sb, name);
		assert(sessionId);
		return sessionId;
	};

	beforeEach(() => {
		gitRepo(sb);
		store.acquire("docs/doc-map.md", live(sb, "alice"));
	});

	it("says what it dropped on a released path, and nothing at all on an unguarded one", () => {
		const ok = run(["release", docMap()], "alice");
		expect(ok.status).toBe(0);
		expect(ok.stdout).toContain("Released docs/doc-map.md");
		const unguarded = run(["release", inRepo("app/page.tsx")], "alice");
		expect(unguarded.status).toBe(0);
		expect(unguarded.stdout).toBe("");
	});

	it("still drops a claim standing on an exempt path", () => {
		const scratch = ".claude/tmp/review-standards.md";
		store.acquire(scratch, live(sb, "alice"));
		const r = run(["release", inRepo(scratch)], "alice");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`Released ${scratch}`);
	});

	it("exits 0 saying nothing is claimed when the path is free", () => {
		run(["release", docMap()], "alice");
		const again = run(["release", docMap()], "alice");
		expect(again.status).toBe(0);
		expect(again.stdout).toContain("No claim on docs/doc-map.md");
	});

	it("exits 1 and names the holder when the caller is not it", () => {
		const r = run(["release", docMap()], liveId("bob"));
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("alice");
	});

	it("refuses a session id passed in argv, naming the argument and keeping the claim, so nobody can release as someone else", () => {
		const r = run(["release", docMap(), "alice"], liveId("bob"));
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/^unexpected argument: alice\n/);
		expect(listedPaths().includes("docs/doc-map.md")).toBe(true);
	});

	it("exits 1 with the reason when the path is dirty", () => {
		fs.writeFileSync(inRepo("docs/doc-map.md"), "half an edit\n");
		const r = run(["release", docMap()], "alice");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("uncommitted changes");
	});

	it.skipIf(AS_ROOT)(
		"exits 1 rather than reporting no claim when the store cannot be read (mantahostels#174)",
		() => {
			fs.chmodSync(store.paths.locksDir(), 0o000);
			try {
				const r = run(["release", docMap()], "alice");
				expect(r.status).toBe(1);
				expect(r.stdout).not.toContain("No claim");
				expect(r.stderr).toMatch(/could not read the claim store/);
			} finally {
				fs.chmodSync(store.paths.locksDir(), 0o755);
			}
		},
	);

	it("re-claims on the holder's next write, so a premature release self-heals", () => {
		run(["release", docMap()], "alice");
		const reclaim = JSON.parse(run(["check", docMap()], "alice").stdout);
		expect(reclaim.hookSpecificOutput.permissionDecision).toBeUndefined();
		expect(reclaim.hookSpecificOutput.additionalContext).toContain(
			"claims the WHOLE of",
		);

		const warned = JSON.parse(run(["check", docMap()], liveId("bob")).stdout);
		expect(warned.hookSpecificOutput.additionalContext).toContain(
			"also held by session alice",
		);
	});
});

describe("list tells an ENDED holder from a running one", () => {
	const rel = "docs/doc-map.md";
	const claudeBin = () => path.join(sb.dir, "bin", "claude");

	const fakeClaude = (state: string) =>
		writeOracle(claudeBin(), [
			state === "failed" || state === "stopped"
				? buildUnrecordedRow({ sessionId: "alice", kind: "background", state })
				: buildListedRow({ sessionId: "alice", state }),
			buildListedRow({ sessionId: "bob" }),
		]);

	const listAs = (sid: string) =>
		cli(["list"], {
			CLAUDE_CODE_SESSION_ID: sid,
			WFC_CLAUDE_BIN: claudeBin(),
		});

	beforeEach(() => {
		store.acquire(rel, live(sb, "alice"));
		live(sb, "bob");
	});

	it.each(["done", "failed", "stopped"])(
		"labels a holder the oracle calls %s as ENDED",
		(state) => {
			fakeClaude(state);
			expect(listAs("bob").stdout).toMatch(/ENDED.*docs\/doc-map\.md/);
		},
	);

	it("still says HELD for a holder the oracle calls working", () => {
		fakeClaude("working");
		expect(listAs("bob").stdout).toMatch(/HELD .*docs\/doc-map\.md/);
	});

	it("keeps the ENDED row in the default view and hides nothing", () => {
		fakeClaude("failed");
		const printed = listAs("bob").stdout;
		expect(printed).toContain("docs/doc-map.md");
		expect(printed).not.toContain("stale claim(s) hidden");
	});

	it("falls back to HELD where the oracle refuses", () => {
		writeOracle(claudeBin(), { exit: 3 });
		expect(listAs("bob").stdout).toMatch(/HELD .*docs\/doc-map\.md/);
	});
});

describe("list", () => {
	it("marks a live holder HELD and a dead one STALE under --all", () => {
		registerSession(sb, "alice", process.pid);
		store.acquire("docs/a-live.md", store.identify("alice"));
		store.acquire("docs/b-dead.md", {
			sessionId: "gone",
			pid: 4_194_303,
			procStart: "1",
			durable: true,
		});
		const printed = out(["list", "--all"]);
		expect(printed).toMatch(/HELD .*docs\/a-live\.md/);
		expect(printed).toMatch(/STALE.*docs\/b-dead\.md/);
	});

	describe("the default view is live claims only (mantahostels#1814)", () => {
		const bothKinds = () => {
			registerSession(sb, "alice", process.pid);
			store.acquire("docs/a-live.md", store.identify("alice"));
			store.acquire("docs/b-dead.md", {
				sessionId: "gone",
				pid: 4_194_303,
				procStart: "1",
				durable: true,
			});
		};

		it("keeps the HELD rows and drops the STALE ones", () => {
			bothKinds();
			const printed = out(["list"]);
			expect(printed).toMatch(/HELD .*docs\/a-live\.md/);
			expect(printed).not.toContain("STALE");
			expect(printed).not.toContain("docs/b-dead.md");
		});

		it("counts what it hid and names the flag that shows it (mantahostels#174)", () => {
			bothKinds();
			expect(out(["list"])).toContain(
				`1 stale claim(s) hidden — node ${coreFile("scripts/session-arbiter.js")} list --all`,
			);
		});

		it.skipIf(AS_ROOT)(
			"warns that a STALE row may be live when the registry will not open",
			() => {
				bothKinds();
				const dir = store.paths.sessionsDir();
				fs.chmodSync(dir, 0o000);
				try {
					const printed = out(["list"]);
					expect(printed).toContain("The sessions registry could not be read");
					expect(printed).toContain("may be a live holder resumed");
					expect(
						printed.split("The sessions registry could not be read"),
					).toHaveLength(2);
					expect(printed.indexOf("stale claim(s) hidden")).toBeLessThan(
						printed.indexOf("The sessions registry could not be read"),
					);
				} finally {
					fs.chmodSync(dir, 0o755);
				}
			},
		);

		it.skipIf(AS_ROOT)("warns under --all too, which hides nothing", () => {
			bothKinds();
			const dir = store.paths.sessionsDir();
			fs.chmodSync(dir, 0o000);
			try {
				const printed = out(["list", "--all"]);
				expect(printed).toContain("The sessions registry could not be read");
				expect(printed).not.toContain("stale claim(s) hidden");
			} finally {
				fs.chmodSync(dir, 0o755);
			}
		});

		it("says nothing about it when the registry opens", () => {
			bothKinds();
			expect(out(["list"])).not.toContain(
				"The sessions registry could not be read",
			);
		});

		it("says nothing about hiding when every claim is live", () => {
			registerSession(sb, "alice", process.pid);
			store.acquire("docs/a-live.md", store.identify("alice"));
			expect(out(["list"])).not.toContain("hidden");
		});

		it("does not call a store of stale claims empty", () => {
			store.acquire("docs/b-dead.md", {
				sessionId: "gone",
				pid: 4_194_303,
				procStart: "1",
				durable: true,
			});
			const printed = out(["list"]);
			expect(printed).not.toContain("No files are claimed.\n");
			expect(printed).toContain("No files are claimed by a live session.");
			expect(printed).toContain("1 stale claim(s) hidden");
		});

		it("keeps the ONE REGION marker on a live region claim", () => {
			registerSession(sb, "alice", process.pid);
			store.acquire(
				store.subjectFor("docs/doc-map.md", "B7"),
				store.identify("alice"),
			);
			store.acquire("docs/b-dead.md", {
				sessionId: "gone",
				pid: 4_194_303,
				procStart: "1",
				durable: true,
			});
			expect(out(["list"])).toContain("ONE REGION (B7)");
		});

		it("keeps an unreadable lock row — unreadable is not dead", () => {
			bothKinds();
			fs.writeFileSync(
				path.join(store.paths.locksDir(), "garbage.json"),
				"not json at all",
			);
			expect(out(["list"])).toContain("?????");
		});

		it("refuses a mistyped flag, naming it and the usage, rather than answering narrowly", () => {
			bothKinds();
			const r = cli(["list", "--al"]);
			expect(r.status).toBe(2);
			expect(r.stdout).toBe("");
			expect(r.stderr).toMatch(
				/^unknown flag: --al\n\nusage: session-arbiter\.js list \[--all\]/,
			);
		});

		it("exits 0 with or without the flag", () => {
			bothKinds();
			expect(cli(["list"]).status).toBe(0);
			expect(cli(["list", "--all"]).status).toBe(0);
		});
	});

	it("marks a RESUMED holder HELD, not STALE (mantahostels#359)", () => {
		registerSession(sb, "resumed", process.pid);
		store.acquire("docs/b-dead.md", {
			sessionId: "resumed",
			pid: 4_194_303,
			procStart: "1",
			durable: true,
		});
		expect(out(["list"])).toMatch(/HELD .*docs\/b-dead\.md/);
	});

	it("says so when nothing is claimed", () => {
		expect(out(["list"])).toContain("No files are claimed.");
	});

	it.skipIf(AS_ROOT)(
		"refuses to call an unreadable store empty (mantahostels#174)",
		() => {
			registerSession(sb, "alice", process.pid);
			store.acquire("docs/a-live.md", store.identify("alice"));
			fs.chmodSync(store.paths.locksDir(), 0o000);
			try {
				const r = cli(["list"]);
				expect(r.status).toBe(1);
				expect(r.stdout).not.toContain("No files are claimed.");
				expect(r.stderr).toMatch(/could not read the lock store/);
			} finally {
				fs.chmodSync(store.paths.locksDir(), 0o755);
			}
		},
	);
});

describe("naming a holder by its session name, not its id (mantahostels#1196)", () => {
	const rel = "docs/doc-map.md";
	const claudeBin = () => path.join(sb.dir, "bin", "claude");
	const calls = () => path.join(sb.dir, "claude-calls");

	type Named = [sessionId: string, name?: string];
	const rowsOf = (agents: Named[]) =>
		agents.map(([sessionId, name]) =>
			name
				? buildListedRow({ sessionId, name })
				: buildUnrecordedRow({ sessionId }),
		);
	const fakeClaude = (agents: Named[]) =>
		writeOracle(claudeBin(), rowsOf(agents), calls());
	const failClaude = (agents: Named[] = []) =>
		writeOracle(claudeBin(), { exit: 3, rows: rowsOf(agents) }, calls());

	const oracleCalls = () =>
		fs.existsSync(calls())
			? fs.readFileSync(calls(), "utf8").split("\n").filter(Boolean).length
			: 0;

	const runAs = (args: string[], sid: string) =>
		cli(args, { CLAUDE_CODE_SESSION_ID: sid, WFC_CLAUDE_BIN: claudeBin() });

	beforeEach(() => {
		const alice = live(sb, "alice");
		store.acquire(rel, alice);
		live(sb, "bob");
	});

	it("names the holder in a claim warning, keeping the id beside it", () => {
		fakeClaude([
			["alice", "Wayfinder 1162"],
			["bob", "Implement 1104"],
		]);
		const r = runAs(["claim", inRepo(rel)], "bob");
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("Wayfinder 1162");
		expect(r.stderr).toContain("alice");
	});

	it("renders the holder in full: name, id, pid and claimed-at (mantahostels#2452)", () => {
		fakeClaude([
			["alice", "Wayfinder 1162"],
			["bob", "Implement 1104"],
		]);
		const r = runAs(["claim", inRepo(rel)], "bob");
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(
			/Wayfinder 1162 \(id alice, pid \d+\) since \d{4}-\d{2}-\d{2}T/,
		);
	});

	it("names the holder in list", () => {
		fakeClaude([
			["alice", "Wayfinder 1162"],
			["bob", "Implement 1104"],
		]);
		const r = runAs(["list"], "bob");
		expect(r.stdout).toMatch(/HELD .*docs\/doc-map\.md.*Wayfinder 1162/);
	});

	it("names the holder from the sessions registry when the oracle cannot be read (#3557)", () => {
		registerSession(sb, "alice", process.ppid, { name: "Wayfinder 1162" });
		failClaude();
		const r = runAs(["claim", inRepo(rel)], "bob");
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(/Wayfinder 1162 \(id alice, pid \d+\)/);
	});

	it("names the holder from the sessions registry on the hook path, still with no oracle call", () => {
		registerSession(sb, "alice", process.ppid, { name: "Wayfinder 1162" });
		fakeClaude([["alice", "Wayfinder 1162"]]);
		const r = runAs(["check", inRepo(rel), "bob"], "bob");
		expect(r.stdout).toContain("Wayfinder 1162 (id alice");
		expect(oracleCalls()).toBe(0);
	});

	it("names the holder in list from the sessions registry when the oracle cannot be read", () => {
		registerSession(sb, "alice", process.ppid, { name: "Wayfinder 1162" });
		failClaude();
		const r = runAs(["list"], "bob");
		expect(r.stdout).toMatch(/HELD .*docs\/doc-map\.md.*Wayfinder 1162/);
	});

	it("names the claimant in issue-claims from the sessions registry", () => {
		registerSession(sb, "alice", process.ppid, { name: "Wayfinder 1162" });
		failClaude();
		store.claimIssue(645, store.identify("alice"));
		expect(runAs(["issue-claims"], "bob").stdout).toMatch(
			/^#645\tWayfinder 1162 \(id alice\)\tsince /m,
		);
	});

	it("falls back to the bare id when neither the oracle nor the registry names it", () => {
		failClaude([
			["alice", "Wayfinder 1162"],
			["bob", "Implement 1104"],
		]);
		const r = runAs(["claim", inRepo(rel)], "bob");
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("alice");
		expect(r.stderr).not.toContain("Wayfinder 1162");
	});

	it("falls back to the bare id for a holder the oracle lists without a name", () => {
		fakeClaude([["alice"], ["bob"]]);
		const r = runAs(["claim", inRepo(rel)], "bob");
		expect(r.stderr).toContain("alice");
	});

	it("reads the oracle once per process, however many holders it names", () => {
		fakeClaude([
			["alice", "Wayfinder 1162"],
			["bob", "Implement 1104"],
		]);
		store.acquire("docs/operating-manual.md", live(sb, "alice"));
		const r = runAs(["list"], "bob");
		expect(r.stdout).toContain("Wayfinder 1162");
		expect(oracleCalls()).toBe(1);
	});

	it("makes NO oracle call on the hook path, which mantahostels#411 bars it from", () => {
		fakeClaude([["alice", "Wayfinder 1162"]]);
		const r = runAs(["check", inRepo(rel), "bob"], "bob");
		expect(r.stdout).toContain("also held by session");
		expect(r.stdout).toContain("alice");
		expect(oracleCalls()).toBe(0);
	});
});

describe("versions — the pull-mode reader for the holder's own clobber (mantahostels#438)", () => {
	const rel = "scripts/evidence-audit.py";

	beforeEach(() => {
		gitRepo(sb);
		fs.mkdirSync(path.join(sb.repo, "scripts"), { recursive: true });
		registerSession(sb, "alice", process.pid);
	});

	const aliceWrites = (text: string) => {
		out(["check", inRepo(rel), "alice"]);
		fs.writeFileSync(inRepo(rel), text);
		out(["record", inRepo(rel), "alice"]);
	};

	it("prints each version newest first with a recovery command that works", () => {
		aliceWrites("alice's uncommitted work\n");
		aliceWrites("restored from a backup\n");

		const printed = out(["versions", inRepo(rel)]);
		expect(printed).toContain(rel);
		expect(printed).toContain("alice");

		const shas = [
			...printed.matchAll(/git cat-file -p ([0-9a-f]{40,64})/g),
		].map((m) => m[1]);
		expect(shas.length).toBe(2);
		expect(
			shas.map((sha) =>
				execFileSync("git", ["cat-file", "-p", sha], {
					cwd: sb.repo,
					encoding: "utf8",
				}),
			),
		).toEqual(["restored from a backup\n", "alice's uncommitted work\n"]);
	});

	it("prints no recovery command for a version git has already pruned", () => {
		aliceWrites("v1\n");
		aliceWrites("v2\n");
		execFileSync("git", ["gc", "--prune=now", "-q"], { cwd: sb.repo });

		const printed = out(["versions", inRepo(rel)]);
		expect(printed).toContain("GONE");
		expect([...printed.matchAll(/git cat-file -p /g)].length).toBe(1);
	});

	it("says so, and exits 0, where nothing holds the path", () => {
		fs.writeFileSync(inRepo(rel), "unclaimed\n");
		const r = cli(["versions", inRepo(rel)]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("No claim on");
	});

	const unguardedWrite = (text: string) => {
		fs.writeFileSync(inRepo(rel), text);
		out(["record", inRepo(rel), "alice"]);
	};

	it("reports an unclaimed writer's own pinned bytes, which the rule text sends it here for (mantahostels#2374)", () => {
		unguardedWrite("alice's unclaimed work\n");
		fs.writeFileSync(inRepo(rel), "restored from a backup\n");

		const r = cli(["versions", inRepo(rel)], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});

		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("No claim on");
		expect(r.stdout).toContain("THIS session");
		const sha = r.stdout.match(/git cat-file -p ([0-9a-f]{40,64})/)?.[1];
		expect(
			execFileSync("git", ["cat-file", "-p", sha as string], {
				cwd: sb.repo,
				encoding: "utf8",
			}),
		).toBe("alice's unclaimed work\n");
	});

	it("prints the holder's versions AND the reader's own, each said to be whose (mantahostels#2374)", () => {
		registerSession(sb, "bob", process.ppid);
		aliceWrites("alice's uncommitted work\n");
		out(["check", inRepo(rel), "bob"]);
		fs.writeFileSync(inRepo(rel), "bob's uncommitted work\n");
		out(["record", inRepo(rel), "bob"]);

		const r = cli(["versions", inRepo(rel)], {
			CLAUDE_CODE_SESSION_ID: "bob",
		});

		expect(r.status).toBe(0);
		expect(r.stdout).toContain("claimed by");
		expect(r.stdout).toContain("alice");
		expect(r.stdout).toContain("THIS session");
		const shas = [
			...r.stdout.matchAll(/git cat-file -p ([0-9a-f]{40,64})/g),
		].map((m) =>
			execFileSync("git", ["cat-file", "-p", m[1]], {
				cwd: sb.repo,
				encoding: "utf8",
			}),
		);
		expect(shas).toContain("alice's uncommitted work\n");
		expect(shas).toContain("bob's uncommitted work\n");
	});

	const corrupt = (file: string) => fs.writeFileSync(file, "{not json");

	it("says the CLAIM record would not read rather than reporting no claim (mantahostels#2382)", () => {
		aliceWrites("alice's uncommitted work\n");
		corrupt(store.paths.lock(rel));

		const r = cli(["versions", inRepo(rel)]);
		expect(r.status).toBe(1);
		expect(r.stdout).not.toContain("No claim on");
		expect(r.stdout).toContain("WOULD NOT READ (unparseable)");
		expect(r.stdout).toContain(store.paths.lock(rel));
		expect(r.stdout).toContain("git cat-file -p <sha>");
	});

	it.skipIf(AS_ROOT)(
		"says so for a CLAIM record the filesystem refuses (mantahostels#2382)",
		() => {
			aliceWrites("alice's uncommitted work\n");
			fs.chmodSync(store.paths.lock(rel), 0o000);
			try {
				const r = cli(["versions", inRepo(rel)]);
				expect(r.status).toBe(1);
				expect(r.stdout).not.toContain("No claim on");
				expect(r.stdout).toContain("WOULD NOT READ (refused)");
				expect(r.stdout).toContain("Check its permissions");
			} finally {
				fs.chmodSync(store.paths.lock(rel), 0o644);
			}
		},
	);

	it("says the OBSERVATION record would not read rather than reporting no claim (mantahostels#2382)", () => {
		unguardedWrite("alice's unclaimed work\n");
		corrupt(store.paths.observation(rel, "alice"));

		const r = cli(["versions", inRepo(rel)], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(r.status).toBe(1);
		expect(r.stdout).not.toContain("No claim on");
		expect(r.stdout).toContain("observation record");
		expect(r.stdout).toContain("WOULD NOT READ (unparseable)");
	});

	it.skipIf(AS_ROOT)(
		"says so for an OBSERVATION record the filesystem refuses (mantahostels#2382)",
		() => {
			unguardedWrite("alice's unclaimed work\n");
			const file = store.paths.observation(rel, "alice");
			fs.chmodSync(file, 0o000);
			try {
				const r = cli(["versions", inRepo(rel)], {
					CLAUDE_CODE_SESSION_ID: "alice",
				});
				expect(r.status).toBe(1);
				expect(r.stdout).not.toContain("No claim on");
				expect(r.stdout).toContain("WOULD NOT READ (refused)");
			} finally {
				fs.chmodSync(file, 0o644);
			}
		},
	);

	it("still prints the half that DID read, so one bad record hides nothing (mantahostels#2382)", () => {
		registerSession(sb, "bob", process.ppid);
		aliceWrites("alice's uncommitted work\n");
		fs.writeFileSync(inRepo(rel), "bob's unclaimed work\n");
		out(["record", inRepo(rel), "bob"]);
		corrupt(store.paths.lock(rel));

		const r = cli(["versions", inRepo(rel)], {
			CLAUDE_CODE_SESSION_ID: "bob",
		});
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("WOULD NOT READ");
		expect(r.stdout).toContain("THIS session");
		expect(r.stdout).toMatch(/git cat-file -p [0-9a-f]{40,64}/);
	});

	it("adds nothing to a write, a check or a release — it is pull-mode only", () => {
		aliceWrites("v1\n");
		const before = cli(["check", inRepo(rel), "alice"]);
		aliceWrites("v2\n");
		const after = cli(["check", inRepo(rel), "alice"]);
		expect(after.stdout).toBe(before.stdout);
		expect(after.stderr).toBe(before.stderr);
		expect(after.status).toBe(before.status);
	});
});

describe("the second signal — dirty, but claimed by nobody", () => {
	const warning = (sessionId: string, file: string) => {
		const printed = out(["check", file, sessionId]);
		return printed === ""
			? ""
			: (JSON.parse(printed).hookSpecificOutput.additionalContext ?? "");
	};

	beforeEach(() => {
		gitRepo(sb);
	});

	it("allows the write but tells the session to read the diff first", () => {
		registerSession(sb, "a", process.pid);
		fs.writeFileSync(inRepo("docs/doc-map.md"), "someone's work\n");
		const json = JSON.parse(out(["check", inRepo("docs/doc-map.md"), "a"]));
		expect(json.hookSpecificOutput.permissionDecision).toBeUndefined();
		expect(json.hookSpecificOutput.additionalContext).toContain(
			"Read the diff",
		);
	});

	it("stays quiet when the file is clean", () => {
		registerSession(sb, "a", process.pid);
		expect(out(["check", inRepo("docs/other.md"), "a"])).toBe("");
	});

	it("names the holder rather than an unclaimed diff when a live session holds the dirty file", () => {
		registerSession(sb, "alice", process.pid);
		store.acquire("docs/doc-map.md", store.identify("alice"));
		fs.writeFileSync(inRepo("docs/doc-map.md"), "alice's work\n");
		registerSession(sb, "bob", process.pid);
		const said = JSON.parse(out(["check", inRepo("docs/doc-map.md"), "bob"]))
			.hookSpecificOutput.additionalContext;
		expect(said).toContain("also held by session alice");
		expect(said).not.toContain("no live session claims");
	});

	it("says it once, not on every write the session makes to the file", () => {
		registerSession(sb, "a", process.pid);
		const file = inRepo("docs/doc-map.md");
		fs.writeFileSync(file, "someone's work\n");
		expect(warning("a", file)).toContain("Read the diff");
		fs.writeFileSync(file, "someone's work, edited\n");
		expect(warning("a", file)).toBe("");
	});

	it("holds its tongue for the claimant only, not for the file", () => {
		registerSession(sb, "a", process.pid);
		const file = inRepo("docs/doc-map.md");
		fs.writeFileSync(file, "a session's work\n");
		expect(warning("a", file)).toContain("Read the diff");
		const lock = store.paths.lock("docs/doc-map.md");
		fs.writeFileSync(
			lock,
			JSON.stringify({
				...JSON.parse(fs.readFileSync(lock, "utf8")),
				pid: 4_194_303,
				procStart: "1",
			}),
		);
		registerSession(sb, "next", process.pid);
		expect(warning("next", file)).toContain("Read the diff");
	});
});

describe("writes — an unreadable ledger is not an empty one", () => {
	const record = (rel: string, sessionId: string) =>
		store.recordWrite(inRepo(rel), sessionId);

	it("a session that has written nothing answers empty, and succeeds", () => {
		const r = cli(["writes", "never-wrote"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
	});

	it("a ledger it can read answers with the paths", () => {
		record("docs/a.md", "alice");
		const r = cli(["writes", "alice"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("docs/a.md\n");
	});

	it("a ledger it cannot read exits non-zero and prints nothing", () => {
		record("docs/a.md", "alice");
		fs.chmodSync(store.paths.ledger("alice"), 0o000);
		const r = cli(["writes", "alice"]);
		expect(r.status).not.toBe(0);
		expect(r.stdout).toBe("");
	});

	it("logs the unreadable ledger, so check-guard-errors can see it", () => {
		record("docs/a.md", "alice");
		fs.chmodSync(store.paths.ledger("alice"), 0o000);
		cli(["writes", "alice"]);
		expect(fs.readFileSync(store.errorLog(), "utf8")).toContain("writes alice");
	});

	const commitAsAlice = () => {
		gitRepo(sb);
		fs.writeFileSync(inRepo("docs/b.md"), "committed\n");
		commitAll(sb);
		const head = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: sb.repo,
			encoding: "utf8",
		}).trim();
		store.recordCommit(head, "alice");
	};

	it("--committed adds the paths the session's own commits touched (#2390)", () => {
		commitAsAlice();
		record("docs/a.md", "alice");
		const r = cli(["writes", "alice", "--committed"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("docs/a.md\ndocs/b.md\n");
	});

	it.skipIf(AS_ROOT)(
		"--committed prints the writes alone, and logs why, where the commit ledger will not read (mantahostels#114)",
		() => {
			commitAsAlice();
			record("docs/a.md", "alice");
			fs.chmodSync(store.paths.commitLedger("alice"), 0o000);
			const r = cli(["writes", "alice", "--committed"]);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("docs/a.md\n");
			expect(fs.readFileSync(store.errorLog(), "utf8")).toContain(
				"writes --committed",
			);
		},
	);

	it("no session id at all is unavailable, not empty", () => {
		const env = { ...process.env };
		delete env.CLAUDE_CODE_SESSION_ID;
		const r = runInProcess(SCRIPT, ["writes"], { cwd: sb.repo, env });
		expect(r.status).not.toBe(0);
		expect(r.stdout).toBe("");
	});
});

describe("record — the PostToolUse attribution path", () => {
	it("adds the path to the session's ledger", () => {
		expect(cli(["record", inRepo("docs/a.md"), "alice"]).status).toBe(0);
		expect(cli(["writes", "alice"]).stdout).toBe("docs/a.md\n");
	});

	it("is a no-op with no path, rather than an error the hook would surface", () => {
		expect(cli(["record"]).status).toBe(0);
	});

	it("ignores a trailing flag-shaped argument as it ignores any extra argument (#1137)", () => {
		const r = cli(["record", inRepo("docs/a.md"), "alice", "--help"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(cli(["writes", "alice"]).stdout).toBe("docs/a.md\n");
	});
});

describe("the argument reader — the caller's own flags parsed, the hook's free text not (#1137)", () => {
	it("refuses an unknown flag with the subcommand's usage, and drops nothing", () => {
		const alice = live(sb, "alice");
		store.acquire("docs/a.md", alice);
		const r = cli(["release", "--forse", inRepo("docs/a.md")], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(r.status).toBe(2);
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe(
			"unknown flag: --forse\n\nusage: session-arbiter.js release [--generator] [--not-mine] <path>\n",
		);
		expect(listedPaths()).toEqual(["docs/a.md"]);
	});

	it.each([
		[
			["prune-markers", "--detatch"],
			"prune-markers [--detach] [--spare <session-id>]",
		],
		[["claim-issue", "--force", "12"], "claim-issue <issue-number>"],
	])("refuses %j with that subcommand's usage", (args, usage) => {
		const r = cli(args);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`usage: session-arbiter.js ${usage}\n`);
	});

	it.each([
		[["claim"], "claim <path> [session-id] [--generator]"],
		[["release"], "release [--generator] [--not-mine] <path>"],
		[["versions"], "versions <path>"],
	])("refuses %j with no path, with that subcommand's usage", (args, usage) => {
		const r = cli(args);
		expect(r.status).toBe(2);
		expect(r.stderr).toBe(`usage: session-arbiter.js ${usage}\n`);
	});

	it("gets a refusal to a full stderr pipe in full before exiting non-zero (#1631)", () => {
		expect(
			throughFullPipe(2, [SCRIPT, "versions", "/nonexistent/x.md"], {
				cwd: sb.repo,
			}),
		).toBe("session-arbiter: /nonexistent/x.md is not in this repo\nexit 2\n");
	});

	it("refuses an argument past the subcommand's last, naming it", () => {
		const r = cli(["list", "extra"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/^unexpected argument: extra\n/);
	});

	it.each([
		[["--help"], "usage: session-arbiter.js check <path>"],
		[["release", "--help"], "usage: session-arbiter.js release [--generator]"],
		[["wait", "-h"], "usage: session-arbiter.js wait <issue-number>"],
	])("answers %j on stdout, exit 0", (args, usage) => {
		const r = cli(args);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
		expect(r.stdout.startsWith(usage)).toBe(true);
	});

	it("refuses an unknown subcommand, with the whole usage", () => {
		const r = cli(["relase", inRepo("docs/a.md")]);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(
			/^unknown command: relase\n\nusage: session-arbiter\.js check <path>/,
		);
	});

	it.each([
		[["claim", "docs/a.md", "--generator"]],
		[["release", "docs/a.md", "--generator"]],
		[["list", "--all"]],
	])("accepts %j without a refusal or usage text", (args) => {
		const r = cli(args.map((a) => (a.startsWith("docs/") ? inRepo(a) : a)));
		expect(r.stderr).not.toMatch(/unknown flag|unexpected argument|usage:/);
		expect(r.status).not.toBe(2);
	});

	it.each(["--help", "--x marks the old_string", "-h"])(
		"check takes an old_string of %j as the anchor, as the hook sends it",
		(anchor) => {
			registerSession(sb, "a", process.pid);
			const r = cli([
				"check",
				inRepo("docs/other.md"),
				"a",
				anchor,
				String(anchor.length),
			]);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("");
			expect(r.stderr).toBe("");
			expect(listedPaths()).toEqual(["docs/other.md"]);
		},
	);
});

describe("prune-markers — what the sweep itself does, run inline", () => {
	const prefixes = [
		".concision-base-",
		".concision-nagged-",
		".concision-pass-",
		".codereview-nagged-",
		".codereview-pass-",
		".priced-options-nagged-",
		".round-check-nagged-",
		".selection-sum-nagged-",
	];
	const hour = 60 * 60 * 1000;
	const crumbPrefixes = [
		".hook-ran-guard-priced-options-",
		".hook-ran-guard-selection-sum-",
	];
	const aged = (full: string, ms: number) => {
		const when = new Date(Date.now() - ms);
		fs.writeFileSync(full, "");
		fs.utimesSync(full, when, when);
	};
	const markers = (sessionId: string) => {
		fs.mkdirSync(markerRoot.markersDir(sb.repo), { recursive: true });
		for (const p of prefixes)
			aged(path.join(markerRoot.markersDir(sb.repo), p + sessionId), 25 * hour);
	};
	const surviving = (sessionId: string) =>
		prefixes.filter((p) =>
			fs.existsSync(path.join(markerRoot.markersDir(sb.repo), p + sessionId)),
		);
	const crumbs = (sessionId: string, ms: number) => {
		fs.mkdirSync(hookRecord.recordsDir(sb.repo), { recursive: true });
		for (const p of crumbPrefixes)
			aged(path.join(hookRecord.recordsDir(sb.repo), p + sessionId), ms);
	};
	const crumbsLeft = (sessionId: string) =>
		crumbPrefixes.filter((p) =>
			fs.existsSync(path.join(hookRecord.recordsDir(sb.repo), p + sessionId)),
		);
	const latch = (id: string, agent: string, sessionId: string, ms: number) => {
		fs.mkdirSync(markerRoot.markersDir(sb.repo), { recursive: true });
		const full = path.join(
			markerRoot.markersDir(sb.repo),
			`.rule-injected-${id}-${agent}-${sessionId}`,
		);
		aged(full, ms);
		return full;
	};

	it("sweeps a finished session's markers and spares a live one's", () => {
		markers("ghost");
		markers("alice");
		live(sb, "alice");

		expect(cli(["prune-markers"]).status).toBe(0);

		expect(surviving("ghost")).toEqual([]);
		expect(surviving("alice")).toEqual(prefixes);
	});

	it("sweeps the Stop guards' block counters, mantahostels#1278's two and mantahostels#1308's third", () => {
		markers("ghost");
		live(sb, "someone-else");

		expect(cli(["prune-markers"]).status).toBe(0);

		for (const p of [
			".priced-options-nagged-",
			".round-check-nagged-",
			".selection-sum-nagged-",
		])
			expect(fs.existsSync(path.join(sb.repo, `${p}ghost`))).toBe(false);
	});

	it("spares a dead session's breadcrumb past the marker age but under a week", () => {
		markers("ghost");
		crumbs("ghost", 25 * hour);
		live(sb, "someone-else");

		expect(cli(["prune-markers"]).status).toBe(0);

		expect(surviving("ghost")).toEqual([]);
		expect(crumbsLeft("ghost")).toEqual(crumbPrefixes);
	});

	it("sweeps a dead session's breadcrumb once it is over a week old", () => {
		crumbs("ghost", 8 * 24 * hour);
		live(sb, "someone-else");

		expect(cli(["prune-markers"]).status).toBe(0);

		expect(crumbsLeft("ghost")).toEqual([]);
	});

	it("spares a live session's breadcrumb however old, past the guard name's hyphens", () => {
		crumbs("alice", 30 * 24 * hour);
		live(sb, "alice");

		expect(cli(["prune-markers"]).status).toBe(0);

		expect(crumbsLeft("alice")).toEqual(crumbPrefixes);
	});

	it("does not spare a breadcrumb whose id is only a prefix of a live id", () => {
		crumbs("alic", 8 * 24 * hour);
		live(sb, "alice");

		expect(cli(["prune-markers"]).status).toBe(0);

		expect(crumbsLeft("alic")).toEqual([]);
	});

	it("does not spare a breadcrumb whose id merely ends with a live id", () => {
		crumbs("xalice", 8 * 24 * hour);
		live(sb, "alice");

		expect(cli(["prune-markers"]).status).toBe(0);

		expect(crumbsLeft("xalice")).toEqual([]);
	});

	it("sweeps a finished session's aged rule latch", () => {
		const f = latch("one", "main", "ghost", 25 * hour);
		live(sb, "someone-else");

		expect(cli(["prune-markers"]).status).toBe(0);

		expect(fs.existsSync(f)).toBe(false);
	});

	it("spares a live session's rule latch however old, past the agent segment", () => {
		const f = latch("one", "main", "alice", 30 * 24 * hour);
		live(sb, "alice");

		expect(cli(["prune-markers"]).status).toBe(0);

		expect(fs.existsSync(f)).toBe(true);
	});

	it("spares a subagent's rule latch under the live parent it is keyed to", () => {
		const f = latch("one", "aac7cb4a45383cc850", "alice", 30 * 24 * hour);
		live(sb, "alice");

		expect(cli(["prune-markers"]).status).toBe(0);

		expect(fs.existsSync(f)).toBe(true);
	});

	it("never touches a file outside the swept families, however old", () => {
		fs.mkdirSync(markerRoot.markersDir(sb.repo), { recursive: true });
		const bystanders = [
			path.join(sb.repo, "package.json"),
			path.join(sb.repo, ".gitignore"),
			path.join(markerRoot.markersDir(sb.repo), ".concision-baseline-keep"),
		];
		for (const b of bystanders) aged(b, 400 * 24 * hour);
		live(sb, "alice");

		expect(cli(["prune-markers"]).status).toBe(0);

		expect(bystanders.filter((b) => !fs.existsSync(b))).toEqual([]);
	});

	it("never touches a non-breadcrumb file in the breadcrumb directory, however old", () => {
		crumbs("ghost", 400 * 24 * hour);
		const strays = [
			"notes.txt",
			".hook-ranked-ghost",
			"x.hook-ran-guard-ghost",
		].map((f) => path.join(hookRecord.recordsDir(sb.repo), f));
		for (const s of strays) aged(s, 400 * 24 * hour);
		live(sb, "alice");

		expect(cli(["prune-markers"]).status).toBe(0);

		expect(strays.filter((s) => !fs.existsSync(s))).toEqual([]);
		expect(crumbsLeft("ghost")).toEqual([]);
	});

	it("sweeps no family when the sessions registry cannot be read", () => {
		markers("ghost");
		crumbs("ghost", 8 * 24 * hour);
		const stuckLatch = latch("one", "main", "ghost", 25 * hour);
		const sessions = path.join(sb.home, "sessions");
		fs.rmSync(sessions, { recursive: true, force: true });
		fs.writeFileSync(sessions, "");

		expect(cli(["prune-markers"]).status).toBe(0);

		expect(surviving("ghost")).toEqual(prefixes);
		expect(crumbsLeft("ghost")).toEqual(crumbPrefixes);
		expect(fs.existsSync(stuckLatch)).toBe(true);
		expect(fs.readFileSync(store.errorLog(), "utf8")).toContain("pruneMarkers");
	});
});

describe("the clobber report — a write by a route no hook watches (mantahostels#295)", () => {
	const auditScript = "scripts/evidence-audit.py";

	beforeEach(() => {
		gitRepo(sb);
		fs.mkdirSync(path.join(sb.repo, "scripts"), { recursive: true });
		registerSession(sb, "alice", process.pid);
	});

	const write = (rel: string, text: string) =>
		fs.writeFileSync(inRepo(rel), text);
	const notes = (stdout: string) =>
		stdout ? JSON.parse(stdout).hookSpecificOutput : {};

	const aliceWrites = (rel: string, text: string) => {
		const pre = out(["check", inRepo(rel), "alice"]);
		write(rel, text);
		out(["record", inRepo(rel), "alice"]);
		return pre;
	};

	it("warns and names the recovery command, and never denies", () => {
		aliceWrites(auditScript, "alice's uncommitted work\n");

		write(auditScript, "restored from a backup\n");

		const seen = notes(out(["check", inRepo(auditScript), "alice"]));
		expect(seen.permissionDecision).toBeUndefined();
		expect(seen.additionalContext).toContain("has changed since this session");
		expect(readRecoveredBlob(seen.additionalContext)).toBe(
			"alice's uncommitted work\n",
		);
	});

	it("says nothing when the claimant's own writes are what changed the file", () => {
		aliceWrites(auditScript, "one\n");
		expect(out(["check", inRepo(auditScript), "alice"])).toBe("");
		aliceWrites(auditScript, "two\n");
		expect(out(["check", inRepo(auditScript), "alice"])).toBe("");
	});

	it("refreshes after a Bash write, so the claimant's own sed is not a clobber", () => {
		aliceWrites("docs/doc-map.md", "v1.35\n");
		write("docs/doc-map.md", "v1.36\n");
		out(["refresh", "alice"]);
		expect(out(["check", inRepo("docs/doc-map.md"), "alice"])).toBe("");
	});

	it("refreshes only what this session holds, so a neighbour's file is untouched", () => {
		registerSession(sb, "bob", process.pid);
		aliceWrites("docs/alice.md", "alice\n");
		out(["check", inRepo("docs/bob.md"), "bob"]);
		write("docs/bob.md", "bob's\n");
		out(["record", inRepo("docs/bob.md"), "bob"]);

		write("docs/bob.md", "clobbered\n");
		out(["refresh", "alice"]);
		expect(
			notes(out(["check", inRepo("docs/bob.md"), "bob"])).additionalContext,
		).toContain("has changed since this session");
	});

	it("watches the detect-only tier and refuses nothing on it", () => {
		aliceWrites(auditScript, "alice's\n");
		registerSession(sb, "bob", process.pid);
		expect(
			notes(out(["check", inRepo(auditScript), "bob"])).permissionDecision,
		).toBeUndefined();

		expect(listedPaths().includes(auditScript)).toBe(true);
	});

	it("warns of the held file on the guarded tier, never denying (#4249)", () => {
		aliceWrites("docs/doc-map.md", "alice's\n");
		registerSession(sb, "bob", process.pid);
		const seen = notes(out(["check", inRepo("docs/doc-map.md"), "bob"]));
		expect(seen.permissionDecision).toBeUndefined();
		expect(seen.additionalContext).toContain("also held by session");
	});

	it("keeps the detect-only tier quiet about dirt nobody claims", () => {
		write(auditScript, "uncommitted, unclaimed\n");
		expect(out(["check", inRepo(auditScript), "alice"])).toBe("");

		write("docs/doc-map.md", "uncommitted, unclaimed\n");
		expect(
			notes(out(["check", inRepo("docs/doc-map.md"), "alice"]))
				.additionalContext,
		).toContain("uncommitted changes that no live session claims");
	});

	it("releases a detect-only claim, so its holder can give the file back", () => {
		aliceWrites(auditScript, "alice's\n");
		commitAll(sb);
		expect(
			cli(["release", inRepo(auditScript)], { CLAUDE_CODE_SESSION_ID: "alice" })
				.stdout,
		).toContain("Released");
	});

	it("lets a script claim a detect-only path, and never aborts it there", () => {
		fs.writeFileSync(inRepo("scripts/tool.js"), "alice's\n");
		expect(cli(["claim", inRepo("scripts/tool.js"), "alice"]).status).toBe(0);
		expect(listedPaths().includes("scripts/tool.js")).toBe(true);
		expect(out(["writes", "alice"])).toContain("scripts/tool.js");

		aliceWrites("docs/doc-map.md", "alice's\n");
		registerSession(sb, "bob", process.pid);

		const r = cli(["claim", inRepo("scripts/tool.js"), "bob"]);
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain("is held by session");

		const guarded = cli(["claim", inRepo("docs/doc-map.md"), "bob"]);
		expect(guarded.status).toBe(0);
		expect(guarded.stderr).toContain("is also held by session");
	});

	describe("a second writer's own baseline on the detect-only tier (mantahostels#363)", () => {
		const bobWrites = (rel: string, text: string) => {
			const pre = out(["check", inRepo(rel), "bob"]);
			write(rel, text);
			out(["record", inRepo(rel), "bob"]);
			return pre;
		};
		beforeEach(() => {
			aliceWrites(auditScript, "alice's uncommitted work\n");
			registerSession(sb, "bob", process.pid);
		});

		it("reports the clobber to the second writer, naming ITS bytes to recover", () => {
			expect(notes(bobWrites(auditScript, "bob's uncommitted work\n"))).toEqual(
				{},
			);

			write(auditScript, "restored from a backup\n");

			const seen = notes(out(["check", inRepo(auditScript), "bob"]));
			expect(seen.permissionDecision).toBeUndefined();
			expect(seen.additionalContext).toContain(
				"has changed since this session",
			);
			expect(readRecoveredBlob(seen.additionalContext)).toBe(
				"bob's uncommitted work\n",
			);
		});

		it("leaves the holder's report naming the holder's own bytes", () => {
			bobWrites(auditScript, "bob's uncommitted work\n");
			const seen = notes(out(["check", inRepo(auditScript), "alice"]));
			expect(seen.additionalContext).toContain(
				"has changed since this session",
			);
			expect(readRecoveredBlob(seen.additionalContext)).toBe(
				"alice's uncommitted work\n",
			);
		});

		it("says nothing when the second writer's own writes are what changed it", () => {
			bobWrites(auditScript, "bob's one\n");
			expect(out(["check", inRepo(auditScript), "bob"])).toBe("");
			bobWrites(auditScript, "bob's two\n");
			expect(out(["check", inRepo(auditScript), "bob"])).toBe("");
		});

		it("refreshes after a Bash write, so the second writer's own sed is not a clobber", () => {
			bobWrites(auditScript, "v1.35\n");
			write(auditScript, "v1.36\n");
			out(["refresh", "bob"]);
			expect(out(["check", inRepo(auditScript), "bob"])).toBe("");
		});

		it("reports and drops the second writer's record on release, and still refuses", () => {
			bobWrites(auditScript, "bob's uncommitted work\n");
			write(auditScript, "restored from a backup\n");

			const r = cli(["release", inRepo(auditScript)], {
				CLAUDE_CODE_SESSION_ID: "bob",
			});
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("has changed since this session");
			expect(readRecoveredBlob(r.stderr)).toBe("bob's uncommitted work\n");
			expect(r.stderr).toContain("is held by session");
			expect(out(["check", inRepo(auditScript), "bob"])).toBe("");
		});
	});

	describe("a writer that took no claim at all (mantahostels#2333, mantahostels#2353)", () => {
		const unguardedWrite = (text: string) => {
			write(auditScript, text);
			out(["record", inRepo(auditScript), "alice"]);
		};

		it("reports the clobber, and the command it prints recovers ITS bytes", () => {
			unguardedWrite("alice's unclaimed work\n");

			write(auditScript, "restored from a backup\n");

			const seen = notes(out(["check", inRepo(auditScript), "alice"]));
			expect(seen.permissionDecision).toBeUndefined();
			expect(seen.additionalContext).toContain(
				"has changed since this session",
			);
			expect(readRecoveredBlob(seen.additionalContext, true)).toBe(
				"alice's unclaimed work\n",
			);
		});

		it("says nothing while the writer's own bytes stand, then speaks", () => {
			unguardedWrite("alice's unclaimed work\n");
			expect(out(["check", inRepo(auditScript), "alice"])).toBe("");
			unguardedWrite("alice's second pass\n");
			expect(out(["check", inRepo(auditScript), "alice"])).toBe("");

			write(auditScript, "restored from a backup\n");
			expect(
				notes(out(["check", inRepo(auditScript), "alice"])).additionalContext,
			).toContain("has changed since this session");
		});

		it("reports it on release too, worded for a reader holding no claim", () => {
			unguardedWrite("alice's unclaimed work\n");
			write(auditScript, "restored from a backup\n");

			const r = cli(["release", inRepo(auditScript)], {
				CLAUDE_CODE_SESSION_ID: "alice",
			});
			expect(r.status).toBe(0);
			expect(r.stdout).toContain(`No claim on ${auditScript}`);
			expect(r.stderr).toContain("has changed since this session");
			expect(r.stderr).not.toContain("The claim is dropped");
			expect(readRecoveredBlob(r.stderr)).toBe("alice's unclaimed work\n");
		});
	});

	describe("the second reporting site — release (mantahostels#332)", () => {
		const commit = () => commitAll(sb);
		const release = (rel: string) =>
			cli(["release", inRepo(rel)], { CLAUDE_CODE_SESSION_ID: "alice" });

		it("warns on the way out with a command that recovers the work, drops the claim anyway, and exits 0", () => {
			aliceWrites(auditScript, "alice's work\n");
			commit();
			write(auditScript, "restored from a backup\n");
			commit();

			const r = release(auditScript);
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("Released scripts/evidence-audit.py");
			expect(r.stderr).toContain("has changed since this session");

			expect(listedPaths().includes(auditScript)).toBe(false);

			const sha = r.stderr.match(/git cat-file -p ([0-9a-f]{40,64})/)?.[1];
			expect(
				execFileSync("git", ["cat-file", "-p", sha as string], {
					cwd: sb.repo,
					encoding: "utf8",
				}),
			).toBe("alice's work\n");
		});

		it("says only what it dropped when nobody touched the file", () => {
			aliceWrites(auditScript, "alice's work\n");
			commit();

			const r = release(auditScript);
			expect(r.stdout).toBe("Released scripts/evidence-audit.py.\n");
			expect(r.stderr).toBe("");
		});

		it("stays silent on a claim never recorded — unknown is not changed", () => {
			write(auditScript, "alice's work\n");
			out(["check", inRepo(auditScript), "alice"]);
			commit();

			expect(release(auditScript).stderr).toBe("");
		});

		it("carries the clobber into the dirty refusal, which still refuses (mantahostels#337)", () => {
			aliceWrites(auditScript, "alice's work\n");
			commit();
			write(auditScript, "restored from a backup\n");

			const r = release(auditScript);
			expect(r.status).toBe(1);
			expect(r.stderr).toMatch(
				/has uncommitted changes, and nothing here could prove .*, so the claim stands/,
			);
			expect(r.stderr).toContain("has changed since this session");
			expect(r.stderr.indexOf("has changed since this session")).toBeLessThan(
				r.stderr.indexOf("has uncommitted changes"),
			);

			expect(listedPaths().includes(auditScript)).toBe(true);
			const sha = r.stderr.match(/git cat-file -p ([0-9a-f]{40,64})/)?.[1];
			expect(
				execFileSync("git", ["cat-file", "-p", sha as string], {
					cwd: sb.repo,
					encoding: "utf8",
				}),
			).toBe("alice's work\n");
		});

		it("carries the clobber into the uncheckable refusal, which still refuses (mantahostels#420)", () => {
			aliceWrites(auditScript, "alice's work\n");
			commit();
			write(auditScript, "restored from a backup\n");
			fs.rmSync(path.join(sb.repo, ".git", "HEAD"));

			const r = release(auditScript);
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("could not read git status");
			expect(r.stderr).toContain("has changed since this session");
			expect(r.stderr.indexOf("has changed since this session")).toBeLessThan(
				r.stderr.indexOf("could not read git status"),
			);
			expect(r.stderr).toContain("the claim and its pin both stand");
			expect(listedPaths().includes(auditScript)).toBe(true);
		});

		it("says nothing extra on an uncheckable refusal nobody clobbered", () => {
			aliceWrites(auditScript, "alice's work\n");
			commit();
			fs.rmSync(path.join(sb.repo, ".git", "HEAD"));

			const r = release(auditScript);
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("could not read git status");
			expect(r.stderr).not.toContain("has changed since this session");
		});

		it("carries the clobber into the contended refusal (mantahostels#420)", () => {
			aliceWrites(auditScript, "alice's work\n");
			commit();
			write(auditScript, "restored from a backup\n");
			commit();

			const { git } = writeFaultyGit(
				{ words: ["status"] },
				{
					script: `sed -i -E 's/("claimId"[[:space:]]*:[[:space:]]*")[^"]*/\\1swapped/' ${shellQuote(store.paths.lock(auditScript))}`,
				},
				{ under: sb.dir },
			);

			const r = cli(["release", inRepo(auditScript)], {
				CLAUDE_CODE_SESSION_ID: "alice",
				WFC_GIT: git,
			});
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("changed while releasing it");
			expect(r.stderr).toContain("has changed since this session");
			expect(r.stderr.indexOf("has changed since this session")).toBeLessThan(
				r.stderr.indexOf("changed while releasing it"),
			);
			expect(r.stderr).toContain("the claim and its pin both stand");
		});

		it("refuses dirty in silence on the session's own unfinished edit", () => {
			aliceWrites(auditScript, "alice's work\n");
			commit();
			aliceWrites(auditScript, "alice's next edit\n");

			const r = release(auditScript);
			expect(r.status).toBe(1);
			expect(r.stderr).toMatch(
				/has uncommitted changes, and nothing here could prove .*, so the claim stands/,
			);
			expect(r.stderr).not.toContain("has changed since this session");
		});
	});

	describe("the third reporting site — a claim broken while its holder lived (mantahostels#349)", () => {
		const aliceDisappears = () => {
			const lock = core.readRecord(store.paths.lock(auditScript));
			fs.writeFileSync(
				store.paths.lock(auditScript),
				JSON.stringify({ ...lock, pid: 999_999, procStart: "1" }),
			);
			fs.rmSync(path.join(sb.home, "sessions", `${process.pid}.json`));
			return lock;
		};

		it("tells the loser what happened and hands back its version", () => {
			aliceWrites(auditScript, "alice's work\n");
			aliceDisappears();

			registerSession(sb, "bob", process.pid);
			out(["check", inRepo(auditScript), "bob"]);
			write(auditScript, "bob's replacement\n");

			registerSession(sb, "alice", process.pid);
			const seen = notes(out(["check", inRepo(auditScript), "alice"]));
			expect(seen.additionalContext).toContain("was broken at");
			expect(seen.additionalContext).toContain("bob");

			const sha = seen.additionalContext.match(
				/git cat-file -p ([0-9a-f]{40,64})/,
			)?.[1];
			expect(
				execFileSync("git", ["cat-file", "-p", sha as string], {
					cwd: sb.repo,
					encoding: "utf8",
				}),
			).toBe("alice's work\n");
		});

		it("carries the news ahead of the held-file warning, where the loser is most often standing", () => {
			aliceWrites("docs/doc-map.md", "alice's work\n");
			const lock = core.readRecord(store.paths.lock("docs/doc-map.md"));
			fs.writeFileSync(
				store.paths.lock("docs/doc-map.md"),
				JSON.stringify({ ...lock, pid: 999_999, procStart: "1" }),
			);
			fs.rmSync(path.join(sb.home, "sessions", `${process.pid}.json`));

			registerSession(sb, "bob", process.pid);
			out(["check", inRepo("docs/doc-map.md"), "bob"]);

			registerSession(sb, "alice", process.pid);
			const seen = notes(out(["check", inRepo("docs/doc-map.md"), "alice"]));
			expect(seen.permissionDecision).toBeUndefined();
			expect(seen.additionalContext).toContain("was broken at");
			expect(seen.additionalContext).toContain("git cat-file -p");
			expect(seen.additionalContext.indexOf("was broken at")).toBeLessThan(
				seen.additionalContext.indexOf("also held by session"),
			);
		});

		it("keeps the pin across the session-start sweep, then drops it with the record", () => {
			aliceWrites(auditScript, "alice's work\n");
			const broken = aliceDisappears();
			registerSession(sb, "bob", process.pid);
			out(["check", inRepo(auditScript), "bob"]);

			out(["prune-markers"]);
			expect(readRefs()).toEqual([`refs/arbiter/${broken.claimId}`]);

			const file = store.paths.break(auditScript, broken.claimId);
			fs.writeFileSync(
				file,
				JSON.stringify({
					...core.readRecord(file),
					at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
				}),
			);

			out(["prune-markers"]);
			expect(readRefs()).toEqual([]);
		});
	});

	it("prune-markers sweeps the pins of claims that are gone", () => {
		aliceWrites(auditScript, "alice's\n");
		expect(readRefs()).toHaveLength(1);

		fs.rmSync(store.paths.locksDir(), { recursive: true, force: true });
		out(["prune-markers"]);
		expect(readRefs()).toEqual([]);
	});

	it("collects a whole backlog of pins, not just the first", () => {
		for (const rel of ["docs/doc-map.md", "AGENTS.md", "CLAUDE.md"])
			aliceWrites(rel, `alice on ${rel}\n`);
		expect(readRefs().length).toBeGreaterThan(1);

		fs.rmSync(store.paths.locksDir(), { recursive: true, force: true });
		out(["prune-markers"]);
		expect(readRefs()).toEqual([]);
	});
});

describe("prune-markers --detach, the SessionStart form", () => {
	const docMap = "docs/doc-map.md";

	beforeEach(() => {
		gitRepo(sb);
		registerSession(sb, "alice", process.pid);
	});

	const aliceWrites = (rel: string, text: string) => {
		out(["check", inRepo(rel), "alice"]);
		fs.writeFileSync(inRepo(rel), text);
		out(["record", inRepo(rel), "alice"]);
	};

	it("exits 0 and says nothing, so a session start is never blocked", () => {
		const r = cli(["prune-markers", "--detach"]);
		expect(r.status).toBe(0);
		expect(`${r.stdout}${r.stderr}`).toBe("");
	});

	it("still sweeps, in the child it launched", async () => {
		aliceWrites(docMap, "alice's\n");
		expect(readRefs()).toHaveLength(1);
		fs.rmSync(store.paths.locksDir(), { recursive: true, force: true });

		expect(cli(["prune-markers", "--detach"]).status).toBe(0);

		const deadline = Date.now() + 20_000;
		while (readRefs().length > 0 && Date.now() < deadline)
			await new Promise((r) => setTimeout(r, 100));
		expect(readRefs()).toEqual([]);
	}, 30_000);

	it("launches its sweep outside the session's scope, as no session, owned by the starter, capped", async () => {
		const fake = writeSystemdRun(fs.mkdtempSync(path.join(sb.dir, "sdr-")));
		const r = cli(["prune-markers", "--detach"], {
			WFC_SYSTEMD_RUN: fake.bin,
			CLAUDE_CODE_SESSION_ID: "starter",
			CLAUDE_JOB_DIR: "/the/job",
		});
		expect(r.status).toBe(0);
		await vi.waitFor(() => expect(fake.calls()).toHaveLength(1));
		expect(fake.calls()[0]).toMatchObject({
			words: "--user --scope --quiet -p RuntimeMaxSec=2700 --",
			command: expect.stringMatching(
				/session-arbiter\.js prune-markers --spare starter$/,
			),
			sid: "",
			job: "",
			owner: "starter",
		});
	});
});

describe("release — the oracle read it pays for (mantahostels#317)", () => {
	const rel = "docs/doc-map.md";
	const run = (args: string[], sid: string) =>
		cli(args, { CLAUDE_CODE_SESSION_ID: sid, WFC_CLAUDE_BIN: claudeBin() });

	const claudeBin = () => path.join(sb.dir, "bin", "claude");
	const calls = () => path.join(sb.dir, "claude-calls");

	const fakeClaude = (ids: string[]) =>
		writeOracle(
			claudeBin(),
			ids.map((sessionId) => buildListedRow({ sessionId })),
			calls(),
		);

	const oracleCalls = () =>
		fs.existsSync(calls())
			? fs.readFileSync(calls(), "utf8").split("\n").filter(Boolean).length
			: 0;

	beforeEach(() => {
		gitRepo(sb);
		fs.writeFileSync(inRepo(rel), "alice's work\n");
		commitAll(sb);
		const alice = live(sb, "alice");
		store.acquire(rel, alice);
		store.recordContent(rel, alice);
		live(sb, "bob");
	});

	it("makes no oracle call on a release that succeeds", () => {
		fakeClaude(["alice"]);
		expect(run(["release", inRepo(rel)], "alice").status).toBe(0);
		expect(oracleCalls()).toBe(0);
	});

	it("pays for one oracle call to name the holder a release is refused for", () => {
		fakeClaude(["bob"]);
		const r = run(["release", inRepo(rel)], "bob");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("alice");
		expect(oracleCalls()).toBe(1);
	});
});

describe("the Bash-only writer, end to end — refresh scans, check reports (mantahostels#419)", () => {
	const auditScript = "scripts/evidence-audit.py";
	const guarded = "docs/doc-map.md";

	const write = (rel: string, text: string) => {
		fs.mkdirSync(path.dirname(inRepo(rel)), { recursive: true });
		fs.writeFileSync(inRepo(rel), text);
	};
	const notes = (stdout: string) =>
		stdout ? JSON.parse(stdout).hookSpecificOutput : {};

	const aliceSeds = (rel: string, text: string) => {
		write(rel, text);
		out(["refresh", "alice"]);
	};

	beforeEach(() => {
		gitRepo(sb);
		registerSession(sb, "alice", process.pid);
		write(auditScript, "seeded\n");
		write(guarded, "seeded\n");
		out(["refresh", "alice"]);
	});

	it("names alice's own bytes as recoverable after a route no hook watches", () => {
		aliceSeds(auditScript, "alice's version bump\n");
		write(auditScript, "restored from a backup\n");

		const seen = notes(out(["check", inRepo(auditScript), "alice"]));
		expect(seen.permissionDecision).toBeUndefined();
		expect(seen.additionalContext).toContain("has changed since this session");
		expect(readRecoveredBlob(seen.additionalContext)).toBe(
			"alice's version bump\n",
		);
	});

	it("reports the same on the refusing tier, which the guard covers by tool route alone", () => {
		aliceSeds(guarded, "alice's version bump\n");
		write(guarded, "restored from a backup\n");

		const seen = notes(out(["check", inRepo(guarded), "alice"]));
		expect(readRecoveredBlob(seen.additionalContext)).toBe(
			"alice's version bump\n",
		);
	});

	it("takes no claim from the scan, so nothing is refused on an inference (mantahostels#288)", () => {
		aliceSeds(auditScript, "alice's version bump\n");
		aliceSeds(guarded, "alice's version bump\n");
		expect(store.listLocks()).toEqual([]);

		registerSession(sb, "bob", process.pid + 1);
		expect(
			notes(out(["check", inRepo(guarded), "bob"])).permissionDecision,
		).toBeUndefined();
	});

	it("says nothing about a file alice's own next Bash call rewrote", () => {
		aliceSeds(auditScript, "v1.35\n");
		aliceSeds(auditScript, "v1.36\n");
		expect(out(["check", inRepo(auditScript), "alice"])).toBe("");
	});

	it("says nothing on a session's very first Bash call, whatever the tier holds (mantahostels#158)", () => {
		registerSession(sb, "carol", process.pid);
		write(auditScript, "changed long before carol started\n");
		out(["refresh", "carol"]);
		expect(out(["check", inRepo(auditScript), "carol"])).toBe("");
	});
});

describe("release-issue on an unfinished build unit, and move-issue (#4535, on #4495)", () => {
	const { markersDir } = createRequire(__filename)("./lib/marker-root.js");
	const At = "repos/acme/widgets/issues/645";
	const Unmet = "## Acceptance criteria\n\n- [x] one\n- [ ] two\n";
	const HoldingOn =
		"**Gated on:** 368 post-change stays recorded — abandon if: the change is reverted";
	const unit = ({
		state = "open",
		labels = ["kind:ticket", "takes:implement"],
		body = Unmet,
	} = {}) => ({
		kind: "issue",
		value: {
			number: 645,
			state,
			labels: labels.map((name) => ({ name })),
			body,
		},
	});
	const claimAs = (
		sid: string,
		{ started = true, cites = "Refs #645" } = {},
	) => {
		fs.mkdirSync(path.join(sb.repo, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(sb.repo, ".claude", "workflow-core.json"),
			JSON.stringify({ contract: 1, founder: "T", tracker: "acme/widgets" }),
		);
		registerSession(sb, sid, process.pid);
		cli(["claim-issue", "645"], { CLAUDE_CODE_SESSION_ID: sid });
		if (!started) return;
		gitRepo(sb);
		fs.writeFileSync(inRepo("docs/b.md"), "slice one\n");
		commitAll(sb, `Do slice one (${cites})`);
		const head = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: sb.repo,
			encoding: "utf8",
		}).trim();
		store.recordCommit(head, sid);
	};
	const release = () =>
		cli(["release-issue", "645"], { CLAUDE_CODE_SESSION_ID: "alice" });

	it("refuses an open, unparked kind:ticket with an unmet criterion, naming the four exits and keeping the claim", () => {
		claimAs("alice");
		fakeGh(sb, { [At]: unit() });
		const r = release();
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("refusing to release #645");
		expect(r.stderr).toContain("No ticket comment or body note moves");
		for (const exit of [
			"scripts/park-blocked.sh",
			"a `needs input:` park with its `**Hand-off:**` block",
			"the 300,000 tripwire",
			"the compaction backstop's hand-off",
		])
			expect(r.stderr).toContain(exit);
		expect(out(["issue-claims"])).toMatch(/^#645\talice/m);
	});

	it.each([
		["parked", unit({ labels: ["kind:ticket", "parked"] })],
		["closed", unit({ state: "closed" })],
		[
			"every criterion met",
			unit({ body: "## Acceptance criteria\n\n- [x] one\n" }),
		],
		[
			"its open criterion waived",
			unit({
				body: "## Acceptance criteria\n\n- [ ] two **waived:** out of scope\n",
			}),
		],
		["not a kind:ticket", unit({ labels: ["kind:brief"] })],
		[
			"held by its `**Gated until:**` line (#4991)",
			unit({ body: `${Unmet}\n**Gated until:** 2999-01-01 — data accrues\n` }),
		],
		[
			"held by its `**Gated on:**` line (#4991)",
			unit({ body: `${Unmet}\n${HoldingOn}\n` }),
		],
	])("releases where the issue is %s", (_, answer) => {
		claimAs("alice");
		fakeGh(sb, { [At]: answer });
		const r = release();
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/Released the claim on #645/);
	});

	it.each([
		[
			"a lapsed `**Gated until:**` line",
			"**Gated until:** 2000-01-01 — data accrued",
		],
		[
			"a malformed `**Gated on:**` line",
			"**Gated on:** 368 post-change stays recorded",
		],
		[
			"both gate lines, which gate nothing",
			`**Gated until:** 2999-01-01 — data accrues\n${HoldingOn}`,
		],
	])("still refuses where the unit carries only %s (#4991)", (_, gate) => {
		claimAs("alice");
		fakeGh(sb, { [At]: unit({ body: `${Unmet}\n${gate}\n` }) });
		const r = release();
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("refusing to release #645");
	});

	it("releases the claim park-blocked.sh's record names, reading nothing", () => {
		claimAs("alice");
		fakeGh(sb, { [At]: unit() });
		fs.mkdirSync(markersDir(sb.repo), { recursive: true });
		fs.writeFileSync(
			path.join(markersDir(sb.repo), ".parked-blocked-alice"),
			JSON.stringify({ outcome: "blocked", issue: 645, session: "alice" }),
		);
		const r = release();
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/Released the claim on #645/);
		expect(ghCallCount(sb)).toBe(0);
	});

	it("releases a unit no commit of this session cites, as a bundle's unstarted member, reading nothing", () => {
		claimAs("alice", { started: false });
		fakeGh(sb, { [At]: unit() });
		const r = release();
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/Released the claim on #645/);
		expect(ghCallCount(sb)).toBe(0);
	});

	it("releases a unit only another repo's issue of that number cites as started", () => {
		claimAs("alice", { cites: "Refs mantahostels#645" });
		fakeGh(sb, { [At]: unit() });
		const r = release();
		expect(r.status).toBe(0);
		expect(ghCallCount(sb)).toBe(0);
	});

	it("fails open where the issue will not read, saying the check went unrun", () => {
		claimAs("alice");
		const r = release();
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/Released the claim on #645/);
		expect(r.stderr).toContain("went unchecked");
	});

	it("moves the claim to a running session, the gate aside", () => {
		claimAs("alice");
		registerSession(sb, "copy", process.pid);
		fakeGh(sb, { [At]: unit() });
		const r = cli(["move-issue", "645", "copy"], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Moved the claim on #645 to session copy.");
		expect(out(["issue-claims"])).toMatch(/^#645\tcopy/m);
		expect(out(["issue-claims"])).not.toMatch(/alice/);
		expect(ghCallCount(sb)).toBe(0);
	});

	it("refuses to move a started unit's claim to a session not running, keeping it", () => {
		claimAs("alice");
		fakeGh(sb, { [At]: unit() });
		const r = cli(["move-issue", "645", "nobody"], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("session nobody is not running");
		expect(r.stderr).toContain("refusing to release #645");
		expect(out(["issue-claims"])).toMatch(/^#645\talice/m);
	});

	it("moves a gated unit's claim to a session not running (#4991)", () => {
		claimAs("alice");
		fakeGh(sb, { [At]: unit({ body: `${Unmet}\n${HoldingOn}\n` }) });
		const r = cli(["move-issue", "645", "nobody"], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Moved the claim on #645 to session nobody.");
		expect(out(["issue-claims"])).not.toMatch(/alice/);
	});

	it("moves nothing where this session holds no claim", () => {
		registerSession(sb, "alice", process.pid);
		const r = cli(["move-issue", "645", "copy"], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("No claim of this session's on #645.");
		expect(out(["issue-claims"])).toBe("No issues are claimed.\n");
	});
});

describe("claim-issue / release-issue — the selection claim (mantahostels#645)", () => {
	it("records the claim against the session in the environment", () => {
		registerSession(sb, "alice", process.pid);
		const r = cli(["claim-issue", "645"], { CLAUDE_CODE_SESSION_ID: "alice" });
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/Recorded #645 as claimed by session alice/);
		expect(out(["issue-claims"])).toMatch(/^#645\talice\tsince /m);
	});

	it("takes no session id from argv, so nobody claims for someone else", () => {
		registerSession(sb, "alice", process.pid);
		const r = cli(["claim-issue", "645", "bob"], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(r.status).toBe(2);
		expect(out(["issue-claims"])).not.toMatch(/alice|bob/);
		cli(["claim-issue", "645"], { CLAUDE_CODE_SESSION_ID: "alice" });
		expect(out(["issue-claims"])).toMatch(/alice/);
	});

	it("exits 0 with no session id, since an unrecorded claim only fails open", () => {
		const r = cli(["claim-issue", "645"], { CLAUDE_CODE_SESSION_ID: "" });
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(/stays selectable/);
	});

	it("exits 2 on an argument that is not an issue number", () => {
		registerSession(sb, "alice", process.pid);
		const r = cli(["claim-issue", "nonsense"], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/is not an issue number/);
	});

	it("releases the claim it recorded", () => {
		registerSession(sb, "alice", process.pid);
		cli(["claim-issue", "645"], { CLAUDE_CODE_SESSION_ID: "alice" });
		const r = cli(["release-issue", "645"], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/Released the claim on #645/);
		expect(out(["issue-claims"])).toBe("No issues are claimed.\n");
	});

	it("says there was nothing of its own to release", () => {
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", process.pid);
		cli(["claim-issue", "645"], { CLAUDE_CODE_SESSION_ID: "bob" });
		const r = cli(["release-issue", "645"], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/No claim of this session's on #645/);
		expect(out(["issue-claims"])).toMatch(/bob/);
	});

	it("never says 'No issues are claimed' about a store it could not read (mantahostels#174)", () => {
		if (AS_ROOT) return;
		fs.mkdirSync(store.paths.issueClaimsDir(), { recursive: true });
		fs.chmodSync(store.paths.issueClaimsDir(), 0o000);
		try {
			const r = cli(["issue-claims"]);
			expect(r.status).toBe(1);
			expect(r.stderr).toMatch(/unknown — not nothing/);
		} finally {
			fs.chmodSync(store.paths.issueClaimsDir(), 0o755);
		}
	});

	it("names both subcommands in the usage", () => {
		const usage = cli([]).stderr;
		expect(usage).toContain("session-arbiter.js claim-issue <issue-number>\n");
		expect(usage).toContain(
			"session-arbiter.js release-issue <issue-number>\n",
		);
	});

	it("warns and exits 1 on a corrupt record, but still prints what it could read (mantahostels#1186)", () => {
		cli(["claim-issue", "645"], { CLAUDE_CODE_SESSION_ID: "alice" });
		fs.writeFileSync(
			path.join(store.paths.issueClaimsDir(), "bogus.json"),
			"not json",
		);
		const r = cli(["issue-claims"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/1 issue-claim record could not be read/);
		expect(r.stdout).toMatch(/#645\talice\tsince /);
	});

	const pruneBin = () => path.join(sb.dir, "prunebin", "claude");
	const fakePrune = (ids: string[] | null) => {
		writeOracle(
			pruneBin(),
			ids?.map((sessionId) => buildListedRow({ sessionId })) ?? null,
		);
		return { CLAUDE_CODE_SESSION_ID: "sweeper", WFC_CLAUDE_BIN: pruneBin() };
	};

	const aged = () => {
		registerSession(sb, "bob", process.pid, { procStart: "999999999" });
		cli(["claim-issue", "645"], { CLAUDE_CODE_SESSION_ID: "bob" });
		const f = path.join(store.paths.issueClaimsDir(), "645-bob.json");
		const t = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
		fs.utimesSync(f, t, t);
		return f;
	};

	it("sweeps a finished session's stale claim at prune-markers", () => {
		const f = aged();
		expect(cli(["prune-markers"], fakePrune(["sweeper"])).status).toBe(0);
		expect(fs.existsSync(f)).toBe(false);
	});

	it("spares that claim where the agents oracle still lists its session (mantahostels#704)", () => {
		const f = aged();
		expect(cli(["prune-markers"], fakePrune(["sweeper", "bob"])).status).toBe(
			0,
		);
		expect(fs.existsSync(f)).toBe(true);
	});

	it("sweeps nothing at all where the agents oracle will not answer (mantahostels#704)", () => {
		const f = aged();
		expect(cli(["prune-markers"], fakePrune(null)).status).toBe(0);
		expect(fs.existsSync(f)).toBe(true);
	});

	it("sweeps when the oracle does not list the sweeping session (mantahostels#710)", () => {
		const f = aged();
		expect(cli(["prune-markers"], fakePrune(["someone-else"])).status).toBe(0);
		expect(fs.existsSync(f)).toBe(false);
	});

	it("still spares a live claim on a list that omits the sweeper", () => {
		const f = aged();
		expect(
			cli(["prune-markers"], fakePrune(["someone-else", "bob"])).status,
		).toBe(0);
		expect(fs.existsSync(f)).toBe(true);
	});

	it("spares the sweeping session's own aged claim (mantahostels#710)", () => {
		registerSession(sb, "sweeper", process.pid, { procStart: "999999999" });
		cli(["claim-issue", "710"], { CLAUDE_CODE_SESSION_ID: "sweeper" });
		const f = path.join(store.paths.issueClaimsDir(), "710-sweeper.json");
		const t = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
		fs.utimesSync(f, t, t);
		aged();
		expect(cli(["prune-markers"], fakePrune(["someone-else"])).status).toBe(0);
		expect(fs.existsSync(f)).toBe(true);
	});

	it("spares the starting session --spare names, run as no session (#4706)", () => {
		registerSession(sb, "sweeper", process.pid, { procStart: "999999999" });
		cli(["claim-issue", "710"], { CLAUDE_CODE_SESSION_ID: "sweeper" });
		const f = path.join(store.paths.issueClaimsDir(), "710-sweeper.json");
		const t = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
		fs.utimesSync(f, t, t);
		const other = aged();
		const env = { ...fakePrune(["someone-else"]), CLAUDE_CODE_SESSION_ID: "" };
		expect(cli(["prune-markers", "--spare", "sweeper"], env).status).toBe(0);
		expect(fs.existsSync(f)).toBe(true);
		expect(fs.existsSync(other)).toBe(false);
	});
});

describe("region claims — a §B entry, not the whole file", () => {
	const docMap = "docs/doc-map.md";

	const neighbourPid = process.ppid;

	const writeMap = () =>
		fs.writeFileSync(
			inRepo(docMap),
			[
				"# doc map",
				"",
				"v1.0 · 21 August 2026",
				"",
				"## Section B — figures",
				"",
				"### B1 · The first",
				"",
				"Body of the first entry.",
				"",
				"### B2 · The second",
				"",
				"Body of the second entry.",
				"",
			].join("\n"),
		);

	const writeMapWithThird = () =>
		fs.appendFileSync(
			inRepo(docMap),
			["### B3 \u00b7 The third", "", "Body of the third entry.", ""].join(
				"\n",
			),
		);

	beforeEach(writeMap);

	const check = (session: string, anchor?: string) =>
		out([
			"check",
			inRepo(docMap),
			session,
			...(anchor === undefined ? [] : [anchor]),
		]);

	const warning = (raw: string): string => {
		const { hookSpecificOutput: hso } = JSON.parse(raw);
		expect(hso.permissionDecision).toBeUndefined();
		return hso.additionalContext;
	};

	it("lets two sessions hold two different entries at once", () => {
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		expect(check("alice", "Body of the first entry.")).toBe("");
		expect(check("bob", "Body of the second entry.")).toBe("");
		const held = listedPaths();
		expect(held).toContain(`${docMap}#B1`);
		expect(held).toContain(`${docMap}#B2`);
	});

	it("warns a second session on the SAME entry, naming the holder and the entry", () => {
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		check("alice", "Body of the first entry.");
		const reason = warning(check("bob", "Body of the first entry."));
		expect(reason).toContain("alice");
		expect(reason).toContain(`${docMap}#B1`);
	});

	const straddling = "Body of the first entry.\n\n### B2 \u00b7 The second";

	const paths = () => listedPaths();

	it("claims BOTH regions a straddling edit touches, not the file entire (mantahostels#1685)", () => {
		registerSession(sb, "alice", process.pid);
		check("alice", straddling);
		expect(paths()).toContain(`${docMap}#B1`);
		expect(paths()).toContain(`${docMap}#B2`);
		expect(paths()).not.toContain(docMap);
	});

	it("leaves a neighbour's OTHER region claimable after a straddling edit", () => {
		writeMapWithThird();
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		check("alice", straddling);
		expect(check("bob", "Body of the third entry.")).toBe("");
		expect(paths()).toContain(`${docMap}#B3`);
	});

	it("says which regions the straddling edit took, and how to release them", () => {
		registerSession(sb, "alice", process.pid);
		const json = JSON.parse(check("alice", straddling));
		const notice = json.hookSpecificOutput.additionalContext;
		expect(notice).toContain(`${docMap}#B1`);
		expect(notice).toContain(`${docMap}#B2`);
		expect(notice).toContain("release");
	});

	it("takes the free region and warns of the one a neighbour holds", () => {
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		check("bob", "Body of the second entry.");
		const reason = warning(check("alice", straddling));
		expect(reason).toContain(`${docMap}#B2 is also held by session bob`);
		expect(paths()).toContain(`${docMap}#B1`);
	});

	it("never tells a straddling write to release a region a neighbour holds", () => {
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		check("bob", "Body of the second entry.");
		const reason = warning(check("alice", straddling));
		expect(reason).not.toContain("Release them as soon as you are done");
		expect(reason).not.toContain(`release ${docMap}#B2`);
	});

	it("still claims the file entire when the anchor is stale", () => {
		registerSession(sb, "alice", process.pid);
		const json = JSON.parse(check("alice", "text that is not in the map"));
		expect(paths()).toContain(docMap);
		expect(json.hookSpecificOutput.additionalContext).toContain("WHOLE");
	});

	it("claims the file entire for a Write, which carries no anchor", () => {
		registerSession(sb, "alice", process.pid);
		expect(listedPaths()).toEqual([]);
		check("alice");
		expect(listedPaths()).toContain(docMap);
	});

	it("tells a Write it took the WHOLE map, and how to release it (mantahostels#2334)", () => {
		registerSession(sb, "alice", process.pid);
		const notice = JSON.parse(check("alice")).hookSpecificOutput
			.additionalContext;
		expect(notice).toContain("claims the WHOLE of");
		expect(notice).toContain(`release ${docMap}`);
		expect(notice).toContain("takes ONE region off its own anchor");
	});

	it("says the whole-file notice ONCE per session, not on every write", () => {
		registerSession(sb, "alice", process.pid);
		expect(check("alice")).toContain("claims the WHOLE of");
		expect(check("alice")).toBe("");
	});

	it("says it for the SIDECAR too, the other regioned path", () => {
		const sidecar = "docs/doc-map-classes.json";
		registerSession(sb, "alice", process.pid);
		fs.writeFileSync(inRepo(sidecar), "{}\n");
		const notice = JSON.parse(out(["check", inRepo(sidecar), "alice"]))
			.hookSpecificOutput.additionalContext;
		expect(notice).toContain(`claims the WHOLE of ${sidecar}`);
	});

	it("says nothing to a Write on an unregioned path", () => {
		registerSession(sb, "alice", process.pid);
		fs.writeFileSync(inRepo("docs/other.md"), "### B1 · x\n\nBody A.\n");
		expect(out(["check", inRepo("docs/other.md"), "alice"])).toBe("");
	});

	it("never tells a contended whole-file Write to release what it does not hold", () => {
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		check("alice", "Body of the first entry.");
		const reason = warning(check("bob"));
		expect(reason).toContain("alice");
		expect(reason).not.toContain("Release it as soon as you are done");
	});

	it("does not LOG the anchorless whole-file claim, which is no fault", () => {
		registerSession(sb, "alice", process.pid);
		check("alice");
		const log = fs.existsSync(sb.errorLog())
			? fs.readFileSync(sb.errorLog(), "utf8")
			: "";
		expect(log).not.toContain("claiming the whole file");
	});

	it("warns a region write while a neighbour holds the whole file, naming the HELD subject", () => {
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		check("alice");
		const reason = warning(check("bob", "Body of the first entry."));
		expect(reason).toContain(`${docMap} is also held by session alice`);
		expect(reason).toContain(`it covers ${docMap}#B1`);
	});

	it("warns a whole-file write while a neighbour holds one entry, naming the neighbour and keeping no lock of its own", () => {
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		check("alice", "Body of the first entry.");
		const reason = warning(check("bob"));
		expect(reason).toContain("alice");
		const held = listedPaths();
		expect(held).toEqual([`${docMap}#B1`]);
	});

	it("falls back to the whole file when the anchor cannot be placed, and says so", () => {
		registerSession(sb, "alice", process.pid);
		const raw = check("alice", "a line this file does not hold");
		expect(raw).toContain("claims the WHOLE of");
		expect(raw).toContain("anchor not found");
		expect(listedPaths()).toContain(docMap);
	});

	it("logs that fallback as a fail-open, per mantahostels#103 §6", () => {
		registerSession(sb, "alice", process.pid);
		check("alice", "a line this file does not hold");
		expect(fs.readFileSync(sb.errorLog(), "utf8")).toContain(
			"claiming the whole file",
		);
	});

	it("falls back, and logs, when the map cannot be read at all", () => {
		registerSession(sb, "alice", process.pid);
		fs.rmSync(inRepo(docMap));
		const raw = check("alice", "Body of the first entry.");
		expect(raw).toContain("claims the WHOLE of");
		expect(fs.readFileSync(sb.errorLog(), "utf8")).toContain(
			"could not be read",
		);
	});

	it("leaves every other guarded path on the whole-file claim", () => {
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		fs.writeFileSync(inRepo("docs/other.md"), "### B1 · x\n\nBody A.\n");
		out(["check", inRepo("docs/other.md"), "alice", "Body A."]);
		expect(listedPaths()).toEqual(["docs/other.md"]);
		const raw = out(["check", inRepo("docs/other.md"), "bob", "Body A."]);
		expect(warning(raw)).toContain("docs/other.md is also held by session");
	});

	const commitMap = () => {
		gitRepo(sb);
		execFileSync("git", ["add", "--", docMap], { cwd: sb.repo });
		execFileSync("git", ["commit", "-qm", "map", "--", docMap], {
			cwd: sb.repo,
		});
	};

	it("releases every region a bare path names", () => {
		commitMap();
		registerSession(sb, "alice", process.pid);
		check("alice", "Body of the first entry.");
		check("alice", "Body of the second entry.");
		const r = cli(["release", inRepo(docMap)], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(r.stdout).toContain(`Released ${docMap}#B1`);
		expect(r.stdout).toContain(`Released ${docMap}#B2`);
		expect(store.listLocks()).toEqual([]);
	});

	it("leaves a neighbour's region alone when a bare path is released", () => {
		commitMap();
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		check("alice", "Body of the first entry.");
		check("bob", "Body of the second entry.");
		const r = cli(["release", inRepo(docMap)], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain("not by this session");
		expect(listedPaths()).toEqual([`${docMap}#B2`]);
	});

	it("releases the whole-file claim too when the session holds both", () => {
		commitMap();
		registerSession(sb, "alice", process.pid);
		check("alice");
		check("alice", "Body of the first entry.");
		expect(store.listLocks()).toHaveLength(2);
		const r = cli(["release", inRepo(docMap)], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(r.status).toBe(0);
		expect(store.listLocks()).toEqual([]);
	});

	it("releases one region when the subject names one", () => {
		commitMap();
		registerSession(sb, "alice", process.pid);
		check("alice", "Body of the first entry.");
		check("alice", "Body of the second entry.");
		cli(["release", `${docMap}#B1`], { CLAUDE_CODE_SESSION_ID: "alice" });
		expect(listedPaths()).toEqual([`${docMap}#B2`]);
	});
});

describe("alloc-entry — the next free B<n>, taken atomically", () => {
	const docMap = "docs/doc-map.md";

	const neighbourPid = process.ppid;

	beforeEach(() =>
		fs.writeFileSync(
			inRepo(docMap),
			"# doc map\n\nv1.0 · 21 August 2026\n\n## Section B\n\n### B7 · The last one\n\nBody.\n",
		),
	);

	const alloc = (session: string) =>
		cli(["alloc-entry"], { CLAUDE_CODE_SESSION_ID: session });

	it("hands out max + 1 and claims the slot with it", () => {
		registerSession(sb, "alice", process.pid);
		const r = alloc("alice");
		expect(r.status).toBe(0);
		expect(r.stdout.trim()).toBe("B8");
		expect(listedPaths()).toEqual([`${docMap}#B8`]);
	});

	it("hands out the id above the high-water mark where a removed id sits above every live one (#2339)", () => {
		fs.writeFileSync(
			inRepo("docs/doc-map-high-water.json"),
			JSON.stringify({ highWaterMark: 9 }),
		);
		registerSession(sb, "alice", process.pid);
		expect(alloc("alice").stdout.trim()).toBe("B10");
	});

	it("warns, naming the missing high-water file and how to write it, yet still hands out an id (#3357)", () => {
		registerSession(sb, "alice", process.pid);
		const r = alloc("alice");
		expect(r.stdout.trim()).toBe("B8");
		expect(r.stderr).toContain("doc-map-high-water.json is missing");
		expect(r.stderr).toContain('{ "highWaterMark": <n> }');
	});

	it("gives a second session the NEXT id, not the same one", () => {
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		expect(alloc("alice").stdout.trim()).toBe("B8");
		expect(alloc("bob").stdout.trim()).toBe("B9");
	});

	it("gives every id out once under real concurrency", async () => {
		const hosts = Array.from({ length: 6 }, () => spawn("sleep", ["30"]));
		try {
			const sessions = hosts.map((h, i) => {
				registerSession(sb, `s${i}`, h.pid as number);
				return `s${i}`;
			});
			const runs = await Promise.all(
				sessions.map(
					(session) =>
						new Promise<string>((resolve) => {
							const r = keptSpawn("concurrent").spawn(
								process.execPath,
								[SCRIPT, "alloc-entry"],
								{
									cwd: sb.repo,
									env: { ...process.env, CLAUDE_CODE_SESSION_ID: session },
								},
							);
							let stdout = "";
							r.stdout.on("data", (d) => {
								stdout += d;
							});
							r.on("close", () => resolve(stdout.trim()));
						}),
				),
			);
			expect(runs.every((id) => /^B\d+$/.test(id))).toBe(true);
			expect(new Set(runs).size).toBe(sessions.length);
		} finally {
			for (const h of hosts) h.kill();
		}
	});

	it("refuses rather than allocating while a neighbour holds the whole file, naming the holder", () => {
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		store.acquire(docMap, store.identify("alice"));
		const r = alloc("bob");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("alice");
		expect(r.stdout).toBe("");
	});

	it("walks past a held id without recording a want (#1487)", () => {
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		store.acquire(`${docMap}#B8`, store.identify("alice"));
		expect(alloc("bob").stdout.trim()).toBe("B9");
		expect(store.readWants()).toEqual([]);
	});

	it("refuses on a path that takes no per-entry claim", () => {
		registerSession(sb, "alice", process.pid);
		const r = cli(["alloc-entry", inRepo("CLAUDE.md")], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("no id to allocate");
	});

	it("refuses when the map cannot be read, allocating nothing", () => {
		registerSession(sb, "alice", process.pid);
		fs.rmSync(inRepo(docMap));
		const r = alloc("alice");
		expect(r.status).toBe(1);
		expect(r.stdout).toBe("");
		expect(store.listLocks()).toEqual([]);
	});
});

describe("claim validates the region id it is handed (mantahostels#1313)", () => {
	const docMap = "docs/doc-map.md";

	beforeEach(() =>
		fs.writeFileSync(
			inRepo(docMap),
			[
				"# doc map",
				"",
				"v1.0 · 21 August 2026",
				"",
				"## Section A — document register",
				"",
				"Rows.",
				"",
				"## Section B — figures",
				"",
				"### B1 · The first",
				"",
				"Body of the first entry.",
				"",
			].join("\n"),
		),
	);

	const claim = (subject: string, session = "alice") =>
		cli(["claim", inRepo(subject)], { CLAUDE_CODE_SESSION_ID: session });

	const heldPaths = () => listedPaths();

	it("refuses an id the document has no region for, naming it and taking no claim", () => {
		registerSession(sb, "alice", process.pid);
		const r = claim(`${docMap}#A`);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("has no region `A`");
		expect(heldPaths()).toEqual([]);
	});

	it("names the sections the file actually has, so the caller can correct it", () => {
		registerSession(sb, "alice", process.pid);
		const r = claim(`${docMap}#Section`);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("section-a");
		expect(r.stderr).toContain("alloc-entry");
	});

	it("tells a poll loop the refusal is fatal, not contention", () => {
		registerSession(sb, "alice", process.pid);
		const r = claim(`${docMap}#A`);
		expect(r.stderr).toContain("RETRYING WILL NEVER CLEAR IT");
		expect(r.stderr).toContain("exit 2");
	});

	const bigMap = (last: number) => {
		const many = ["# doc map", "", "v1.0 · 21 August 2026", "", "## Section B"];
		for (let n = 1; n <= last; n++)
			many.push("", `### B${n} · Entry`, "", "Body.");
		fs.writeFileSync(inRepo(docMap), `${many.join("\n")}\n`);
	};

	it("truncates the id list", () => {
		registerSession(sb, "alice", process.pid);
		const many = ["# doc map", "", "v1.0 · 21 August 2026"];
		for (let n = 1; n <= 20; n++) many.push("", `## Chapter ${n}`, "", "Text.");
		fs.writeFileSync(inRepo(docMap), `${many.join("\n")}\n`);
		const r = claim(`${docMap}#nonesuch`);
		expect(r.stderr).toMatch(/and \d+ more/);
		expect(r.stderr).not.toContain("chapter-20");
	});

	it("shows the entries AROUND a mistyped entry id, not the first twelve", () => {
		registerSession(sb, "alice", process.pid);
		bigMap(40);
		fs.appendFileSync(inRepo(docMap), "\n### B60 · The last\n\nBody.\n");
		const r = claim(`${docMap}#B50`);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("B40");
		expect(r.stderr).not.toMatch(/\bB1,/);
	});

	it("claims a region the document does have", () => {
		registerSession(sb, "alice", process.pid);
		expect(claim(`${docMap}#B1`).status).toBe(0);
		expect(heldPaths()).toEqual([`${docMap}#B1`]);
	});

	it("claims a `## ` section by its slug", () => {
		registerSession(sb, "alice", process.pid);
		expect(claim(`${docMap}#section-b-preamble`).status).toBe(0);
		expect(heldPaths()).toEqual([`${docMap}#section-b-preamble`]);
	});

	it("still claims an append slot alloc-entry handed out (mantahostels#970)", () => {
		registerSession(sb, "alice", process.pid);
		expect(claim(`${docMap}#B2`).status).toBe(0);
		expect(heldPaths()).toEqual([`${docMap}#B2`]);
	});

	it("refuses `#section-a` on the map, routing the caller to the sidecar and its generator, and taking no claim", () => {
		registerSession(sb, "alice", process.pid);
		const r = claim(`${docMap}#section-a`);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("§A register tables are derived");
		expect(r.stderr).toContain("docs/doc-map-classes.json#A:<path>");
		expect(r.stderr).toContain(
			`node ${coreFile("scripts/generate-doc-map-section-a.js")}`,
		);
		expect(r.stderr).toContain("RETRYING WILL NEVER CLEAR IT");
		expect(heldPaths()).toEqual([]);
	});

	it("refuses a §A row id on the map, which mantahostels#1414 waved through as a slot, saying §A is derived and taking no claim", () => {
		registerSession(sb, "alice", process.pid);
		const r = claim(`${docMap}#A:docs/brand-new.md`);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("§A register tables are derived");
		expect(heldPaths()).toEqual([]);
	});

	it("lets the generator claim §A, which is the one caller that writes it", () => {
		registerSession(sb, "alice", process.pid);
		const r = cli(["claim", inRepo(`${docMap}#section-a`), "--generator"], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(r.status).toBe(0);
		expect(heldPaths()).toEqual([`${docMap}#section-a`]);
	});

	it("still mints `section-a` on the write hook's own route, which is ungated", () => {
		registerSession(sb, "alice", process.pid);
		cli(["check", inRepo(docMap), "alice", "Rows."], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(heldPaths()).toEqual([`${docMap}#section-a`]);
	});

	it("refuses the same subject inside a `claim-all` set, saying §A is derived and taking no lock", () => {
		registerSession(sb, "alice", process.pid);
		const r = cli(
			["claim-all", inRepo(`${docMap}#B1`), inRepo(`${docMap}#section-a`)],
			{ CLAUDE_CODE_SESSION_ID: "alice" },
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("§A register tables are derived");
		expect(heldPaths()).toEqual([]);
	});

	it("keeps §A's rows out of the sections a mistyped id is offered (mantahostels#1414)", () => {
		registerSession(sb, "alice", process.pid);
		fs.writeFileSync(
			inRepo(docMap),
			[
				"# doc map",
				"",
				"v1.0 · 21 August 2026",
				"",
				"## Section A — document register",
				"",
				"| `docs/alpha.md` | a doc | `source-of-truth` | Direct | — |",
				"| `docs/beta.md` | a doc | `source-of-truth` | Direct | — |",
				"",
				"## Section B — figures",
				"",
				"### B1 · The first",
				"",
				"Body.",
				"",
			].join("\n"),
		);
		const r = claim(`${docMap}#sektion-a`);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("section-a");
		expect(r.stderr).not.toContain("A:docs/alpha.md");
	});

	it("refuses a B<n> BELOW the next free id that no entry uses, naming it, offering alloc-entry and taking no claim", () => {
		registerSession(sb, "alice", process.pid);
		fs.appendFileSync(inRepo(docMap), "\n### B5 · The last\n\nBody.\n");
		const r = claim(`${docMap}#B3`);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("has no region `B3`");
		expect(r.stderr).toContain("alloc-entry");
		expect(heldPaths()).toEqual([]);
	});

	it("falls open when the map cannot be read, claiming as it did before", () => {
		registerSession(sb, "alice", process.pid);
		fs.rmSync(inRepo(docMap));
		expect(claim(`${docMap}#B1`).status).toBe(0);
		expect(heldPaths()).toEqual([`${docMap}#B1`]);
	});

	it("SAYS the claim went unvalidated when the map cannot be read", () => {
		registerSession(sb, "alice", process.pid);
		fs.rmSync(inRepo(docMap));
		const r = claim(`${docMap}#B1`);
		expect(r.stderr).toContain("was never checked against it");
		expect(r.stderr).toContain("check-guard-errors.js");
	});

	it("leaves a bare path alone — there is no region to check", () => {
		registerSession(sb, "alice", process.pid);
		expect(claim(docMap).status).toBe(0);
		expect(heldPaths()).toEqual([docMap]);
	});

	it("leaves a `#` in an unregioned path alone", () => {
		registerSession(sb, "alice", process.pid);
		expect(claim("docs/plan#1.md").status).toBe(0);
		expect(heldPaths()).toEqual(["docs/plan#1.md"]);
	});
});

describe("warns when a regioned path is claimed with no region (mantahostels#1856)", () => {
	const docMap = "docs/doc-map.md";
	const sidecar = "docs/doc-map-classes.json";
	const whole = "takes the WHOLE file";

	const writeMap = () =>
		fs.writeFileSync(
			inRepo(docMap),
			[
				"# doc map",
				"",
				"v1.0 · 21 August 2026",
				"",
				"## Section A — document register",
				"",
				"| `docs/alpha.md` | a doc | `source-of-truth` | Direct | — |",
				"",
				"## Section B — figures",
				"",
				"### B1 · The first",
				"",
				"Body.",
				"",
				"### B2 · The second",
				"",
				"Body.",
				"",
			].join("\n"),
		);

	beforeEach(() => {
		writeMap();
		registerSession(sb, "alice", process.pid);
	});

	const claim = (subject: string) =>
		cli(["claim", inRepo(subject)], { CLAUDE_CODE_SESSION_ID: "alice" });

	const heldPaths = () => listedPaths();

	it("warns that it takes the whole file, and still takes the claim at exit 0", () => {
		const r = claim(docMap);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(whole);
		expect(heldPaths()).toEqual([docMap]);
	});

	it("lists the regions the file has, in the two shapes it still holds", () => {
		const { stderr } = claim(docMap);
		expect(stderr).toContain("section-a");
		expect(stderr).toContain("2 `B<n>` entries, B1 to B2");
		expect(stderr).not.toContain("register row");
	});

	it("names alloc-entry as the route to a new entry's slot", () => {
		expect(claim(docMap).stderr).toContain(`alloc-entry ${docMap}`);
	});

	it("reads the sidecar's keys, which parse under a different reader (mantahostels#1848)", () => {
		fs.writeFileSync(
			inRepo(sidecar),
			JSON.stringify(
				{ "docs/alpha.md": { class: "x" }, "docs/beta.md": { class: "y" } },
				null,
				2,
			),
		);
		const r = claim(sidecar);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("2 `A:<path>` register rows");
		expect(r.stderr).not.toContain("Its regions: head");
	});

	it("offers alloc-entry only where `B<n>` entries exist", () => {
		fs.writeFileSync(
			inRepo(sidecar),
			JSON.stringify({ "docs/alpha.md": { class: "x" } }, null, 2),
		);
		expect(claim(sidecar).stderr).not.toContain("alloc-entry");
	});

	it("offers no alloc-entry line when the document could not be read", () => {
		fs.rmSync(inRepo(docMap));
		expect(claim(docMap).stderr).not.toContain("alloc-entry");
	});

	it("gives the entry range numerically, not by document order", () => {
		fs.writeFileSync(
			inRepo(docMap),
			[
				"# doc map",
				"",
				"## Section B — figures",
				"",
				"### B40 · Out of order",
				"",
				"Body.",
				"",
				"### B7 · Also out of order",
				"",
				"Body.",
				"",
			].join("\n"),
		);
		expect(claim(docMap).stderr).toContain("2 `B<n>` entries, B7 to B40");
	});

	it("says nothing when the claim names a region", () => {
		const r = claim(`${docMap}#B1`);
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain(whole);
	});

	it("says nothing on a watched path that has no regions", () => {
		const r = claim("docs/operating-manual.md");
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain(whole);
	});

	it("leaves a misspelt region exit 2, naming it, and does NOT also warn", () => {
		const r = claim(`${docMap}#sektion-a`);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("has no region `sektion-a`");
		expect(r.stderr).not.toContain(whole);
	});

	it("warns that it takes the whole file even where a neighbour holds it", () => {
		store.acquire(docMap, live(sb, "bob"));
		const r = claim(docMap);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(whole);
	});

	it("still takes the claim when the map cannot be read", () => {
		fs.rmSync(inRepo(docMap));
		const r = claim(docMap);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(whole);
		expect(r.stderr).not.toContain("Its regions:");
		expect(heldPaths()).toEqual([docMap]);
	});

	describe("claim-all", () => {
		const claimAll = (...subjects: string[]) =>
			cli(["claim-all", ...subjects.map(inRepo)], {
				CLAUDE_CODE_SESSION_ID: "alice",
			});

		it("warns once, about the offending subject alone", () => {
			const r = claimAll(docMap, "docs/operating-manual.md");
			expect(r.status).toBe(0);
			expect(r.stderr.split(whole)).toHaveLength(2);
			expect(r.stderr).not.toContain(
				"operating-manual.md is claimed per region",
			);
		});

		it("warns once per offending subject, not once per call, naming the sidecar in its own warning", () => {
			fs.writeFileSync(
				inRepo(sidecar),
				JSON.stringify({ "docs/alpha.md": { class: "x" } }, null, 2),
			);
			const r = claimAll(docMap, sidecar);
			expect(r.status).toBe(0);
			expect(r.stderr.split(whole)).toHaveLength(3);
			expect(r.stderr).toContain(`${sidecar} is claimed per region`);
		});

		it("says nothing when every regioned subject names its region", () => {
			const r = claimAll(`${docMap}#B1`, "docs/operating-manual.md");
			expect(r.status).toBe(0);
			expect(r.stderr).not.toContain(whole);
		});

		it("keeps the misspelt-region refusal ahead of the warn", () => {
			const r = claimAll(docMap, `${docMap}#sektion-a`);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain("has no region `sektion-a`");
			expect(r.stderr).not.toContain(whole);
		});
	});
});

describe("warns on a `### B<n>` this session never allocated (mantahostels#1424)", () => {
	const docMap = "docs/doc-map.md";

	beforeEach(() =>
		fs.writeFileSync(
			inRepo(docMap),
			[
				"# doc map",
				"",
				"v1.0 · 21 August 2026",
				"",
				"## Section B — figures",
				"",
				"### B7 · The last one",
				"",
				"Body.",
				"",
			].join("\n"),
		),
	);

	const check = (session: string, ids: string, anchor = "Body.") =>
		out(["check", inRepo(docMap), session, anchor, String(anchor.length), ids]);

	const context = (raw: string) =>
		raw ? JSON.parse(raw).hookSpecificOutput.additionalContext : "";

	it("names the id and the alloc-entry recipe", () => {
		registerSession(sb, "alice", process.pid);
		const said = context(check("alice", "B8"));
		expect(said).toContain("B8");
		expect(said).toContain("alloc-entry docs/doc-map.md");
	});

	it("says nothing about an id alloc-entry handed this session", () => {
		registerSession(sb, "alice", process.pid);
		expect(
			cli(["alloc-entry"], { CLAUDE_CODE_SESSION_ID: "alice" }).stdout.trim(),
		).toBe("B8");
		expect(context(check("alice", "B8"))).not.toContain("B8");
	});

	it("says nothing when the write introduces no heading", () => {
		registerSession(sb, "alice", process.pid);
		expect(check("alice", "")).toBe("");
	});

	it("says nothing while this session holds the file whole", () => {
		registerSession(sb, "alice", process.pid);
		store.acquire(docMap, store.identify("alice"));
		expect(context(check("alice", "B8"))).not.toContain("B8");
	});

	it("warns rather than denying, even on an id nobody allocated", () => {
		registerSession(sb, "alice", process.pid);
		const json = JSON.parse(check("alice", "B8"));
		expect(json.hookSpecificOutput.permissionDecision).toBeUndefined();
	});

	it("names every unallocated id at once", () => {
		registerSession(sb, "alice", process.pid);
		const said = context(check("alice", "B8,B9"));
		expect(said).toContain("B8");
		expect(said).toContain("B9");
	});

	it("ignores ids forwarded for a path that takes no region claims", () => {
		registerSession(sb, "alice", process.pid);
		expect(
			out(["check", inRepo("docs/other.md"), "alice", "", "0", "B8"]),
		).toBe("");
	});

	it("ignores a malformed id rather than naming it back", () => {
		registerSession(sb, "alice", process.pid);
		expect(check("alice", "B8x,../etc")).toBe("");
	});
});

describe("list says when a claim is one region, not the file (mantahostels#1313)", () => {
	const docMap = "docs/doc-map.md";

	it("marks a region claim as covering one region", () => {
		registerSession(sb, "alice", process.pid);
		store.acquire(`${docMap}#B190`, store.identify("alice"));
		const printed = out(["list"]);
		expect(printed).toContain("ONE REGION (B190)");
		expect(printed).toContain("its other regions are free");
	});

	it("says nothing of the sort about a whole-file claim", () => {
		registerSession(sb, "alice", process.pid);
		store.acquire(docMap, store.identify("alice"));
		expect(out(["list"])).not.toContain("ONE REGION");
	});

	it("leaves the path column a bare subject, greppable by filename", () => {
		registerSession(sb, "alice", process.pid);
		store.acquire(`${docMap}#B190`, store.identify("alice"));
		const line = out(["list"]).trim().split("\n")[0];
		expect(line.split("\t")[0]).toBe(`HELD   ${docMap}#B190`);
	});
});

describe("releasing a region the rest of the file's dirt no longer pins (mantahostels#1434)", () => {
	const docMap = "docs/doc-map.md";

	const doc = (b196: string, b197: string) =>
		[
			"# doc map",
			"",
			"v1.0 · 21 August 2026",
			"",
			"## Section B — figures",
			"",
			"### B196 · The first",
			"",
			b196,
			"",
			"### B197 · The second",
			"",
			b197,
			"",
		].join("\n");

	const writeMap = (text: string) => fs.writeFileSync(inRepo(docMap), text);
	const alice = () => {
		registerSession(sb, "alice", process.pid);
		return store.identify("alice");
	};
	const release = (subject: string, ...flags: string[]) =>
		cli(["release", ...flags, subject], { CLAUDE_CODE_SESSION_ID: "alice" });

	beforeEach(() => {
		gitRepo(sb);
		writeMap(doc("B196 as committed.", "B197 as committed."));
		commitAll(sb);
	});

	it("releases a committed region while a neighbour's edit sits elsewhere", () => {
		store.acquire(`${docMap}#B196`, alice());
		writeMap(doc("B196 as committed.", "B197, mid-edit by a neighbour."));

		expect(release(`${docMap}#B196`).status).toBe(0);
		expect(store.listLocks()).toEqual([]);
	});

	it("still refuses while the claimed region itself is dirty, naming the region", () => {
		store.acquire(`${docMap}#B196`, alice());
		writeMap(doc("B196, half-rewritten.", "B197 as committed."));

		const r = release(`${docMap}#B196`);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`${docMap}#B196 has uncommitted changes`);
	});

	it("drops a claim on a region that has vanished from the document", () => {
		store.acquire(`${docMap}#B999`, alice());
		expect(release(`${docMap}#B999`).status).toBe(0);
		expect(store.listLocks()).toEqual([]);
	});
});

describe("release-committed — the claim goes back when the commit lands (mantahostels#2336, #2058)", () => {
	const docMap = "docs/doc-map.md";
	const sidecar = "docs/doc-map-classes.json";

	const neighbourPid = process.ppid;

	const releaseCommitted = (sid: string, paths: string[]) =>
		cli(["release-committed", ...paths], { CLAUDE_CODE_SESSION_ID: sid });

	const held = (subject: string) => listedPaths().includes(subject);

	const environment = () => {
		const other = "docs/environment.md";
		fs.writeFileSync(inRepo(other), "notes\n");
		commitAll(sb, "environment");
		return other;
	};

	beforeEach(() => {
		gitRepo(sb);
		fs.writeFileSync(inRepo(docMap), "# doc map\n");
		fs.writeFileSync(inRepo(sidecar), "{}\n");
		commitAll(sb);
	});

	it("drops this session's whole-file claim on the doc map when the commit touched it", () => {
		store.acquire(docMap, live(sb, "alice"));

		const r = releaseCommitted("alice", [docMap]);

		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`Released ${docMap}`);
		expect(held(docMap)).toBe(false);
	});

	it("covers the class sidecar too", () => {
		store.acquire(sidecar, live(sb, "alice"));

		expect(releaseCommitted("alice", [sidecar]).stdout).toContain(
			`Released ${sidecar}`,
		);
		expect(held(sidecar)).toBe(false);
	});

	it("takes an absolute path, which is what git hands the hook's caller", () => {
		store.acquire(docMap, live(sb, "alice"));

		expect(releaseCommitted("alice", [inRepo(docMap)]).stdout).toContain(
			`Released ${docMap}`,
		);
		expect(held(docMap)).toBe(false);
	});

	it("leaves a REGION claim standing — one region is cheap, and mantahostels#2336 scopes to whole-file", () => {
		const subject = `${docMap}#section-b`;
		store.acquire(subject, live(sb, "alice"));

		const r = releaseCommitted("alice", [docMap]);

		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(
			new RegExp(
				`^Kept ${subject} — a region claim, which a commit never releases`,
			),
		);
		expect(held(subject)).toBe(true);
		expect(
			JSON.parse(fs.readFileSync(store.paths.keptClaimsLog(), "utf8")),
		).toMatchObject({ path: subject, verdict: "region", own: null });
	});

	it("reads a --commit that names no full sha as a path, and still releases the rest (#3746)", () => {
		const other = environment();
		store.acquire(other, live(sb, "alice"));

		const r = cli(["release-committed", "--commit", other], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});

		expect(r.stdout).toContain(`Released ${other}`);
		expect(held(other)).toBe(false);
	});

	it("drops a claim on a path that takes no regions (#2058)", () => {
		const other = environment();
		store.acquire(other, live(sb, "alice"));

		const r = releaseCommitted("alice", [other]);

		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`Released ${other}`);
		expect(held(other)).toBe(false);
	});

	it("drops a detect-only scripts/ claim too, so `list` stops showing a finished file", () => {
		const script = "scripts/tool.js";
		fs.mkdirSync(inRepo("scripts"), { recursive: true });
		fs.writeFileSync(inRepo(script), "// tool\n");
		commitAll(sb, "tool");
		store.acquire(script, live(sb, "alice"));

		expect(releaseCommitted("alice", [script]).stdout).toContain(
			`Released ${script}`,
		);
		expect(held(script)).toBe(false);
	});

	it("names every released path on ONE line, and the dirty one it kept on another (#2148)", () => {
		const other = environment();
		const me = live(sb, "alice");
		for (const p of [docMap, sidecar, other]) store.acquire(p, me);
		fs.writeFileSync(inRepo(other), "notes\nhalf an edit\n");

		const r = releaseCommitted("alice", [docMap, sidecar, other]);

		const [released, kept, ...rest] = r.stdout.trim().split("\n");
		expect(rest).toEqual([]);
		expect(released).toContain(docMap);
		expect(released).toContain(sidecar);
		expect(released).not.toContain(other);
		expect(kept).toMatch(new RegExp(`^Kept ${other} — `));
		expect(held(other)).toBe(true);
	});

	it("leaves a claim the commit did not touch", () => {
		store.acquire(docMap, live(sb, "alice"));

		const r = releaseCommitted("alice", [sidecar]);

		expect(r.stdout).toBe(
			`Released nothing — this session holds no whole-file claim on ${sidecar}.\n`,
		);
		expect(held(docMap)).toBe(true);
	});

	it("never drops a neighbour's claim, however the commit was spelt", () => {
		registerSession(sb, "bob", neighbourPid);
		store.acquire(docMap, store.identify("bob"));
		live(sb, "alice");

		const r = releaseCommitted("alice", [docMap]);

		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Released nothing");
		expect(held(docMap)).toBe(true);
	});

	it("keeps the claim on a file the commit left dirty, and says so in ONE line (#2148)", () => {
		store.acquire(docMap, live(sb, "alice"));
		fs.writeFileSync(inRepo(docMap), "# doc map\nhalf an edit\n");

		const r = releaseCommitted("alice", [docMap]);

		expect(r.status).toBe(0);
		expect(r.stdout.trim().split("\n")).toHaveLength(1);
		expect(r.stdout).toMatch(new RegExp(`^Kept ${docMap} — `));
		expect(r.stderr).toBe("");
		expect(held(docMap)).toBe(true);
	});

	it("does nothing at all without a session id — a person's own terminal commit", () => {
		store.acquire(docMap, live(sb, "alice"));

		const r = cli(["release-committed", docMap], {
			CLAUDE_CODE_SESSION_ID: "",
		});

		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(held(docMap)).toBe(true);
		expect(fs.existsSync(sb.errorLog())).toBe(false);
	});

	const aliceWrites = (rel: string, text: string) => {
		out(["check", inRepo(rel), "alice"]);
		fs.writeFileSync(inRepo(rel), text);
		out(["record", inRepo(rel), "alice"]);
	};

	it("reports a clobber of the holder's own bytes even where the release is refused (mantahostels#332, mantahostels#420)", () => {
		live(sb, "alice");
		aliceWrites(docMap, "alice's work\n");
		commitAll(sb, "alice");
		fs.writeFileSync(inRepo(docMap), "restored from a backup\n");

		const r = releaseCommitted("alice", [docMap]);

		expect(r.status).toBe(0);
		expect(r.stderr).toContain("has changed since this session");
		expect(held(docMap)).toBe(true);
		const sha = r.stderr.match(/git cat-file -p ([0-9a-f]{40,64})/)?.[1];
		expect(
			execFileSync("git", ["cat-file", "-p", sha as string], {
				cwd: sb.repo,
				encoding: "utf8",
			}),
		).toBe("alice's work\n");
	});

	it("tells a refused reader the pin STANDS, not that it went with the record (mantahostels#2370)", () => {
		live(sb, "alice");
		aliceWrites(docMap, "alice's work\n");
		commitAll(sb, "alice");
		fs.writeFileSync(inRepo(docMap), "restored from a backup\n");

		const r = releaseCommitted("alice", [docMap]);

		expect(r.status).toBe(0);
		expect(r.stderr).toContain("Nothing was released here");
		expect(r.stderr).not.toContain("dropped either way");
		expect(held(docMap)).toBe(true);
	});

	it("keeps the released branch's closing, where the pin really did go", () => {
		live(sb, "alice");
		aliceWrites(docMap, "alice's work\n");
		fs.writeFileSync(inRepo(docMap), "restored from a backup\n");
		commitAll(sb, "clobbered");

		const r = releaseCommitted("alice", [docMap]);

		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`Released ${docMap}`);
		expect(r.stderr).toContain("dropped either way");
		expect(r.stderr).not.toContain("Nothing was released here");
		expect(held(docMap)).toBe(false);
	});

	it("exits 0 on a commit that touched no claimed path, saying it released nothing", () => {
		live(sb, "alice");
		const r = releaseCommitted("alice", ["app/page.tsx"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Released nothing");
	});
});

describe("releasing once the holder's own hunks have landed (#2148)", () => {
	const notes = "docs/notes.md";
	const seed = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n";
	const theirs = seed.replace("one", "ONE");
	const both = theirs.replace("nine", "NINE");
	const herHunkOnly = seed.replace("nine", "NINE");

	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: sb.repo, encoding: "utf8" });

	const held = () => listedPaths().includes(notes);

	const aliceWrites = (text: string) => {
		out(["check", inRepo(notes), "alice"]);
		fs.writeFileSync(inRepo(notes), text);
		out(["record", inRepo(notes), "alice"]);
	};

	const commitOnly = (text: string) => {
		const disk = fs.readFileSync(inRepo(notes), "utf8");
		fs.writeFileSync(inRepo(notes), text);
		git("add", "--", notes);
		git("commit", "-q", "-m", "alice's hunk");
		fs.writeFileSync(inRepo(notes), disk);
	};

	const release = (...args: string[]) =>
		cli(["release", ...args, notes], { CLAUDE_CODE_SESSION_ID: "alice" });

	beforeEach(() => {
		gitRepo(sb);
		fs.mkdirSync(inRepo("docs"), { recursive: true });
		fs.writeFileSync(inRepo(notes), seed);
		commitAll(sb);
		live(sb, "alice");
		fs.writeFileSync(inRepo(notes), theirs);
	});

	it("gives the claim back at the commit, through .husky/post-commit's release step, with the neighbour's hunk still uncommitted", () => {
		aliceWrites(both);
		commitOnly(herHunkOnly);

		const r = releaseClaimsRow(
			buildRunIo({
				cwd: sb.repo,
				env: {
					...process.env,
					CLAUDE_CODE_SESSION_ID: "alice",
					GIT_INDEX_FILE: ".git/index",
				},
			}),
		);

		expect(r.exit).toBe(0);
		expect(r.stdout).toContain(`Released ${notes}`);
		expect(r.stdout).toContain(
			`Still carrying other sessions' uncommitted changes, none of this session's: ${notes}.`,
		);
		expect(held()).toBe(false);
		expect(fs.readFileSync(inRepo(notes), "utf8")).toBe(both);
		expect(git("diff", "--", notes)).toContain("+ONE");
	});

	it("keeps the claim while a hunk of the holder's own is uncommitted, saying so and offering no --not-mine (mantahostels#63)", () => {
		aliceWrites(both.replace("five", "FIVE"));
		commitOnly(herHunkOnly);

		const r = cli(["release-committed", notes], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});

		expect(r.stdout).toBe(
			`Kept ${notes} — an uncommitted change of this session's own is still in it; the commit that lands it releases the claim.\n`,
		);
		expect(held()).toBe(true);
	});

	describe("the overlay's attribution after it", () => {
		const mine = () => attributeDirty([notes], { sessionId: "alice" }).mine;
		const releaseCommitted = () =>
			cli(["release-committed", notes], { CLAUDE_CODE_SESSION_ID: "alice" });

		it("stops carrying the file once the commit landed all of the holder's hunks", () => {
			aliceWrites(both);
			expect(mine()).toEqual([notes]);
			commitOnly(herHunkOnly);

			expect(releaseCommitted().stdout).toContain(`Released ${notes}`);
			expect(mine()).toEqual([]);
		});

		it("still carries it while a hunk of the holder's own is uncommitted", () => {
			aliceWrites(both.replace("five", "FIVE"));
			commitOnly(herHunkOnly);

			expect(releaseCommitted().stdout).toContain(`Kept ${notes}`);
			expect(mine()).toEqual([notes]);
		});

		it("still leaves it out once the neighbour writes to it after the release", () => {
			aliceWrites(both);
			commitOnly(herHunkOnly);
			releaseCommitted();

			fs.writeFileSync(inRepo(notes), both.replace("five", "FIVE"));

			expect(mine()).toEqual([]);
		});

		it("leaves it out after a --not-mine release the proof could not make", () => {
			aliceWrites(theirs.replace("two", "TWO"));
			commitOnly(seed.replace("two", "TWO"));

			expect(release("--not-mine").status).toBe(0);
			expect(mine()).toEqual([]);
		});

		it("carries it again once the holder writes to it after the release", () => {
			aliceWrites(both);
			commitOnly(herHunkOnly);
			releaseCommitted();

			aliceWrites(both.replace("five", "FIVE"));

			expect(mine()).toEqual([notes]);
		});
	});

	it("releases by hand on the same proof, saying the dirt left behind is not its own", () => {
		aliceWrites(both);
		commitOnly(herHunkOnly);

		const r = release();

		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`Released ${notes}.`);
		expect(r.stdout).toContain("other sessions'");
		expect(held()).toBe(false);
	});

	it("refuses a hand release while a hunk of its own is uncommitted, even under --not-mine", () => {
		aliceWrites(both);

		for (const r of [release(), release("--not-mine")]) {
			expect(r.status).toBe(1);
			expect(r.stderr).toContain(
				"still holds an uncommitted change of this session's own",
			);
			expect(r.stderr).not.toContain("--not-mine");
		}
		expect(held()).toBe(true);
	});

	it("counts a hunk staged but never committed as the holder's own, though the disk no longer shows it", () => {
		aliceWrites(both.replace("five", "FIVE"));
		git("add", "--", notes);
		aliceWrites(both);
		commitOnly(herHunkOnly);
		fs.writeFileSync(inRepo(notes), herHunkOnly.replace("five", "FIVE"));
		git("add", "--", notes);
		fs.writeFileSync(inRepo(notes), both);

		expect(release().status).toBe(1);
		expect(held()).toBe(true);
	});

	it("counts a write no hook re-pinned as the holder's own, and keeps the claim without offering --not-mine", () => {
		aliceWrites(both);
		commitOnly(herHunkOnly);
		fs.writeFileSync(inRepo(notes), both.replace("five", "FIVE"));

		const r = release("--not-mine");

		expect(r.status).toBe(1);
		expect(r.stderr).toContain("an uncommitted change of this session's own");
		expect(held()).toBe(true);
	});

	it("names `release --not-mine` where it cannot prove whose the dirt is — a hunk abutting a neighbour's, the known gap — and that releases", () => {
		aliceWrites(theirs.replace("two", "TWO"));
		commitOnly(seed.replace("two", "TWO"));

		const kept = cli(["release-committed", notes], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		const refused = release();

		expect(kept.stdout).toContain(`Kept ${notes}`);
		expect(kept.stdout).toContain(`release --not-mine ${notes}`);
		expect(refused.status).toBe(1);
		expect(refused.stderr).toContain(`release --not-mine ${notes}`);
		expect(held()).toBe(true);

		const r = release("--not-mine");

		expect(r.status).toBe(0);
		expect(r.stdout).toContain("on this session's word (--not-mine)");
		expect(held()).toBe(false);
	});

	it("logs each keep with its verdict, own, session and commit, and nothing for a release (#3746)", () => {
		aliceWrites(theirs.replace("two", "TWO"));
		commitOnly(seed.replace("two", "TWO"));
		const sha = git("rev-parse", "HEAD").trim();

		const kept = cli(["release-committed", "--commit", sha, notes], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(kept.stdout).toContain(`Kept ${notes}`);

		const log = store.paths.keptClaimsLog();
		const rows = () =>
			fs
				.readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l));
		expect(rows()).toEqual([
			{
				at: expect.any(String),
				path: notes,
				verdict: "dirty",
				own: "unproven",
				session: "alice",
				commit: sha,
			},
		]);

		cli(["release-committed", notes], { CLAUDE_CODE_SESSION_ID: "alice" });
		expect(rows()[1]).toMatchObject({ path: notes, commit: null });
		release("--not-mine");
		cli(["release-committed", notes], { CLAUDE_CODE_SESSION_ID: "alice" });
		expect(rows()).toHaveLength(2);
	});

	it("still finds a clean pending hunk where another hunk conflicts", () => {
		aliceWrites(theirs.replace("two", "TWO").replace("nine", "NINE"));
		commitOnly(seed.replace("two", "TWO"));

		const r = release();

		expect(r.status).toBe(1);
		expect(r.stderr).toContain("an uncommitted change of this session's own");
		expect(held()).toBe(true);
	});

	it("takes no preBlob where the file holds an earlier edit of the session's own — a resumed retake (mantahostels#63)", () => {
		aliceWrites(both.replace("five", "FIVE"));
		fs.rmSync(core.paths.lock(notes));
		aliceWrites(both.replace("five", "FIVE"));
		commitOnly(herHunkOnly);

		const lock = JSON.parse(fs.readFileSync(core.paths.lock(notes), "utf8"));
		expect(lock.preBlob).toBeNull();
		expect(release().status).toBe(1);
		expect(held()).toBe(true);
	});
});

describe("one claim store across seats (#383)", () => {
	const seat = (name: string) => path.join(path.dirname(sb.home), name);

	const runOn = (dir: string, sessionId: string, args: string[]) => {
		fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, "sessions", `${process.pid}.json`),
			JSON.stringify({
				pid: process.pid,
				sessionId,
				procStart: proc.readProcStartOf(process.pid),
				status: "idle",
				cwd: sb.repo,
			}),
		);
		return cli(args, {
			CLAUDE_CONFIG_DIR: dir,
			CLAUDE_CODE_SESSION_ID: sessionId,
		});
	};

	it("warns a seat-3 session of the file a seat-2 session holds, naming the holder", () => {
		const file = inRepo("docs/seat.md");
		expect(
			runOn(seat(".claude2"), "alice", ["claim", file, "alice"]).status,
		).toBe(0);

		const r = runOn(seat(".claude3"), "bob", ["claim", file, "bob"]);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("also held by session alice");
		expect(
			runOn(seat(".claude3"), "bob", ["claim", inRepo("docs/other.md"), "bob"])
				.status,
		).toBe(0);
	});

	it("writes nothing outside the sandbox's own seat dirs", () => {
		runOn(seat(".claude2"), "alice", [
			"claim",
			inRepo("docs/seat.md"),
			"alice",
		]);
		runOn(seat(".claude3"), "bob", ["claim", inRepo("docs/seat.md"), "bob"]);

		expect(fs.readdirSync(path.dirname(sb.home)).sort()).toEqual([
			".claude",
			".claude2",
			".claude3",
		]);
		for (const s of [".claude2", ".claude3"])
			expect(fs.existsSync(path.join(seat(s), "projects"))).toBe(false);
		expect(fs.existsSync(path.join(sb.home, "projects"))).toBe(true);
	});
});

describe("wait: one call waits on an issue claim (#540)", () => {
	const waitAs = (
		sid: string,
		args: string[],
		extraEnv: Record<string, string> = {},
	) => {
		const child = keptSpawn("concurrent").spawn(
			process.execPath,
			[SCRIPT, "wait", ...args],
			{
				cwd: sb.repo,
				env: {
					...process.env,
					CLAUDE_CODE_SESSION_ID: sid,
					WFC_ARBITER_WAIT_POLL_S: "0.05",
					...extraEnv,
				},
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => {
			stdout += d;
		});
		child.stderr.on("data", (d) => {
			stderr += d;
		});
		const done = new Promise<{
			status: number | null;
			stdout: string;
			stderr: string;
		}>((resolve) =>
			child.on("close", (status) => resolve({ status, stdout, stderr })),
		);
		return { child, done };
	};

	const wantOf = (sid: string) =>
		cli(["list"], { CLAUDE_CODE_SESSION_ID: sid })
			.stdout.split("\n")
			.find((l) => l.startsWith(`WAITING  ${sid} wants `)) ?? null;

	const started = async (sid: string) => {
		for (let i = 0; i < 200 && wantOf(sid) === null; i++)
			await new Promise((r) => setTimeout(r, 25));
		expect(wantOf(sid)).not.toBeNull();
	};

	const aliceHolds = () => {
		const alice = live(sb, "alice");
		expect(store.claimIssue(540, alice).status).toBe("claimed");
		live(sb, "bob");
		return alice;
	};

	it("waits out a full non-blocking stdout pipe, keeping its verdict and its exit code (#1635)", () => {
		live(sb, "bob");
		const preload = path.join(sb.dir, "touch-stdout.js");
		fs.writeFileSync(preload, "process.stdout;\n");
		const seen = throughFullPipe(
			1,
			["--require", preload, SCRIPT, "wait", "540", "30"],
			{ cwd: sb.repo, env: { ...process.env, CLAUDE_CODE_SESSION_ID: "bob" } },
		);
		expect(seen).toMatch(/^NOT-HELD {2}issue #540 .*\nexit 4\n$/s);
	});

	it("exits CEILING naming the holder, and drops its want", async () => {
		aliceHolds();
		const r = await waitAs("bob", ["540", "0.3"]).done;
		expect(r.stdout).toMatch(/^CEILING {2}issue #540 — still held by alice/);
		expect(r.status).toBe(5);
		expect(wantOf("bob")).toBeNull();
	});

	it("names the holder at CEILING from the sessions registry when the oracle cannot be read (#3557)", async () => {
		aliceHolds();
		registerSession(sb, "alice", process.ppid, { name: "Wayfinder 1162" });
		const bin = writeOracle(path.join(sb.dir, "bin", "claude"), { exit: 3 });
		const r = await waitAs("bob", ["540", "0.3"], {
			WFC_CLAUDE_BIN: bin,
		}).done;
		expect(r.stdout).toMatch(
			/^CEILING .*still held by Wayfinder 1162 \(id alice/m,
		);
	});

	it("shows its want under `list` while it runs, and drops it when killed", async () => {
		aliceHolds();
		const w = waitAs("bob", ["540", "30"]);
		await started("bob");
		expect(wantOf("bob")).toMatch(/wants issue #540, claimed by alice/);
		w.child.kill("SIGTERM");
		expect((await w.done).status).toBe(143);
		expect(wantOf("bob")).toBeNull();
	});

	it("waits on the issue-claim register for a bare issue number", async () => {
		const alice = live(sb, "alice");
		store.claimIssue(540, alice);
		const bob = live(sb, "bob");
		store.claimIssue(540, bob);
		const w = waitAs("bob", ["540", "30"]);
		await started("bob");
		expect(wantOf("bob")).toMatch(/wants issue #540, claimed by alice/);
		store.releaseIssue(540, alice);
		const r = await w.done;
		expect(r.stdout).toMatch(/^RELEASED {2}issue #540/);
		expect(r.status).toBe(0);
		expect(wantOf("bob")).toBeNull();
	});

	it("exits NOT-HELD for an issue nobody else claims", async () => {
		live(sb, "bob");
		const r = await waitAs("bob", ["540", "30"]).done;
		expect(r.stdout).toMatch(/^NOT-HELD {2}issue #540/);
		expect(r.status).toBe(4);
	});

	describe("HOLDER-ENDED and DEADLOCK (#542)", () => {
		const calls = () => path.join(sb.dir, "oracle-calls");
		const oracleSays = (aliceState: string, others = ["bob"], exit = 0) => {
			const rows = [
				buildListedRow({ sessionId: "alice", state: aliceState }),
				...others.map((sessionId) => buildListedRow({ sessionId })),
			];
			const bin = writeOracle(
				path.join(sb.dir, "claude-542"),
				exit ? { exit, rows } : rows,
				calls(),
			);
			return { WFC_CLAUDE_BIN: bin, WFC_ORACLE_CACHE: "0" };
		};
		const aliceEnded = () => oracleSays("done");
		const oracleReads = () =>
			fs.existsSync(calls())
				? fs.readFileSync(calls(), "utf8").split("\n").filter(Boolean).length
				: 0;

		it("exits HOLDER-ENDED for an issue, saying its claim is stale", async () => {
			store.claimIssue(540, live(sb, "alice"));
			live(sb, "bob");
			const r = await waitAs("bob", ["540", "30"], aliceEnded()).done;
			expect(r.stdout).toMatch(/^HOLDER-ENDED {2}issue #540 — .*stale/);
			expect(r.status).toBe(6);
			expect(wantOf("bob")).toBeNull();
		});

		it("waits on to CEILING, never HOLDER-ENDED, where the oracle refuses — and says so", async () => {
			aliceHolds();
			const r = await waitAs(
				"bob",
				["540", "0.5"],
				oracleSays("done", ["bob"], 3),
			).done;
			expect(r.stdout).toMatch(/^CEILING {2}issue #540/);
			expect(r.stdout).toContain("Whether its session has ended is UNKNOWN");
			expect(r.status).toBe(5);
		});

		it("reads the oracle once, not once a poll, inside 30 s", async () => {
			aliceHolds();
			const r = await waitAs("bob", ["540", "0.6"], oracleSays("working")).done;
			expect(r.status).toBe(5);
			expect(oracleReads()).toBe(1);
		});

		it("starts one listing between three staggered waiters inside one TTL", async () => {
			aliceHolds();
			live(sb, "carol");
			live(sb, "dave");
			const env = {
				...oracleSays("working", ["bob", "carol", "dave"]),
				WFC_ORACLE_CACHE: "1",
			};
			const first = waitAs("bob", ["540", "2"], env);
			const published = () =>
				oracleCache.readFresh(buildOracleKey(env.WFC_CLAUDE_BIN)) !== null;
			for (let i = 0; i < 200 && !published(); i++)
				await new Promise((r) => setTimeout(r, 25));
			expect(published()).toBe(true);
			const later = ["carol", "dave"].map(
				(sid) => waitAs(sid, ["540", "1"], env).done,
			);
			const runs = await Promise.all([first.done, ...later]);
			for (const r of runs) {
				expect(r.status).toBe(5);
				expect(r.stdout).not.toContain("UNKNOWN");
			}
			expect(oracleReads()).toBe(1);
		});

		it("confirms a shared reading's HOLDER-ENDED with a fresh one before firing", async () => {
			aliceHolds();
			const env = {
				...oracleSays("working"),
				WFC_ORACLE_CACHE: "1",
			};
			oracleCache.write(
				buildOracleKey(env.WFC_CLAUDE_BIN),
				JSON.stringify([
					{ sessionId: "alice", kind: "background", state: "done" },
					{ sessionId: "bob" },
				]),
			);
			const r = await waitAs("bob", ["540", "0.6"], env).done;
			expect(r.stdout).toMatch(/^CEILING {2}issue #540/);
			expect(r.status).toBe(5);
			expect(oracleReads()).toBe(1);
		});

		it("exits DEADLOCK through an issue want, naming both sessions", async () => {
			const alice = live(sb, "alice");
			store.claimIssue(540, alice);
			const bob = live(sb, "bob");
			store.claimIssue(541, bob);
			store.recordWant("issue #541", alice);
			const r = await waitAs("bob", ["540", "30"]).done;
			expect(r.stdout).toMatch(
				/^DEADLOCK {2}issue #540 — bob wants issue #540 -> alice wants issue #541/,
			);
			expect(r.stdout).toContain("release-issue <n>");
			expect(r.status).toBe(7);
			expect(wantOf("bob")).toBeNull();
		});
	});

	it.each(["soon", "0", "Infinity"])(
		"refuses a ceiling of %s, which would not bound the wait, printing the wait usage",
		async (ceiling) => {
			live(sb, "bob");
			const r = await waitAs("bob", ["540", ceiling]).done;
			expect(r.stderr).toContain("usage: session-arbiter.js wait");
			expect(r.stdout).toBe("");
			expect(r.status).toBe(2);
		},
	);
});
