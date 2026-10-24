// @vitest-environment node
/*
 * The judge half of mantahostels#1035: given script paths, which of them is a live
 * neighbour holding half-written?
 *
 * Driven in-process inside a sandbox git repo with a real arbiter store, so a
 * script is uncommitted and claimed exactly as a neighbour mid-save leaves it.
 * `scripts/guard-stale-script.sh`, a `PreToolUse` Bash hook, warns on its
 * answer: loosen a case and a session runs a half-saved script unwarned and
 * debugs the hang, or is warned off scripts nobody is editing.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	AS_ROOT,
	finished,
	freshSandbox,
	live,
	locks as locksMod,
	store,
} from "./lib/arbiter-testkit";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.join(__dirname, "warn-stale-script.js");

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
	const me = live(sb, sessionId);
	store.acquire(rel, me);
}

/** The judge's output for `candidates`, run as `sessionId`. */
function judge(sessionId: string, ...candidates: string[]) {
	const r = runInProcess(SCRIPT, [sessionId, ...candidates], {
		cwd: sb.repo,
		env: { ...process.env },
	});
	expect(r.status).toBe(0); // it never fails the command it precedes
	return r.stdout;
}

describe("a script a live neighbour holds half-written", () => {
	it("warns, naming the path, the holder and what may go wrong", () => {
		committedScript("scripts/pick-next.js");
		claimedBy("scripts/pick-next.js", "neighbour-session");
		dirty("scripts/pick-next.js");

		const out = judge("mine", path.join(sb.repo, "scripts/pick-next.js"));

		expect(out).toContain("scripts/pick-next.js");
		expect(out).toContain("neighbour-session");
		expect(out).toContain("unfinished edit");
		// The residual is stated, never left implied (mantahostels#1035's done-when).
		expect(out).toContain("#364");
	});

	it("says nothing is blocked, and blocks nothing", () => {
		committedScript("scripts/pick-next.js");
		claimedBy("scripts/pick-next.js", "neighbour-session");
		dirty("scripts/pick-next.js");

		const out = judge("mine", "scripts/pick-next.js");

		expect(out).toContain("Nothing is blocked");
		expect(out).not.toContain("permissionDecision");
	});

	it("reaches it through an `npm run` body as well as a bare path", () => {
		committedScript("scripts/pick-next.js");
		fs.writeFileSync(
			path.join(sb.repo, "package.json"),
			JSON.stringify({ scripts: { "pick:next": "node scripts/pick-next.js" } }),
		);
		claimedBy("scripts/pick-next.js", "neighbour-session");
		dirty("scripts/pick-next.js");

		expect(judge("mine", "npm-script:pick:next")).toContain(
			"scripts/pick-next.js",
		);
	});
});

describe("what must stay silent", () => {
	it("a claimed script with no uncommitted edit", () => {
		committedScript("scripts/pick-next.js");
		claimedBy("scripts/pick-next.js", "neighbour-session");

		expect(judge("mine", "scripts/pick-next.js")).toBe("");
	});

	it("this session's own work in progress", () => {
		committedScript("scripts/pick-next.js");
		claimedBy("scripts/pick-next.js", "mine");
		dirty("scripts/pick-next.js");

		expect(judge("mine", "scripts/pick-next.js")).toBe("");
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

		expect(judge("mine", "scripts/pick-next.js")).toBe("");
	});

	it("a dirty script under no claim — the known residual (mantahostels#364)", () => {
		committedScript("scripts/pick-next.js");
		dirty("scripts/pick-next.js");

		expect(judge("mine", "scripts/pick-next.js")).toBe("");
	});

	it("a path outside the claim tiers, and one outside the repo", () => {
		fs.mkdirSync(path.join(sb.repo, "app"), { recursive: true });
		committedScript("app/page.tsx");
		claimedBy("app/page.tsx", "neighbour-session");
		dirty("app/page.tsx");

		expect(judge("mine", "app/page.tsx", "/usr/bin/node")).toBe("");
	});

	it("no candidates at all", () => {
		expect(judge("mine")).toBe("");
	});
});

describe("when it cannot answer", () => {
	it.skipIf(AS_ROOT)("stays silent on an unreadable lock store", () => {
		committedScript("scripts/pick-next.js");
		claimedBy("scripts/pick-next.js", "neighbour-session");
		dirty("scripts/pick-next.js");
		const locks = store.paths.locksDir();
		fs.chmodSync(locks, 0o000);
		try {
			// A store that will not open is "unknown", never "nobody holds it" (mantahostels#174)
			// — and an unknown must not manufacture a warning about work no one can
			// see, so it allows unchecked (mantahostels#103 §6).
			expect(judge("mine", "scripts/pick-next.js")).toBe("");
		} finally {
			fs.chmodSync(locks, 0o700);
		}
	});
});

describe("module.exports survives runInProcess", () => {
	it("stays readable after a call, not left an empty husk by the require.main guard", () => {
		committedScript("scripts/pick-next.js");
		judge("mine", "scripts/pick-next.js"); // runs the script in-process at least once first

		const { main, warnings } = createRequire(__filename)(SCRIPT);

		expect(typeof main).toBe("function");
		expect(typeof warnings).toBe("function");
	});
});
