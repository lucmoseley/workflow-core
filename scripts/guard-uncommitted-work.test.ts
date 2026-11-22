// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readCurrentBootId, readProcStartOf } from "./lib/arbiter-proc";
import { AS_ROOT, registerSession } from "./lib/arbiter-testkit";
import { cutWorktree } from "./lib/git-fixture";
import { runInProcess } from "./lib/run-in-process";
import { shellQuote } from "./lib/sh-quote.js";
import { readStopGuardBlock, type StopBlock } from "./lib/stop-guard-testkit";
import {
	buildAsyncAgentResult,
	buildBashCall,
	buildFinalNotification,
	buildInterimNotification,
	buildToolCall,
} from "./lib/transcript-testkit";

const require_ = createRequire(__filename);
const { REFUSAL_NAMED_MAX } = require_("./lib/dirty-tree.js");
const arbiter = require_("./lib/arbiter-store.js");
// code-edges loads: lib/hook-block.js

const GUARD = path.join(__dirname, "guard-uncommitted-work.js");
const ARBITER = path.join(__dirname, "session-arbiter.js");

let root: string;
let sid: string;

function makeRepo(): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "uncommitted-")),
	);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, stdio: "ignore" });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "T");
	fs.writeFileSync(path.join(dir, "tracked.md"), "one\n");
	fs.writeFileSync(path.join(dir, "other.md"), "one\n");
	fs.writeFileSync(path.join(dir, "tool.sh"), "one\n");
	git("add", "tracked.md", "other.md", "tool.sh");
	git("commit", "-qm", "base");
	return dir;
}

function storeDir(sub = "", forRoot = root): string {
	return path.join(
		root,
		".claude-home",
		"projects",
		forRoot.replace(/[^a-zA-Z0-9]/g, "-"),
		sub,
	);
}

