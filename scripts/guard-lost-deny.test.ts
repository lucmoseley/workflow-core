// @vitest-environment node
/*
 * guard-lost-deny.js tells a session, at Stop, that a deny-capable guard was
 * killed at its timeout and failed open on one of its tool calls — naming the
 * guard, the call and a replay command, once per call — and stays silent where
 * nothing deny-capable was lost (mantahostels#2299, ruled at mantahostels#2289).
 *
 * Black-box: the guard is driven end to end with a Stop payload on stdin and
 * its repo root pointed at a throwaway directory, so the counters, the seen
 * set and the breadcrumbs it mints never land in the shared tree. The core it
 * reads the guards from (WFC_SCRIPT_ROOT) is that same directory, except where
 * a test splits the two to stand in for an adopter (#1017) or points it at
 * this repo to read the real guards (#1815). `replay`
 * still spawns the lost guards themselves for real; that spawn is the guard's,
 * not the test's, and runInProcess captures it like any other write to fd 1/2
 * since it goes through the patched `process.stdout.write`, never
 * `stdio: "inherit"`.
 *
 * It runs at every `Stop` and is the only reporter a session hears while it
 * can still act: break it and a tool call that escaped a killed deny guard
 * proceeds with nothing said; loosen the dedupe or the worth-a-turn test and
 * it blocks turns for nothing.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";
import { readStopGuardBlock, type StopRun } from "./lib/stop-guard-testkit";
import { buildBashCall } from "./lib/transcript-testkit";

/* The breadcrumb directory, from the module that owns it (mantahostels#3382). */
const hookRecord = createRequire(__filename)("./lib/hook-record.js");

/* The nagged counter lives under gr_markers_dir (.claude/tmp/markers), not
 * the throwaway root itself — hook-block.js's counterPath (mantahostels#3515 F8,
 * issue #2). */
const { markersDir } = createRequire(__filename)("./lib/marker-root.js");

const GUARD = path.join(__dirname, "guard-lost-deny.js");

let dir: string;
let core: string;
let sid: string;

/** A guard file in the core — deny-capable where it prints a deny verdict. */
const guardFile = (name: string, denies: boolean) => {
	const body = denies
		? '#!/usr/bin/env bash\nprintf \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"because"}}\'\n'
		: "#!/usr/bin/env bash\necho fine\n";
	const file = path.join(core, "scripts", name);
	fs.writeFileSync(file, body);
	fs.chmodSync(file, 0o755);
	return file;
};

/** A deny-capable guard-branch.sh that echoes the payload it is handed. */
const echoGuard = () => {
	const guard = path.join(core, "scripts", "guard-branch.sh");
	fs.writeFileSync(
		guard,
		'#!/usr/bin/env bash\ncat\necho \'{"permissionDecision":"deny"} is what makes this deny-capable\' >/dev/null\n',
	);
	fs.chmodSync(guard, 0o755);
};

/** The payload echoGuard printed during a replay. */
const sentPayload = (stdout: string) =>
	JSON.parse(stdout.split("=== guard-branch.sh ===\n")[1].split("\nexit ")[0]);

/** The attachment record the harness writes when a hook is killed. */
const killed = (over: object = {}) => ({
	type: "attachment",
	timestamp: "2026-08-31T07:02:03.606Z",
	attachment: {
		type: "hook_cancelled",
		hookName: "PreToolUse:Bash",
		toolUseID: "toolu_A",
		hookEvent: "PreToolUse",
		command: "$CLAUDE_PROJECT_DIR/scripts/guard-branch.sh",
		durationMs: 15_003,
		timedOut: true,
		timeoutMs: 15_000,
		...over,
	},
});

/** A Bash call carrying the session id the replayed hook payload must echo. */
const fileCall = (command: string, id: string) =>
	buildBashCall(command, id, { sessionId: "session-in-the-file" });

