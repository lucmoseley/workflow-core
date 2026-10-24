// @vitest-environment node
/*
 * guard-hook-escape.sh refuses an agent's own spelling of a git-hook escape
 * (#916): the two WFC_ALLOW_* variables pre-commit gates stand down on are the
 * founder's to set. The command judged is never run: the guard is spawned on a
 * payload against a throwaway repo, and the deny is checked against the rule
 * fragment it splices rather than a second copy of its text.
 *
 * It runs as a `PreToolUse` Bash hook (`self-plugin/hooks/hooks.json`,
 * `hooks/hooks.json`): loosen a case and an agent can stand down a
 * `.husky/pre-commit` gate for itself — the branch check or a gate-input
 * delete — on its own say-so.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBashPayload, spawnGuard } from "./lib/pretool-guard-testkit";

const GUARD = path.resolve(__dirname, "guard-hook-escape.sh");
/* The deny is checked against the fragment it splices, never a second copy. */
const { ruleText } = createRequire(__filename)("./lib/rule-text.js");

let dir: string;

/** The refusal's prose, or null where the guard allowed. */
const denial = (command: string): string | null => {
	const r = spawnGuard(GUARD, buildBashPayload(command, "test"), {
		project: dir,
		config: path.join(dir, "config"),
		cwd: dir,
		timeout: 20_000,
	});
	expect(r.status).toBe(0);
	if (!(r.stdout ?? "").trim()) return null;
	const out = JSON.parse(r.stdout).hookSpecificOutput;
	expect(out.hookEventName).toBe("PreToolUse");
	if (out.permissionDecision !== "deny") return null;
	return out.permissionDecisionReason as string;
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-hook-escape-"));
	execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: dir });
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("an agent setting a git-hook escape is refused", () => {
	it.each([
		"WFC_ALLOW_GATE_INPUT_DELETE=1 git commit -m x -- a",
		"WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"WFC_ALLOW_GATE_INPUT_DELETE=1 node scripts/commit-paths.js -m x -- a",
		'WFC_ALLOW_BRANCH="1" git commit -m x -- a',
		"FOO=bar WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"WFC_ALLOW_BRANCH+=1 git commit -m x -- a",
		"env WFC_ALLOW_GATE_INPUT_DELETE=1 git commit -m x -- a",
		"env -i PATH=/usr/bin WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"sudo WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"export WFC_ALLOW_BRANCH=1",
		"export WFC_ALLOW_GATE_INPUT_DELETE",
		"export FOO=1 WFC_ALLOW_GATE_INPUT_DELETE=1 && git commit -m x -- a",
		"WFC_ALLOW_BRANCH=1; export WFC_ALLOW_BRANCH; git commit -m x -- a",
		"declare -x WFC_ALLOW_BRANCH=1",
		"typeset -rx WFC_ALLOW_GATE_INPUT_DELETE=1",
		"git status && WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"cd /tmp && env WFC_ALLOW_GATE_INPUT_DELETE=yes git commit -m x -- a",
		// Behind a reserved word or an `exec`, which the walker skips (#1013).
		"{ WFC_ALLOW_BRANCH=1 git commit -m x -- a; }",
		"git status && { WFC_ALLOW_BRANCH=1 git commit -m x -- a; }",
		"if true; then WFC_ALLOW_BRANCH=1 git commit -m x -- a; fi",
		"for f in a; do WFC_ALLOW_BRANCH=1 git commit -m x -- $f; done",
		"! WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"exec env WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"if WFC_ALLOW_BRANCH=1 git commit -m x -- a; then :; fi",
		"while WFC_ALLOW_BRANCH=1 git commit -m x -- a; do :; done",
		"time WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"WFC_ALLOW_BRANCH=1 exec git commit -m x -- a",
		"exec WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		// A multi-line quoted span before the assignment does not hide it.
		"echo 'a\nb'; WFC_ALLOW_BRANCH=1 git commit -m x -- a",
	])("%s", (command) => {
		const reason = denial(command);
		expect(reason).not.toBeNull();
		expect(reason).toContain(ruleText("hook-escape"));
		expect(reason).toContain("This command sets a git-hook escape");
	});
});

describe("what it does not judge", () => {
	it.each([
		// A mention is not an assignment.
		"grep -n WFC_ALLOW_BRANCH scripts/",
		"grep -rn 'WFC_ALLOW_BRANCH=1' .husky",
		'echo "WFC_ALLOW_GATE_INPUT_DELETE=1 git commit"',
		"git log -S WFC_ALLOW_GATE_INPUT_DELETE",
		// The founder's command written into a multi-line hand-over.
		"gh issue comment 1 --body 'Run this:\nWFC_ALLOW_BRANCH=1 git commit -m x -- a'",
		"echo 'x <<EOF\nWFC_ALLOW_BRANCH=1 git commit -m y\nEOF' > a.txt",
		"cat > a.txt <<'EOF'\nWFC_ALLOW_BRANCH=1 git commit -m y\nEOF",
		// A neighbouring name, and the escape out of this guard's scope.
		"WFC_ALLOW_BRANCHES=1 git commit -m x -- a",
		"WFC_ALLOW_NEW_PACKAGE=1 npm install left-pad",
		// Unsetting, and declaring without exporting.
		"env -u WFC_ALLOW_BRANCH git commit -m x -- a",
		"unset WFC_ALLOW_BRANCH",
		"export -n WFC_ALLOW_BRANCH",
		"declare -r WFC_ALLOW_BRANCH=1",
		"git commit -m x -- a",
		// Behind a reserved word or an `exec`, with no escape set (#1013).
		"{ git commit -m x -- a; }",
		"time git commit -m x -- a",
		"exec git commit -m x -- a",
		// `-a` names the command's argv[0]; it assigns no variable.
		"exec -a WFC_ALLOW_BRANCH=1 git commit -m x -- a",
	])("%s", (command) => {
		expect(denial(command)).toBeNull();
	});
});