function ledger(entries: string[] | null, forRoot = root) {
	const dir = storeDir("writes", forRoot);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${sid.replace(/[^A-Za-z0-9_-]/g, "-")}.txt`);
	if (entries === null) {
		fs.rmSync(file, { force: true });
		return;
	}
	fs.writeFileSync(file, entries.map((e) => `${e}\n`).join(""));
}

function claim(rel: string, owner: string, tree?: string) {
	const dir = storeDir("locks");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, `${rel.replace(/[^A-Za-z0-9_-]/g, "-")}.json`),
		JSON.stringify({
			path: rel,
			...(tree ? { tree } : {}),
			sessionId: owner,
			pid: process.pid,
			procStart: readProcStartOf(process.pid),
			bootId: readCurrentBootId(),
		}),
	);
}

interface Run {
	blocked: boolean;
	reason: string;
	warn: string;
}

function run(
	cwd = root,
	extraEnv: Record<string, string> = {},
	payload: Record<string, unknown> = {},
	stdin?: string,
): Run {
	const out = readStopGuardBlock(GUARD, {
		dir: cwd,
		sid,
		config: path.join(root, ".claude-home"),
		env: extraEnv,
		payload: { transcript_path: undefined, ...payload },
		stdin,
	}) as (Partial<StopBlock> & { systemMessage?: string }) | null;
	if (!out) return { blocked: false, reason: "", warn: "" };
	return {
		blocked: out.decision === "block",
		reason: out.reason ?? "",
		warn: out.systemMessage ?? "",
	};
}

function dirty(rel: string) {
	fs.appendFileSync(path.join(root, rel), "two\n");
}

beforeEach(() => {
	root = makeRepo();
	sid = `test-session-${Math.random().toString(36).slice(2)}`;
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("the dirt limb", () => {
	it("blocks when a tracked file this session wrote is uncommitted, naming it", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const r = run();
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("tracked.md");
	});

	it("passes on a clean tree", () => {
		ledger(["tracked.md"]);
		expect(run().blocked).toBe(false);
	});

	it("passes when the dirty file is staged AND committed", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		execFileSync("git", ["commit", "-qm", "x", "--", "tracked.md"], {
			cwd: root,
			stdio: "ignore",
		});
		expect(run().blocked).toBe(false);
	});

	it("blocks on a merely staged change", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		execFileSync("git", ["add", "tracked.md"], { cwd: root, stdio: "ignore" });
		expect(run().blocked).toBe(true);
	});
});

describe("attribution — a neighbour's dirt is not yours (mantahostels#114)", () => {
	it("passes when the dirty file is not in this session's ledger", () => {
		ledger(["tracked.md"]);
		dirty("other.md");
		expect(run().blocked).toBe(false);
	});

	it("names only the session's own file when both are dirty", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		dirty("other.md");
		const r = run();
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("tracked.md");
		expect(r.reason).not.toContain("other.md");
	});

	it("passes when the ledger is empty", () => {
		ledger([]);
		dirty("tracked.md");
		expect(run().blocked).toBe(false);
	});

	it("passes when there is no ledger file at all", () => {
		ledger(null);
		dirty("tracked.md");
		expect(run().blocked).toBe(false);
	});
});

describe("a Bash-route code write is credited and blocks (mantahostels#2778)", () => {
	const entry = path.join(__dirname, "guard-dispatch.js");

	function credit(rel: string) {
		const res = runInProcess(entry, ["--only", "guard-claimed-bash-write"], {
			cwd: root,
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: root,
				CLAUDE_CONFIG_DIR: path.join(root, ".claude-home"),
			},
			stdin: JSON.stringify({
				session_id: sid,
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: `sed -i s/a/b/ ${rel}` },
			}),
		});
		expect(res.status).toBe(0);
		expect(res.stdout).toBe("");
	}

	it("blocks on an uncommitted code file the credit half billed here, naming it", () => {
		credit("tool.sh");
		dirty("tool.sh");
		const r = run();
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("tool.sh");
	});

	it("leaves a doc the same session dirtied unnamed and unblocked", () => {
		credit("tool.sh");
		dirty("tracked.md");
		expect(run().blocked).toBe(false);
	});
});

describe("untracked scratch is out (mantahostels#1555)", () => {
	it("passes on an untracked file even when the ledger claims it", () => {
		ledger(["scratch.md"]);
		fs.writeFileSync(path.join(root, "scratch.md"), "notes\n");
		expect(run().blocked).toBe(false);
	});

	it("is silent on untracked scratch at the repo root", () => {
		fs.writeFileSync(path.join(root, ".i0.out"), "captured\n");
		const r = run();
		expect(r.blocked).toBe(false);
		expect(r.warn).toBe("");
	});
});

describe("the session's own worktree (#4229)", () => {
	let wt: string;
	beforeEach(() => {
		wt = cutWorktree(root);
	});

	const runIn = (payload: Record<string, unknown> = {}): Run => {
		const out = readStopGuardBlock(GUARD, {
			dir: root,
			worktree: wt,
			sid,
			config: path.join(root, ".claude-home"),
			payload: { transcript_path: undefined, ...payload },
		});
		return out
			? { blocked: out.decision === "block", reason: out.reason, warn: "" }
			: { blocked: false, reason: "", warn: "" };
	};

	const wrote = (rel: string) => ledger([`${rel}\t${wt}`]);

	it("blocks on the worktree's dirt, naming it as the worktree spells it", () => {
		wrote("tracked.md");
		fs.appendFileSync(path.join(wt, "tracked.md"), "three\n");
		const r = runIn();
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain(`uncommitted in ${wt}: tracked.md.`);
		expect(r.reason).toContain("-- tracked.md`");
		expect(r.reason).not.toContain("index is every session's");
	});

	it("passes on main-checkout dirt at a path the session wrote in its worktree", () => {
		wrote("tracked.md");
		dirty("tracked.md");
		expect(runIn().blocked).toBe(false);
	});

	it("passes on worktree dirt at a path the session wrote only in the main checkout (#4457)", () => {
		ledger(["tracked.md"]);
		fs.appendFileSync(path.join(wt, "tracked.md"), "three\n");
		expect(runIn().blocked).toBe(false);
	});

	it("blocks on worktree dirt though a live neighbour claims that path in the main checkout (#4457)", () => {
		wrote("tracked.md");
		fs.appendFileSync(path.join(wt, "tracked.md"), "three\n");
		claim("tracked.md", "some-other-session");
		expect(runIn().blocked).toBe(true);
	});

	it("passes on worktree dirt a live neighbour claims in that same worktree", () => {
		wrote("tracked.md");
		fs.appendFileSync(path.join(wt, "tracked.md"), "three\n");
		claim("tracked.md", "some-other-session", wt);
		expect(runIn().blocked).toBe(false);
	});

	describe("hooks handed the worktree as CLAUDE_PROJECT_DIR (#4493)", () => {
		const arbiterCli = (args: string[], projectDir: string | undefined) => {
			const { CLAUDE_PROJECT_DIR: _p, WFC_REPO_ROOT: _r, ...env } = process.env;
			return runInProcess(ARBITER, args, {
				cwd: wt,
				env: {
					...env,
					CLAUDE_CONFIG_DIR: path.join(root, ".claude-home"),
					CLAUDE_CODE_SESSION_ID: sid,
					...(projectDir ? { CLAUDE_PROJECT_DIR: projectDir } : {}),
				},
			});
		};
		const endShipped = () =>
			readStopGuardBlock(GUARD, {
				dir: root,
				worktree: wt,
				sid,
				config: path.join(root, ".claude-home"),
				env: { CLAUDE_PROJECT_DIR: wt, WFC_REPO_ROOT: undefined },
				payload: {
					transcript_path: undefined,
					last_assistant_message: "Done.\n\nresult: shipped",
				},
			});

		const doc = "docs/notes.md";

		it("names a committed file's claim, which the hand-run release then clears", () => {
			fs.mkdirSync(path.join(wt, "docs"));
			fs.writeFileSync(path.join(wt, doc), "notes\n");
			execFileSync("git", ["add", doc], { cwd: wt });
			execFileSync("git", ["commit", "-qm", "notes"], { cwd: wt });
			const home = path.join(root, ".claude-home");
			fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
			registerSession({ home, repo: wt }, sid, process.pid);
			expect(arbiterCli(["claim", doc], wt).status).toBe(0);
			const reason = endShipped()?.reason ?? "";
			expect(reason).toContain(
				`holds 1 claim(s) on files with no uncommitted change: ${doc}.`,
			);
			expect(reason).toMatch(
				new RegExp(
					`\`node \\S*session-arbiter\\.js release-committed ${doc}\``,
				),
			);

			const released = arbiterCli(["release-committed", doc], undefined);
			expect(released.stdout).toContain(`Released ${doc}`);
			expect(endShipped()).toBeNull();
		});
	});

	it("does not call a claimed file clean while it is dirty in the worktree", () => {
		claim("tracked.md", sid, wt);
		claim("other.md", sid, wt);
		fs.appendFileSync(path.join(wt, "other.md"), "three\n");
		const r = runIn({ last_assistant_message: "Done.\n\nresult: shipped" });
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain(
			"holds 1 claim(s) on files with no uncommitted change: tracked.md.",
		);
	});
});