const transcript = (records: object[]): string => {
	const file = path.join(dir, `${sid}.jsonl`);
	fs.writeFileSync(
		file,
		`${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
	);
	return file;
};

/** The half-written final line a transcript still being appended to ends on. */
const halfWritten = (file: string) =>
	fs.appendFileSync(file, '{"type":"attach');

/**
 * The guard's verdict on this session's transcript, run as an interactive
 * session unless `over.job` says otherwise; with no `over.message`, the guard
 * reads the turn's text from the transcript.
 */
const run = (over: Partial<StopRun> = {}) => {
	const block = readStopGuardBlock(GUARD, {
		dir,
		sid,
		config: dir,
		transcript: path.join(dir, `${sid}.jsonl`),
		...over,
		env: { WFC_SCRIPT_ROOT: core, ...over.env },
	});
	return { blocked: block !== null, reason: block?.reason ?? "" };
};

/** The `replay` subcommand, a CLI rather than a Stop run. */
const replay = (...argv: string[]) =>
	runInProcess(GUARD, ["replay", ...argv], {
		stdin: "",
		cwd: dir,
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: dir,
			WFC_REPO_ROOT: dir,
			WFC_SCRIPT_ROOT: core,
			CLAUDE_CONFIG_DIR: dir,
		},
	});

/** The last breadcrumb this guard wrote for this session. */
const readCrumb = () => {
	const file = path.join(
		hookRecord.recordsDir(dir),
		`.hook-ran-guard-lost-deny-${sid}`,
	);
	const lines = fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim());
	return JSON.parse(lines.at(-1) ?? "");
};

const readSeen = () =>
	fs
		.readFileSync(
			path.join(dir, ".claude", "tmp", "markers", `.lost-deny-seen-${sid}`),
			"utf8",
		)
		.split("\n")
		.filter(Boolean);

/* A package.json makes the core a checkout, so the replay command it prints
 * stays `scripts/…` rather than an install's absolute path. */
const makeCore = (root: string) => {
	fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
	fs.writeFileSync(path.join(root, "package.json"), "{}\n");
	return root;
};

beforeEach(() => {
	dir = makeCore(fs.mkdtempSync(path.join(os.tmpdir(), "lost-deny-")));
	core = dir;
	sid = "s-lost-deny";
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	if (core !== dir) fs.rmSync(core, { recursive: true, force: true });
});

describe("what it reports", () => {
	it("names the guard, the tool call and the replay command", () => {
		guardFile("guard-branch.sh", true);
		const file = transcript([
			fileCall("git worktree add /tmp/w", "toolu_A"),
			killed(),
		]);

		const r = run();

		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("guard-branch.sh");
		expect(r.reason).toContain("git worktree add /tmp/w");
		expect(r.reason).toContain(
			`node scripts/guard-lost-deny.js replay ${file} toolu_A`,
		);
		expect(r.reason).toContain(
			"guard-branch.sh was cancelled after 15003 ms against a 15000 ms timeout",
		);
	});

	it("says the list may be short where a line of the transcript would not parse — mantahostels#3311", () => {
		guardFile("guard-branch.sh", true);
		const file = transcript([fileCall("git push", "toolu_A"), killed()]);
		halfWritten(file);

		const r = run();

		expect(r.blocked).toBe(true);
		expect(r.reason).toContain(
			"1 line(s) of the transcript would not parse and were skipped",
		);
	});

	it("says nothing about skipped lines where the transcript parsed whole", () => {
		guardFile("guard-branch.sh", true);
		transcript([fileCall("git push", "toolu_A"), killed()]);

		const r = run();

		expect(r.blocked).toBe(true);
		expect(r.reason).not.toContain("would not parse");
	});

	it("says a guard that ran and exited non-zero did exactly that", () => {
		guardFile("guard-branch.sh", true);
		transcript([
			fileCall("git push", "toolu_A"),
			killed({
				type: "hook_non_blocking_error",
				exitCode: 126,
				durationMs: 12,
				timeoutMs: 10_000,
			}),
		]);

		const r = run();

		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("guard-branch.sh ran and exited 126");
		expect(r.reason).not.toContain("cancelled");
	});

	it("reports one stanza per tool call, however many guards died on it", () => {
		guardFile("guard-branch.sh", true);
		guardFile("guard-commit-form.sh", true);
		transcript([
			fileCall("git commit -m x", "toolu_A"),
			killed(),
			killed({
				command: "$CLAUDE_PROJECT_DIR/scripts/guard-commit-form.sh",
			}),
		]);

		const r = run();

		expect(r.reason).toContain("guard-branch.sh, guard-commit-form.sh");
		expect(r.reason.match(/guard-lost-deny\.js replay/g)).toHaveLength(1);
	});
});

describe("whether the loss was worth a turn", () => {
	it("prices a guard that has never denied, and says so in the summary", () => {
		guardFile("guard-pull-form.js", true);
		transcript([
			fileCall("git pull", "toolu_A"),
			killed({ command: "$CLAUDE_PROJECT_DIR/scripts/guard-pull-form.js" }),
		]);

		const r = run();

		expect(r.blocked).toBe(true);
		expect(r.reason).toContain(
			"guard-pull-form.js: denies 0% of calls (0 denials in 21,952 calls",
		);
		expect(r.reason).toContain("under the 1% cut, so a replay rarely pays");
		expect(r.reason).toContain("No guard here denies often enough");
	});

	it("prices the one guard that denies often enough to chase", () => {
		guardFile("guard-issue-close.js", true);
		transcript([
			fileCall("gh issue close 1", "toolu_A"),
			killed({ command: "$CLAUDE_PROJECT_DIR/scripts/guard-issue-close.js" }),
		]);

		const r = run();

		expect(r.blocked).toBe(true);
		expect(r.reason).toContain(
			"guard-issue-close.js: denies 1.588% of calls (255 denials in 16,057 calls; 95% CI 1.41%-1.79%) — over the 1% cut, worth the replay",
		);
		expect(r.reason).toContain("This one is worth the replay");
	});

	it("calls an unmeasured guard unknown, never zero", () => {
		guardFile("guard-invented-today.sh", true);
		transcript([
			fileCall("git push", "toolu_A"),
			killed({
				command: "$CLAUDE_PROJECT_DIR/scripts/guard-invented-today.sh",
			}),
		]);

		const r = run();

		expect(r.blocked).toBe(true);
		expect(r.reason).toContain(
			"guard-invented-today.sh: deny rate UNKNOWN — no row in the 5 Sep 2026 census",
		);
		expect(r.reason).not.toContain("0% of calls");
		expect(r.reason).toContain("This one is worth the replay");
	});

	it("counts only the tool calls worth chasing where the block mixes both", () => {
		guardFile("guard-issue-body.js", true);
		guardFile("guard-suite-concurrency.js", true);
		transcript([
			fileCall("gh issue create --body x", "toolu_A"),
			killed({ command: "$CLAUDE_PROJECT_DIR/scripts/guard-issue-body.js" }),
			fileCall("npm test", "toolu_B"),
			killed({
				toolUseID: "toolu_B",
				command: "$CLAUDE_PROJECT_DIR/scripts/guard-suite-concurrency.js",
			}),
		]);

		const r = run();

		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("1 of 2 are worth the replay");
	});

	it("dates the figures and names what they were priced against", () => {
		guardFile("guard-branch.sh", true);
		transcript([fileCall("git worktree add /tmp/w", "toolu_A"), killed()]);

		const r = run();

		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("as of 5 Sep 2026");
		expect(r.reason).toContain("whole-corpus and unbounded");
		expect(r.reason).toContain("every tool_use record");
		expect(r.reason).toContain(
			"https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/lost-deny-recoverability.md",
		);
	});
});

describe("what it stays silent on", () => {
	it("says nothing where no hook was killed at all", () => {
		guardFile("guard-branch.sh", true);
		transcript([fileCall("ls", "toolu_A")]);

		expect(run().blocked).toBe(false);
		expect(readCrumb()).toMatchObject({ outcome: "no-finding" });
	});

	it("says nothing where the guard that died cannot deny", () => {
		guardFile("check-issue-labels.js", false);
		transcript([
			fileCall("ls", "toolu_A"),
			killed({
				command:
					'command -v node >/dev/null 2>&1 && node "$CLAUDE_PROJECT_DIR"/scripts/check-issue-labels.js --notify || true',
			}),
		]);

		expect(run().blocked).toBe(false);
		expect(readCrumb()).toMatchObject({ outcome: "no-finding" });
	});

	it("says nothing about a deny-capable guard lost on any event but PreToolUse", () => {
		guardFile("guard-branch.sh", true);
		transcript([
			fileCall("ls", "toolu_A"),
			killed({ hookEvent: "Stop", hookName: "Stop" }),
		]);

		expect(run().blocked).toBe(false);
	});

	it("says nothing about ITSELF, whose own source spells a deny verdict", () => {
		guardFile("guard-lost-deny.js", true);
		transcript([
			fileCall("ls", "toolu_A"),
			killed({
				hookEvent: "Stop",
				hookName: "Stop",
				command:
					'command -v node >/dev/null 2>&1 && node "$CLAUDE_PROJECT_DIR"/scripts/guard-lost-deny.js || true',
			}),
		]);

		expect(run().blocked).toBe(false);
	});

	it("says nothing where the guard file is not there to be read", () => {
		transcript([fileCall("ls", "toolu_A"), killed()]);

		expect(run().blocked).toBe(false);
	});

	it("crumbs no-transcript where the payload names a file that is not there", () => {
		guardFile("guard-branch.sh", true);

		expect(run().blocked).toBe(false);
		expect(readCrumb()).toMatchObject({ outcome: "no-transcript" });
	});

	it("crumbs the loss but does not block while another Stop hook has blocked", () => {
		guardFile("guard-branch.sh", true);
		transcript([fileCall("ls", "toolu_A"), killed()]);

		const r = run({ payload: { stop_hook_active: true } });

		expect(r.blocked).toBe(false);
		expect(readCrumb()).toMatchObject({ outcome: "message" });
		expect(
			fs.existsSync(
				path.join(dir, ".claude", "tmp", "markers", `.lost-deny-seen-${sid}`),
			),
		).toBe(false);
	});
});

describe("the deny-capable set", () => {
	it("names exactly the guards the census counts deny-capable, over the real wiring — #1815", () => {
		const repo = path.resolve(__dirname, "..");
		const census = spawnSync(
			process.execPath,
			[
				path.join(repo, "scripts", "lost-deny-rates.js"),
				"--triggers",
				"--scope",
				"all",
			],
			{ encoding: "utf8", env: { ...process.env, WFC_LOST_DENY_ROOT: repo } },
		);
		const rows: { guard: string; denyCapable: boolean }[] = JSON.parse(
			census.stdout,
		);
		transcript([
			fileCall("ls", "toolu_A"),
			...rows.map((r) =>
				killed({ command: `$CLAUDE_PROJECT_DIR/scripts/${r.guard}` }),
			),
		]);

		const header = run({ env: { WFC_SCRIPT_ROOT: repo } }).reason.match(
			/^(.+) — lost on /m,
		);

		expect(header?.[1].split(", ").sort()).toEqual(
			rows
				.filter((r) => r.denyCapable)
				.map((r) => r.guard)
				.sort(),
		);
		expect(rows.some((r) => !r.denyCapable)).toBe(true);
	});

	it("counts the real dispatcher, whose file-claim core refuses through the arbiter — #1815", () => {
		transcript([
			fileCall("ls", "toolu_A"),
			killed({
				hookName: "PreToolUse:Write",
				command: "$CLAUDE_PROJECT_DIR/scripts/guard-dispatch.js",
			}),
		]);

		const r = run({ env: { WFC_SCRIPT_ROOT: path.resolve(__dirname, "..") } });

		expect(r.reason).toContain("guard-dispatch.js");
	});

	it("admits a guard added after this one, with no edit here", () => {
		guardFile("guard-invented-today.sh", true);
		transcript([
			fileCall("ls", "toolu_A"),
			killed({
				command: "$CLAUDE_PROJECT_DIR/scripts/guard-invented-today.sh",
			}),
		]);

		expect(run().reason).toContain("guard-invented-today.sh");
	});

	it("looks up no guard outside scripts/, however the record spells it", () => {
		fs.writeFileSync(
			path.join(core, "outside.sh"),
			'{"permissionDecision":"deny"}\n',
		);
		transcript([
			fileCall("ls", "toolu_A"),
			killed({ command: "$CLAUDE_PROJECT_DIR/scripts/../outside.sh" }),
		]);

		expect(run().blocked).toBe(false);
	});
});

describe("the dedupe", () => {
	const oneLoss = () => {
		guardFile("guard-branch.sh", true);
		transcript([fileCall("ls", "toolu_A"), killed()]);
	};

	it("names each tool call once and never again", () => {
		oneLoss();

		expect(run().blocked).toBe(true);
		expect(readSeen()).toEqual(["toolu_A"]);
		expect(run().blocked).toBe(false);
	});

	/* blockStop stops emitting after MAX_BLOCKS turns. A set written before the
	 * block rather than after would mark this loss told and drop it for ever. */
	it("marks nothing seen on a turn where the block did not go out", () => {
		oneLoss();
		fs.writeFileSync(
			path.join(markersDir(dir), `.lost-deny-nagged-${sid}`),
			"3\n",
		);

		expect(run().blocked).toBe(false);
		expect(
			fs.existsSync(
				path.join(dir, ".claude", "tmp", "markers", `.lost-deny-seen-${sid}`),
			),
		).toBe(false);
	});

	it("still reports a loss on a tool call it has not named yet", () => {
		oneLoss();
		run();

		fs.appendFileSync(
			path.join(dir, `${sid}.jsonl`),
			`${[
				JSON.stringify(fileCall("git push", "toolu_B")),
				JSON.stringify(killed({ toolUseID: "toolu_B" })),
			].join("\n")}\n`,
		);
		const r = run();

		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("toolu_B");
		expect(r.reason).not.toContain("toolu_A");
		expect(readSeen()).toEqual(["toolu_A", "toolu_B"]);
	});
});

describe("replay", () => {
	it("runs the lost guard against the payload it never saw", () => {
		echoGuard();
		const file = transcript([
			fileCall("git worktree add /tmp/w", "toolu_A"),
			killed(),
		]);

		const r = replay(file, "toolu_A");

		expect(r.status).toBe(0);
		expect(r.stdout).toContain("=== guard-branch.sh ===");
		const sent = sentPayload(r.stdout);
		expect(sent).toMatchObject({
			hook_event_name: "PreToolUse",
			session_id: "session-in-the-file",
			tool_name: "Bash",
			tool_input: { command: "git worktree add /tmp/w" },
		});
		expect(r.stdout).toContain("None of the 1 lost guard(s) deny this call.");
	});

	it("says so, loudly, where the replayed guard denies", () => {
		const guard = path.join(core, "scripts", "guard-branch.sh");
		fs.writeFileSync(
			guard,
			'#!/usr/bin/env bash\nprintf \'{"hookSpecificOutput":{"permissionDecision":"deny"}}\'\n',
		);
		fs.chmodSync(guard, 0o755);
		const file = transcript([
			fileCall("git worktree add /tmp/w", "toolu_A"),
			killed(),
		]);

		const r = replay(file, "toolu_A");

		expect(r.stdout).toContain("1 of 1 DENY this call. Undo it.");
	});

	it("names an incomplete read rather than let it read as a mistyped id — mantahostels#3311", () => {
		guardFile("guard-branch.sh", true);
		const file = transcript([fileCall("ls", "toolu_A")]);
		halfWritten(file);

		const r = replay(file, "toolu_B");

		expect(r.status).toBe(2);
		expect(r.stderr).toContain("toolu_B is not a tool call");
		expect(r.stderr).toContain("1 line(s) of it would not parse");
	});

	it("says nothing about an incomplete read where the transcript parsed whole", () => {
		guardFile("guard-branch.sh", true);
		const file = transcript([fileCall("ls", "toolu_A")]);

		const r = replay(file, "toolu_B");

		expect(r.stderr).not.toContain("would not parse");
	});

	it("refuses a tool call that lost no deny-capable guard", () => {
		guardFile("guard-branch.sh", true);
		const file = transcript([
			fileCall("ls", "toolu_A"),
			killed({ toolUseID: "toolu_B" }),
		]);

		const r = replay(file, "toolu_A");

		expect(r.status).toBe(2);
		expect(r.stderr).toContain("no deny-capable guard was lost");
	});

	it("refuses a usage it cannot act on", () => {
		expect(replay().status).toBe(2);
		expect(replay(path.join(dir, "nope.jsonl"), "toolu_A").status).toBe(2);
	});
});

describe("in an adopter, whose repo holds none of the guards — #1017", () => {
	beforeEach(() => {
		core = makeCore(fs.mkdtempSync(path.join(os.tmpdir(), "lost-deny-core-")));
	});

	it("reads the guard from the core and reports it", () => {
		guardFile("guard-branch.sh", true);
		transcript([fileCall("ls", "toolu_A"), killed()]);

		const r = run();

		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("guard-branch.sh");
		/* The seen set stays with the session's repo. */
		expect(readSeen()).toEqual(["toolu_A"]);
	});

	it("never reads a same-named file in the session's repo", () => {
		guardFile("guard-branch.sh", false);
		fs.writeFileSync(
			path.join(dir, "scripts", "guard-branch.sh"),
			'{"permissionDecision":"deny"}\n',
		);
		transcript([fileCall("ls", "toolu_A"), killed()]);

		expect(run().blocked).toBe(false);
	});

	/** An adopter's own guard, in the session repo's scripts/. */
	const ownGuard = (name: string, body: string) =>
		fs.writeFileSync(path.join(dir, "scripts", name), body);
	const lostOwn = (name: string) =>
		killed({ command: `node "$CLAUDE_PROJECT_DIR"/scripts/${name}` });

	it("reports its own guard that refuses by hand — #1815", () => {
		ownGuard(
			"guard-correspondence-reviewer.js",
			'out({ hookSpecificOutput: { permissionDecision: "deny" } });\n',
		);
		transcript([
			fileCall("ls", "toolu_A"),
			lostOwn("guard-correspondence-reviewer.js"),
		]);

		expect(run().reason).toContain("guard-correspondence-reviewer.js");
	});

	it("says nothing about its own guard that only adds context", () => {
		ownGuard(
			"guard-note.js",
			'out({ hookSpecificOutput: { additionalContext: "fyi" } });\n',
		);
		transcript([fileCall("ls", "toolu_A"), lostOwn("guard-note.js")]);

		expect(run().blocked).toBe(false);
	});

	it("replays the core's guard, with the session's repo as its cwd", () => {
		echoGuard();
		const file = transcript([fileCall("ls", "toolu_A"), killed()]);

		const r = replay(file, "toolu_A");

		expect(r.status).toBe(0);
		const sent = sentPayload(r.stdout);
		expect(sent).toMatchObject({ cwd: dir });
	});
});
