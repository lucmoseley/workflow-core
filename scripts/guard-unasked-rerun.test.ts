// @vitest-environment node
/*
 * The guard-unasked-rerun core of guard-dispatch.js — the refuse-once re-run
 * guard (#815, spec #810) — driven through the dispatcher entry run on it
 * alone: a payload on stdin, the allow or deny read back. These are its
 * boundary cases (§X11, #2800): each exit, each payload field and env var it
 * reads, the judge, rule store and error log crossed for real. Which command
 * reaches the judge, and what each answer becomes, is
 * lib/unasked-rerun-guard.test.ts's; what the judge answers is
 * lib/unasked-rerun.test.ts's; the entry's payload faults and the throw
 * policy are guard-dispatch's own tests' (#3227).
 *
 * Each case copies a throwaway git repository with its own marker store, so
 * the refusal is the real judge's over real git.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath, readFailOpenLog } from "./guard-log-fixture";
import { defineTemplate } from "./lib/git-fixture";
import {
	buildBashPayload,
	dispatchCoreOutput,
} from "./lib/pretool-guard-testkit";
import { storePath } from "./lib/test-pass-marker.js";

const CORE = "guard-unasked-rerun";
const REFUSAL_LOG = ".unasked-rerun-refusals.jsonl";

const SID = "sess-815";

let dir: string;
let config: string;
let project: string;

const gitIn = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();

/* HEAD a commit past origin/main touching a.js, built once and copied per
 * case (§X8 (1)); the case writes the certificate attesting it. */
const template = defineTemplate((root) => {
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	gitIn(root, "init", "-q", "-b", "main");
	gitIn(root, "config", "user.email", "t@example.com");
	gitIn(root, "config", "user.name", "t");
	fs.writeFileSync(path.join(root, ".gitignore"), ".claude/\n");
	gitIn(root, "add", ".gitignore");
	gitIn(root, "commit", "-q", "-m", "ignore");
	gitIn(root, "update-ref", "refs/remotes/origin/main", "HEAD");
	fs.writeFileSync(path.join(root, "a.js"), "a.js\n");
	gitIn(root, "add", "a.js");
	gitIn(root, "commit", "-q", "-m", "c");
});

/** One admissible narrowed certificate named RUN-A attesting HEAD's a.js. */
function attestHead() {
	const sha = gitIn(project, "rev-parse", "HEAD");
	const certificate = {
		sha,
		at: "RUN-A",
		suite: "vitest",
		dirtyAtStart: false,
		foreign: [],
		scope: {
			modulesRun: 1,
			modulesTotal: 9,
			tests: 3,
			passed: 3,
			skipped: 0,
			failed: 0,
			nameFilter: null,
			fileFilters: [],
			changed: "x",
			admissible: true,
		},
		treeAtEnd: gitIn(project, "rev-parse", `${sha}^{tree}`),
		closure: ["a.js"],
		changedPaths: ["a.js"],
	};
	fs.mkdirSync(path.dirname(storePath(project)), { recursive: true });
	fs.writeFileSync(storePath(project), `${JSON.stringify(certificate)}\n`);
	return sha;
}

/** The hook output for `command`, or null; exit 0 and a quiet stderr asserted. */
const emission = (
	command: string,
	{
		session = SID as string | null,
		cwd = project,
		root = project,
		env = {} as NodeJS.ProcessEnv,
	} = {},
) =>
	dispatchCoreOutput(
		CORE,
		{ ...buildBashPayload(command, session), cwd },
		{ project: root, config, cwd: root, env },
	);

const readRefusals = () => {
	const at = path.join(project, ".claude/tmp/markers", REFUSAL_LOG);
	return fs.existsSync(at)
		? fs.readFileSync(at, "utf8").split("\n").filter(Boolean)
		: [];
};

beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "unasked-")));
	config = path.join(dir, "config");
	project = template.instantiate(path.join(dir, "project"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("the guard, end to end", () => {
	it("refuses the first bare run over an attested HEAD as JSON on exit 0, carrying the judge's text and the whole rule, then lets the same command through", () => {
		const sha = attestHead();
		/* The payload's cwd stands outside the repo; the cd, resolved against
		 * the real tree, carries the run into it. */
		const command = `cd ${project} && npm run test`;
		const out = emission(command, { cwd: dir });
		expect(out.permissionDecision).toBe("deny");
		const reason = out.permissionDecisionReason as string;
		expect(reason).toContain(
			`certificates already attest what this run would test at HEAD ${sha.slice(0, 12)}, so it can only repeat their verdict`,
		);
		expect(reason).toContain("RUN-A");
		/* The fragment's paths resolve against the host root, so its opening
		 * line is matched rather than the test process's own reading. */
		expect(reason).toContain(
			"this refuses once a session.\n\nAN UNASKED RE-RUN IS REFUSED ONCE A SESSION",
		);
		expect(readRefusals()).toHaveLength(1);
		expect(emission(command, { cwd: dir })).toBeNull();
		expect(fs.existsSync(failOpenLogPath(config, project))).toBe(false);
	});

	it("is silent on a command that is no bare test run, judging nothing", () => {
		attestHead();
		expect(emission("npm run test -- a.test.ts")).toBeNull();
		expect(readRefusals()).toEqual([]);
		expect(emission("npm run test")?.permissionDecision).toBe("deny");
	});

	it("allows a payload with no session id silently", () => {
		attestHead();
		expect(emission("npm run test", { session: null })).toBeNull();
		expect(readRefusals()).toEqual([]);
		expect(fs.existsSync(failOpenLogPath(config, project))).toBe(false);
	});
});

describe("a refusal whose rule it cannot read still refuses", () => {
	it("refuses with an empty store, names the fragment's file, and records no fail-open", () => {
		attestHead();
		const store = fs.mkdtempSync(path.join(dir, "store-"));
		const out = emission("npm run test", { env: { WFC_RULES_DIR: store } });
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			"docs/agents/rules/unasked-rerun.txt",
		);
		expect(fs.existsSync(failOpenLogPath(config, project))).toBe(false);
	});
});

describe("the fail-open record", () => {
	it("records a working directory git cannot read, from the payload's cwd, allowing", () => {
		attestHead();
		const outside = path.join(dir, "outside");
		fs.mkdirSync(outside);
		expect(
			emission("npm run test", {
				cwd: outside,
				env: { GIT_CEILING_DIRECTORIES: dir },
			}),
		).toBeNull();
		const [line] = readFailOpenLog(config, project).trim().split("\n");
		expect(line?.split("\t")).toEqual([
			expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
			CORE,
			"could not judge whether certificates attest HEAD — a bare test run allowed unjudged",
			"git could not resolve the run's working directory",
		]);
	});

	it("records a repository root git cannot read, from CLAUDE_PROJECT_DIR, allowing", () => {
		attestHead();
		const outside = path.join(dir, "outside");
		fs.mkdirSync(outside);
		expect(
			emission("npm run test", {
				root: outside,
				env: { GIT_CEILING_DIRECTORIES: dir },
			}),
		).toBeNull();
		expect(readFailOpenLog(config, outside)).toContain(
			"git could not resolve the repository root",
		);
	});
});