describe("outside a repository", () => {
	it("passes where the cwd is not a git repository at all", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "notarepo-"));
		try {
			expect(run(outside).blocked).toBe(false);
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("the concision backstop's markers buy no exemption", () => {
	it.each(["concision", "codereview"])(
		"blocks even while the %s pass it demanded is outstanding",
		(kind) => {
			ledger(["tracked.md"]);
			dirty("tracked.md");
			fs.writeFileSync(path.join(root, `.${kind}-nagged-${sid}`), "");
			expect(run().blocked).toBe(true);
		},
	);
});

describe("the way out", () => {
	it("hands over a pathspec commit naming every dirty path", () => {
		ledger(["tracked.md", "other.md"]);
		dirty("tracked.md");
		dirty("other.md");
		const r = run();
		expect(r.reason).toContain(
			'git commit -m "<why, in plain language>" -- other.md tracked.md',
		);
		expect(r.reason).toContain("Never `git add` first");
	});

	function manyDirty(count: number): string[] {
		const many = Array.from({ length: count }, (_, i) => `f${String(i)}.md`);
		for (const f of many) fs.writeFileSync(path.join(root, f), "one\n");
		execFileSync("git", ["add", ...many], { cwd: root, stdio: "ignore" });
		execFileSync("git", ["commit", "-qm", "many"], {
			cwd: root,
			stdio: "ignore",
		});
		for (const f of many) dirty(f);
		ledger(many);
		return many;
	}

	it("withholds the command rather than truncating it, above the cap", () => {
		manyDirty(REFUSAL_NAMED_MAX + 2);
		const r = run();
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("(and 2 more)");
		expect(r.reason).not.toContain(
			'git commit -m "<why, in plain language>" -- f',
		);
		expect(r.reason).toContain("git status --porcelain -uno");
	});

	it("names every path at exactly the cap", () => {
		manyDirty(REFUSAL_NAMED_MAX);
		const r = run();
		expect(r.reason).not.toContain("more)");
		expect(r.reason).toContain('git commit -m "<why, in plain language>" -- f');
	});

	it("truncates one path past the cap", () => {
		manyDirty(REFUSAL_NAMED_MAX + 1);
		expect(run().reason).toContain("(and 1 more)");
	});
});

describe("the block is bounded (lib/hook-block.js)", () => {
	it("stops blocking after six, so an uncommittable session is not trapped", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		for (let i = 0; i < 6; i++) expect(run().blocked).toBe(true);
		expect(run().blocked).toBe(false);
	});

	it("still blocks at three, the house default this guard raises to six (mantahostels#2791)", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		fs.writeFileSync(path.join(root, `.uncommitted-nagged-${sid}`), "3\n");
		expect(run().blocked).toBe(true);
	});
});

