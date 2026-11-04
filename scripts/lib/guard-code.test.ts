// @vitest-environment node
/*
 * The guard hooks' pinned code (#4227): adoption of the verified tip behind
 * a load probe; the shim and the hook line are run-pinned-guards.test.ts's. Real
 * git in a temporary directory: a bare origin and a checkout of it, whose
 * `scripts/guard-dispatch.js` each case writes as a stub.
 *
 * Break it and a commit whose guards cannot load is adopted, refusing every
 * call in every session, or a working copy's edit reaches the hooks again.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CODE_LIB = path.resolve(__dirname, "guard-code.js");
const { CORE_FAULT_TEXT } = require("./core-fault.js") as {
	CORE_FAULT_TEXT: string;
};
const HOOKS = "self-plugin/hooks/hooks.json";

const { adoptGuardCodeAt, guardFiles } = require(CODE_LIB) as {
	adoptGuardCodeAt: (
		root: string,
		o: { env: NodeJS.ProcessEnv },
	) => { kind: string; sha?: string; why?: string } | null;
	guardFiles: (codeDir: string) => Record<string, string>;
};

let dir: string;
let repo: string;
let codeDir: string;

const gitIn =
	(cwd: string) =>
	(...args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/* Commit `entry` as the guard entry and push it as origin's `main`. */
function land(entry: string): string {
	const git = gitIn(repo);
	fs.writeFileSync(path.join(repo, "scripts/guard-dispatch.js"), entry);
	git("add", "-A");
	git("commit", "--quiet", "-m", "guard entry");
	git("push", "--quiet", "origin", "HEAD:main");
	return git("rev-parse", "HEAD");
}

const OK = "process.stdin.resume(); process.stdin.on('end', () => {});\n";
const THROWS = "throw new SyntaxError(\"Unexpected token '}'\");\n";
const DENIES = `process.stdout.write(JSON.stringify({hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "guard-x ${CORE_FAULT_TEXT}: scripts/lib/shell-parse.js failed to load"}}));\n`;

/* The code directory the case's own, never the machine's. */
const at = (root: string) =>
	adoptGuardCodeAt(root, {
		env: { ...process.env, WFC_GUARD_CODE_DIR: codeDir },
	});
const adopt = () => at(repo);
const files = () => guardFiles(codeDir);
const live = () => fs.readlinkSync(files().current);

beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-code-")));
	const origin = path.join(dir, "origin.git");
	repo = path.join(dir, "repo");
	codeDir = path.join(dir, "home", ".guard-code");
	execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
	execFileSync("git", ["clone", "--quiet", origin, repo]);
	const git = gitIn(repo);
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
	fs.mkdirSync(path.join(repo, "self-plugin/hooks"), { recursive: true });
	fs.writeFileSync(path.join(repo, HOOKS), '{"hooks":{}}\n');
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("adoption", () => {
	it("sets the link up where there is none, as on a fresh machine", () => {
		const sha = land(OK);
		expect(adopt()).toEqual({ kind: "adopted", sha });
		expect(live()).toBe(path.join(codeDir, sha));
		expect(adopt()).toEqual({ kind: "current", sha });
	});

	it("does not adopt a tip whose guards fail to load, keeping the previous code live, and never tries it again", () => {
		const good = land(OK);
		adopt();
		const bad = land(THROWS);
		const r = adopt();
		expect(r?.kind).toBe("refused");
		expect(r?.why).toMatch(/Unexpected token/);
		expect(live()).toBe(path.join(codeDir, good));
		expect(fs.existsSync(path.join(codeDir, bad))).toBe(false);
		expect(fs.readFileSync(files().refused, "utf8")).toBe(`${bad}\n`);
		expect(fs.readFileSync(files().log, "utf8")).toMatch(
			new RegExp(`refused ${bad.slice(0, 9)}: .*Unexpected token`),
		);
		expect(adopt()).toEqual({ kind: "known-refused", sha: bad });
		expect(fs.existsSync(path.join(codeDir, bad))).toBe(false);
	});

	it("refuses a tip whose probe call is denied, as a core whose module fails to load answers", () => {
		const good = land(OK);
		adopt();
		land(DENIES);
		const r = adopt();
		expect(r?.kind).toBe("refused");
		expect(r?.why).toMatch(/denied: guard-x could not judge/);
		expect(live()).toBe(path.join(codeDir, good));
	});

	it("adopts a tip whose probe call is denied for any reason but a core it could not run", () => {
		const sha = land(DENIES.replace(CORE_FAULT_TEXT, "refuses ls"));
		expect(adopt()).toEqual({ kind: "adopted", sha });
	});

	it("refuses nothing where the probe could not run, trying the tip again next time", () => {
		const sha = land(OK);
		fs.mkdirSync(path.dirname(codeDir), { recursive: true });
		fs.writeFileSync(codeDir, "");
		const r = adopt();
		expect(r?.kind).toBe("error");
		expect(r?.why).toMatch(/not probed, .*tried again next time/);
		expect(fs.existsSync(files().refused)).toBe(false);
		fs.rmSync(codeDir);
		expect(adopt()).toEqual({ kind: "adopted", sha });
	});

	it("keeps the code it replaces as the previous, and removes every other worktree", () => {
		const first = land(OK);
		adopt();
		const second = land(`${OK}// two\n`);
		adopt();
		const third = land(`${OK}// three\n`);
		adopt();
		expect(live()).toBe(path.join(codeDir, third));
		expect(fs.readlinkSync(files().previous)).toBe(path.join(codeDir, second));
		expect(fs.readdirSync(codeDir).sort()).toEqual([second, third].sort());
		expect(fs.existsSync(path.join(codeDir, first))).toBe(false);
	});

	it("adopts nothing in a checkout whose hooks do not run from it", () => {
		land(OK);
		fs.rmSync(path.join(repo, HOOKS));
		expect(at(repo)).toBeNull();
	});
});
