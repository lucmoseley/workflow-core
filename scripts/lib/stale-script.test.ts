// @vitest-environment node
/*
 * lib/stale-script.js, a PreToolUse dispatcher core (#2789), warns when a
 * Bash call may run a neighbour's half-written script (mantahostels#1035).
 *
 * Two questions. Which scripts does this command RUN? "Run" is the whole of
 * it: a command that merely mentions a script — a grep, a cat, an echo, a
 * heredoc — must produce nothing, or the warning fires on reading the very
 * file it is telling you not to trust. And which of those is a live
 * neighbour holding half-written?
 *
 * Module cases, run in process through lib/guard-core-testkit.ts over the
 * production ports (lib/stale-script-host.js): a sandbox git repo with a real
 * arbiter store, so a script is uncommitted and claimed exactly as a neighbour
 * mid-save leaves it. The hook line and stdin are scripts/guard-dispatch.test.ts's
 * boundary set.
 *
 * A missed run route lets a session run a neighbour's half-saved script
 * unwarned; a mention parsed as a run warns on every read.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	AS_ROOT,
	finished,
	freshSandbox,
	live,
	locks as locksMod,
	store,
} from "./arbiter-testkit";
import { runCore, toolCall } from "./guard-core-testkit";

const sb = freshSandbox((fresh) => {
	fs.mkdirSync(path.join(fresh.repo, "scripts"), { recursive: true });
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: fresh.repo, stdio: "ignore" });
	git("init", "-q", "-b", "main", ".");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	// This checkout's core.hooksPath is absolute, so a scratch repo would
	// otherwise run the real Husky gates (mantahostels#100's finding).
	git("config", "core.hooksPath", path.join(fresh.dir, "no-hooks"));
});

/*
 * The store's own filename for a claim: a truncated sha256 of the repo-relative
 * path. Duplicated rather than exported, matching check-stranded-file-claims's
 * suite — a fixture writing lock files under a name of its own invention is one
 * the arbiter's readers cannot find.
 */
const lockFile = (rel: string) =>
	`${createHash("sha256").update(rel).digest("hex").slice(0, 16)}.json`;

const gitIn = (...args: string[]) =>
	execFileSync("git", args, { cwd: sb.repo, stdio: "ignore" });

/** A committed script, so "dirty" below means an edit rather than a new file. */
function committedScript(rel: string, body = "console.log(1)\n") {
	fs.writeFileSync(path.join(sb.repo, rel), body);
	gitIn("add", "--", rel);
	gitIn("commit", "-qm", `add ${rel}`);
}

/** The uncommitted edit a neighbour is mid-save on. */
const dirty = (rel: string) =>
	fs.appendFileSync(path.join(sb.repo, rel), "// half-written\n");

/** `sessionId` takes the claim the arbiter would take on its first write. */
function claimedBy(rel: string, sessionId: string) {
	store.acquire(rel, live(sb, sessionId));
}

/** Each of `rels` committed, claimed by a live neighbour and left dirty. */
function heldHalfWritten(...rels: string[]) {
	for (const rel of rels) {
		committedScript(rel);
		claimedBy(rel, "neighbour-session");
		dirty(rel);
	}
}

/** The core's run on `command` as session `mine` from the repo root. */
function run(command: string, session: string | null = "mine") {
	return runCore(
		"guard-stale-script",
		toolCall("Bash", { command }, { session_id: session ?? undefined }),
		{ root: sb.repo },
	);
}

/** The context the core hands the session, "" where it is silent. */
function warned(command: string) {
	const { output } = run(command);
	expect(output?.permissionDecision).toBeUndefined();
	return output?.additionalContext ?? "";
}

const named = (text: string) =>
	[...text.matchAll(/^(\S+) is uncommitted/gm)].map((m) => m[1]);