describe("the payload limb", () => {
	it("passes when the payload carries no session id", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		expect(
			run(root, {}, {}, JSON.stringify({ hook_event_name: "Stop" })),
		).toEqual({ blocked: false, reason: "", warn: "" });
	});
});

describe("a live neighbour's claim subtracts the path", () => {
	it("passes when a live OTHER session holds the dirty path", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		claim("tracked.md", "some-other-session");
		expect(run().blocked).toBe(false);
	});

	it("still blocks when the live claim is this session's own", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		claim("tracked.md", sid);
		expect(run().blocked).toBe(true);
	});
});

function oracle(ids: string[] | null, { marker }: { marker?: string } = {}) {
	const bin = path.join(root, "fake-claude");
	const listing = path.join(root, "agents.json");
	if (ids !== null)
		fs.writeFileSync(
			listing,
			JSON.stringify(ids.map((sessionId) => ({ sessionId }))),
		);
	fs.writeFileSync(
		bin,
		`#!/bin/sh\n${marker ? `touch ${shellQuote(marker)}\n` : ""}${
			ids === null
				? 'echo "no daemon" >&2\nexit 1\n'
				: `cat ${shellQuote(listing)}\n`
		}`,
		{ mode: 0o755 },
	);
	return bin;
}

const withOracle = (ids: string[] | null, opts?: { marker?: string }) => ({
	WFC_CLAUDE_BIN: oracle(ids, opts),
	CLAUDE_CODE_SESSION_ID: sid,
});

