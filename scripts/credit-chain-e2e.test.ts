// @vitest-environment node
/*
 * Pins that a Bash write credited through the whole chain makes the Stop
 * backstop's code signal fire, and that a path a live neighbour holds is
 * neither credited nor named.
 *
 * The seam mantahostels#2806 was opened for: each hop of the Bash-write credit chain —
 * scripts/guard-claimed-bash-write.sh (the parser) → scripts/warn-claimed-bash-write.js
 * (the judge, `credit()`) → scripts/lib/arbiter-ledger.js (the write ledger) →
 * scripts/concision-backstop.sh (the code signal) — is unit-tested in isolation,
 * but nothing drove a command through all four and asserted the code signal at
 * the far end. This file does exactly that, against the REAL scripts, never a
 * re-implementation of any hop's own logic. They run in a throwaway fixture
 * repo on `CLAUDE_PROJECT_DIR`, never this one, so no real claim or ledger is
 * touched.
 *
 * The chain runs from a `PreToolUse` Bash hook to the `Stop` backstop in
 * `.claude/settings.json`: loosen a case and a drift in a join leaves every
 * unit test green while Bash-written code stops drawing a review, or a session
 * is nagged over a neighbour's held file.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox, live, store } from "./lib/arbiter-testkit";

const GUARD = path.resolve(__dirname, "guard-claimed-bash-write.sh");
const BACKSTOP = path.resolve(__dirname, "concision-backstop.sh");
const REAL_LIB = path.resolve(__dirname, "lib");
const REAL_JUDGE = path.resolve(__dirname, "warn-claimed-bash-write.js");

const ME = "session-under-test";
const OTHER = "parallel-session";

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: sb.repo, encoding: "utf8" });

const sb = freshSandbox((fresh) => {
	git("init", "-q", "-b", "main", ".");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	// Never the founder's real Husky hooks against a throwaway fixture repo.
	git("config", "core.hooksPath", path.join(fresh.dir, "no-hooks"));
	fs.writeFileSync(path.join(fresh.repo, "seed.md"), "seed\n");
	git("add", "seed.md");
	git("commit", "-qm", "init");
	standRealJudge();
});

const env = () => ({
	...process.env,
	CLAUDE_PROJECT_DIR: sb.repo,
	CLAUDE_CONFIG_DIR: sb.home,
});

/**
 * Stands a REAL copy of the judge inside the fixture repo, plus all of
 * `lib/` — deliberately the whole directory, not just what the judge
 * currently requires, so a family added to `arbiter-store.js`'s requires is
 * never missed. guard-claimed-bash-write.sh resolves the judge off
 * `$CLAUDE_PROJECT_DIR/scripts/warn-claimed-bash-write.js` — never off its own
 * location — so the fixture must carry one. Copied fresh every test, so a
 * mutation made to the real file on disk before the suite runs is what
 * executes here.
 */
function standRealJudge() {
	const scripts = path.join(sb.repo, "scripts");
	fs.mkdirSync(scripts, { recursive: true });
	fs.copyFileSync(REAL_JUDGE, path.join(scripts, "warn-claimed-bash-write.js"));
	fs.cpSync(REAL_LIB, path.join(scripts, "lib"), { recursive: true });
}

/** Runs the guard on `command`, as Claude Code's PreToolUse hook would. */
function runGuard(command: string, sid = ME) {
	const r = spawnSync(GUARD, [], {
		cwd: sb.repo,
		encoding: "utf8",
		input: JSON.stringify({
			session_id: sid,
			tool_name: "Bash",
			tool_input: { command },
		}),
		env: env(),
	});
	expect(r.status).toBe(0);
	// A guard's fail-open path (mantahostels#147) also exits 0, so the exit code alone
	// cannot tell "not credited because contended" from "not credited because
	// the chain broke silently" — assert it ran clean: nothing logged to the
	// fail-open log, and no tier-1 warning on stdout (none of this file's
	// targets are tier-1).
	const log = sb.errorLog();
	expect(fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "").toBe("");
	expect(r.stdout?.trim() ?? "").toBe("");
	return r;
}

/** Runs the backstop hook in `mode`, as Claude Code's Stop hook would. */
function runBackstop(mode: "start" | "stop", sid = ME) {
	const r = spawnSync(BACKSTOP, [mode], {
		cwd: sb.repo,
		encoding: "utf8",
		input: JSON.stringify({ session_id: sid }),
		env: env(),
	});
	if (r.status === null) throw new Error(`backstop did not run: ${r.error}`);
	if (!r.stdout?.trim()) return null;
	return JSON.parse(r.stdout).reason as string;
}

/** 30 lines, well past CODE_THRESHOLD (20 lines of churn). */
const BIG_CODE = Array.from(
	{ length: 30 },
	(_, i) => `echo "line ${i} of a real edit"`,
).join("\n");

describe("the credit chain end to end (mantahostels#2806)", () => {
	it("drives a realistic Bash write through the guard, the judge and the ledger, and the backstop's code signal fires on it", () => {
		fs.writeFileSync(path.join(sb.repo, "scripts", "x.sh"), "echo a\n");
		git("add", "scripts/x.sh");
		git("commit", "-qm", "a script to edit", "--", "scripts/x.sh");
		runBackstop("start");

		// The guard parses this real command's write target and hands it to the
		// REAL judge as `--credit scripts/x.sh`.
		runGuard("sed -i s/a/b/ scripts/x.sh");

		// What the ledger now holds is asked of the arbiter's own reader
		// (`writesBy`), never re-parsed here — that would test this file's
		// assumptions about the ledger's shape, not the real one.
		expect(store.writesBy(ME)).toEqual(["scripts/x.sh"]);

		// The command line the guard read is not what actually changed the file on
		// disk (the hook only ever sees the STRING; nothing here executes it) — so
		// the churn the backstop measures is produced the same way the rest of this
		// suite's fixtures produce it: a direct rewrite standing in for whatever
		// tool call the guard's PreToolUse hook preceded.
		fs.writeFileSync(path.join(sb.repo, "scripts", "x.sh"), `${BIG_CODE}\n`);

		const reason = runBackstop("stop");
		expect(reason).toContain("code-review");
		expect(reason).toContain("scripts/x.sh");
	});

	it("does not credit a path a live neighbour holds, but does credit an uncontended path in the same command, and the code signal never names the held path", () => {
		store.acquire("scripts/y.sh", live(sb, OTHER));

		fs.writeFileSync(path.join(sb.repo, "scripts", "y.sh"), "echo a\n");
		fs.writeFileSync(path.join(sb.repo, "scripts", "z.sh"), "echo a\n");
		git("add", "scripts/y.sh", "scripts/z.sh");
		git(
			"commit",
			"-qm",
			"one script a neighbour holds, one free",
			"--",
			"scripts/y.sh",
			"scripts/z.sh",
		);
		runBackstop("start");

		runGuard("sed -i s/a/b/ scripts/y.sh scripts/z.sh");

		// The held path is excluded and the free path in the SAME command is
		// credited — proving the chain was live and the exclusion is the
		// contention skip, not a silent break.
		expect(store.writesBy(ME)).toEqual(["scripts/z.sh"]);

		fs.writeFileSync(path.join(sb.repo, "scripts", "y.sh"), `${BIG_CODE}\n`);
		fs.writeFileSync(path.join(sb.repo, "scripts", "z.sh"), `${BIG_CODE}\n`);

		const reason = runBackstop("stop");
		expect(reason).toContain("scripts/z.sh");
		expect(reason).not.toContain("scripts/y.sh");
	});
});