describe("the scripts a command runs", () => {
	it("reads one run under an interpreter", () => {
		heldHalfWritten("scripts/pick-next.js");
		expect(named(warned("node scripts/pick-next.js --json"))).toEqual([
			"scripts/pick-next.js",
		]);
	});

	it("reads one run as the command itself", () => {
		heldHalfWritten("scripts/thing.sh");
		expect(named(warned("./scripts/thing.sh"))).toEqual(["scripts/thing.sh"]);
	});

	it("reads every script a compound command runs", () => {
		heldHalfWritten("scripts/thing.sh", "scripts/pick-next.js");
		expect(
			named(warned("bash scripts/thing.sh && node scripts/pick-next.js")),
		).toEqual(["scripts/thing.sh", "scripts/pick-next.js"]);
	});

	it("reaches a script through an `npm run` body", () => {
		heldHalfWritten("scripts/pick-next.js");
		fs.writeFileSync(
			path.join(sb.repo, "package.json"),
			JSON.stringify({ scripts: { "pick:next": "node scripts/pick-next.js" } }),
		);
		expect(named(warned("npm run pick:next"))).toEqual([
			"scripts/pick-next.js",
		]);
	});

	it("reads the script run, never the script paths passed to it", () => {
		// `node scripts/session-arbiter.js claim scripts/foo.js` is the contention
		// poll CLAUDE.md prescribes; warning about its argument would fire the core
		// on the very command sent to ask whether that file is free.
		heldHalfWritten("scripts/pick-next.js", "scripts/thing.sh");
		expect(
			named(warned("node scripts/pick-next.js claim scripts/thing.sh")),
		).toEqual(["scripts/pick-next.js"]);
	});

	it("takes an absolute path as given", () => {
		heldHalfWritten("scripts/pick-next.js");
		expect(named(warned(`node ${sb.repo}/scripts/pick-next.js`))).toEqual([
			"scripts/pick-next.js",
		]);
	});
});

describe("what must not be read as a run", () => {
	it.each([
		["a script read rather than run", "cat scripts/pick-next.js"],
		["a script searched", "grep -n hang scripts/pick-next.js"],
		["a path inside a quoted span", 'echo "node scripts/pick-next.js"'],
		["a path that does not exist", "node scripts/not-here.js"],
		["an ordinary command", "ls -la && free -m"],
		["an npm command that runs no script", "npm ci"],
		["an npm subcommand other than run", "npm install pick:next"],
	])("%s", (_what, command) => {
		heldHalfWritten("scripts/pick-next.js");
		expect(warned(command)).toBe("");
	});
});

describe("a script a live neighbour holds half-written", () => {
	it("warns, naming the path, the holder, what may go wrong and the residual it leaves", () => {
		heldHalfWritten("scripts/pick-next.js");
		const out = warned("node scripts/pick-next.js");
		expect(out).toContain("scripts/pick-next.js");
		expect(out).toContain("neighbour-session");
		expect(out).toContain("unfinished edit");
		expect(out).toContain("#364");
	});

	it("says nothing is blocked, as context, and never a decision", () => {
		heldHalfWritten("scripts/pick-next.js");
		const { output } = run("node scripts/pick-next.js");
		expect(output?.additionalContext).toContain("Nothing is blocked");
		expect(output).not.toHaveProperty("permissionDecision");
	});
});