describe("a live neighbour's observation subtracts the path (mantahostels#2282)", () => {
	const neighbour = "neighbour-session";
	const mine = "scripts/one.js";
	const others = "scripts/two.js";

	const observationsDir = () => storeDir("observations");

	beforeEach(() => {
		fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
		for (const rel of [mine, others])
			fs.writeFileSync(path.join(root, rel), "one\n");
		execFileSync("git", ["add", mine, others], { cwd: root, stdio: "ignore" });
		execFileSync("git", ["commit", "-qm", "scripts"], {
			cwd: root,
			stdio: "ignore",
		});
	});

	function observe(rel: string, owner: string) {
		const { CLAUDE_PROJECT_DIR, CLAUDE_CONFIG_DIR } = process.env;
		vi.stubEnv("CLAUDE_PROJECT_DIR", root);
		vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(root, ".claude-home"));
		try {
			const sha = arbiter.recordObservation(rel, { sessionId: owner });
			expect(sha, `no observation was minted for ${rel}`).not.toBeNull();
		} finally {
			vi.stubEnv("CLAUDE_PROJECT_DIR", CLAUDE_PROJECT_DIR);
			vi.stubEnv("CLAUDE_CONFIG_DIR", CLAUDE_CONFIG_DIR);
		}
	}

	it("passes when a live OTHER session has observed the dirty path", () => {
		ledger([mine]);
		dirty(mine);
		observe(mine, neighbour);
		expect(run(root, withOracle([sid, neighbour])).blocked).toBe(false);
	});

	it("still blocks when the observation is this session's own", () => {
		ledger([mine]);
		dirty(mine);
		observe(mine, sid);
		expect(run(root, withOracle([sid])).blocked).toBe(true);
	});

	it("still blocks when the observing session is not live", () => {
		ledger([mine]);
		dirty(mine);
		observe(mine, neighbour);
		expect(run(root, withOracle([sid])).blocked).toBe(true);
	});

	it("still blocks when the neighbour observed some other file", () => {
		ledger([mine]);
		dirty(mine);
		observe(others, neighbour);
		expect(run(root, withOracle([sid, neighbour])).blocked).toBe(true);
	});

	it("blocks and says the neighbour check went blind when the oracle refuses", () => {
		ledger([mine]);
		dirty(mine);
		observe(mine, neighbour);
		const r = run(root, withOracle(null));
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("could not run");
	});

	it.skipIf(AS_ROOT)(
		"blocks and says so when the observation store will not open",
		() => {
			ledger([mine]);
			dirty(mine);
			observe(mine, neighbour);
			fs.chmodSync(observationsDir(), 0o000);
			try {
				const r = run(root, withOracle([sid, neighbour]));
				expect(r.blocked).toBe(true);
				expect(r.reason).toContain("could not be read");
			} finally {
				fs.chmodSync(observationsDir(), 0o755);
			}
		},
	);

	it("does not spend the oracle on a turn with nothing to name", () => {
		const marker = path.join(root, "oracle-ran");
		ledger([mine]);
		observe(mine, neighbour);
		expect(run(root, withOracle([sid, neighbour], { marker })).blocked).toBe(
			false,
		);
		expect(fs.existsSync(marker)).toBe(false);
	});
});

describe("the spent block cap stands the oracle down (mantahostels#2383)", () => {
	const neighbour = "neighbour-session";
	const mine = "tracked.md";

	const counter = () =>
		path.join(
			require_("./lib/marker-root.js").markersDir(root),
			`.uncommitted-nagged-${sid}`,
		);

	it("does not spend the oracle once the block cap is spent", () => {
		const marker = path.join(root, "oracle-ran");
		ledger([mine]);
		dirty(mine);
		fs.writeFileSync(counter(), "6\n");
		expect(run(root, withOracle([sid, neighbour], { marker })).blocked).toBe(
			false,
		);
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("leaves the counter untouched — the read never increments it", () => {
		ledger([mine]);
		dirty(mine);
		fs.writeFileSync(counter(), "6\n");
		run(root, withOracle([sid, neighbour]));
		expect(fs.readFileSync(counter(), "utf8")).toBe("6\n");
	});

	it("still blocks when the counter holds something that is not a number", () => {
		ledger([mine]);
		dirty(mine);
		fs.writeFileSync(counter(), "not a number\n");
		expect(run(root, withOracle([sid])).blocked).toBe(true);
	});

	it("still blocks below the cap, and spends the oracle to get there", () => {
		const marker = path.join(root, "oracle-ran");
		ledger([mine]);
		dirty(mine);
		fs.writeFileSync(counter(), "5\n");
		expect(run(root, withOracle([sid], { marker })).blocked).toBe(true);
		expect(fs.existsSync(marker)).toBe(true);
	});
});

describe("path shapes the porcelain parser exists for", () => {
	it("names a path containing a space, quoted as one shell word", () => {
		const spaced = "a file.md";
		fs.writeFileSync(path.join(root, spaced), "one\n");
		execFileSync("git", ["add", spaced], { cwd: root, stdio: "ignore" });
		execFileSync("git", ["commit", "-qm", "spaced"], {
			cwd: root,
			stdio: "ignore",
		});
		dirty(spaced);
		ledger([spaced]);
		const r = run();
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("'a file.md'");
	});

	it("names both sides of a rename, and reads its source as a source", () => {
		execFileSync("git", ["mv", "other.md", "renamed.md"], {
			cwd: root,
			stdio: "ignore",
		});
		dirty("tracked.md");
		ledger(["tracked.md", "other.md", "renamed.md"]);
		const r = run();
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("renamed.md");
		expect(r.reason).toContain("tracked.md");
		expect(r.reason).toContain("other.md");
	});
});

describe("the `waiting:` stand-down (mantahostels#2567)", () => {
	const launchId = "toolu_launch01";

	function transcript(lines: unknown[]): string {
		const file = path.join(root, "transcript.jsonl");
		fs.writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
		return file;
	}

	const userTurn = {
		type: "user",
		message: { content: [{ type: "text", text: "go" }] },
	};

	const bashLaunch = buildBashCall("sleep 60", launchId, {
		input: { run_in_background: true },
	});

	const notification = {
		type: "user",
		message: {
			content: [
				{
					type: "text",
					text: `<task-notification><tool-use-id>${launchId}</tool-use-id></task-notification>`,
				},
			],
		},
	};

	function say(text: string) {
		return {
			type: "assistant",
			message: { content: [{ type: "text", text }] },
		};
	}

	const handoff = "waiting: the suite run above will wake this session.";

	it("stands down on a waiting: hand-off with a launch still out", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const file = transcript([userTurn, bashLaunch, say(handoff)]);
		expect(
			run(root, {}, { last_assistant_message: handoff, transcript_path: file })
				.blocked,
		).toBe(false);
	});

	it("stands down for a foreground call moved to the background at its timeout (#1012)", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const foreground = buildBashCall("npm run test", launchId);
		const overrun = {
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: launchId,
						content:
							"Command did not complete within its 600s timeout and was moved to the background (ID: b1).",
					},
				],
			},
		};
		const file = transcript([userTurn, foreground, overrun, say(handoff)]);
		expect(
			run(root, {}, { last_assistant_message: handoff, transcript_path: file })
				.blocked,
		).toBe(false);
	});

	const agentLaunch = [
		buildToolCall("Agent", { description: "Fix review findings" }, launchId),
		buildAsyncAgentResult(launchId),
		buildInterimNotification(launchId),
	];

	it("stands down for a subagent whose only notification is interim (#5420)", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const file = transcript([userTurn, ...agentLaunch, say(handoff)]);
		expect(
			run(root, {}, { last_assistant_message: handoff, transcript_path: file })
				.blocked,
		).toBe(false);
	});

	it("blocks again once that subagent's final notification arrives (#5420)", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const file = transcript([
			userTurn,
			...agentLaunch,
			buildFinalNotification(),
			say(handoff),
		]);
		expect(
			run(root, {}, { last_assistant_message: handoff, transcript_path: file })
				.blocked,
		).toBe(true);
	});

	it("still blocks when the launch has already been settled, naming the file", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const file = transcript([userTurn, bashLaunch, notification, say(handoff)]);
		const r = run(
			root,
			{},
			{
				last_assistant_message: handoff,
				transcript_path: file,
			},
		);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("tracked.md");
	});

	it("still blocks when the transcript holds no launch at all", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const file = transcript([userTurn, say(handoff)]);
		expect(
			run(root, {}, { last_assistant_message: handoff, transcript_path: file })
				.blocked,
		).toBe(true);
	});

	it("still blocks on a bare waiting: carrying nothing after the colon", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const file = transcript([userTurn, bashLaunch, say("waiting:")]);
		expect(
			run(
				root,
				{},
				{ last_assistant_message: "waiting:", transcript_path: file },
			).blocked,
		).toBe(true);
	});

	it.each([
		["with a launch still out", [userTurn, bashLaunch] as unknown[]],
		["with no launch at all", [userTurn] as unknown[]],
	])("still blocks where a later marker governs, %s", (_name, prefix) => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const message = `${handoff}\nresult: done.`;
		const file = transcript([...prefix, say(message)]);
		expect(
			run(root, {}, { last_assistant_message: message, transcript_path: file })
				.blocked,
		).toBe(true);
	});

	it("reads the message off the transcript when the payload omits it", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const file = transcript([userTurn, bashLaunch, say(handoff)]);
		expect(run(root, {}, { transcript_path: file }).blocked).toBe(false);
	});

	it("still blocks when the transcript named does not exist", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		expect(
			run(
				root,
				{},
				{
					last_assistant_message: handoff,
					transcript_path: path.join(root, "absent.jsonl"),
				},
			).blocked,
		).toBe(true);
	});

	it("names the fault when a waiting: hand-off does not earn the stand-down", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const file = transcript([userTurn, bashLaunch, notification, say(handoff)]);
		const r = run(
			root,
			{},
			{
				last_assistant_message: handoff,
				transcript_path: file,
			},
		);
		expect(r.reason).toContain(
			"nothing this session launched is still running",
		);
		expect(r.reason).toContain("Re-sending it unchanged will block again");
	});

	it("says nothing about the hand-off where the turn never claimed one", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const file = transcript([userTurn, say("result: done.")]);
		const r = run(
			root,
			{},
			{
				last_assistant_message: "result: done.",
				transcript_path: file,
			},
		);
		expect(r.blocked).toBe(true);
		expect(r.reason).not.toContain("hand-off");
	});

	it("still blocks when the payload omits the message and the transcript will not read", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const dir = path.join(root, "adirectory.jsonl");
		fs.mkdirSync(dir);
		const r = run(root, {}, { transcript_path: dir });
		expect(r.blocked).toBe(true);
		expect(r.reason).not.toContain("hand-off");
	});

	it("falls back to the conventional transcript path when the payload names none", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const dir = storeDir();
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, `${sid}.jsonl`),
			[userTurn, bashLaunch, say(handoff)]
				.map((l) => `${JSON.stringify(l)}\n`)
				.join(""),
		);
		expect(run(root, {}, { last_assistant_message: handoff }).blocked).toBe(
			false,
		);
	});

	it("spends no block when it stands down", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const file = transcript([userTurn, bashLaunch, say(handoff)]);
		run(root, {}, { last_assistant_message: handoff, transcript_path: file });
		const markers = require_("./lib/marker-root.js").markersDir(root);
		const counters = fs
			.readdirSync(markers)
			.filter((f) => f.startsWith(".uncommitted-nagged-"));
		expect(counters).toEqual([]);
	});
});