describe("what must stay silent", () => {
	it("a claimed script with no uncommitted edit", () => {
		committedScript("scripts/pick-next.js");
		claimedBy("scripts/pick-next.js", "neighbour-session");
		expect(warned("node scripts/pick-next.js")).toBe("");
	});

	it("this session's own work in progress", () => {
		committedScript("scripts/pick-next.js");
		claimedBy("scripts/pick-next.js", "mine");
		dirty("scripts/pick-next.js");
		expect(warned("node scripts/pick-next.js")).toBe("");
	});

	it("a claim whose holder has stopped running", () => {
		committedScript("scripts/pick-next.js");
		dirty("scripts/pick-next.js");
		// The lock freezes pid and procStart at claim time, so a holder that has
		// since ended is a lock whose procStart no longer matches its pid — written
		// here rather than acquired, which would freeze this live process in.
		finished(sb, "neighbour-session");
		const lock = locksMod.newLock({
			path: "scripts/pick-next.js",
			sessionId: "neighbour-session",
			pid: process.pid,
			procStart: "999999999",
		});
		fs.mkdirSync(store.paths.locksDir(), { recursive: true });
		fs.writeFileSync(
			path.join(store.paths.locksDir(), lockFile("scripts/pick-next.js")),
			JSON.stringify(lock),
		);
		expect(warned("node scripts/pick-next.js")).toBe("");
	});

	it("a dirty script under no claim — the known residual (mantahostels#364)", () => {
		committedScript("scripts/pick-next.js");
		dirty("scripts/pick-next.js");
		expect(warned("node scripts/pick-next.js")).toBe("");
	});

	it("a path outside the claim tiers, and one outside the repo", () => {
		fs.mkdirSync(path.join(sb.repo, "app"), { recursive: true });
		committedScript("app/page.tsx");
		claimedBy("app/page.tsx", "neighbour-session");
		dirty("app/page.tsx");
		expect(warned("./app/page.tsx && /usr/bin/env true")).toBe("");
	});

	it("stays silent, and records nothing, on a command it judges cleanly", () => {
		expect(run("ls -la")).toEqual({ output: null, logs: [] });
	});
});

describe("failing open", () => {
	it("allows unchecked, and records, when the payload names no session", () => {
		// Without a session id, this session's own claims are indistinguishable
		// from a neighbour's, so every warning would be about the reader's own
		// work in progress.
		heldHalfWritten("scripts/pick-next.js");
		const { output, logs } = run("node scripts/pick-next.js", null);
		expect(output).toBeNull();
		expect(logs).toEqual([
			"no session_id in payload — a script invocation allowed unchecked",
		]);
	});

	it.skipIf(AS_ROOT)("stays silent on an unreadable lock store", () => {
		heldHalfWritten("scripts/pick-next.js");
		const locks = store.paths.locksDir();
		fs.chmodSync(locks, 0o000);
		try {
			// A store that will not open is "unknown", never "nobody holds it" (mantahostels#174)
			// — and an unknown must not manufacture a warning about work no one can
			// see, so it allows unchecked (mantahostels#103 §6).
			expect(warned("node scripts/pick-next.js")).toBe("");
		} finally {
			fs.chmodSync(locks, 0o700);
		}
	});
});

describe("the cases a mutant must not survive (#2789)", () => {
	it("reads an interpreter named by its full path", () => {
		heldHalfWritten("scripts/pick-next.js");
		expect(named(warned("/usr/bin/node scripts/pick-next.js"))).toEqual([
			"scripts/pick-next.js",
		]);
	});

	it("never reads a bare filename as a script path", () => {
		heldHalfWritten("scripts/pick-next.js");
		const { output } = runCore(
			"guard-stale-script",
			{
				session_id: "mine",
				tool_name: "Bash",
				tool_input: { command: "node pick-next.js" },
			},
			{ root: sb.repo, cwd: path.join(sb.repo, "scripts") },
		);
		expect(output).toBeNull();
	});

	it("reads a script name only after `run`", () => {
		heldHalfWritten("scripts/pick-next.js");
		fs.writeFileSync(
			path.join(sb.repo, "package.json"),
			JSON.stringify({ scripts: { "pick:next": "node scripts/pick-next.js" } }),
		);
		expect(warned("npm install pick:next")).toBe("");
	});

	it.each([
		["a missing path", "scripts/not-here.js"],
		["a directory", "scripts/"],
	])("passes over an interpreter argument that is %s", (_what, arg) => {
		heldHalfWritten("scripts/pick-next.js");
		expect(named(warned(`node ${arg} scripts/pick-next.js`))).toEqual([
			"scripts/pick-next.js",
		]);
	});

	it("parts two warnings with a blank line", () => {
		heldHalfWritten("scripts/thing.sh", "scripts/pick-next.js");
		expect(
			warned("bash scripts/thing.sh && node scripts/pick-next.js"),
		).toContain(
			"so silence is not proof the file is settled.\n\nscripts/pick-next.js is uncommitted",
		);
	});
});