describe("a claim left on a committed file (#3565)", () => {
	const ending = (message: string) =>
		run(root, {}, { last_assistant_message: `Done.\n\n${message}` });

	it.each(["result: shipped", "needs input: which one — waits on you: #1"])(
		"blocks a turn ending `%s`, naming each clean file and the release that clears it",
		(marker) => {
			claim("tracked.md", sid);
			claim("other.md", sid);
			const r = ending(marker);
			expect(r.blocked).toBe(true);
			expect(r.reason).toContain(
				"holds 2 claim(s) on files with no uncommitted change: other.md tracked.md.",
			);
			expect(r.reason).toContain(
				"session-arbiter.js release-committed other.md tracked.md`",
			);
		},
	);

	it("leaves out a dirty file, a region claim and a neighbour's claim", () => {
		claim("tracked.md", sid);
		claim("other.md", sid);
		dirty("other.md");
		claim("tool.sh", "some-other-session");
		claim("docs/doc-map.md#B1", sid);
		const r = ending("result: shipped");
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain(
			"holds 1 claim(s) on files with no uncommitted change: tracked.md.",
		);
	});

	it.each([
		["a `waiting:` turn", "waiting: the suite will wake this session."],
		["a turn with no marker", "Here is what I found."],
	])("passes %s", (_, message) => {
		claim("tracked.md", sid);
		expect(run(root, {}, { last_assistant_message: message }).blocked).toBe(
			false,
		);
	});

	it("passes once this session holds no clean claim", () => {
		claim("tracked.md", "some-other-session");
		expect(ending("result: shipped").blocked).toBe(false);
	});
});
