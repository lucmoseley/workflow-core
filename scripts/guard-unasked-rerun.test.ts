// @vitest-environment node
/*
 * guard-unasked-rerun.test.ts — the refuse-once re-run guard (#815, spec #810),
 * driven as the hook it is: a payload on stdin, the allow or deny read back.
 *
 * Each case builds a throwaway git repository with its own marker store and
 * write ledger, so cover is judged by the real certificate library rather than
 * a stub. The "where it cannot judge" cases are the fail-open record, so
 * dropping one hides a guard that allows silently.
 *
 * The guard is a `PreToolUse` Bash hook in self-plugin/hooks/hooks.json: loosen
 * the refusal cases and a suite that can only repeat a known verdict runs again
 * unasked; loosen the never-refused ones and a session's needed run is denied.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath } from "./guard-log-fixture";
import { sweptMarkers } from "./lib/arbiter-testkit";
import { caught } from "./lib/caught.js";
import { storePath } from "./lib/test-pass-marker.js";
import { REFUSAL_LOG } from "./lib/unasked-rerun.js";

const GUARD = path.resolve(__dirname, "guard-unasked-rerun.sh");
const { paths } = createRequire(import.meta.url)("./lib/arbiter-core.js");

const SID = "sess-815";

let dir: string;
let config: string;
let project: string;

const git = (...args: string[]) =>
	execFileSync("git", args, {
		cwd: project,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();

function commitTouching(...rels: string[]) {
	for (const rel of rels) fs.writeFileSync(path.join(project, rel), `${rel}\n`);
	git("add", "--", ...rels);
	git("commit", "-q", "-m", "c");
	return git("rev-parse", "HEAD");
}

/** An admissible narrowed green on `sha`, selected for `rels` and reading them alone. */
const narrowedOn = (sha: string, rels: string[], at: string) => ({
	sha,
	at,
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
	treeAtEnd: git("rev-parse", `${sha}^{tree}`),
	closure: rels,
	changedPaths: rels,
});

const writeStore = (...entries: unknown[]) =>
	fs.writeFileSync(
		storePath(project),
		`${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
	);

/** `derive` under this case's config, as the arbiter derives its paths. */
function underConfig<T>(derive: () => T): T {
	const saved = [process.env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_PROJECT_DIR];
	process.env.CLAUDE_CONFIG_DIR = config;
	process.env.CLAUDE_PROJECT_DIR = project;
	try {
		return derive();
	} finally {
		for (const [k, v] of [
			["CLAUDE_CONFIG_DIR", saved[0]],
			["CLAUDE_PROJECT_DIR", saved[1]],
		] as const) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

const ledgerPath = (sid: string): string =>
	underConfig(() => paths.ledger(sid));

const commitLedgerPath = (sid: string): string =>
	underConfig(() => paths.commitLedger(sid, project));

function writeLedger(sid: string, ...rels: string[]) {
	const at = ledgerPath(sid);
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, `${rels.join("\n")}\n`);
}

/** `sid`'s commit ledger, as `.husky/post-commit` keeps it (#766). */
function writeCommits(sid: string, ...shas: string[]) {
	const at = commitLedgerPath(sid);
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, `${shas.join("\n")}\n`);
}

const run = (
	command: string,
	payload: Record<string, unknown> = {},
	env: Record<string, string> = {},
) => {
	const r = spawnSync(GUARD, [], {
		encoding: "utf8",
		input: JSON.stringify({
			tool_name: "Bash",
			tool_input: { command },
			session_id: SID,
			cwd: project,
			...payload,
		}),
		env: {
			...process.env,
			CLAUDE_CONFIG_DIR: config,
			CLAUDE_PROJECT_DIR: project,
			...env,
		},
	});
	if (r.status === null) throw new Error(`guard did not run: ${r.error}`);
	return r;
};

const failOpenLog = () =>
	fs.readFileSync(failOpenLogPath(config, project), "utf8");

const MARKERS = () => path.join(project, ".claude/tmp/markers");

const denied = (r: ReturnType<typeof run>) => {
	expect(r.status).toBe(0);
	const out = JSON.parse(r.stdout).hookSpecificOutput;
	expect(out.permissionDecision).toBe("deny");
	return out.permissionDecisionReason as string;
};

const allowed = (r: ReturnType<typeof run>) => {
	expect(r.status).toBe(0);
	expect(r.stdout).toBe("");
};

const refusals = () => {
	const at = path.join(project, ".claude/tmp/markers", REFUSAL_LOG);
	if (!fs.existsSync(at)) return [];
	return fs
		.readFileSync(at, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
};

beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "unasked-")));
	config = path.join(dir, "config");
	project = path.join(dir, "project");
	fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	git("commit", "-q", "--allow-empty", "-m", "root");
	git("update-ref", "refs/remotes/origin/main", "HEAD");
	fs.writeFileSync(
		path.join(project, ".claude/workflow-core.json"),
		JSON.stringify({ commands: { test: "node scripts/run-vitest.js" } }),
	);
	fs.writeFileSync(path.join(project, ".gitignore"), ".claude/\n");
	git("add", ".gitignore");
	git("commit", "-q", "-m", "ignore");
	git("update-ref", "refs/remotes/origin/main", "HEAD");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** HEAD a commit past origin/main, covered by one narrowed green named RUN-A. */
function attestedHead() {
	const sha = commitTouching("a.js");
	writeStore(narrowedOn(sha, ["a.js"], "RUN-A"));
	return sha;
}

/**
 * HEAD plus this session's uncommitted edit to c.js, covered by RUN-C: a green
 * whose overlay carried that edit, as `test:changed` reads it (#1217).
 */
function attestedEdit() {
	const sha = commitTouching("c.js");
	fs.writeFileSync(path.join(project, "c.js"), "edited\n");
	writeLedger(SID, "c.js");
	const tree = git("rev-parse", `${git("stash", "create")}^{tree}`);
	writeStore({ ...narrowedOn(sha, ["c.js"], "RUN-C"), treeAtEnd: tree });
	return sha;
}

describe("the first bare run over a covered HEAD", () => {
	it("is refused, naming the covering run and saying re-typing runs it", () => {
		const sha = attestedHead();
		const reason = denied(run("npm run test"));
		expect(reason).toContain(`at HEAD ${sha.slice(0, 12)} is already covered`);
		expect(reason).toContain("RUN-A");
		expect(reason).toContain("Type the same command again and it runs");
		expect(reason).toContain("AN UNASKED RE-RUN IS REFUSED ONCE A SESSION");
	});

	it("lets the same command through the second time", () => {
		attestedEdit();
		denied(run("npm run test:changed"));
		allowed(run("npm run test:changed"));
		allowed(run("npm run test"));
	});

	it("judges vitest alone, so an uncovered pytest file refuses nothing less", () => {
		const sha = commitTouching("a.js", "b.py");
		writeStore(narrowedOn(sha, ["a.js", "b.py"], "RUN-A"));
		const reason = denied(run("npm run test"));
		expect(reason).not.toContain("PYTEST");
	});

	it("writes a latch the marker sweep knows", () => {
		attestedHead();
		denied(run("npm run test"));
		const latches = fs.readdirSync(MARKERS()).filter((f) => f.endsWith(SID));
		expect(latches).toHaveLength(1);
		expect(sweptMarkers(latches)).toEqual(latches);
	});

	it("appends one line per refusal to the refusal log", () => {
		const sha = attestedHead();
		denied(run("npm run test"));
		run("npm run test");
		const lines = refusals();
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			session: SID,
			command: "npm run test",
			head: sha,
			members: [{ sha, at: "RUN-A", full: false, by: "sha" }],
		});
	});

	it("spends the latch on a refused queued run", () => {
		attestedHead();
		denied(run("npm run test -- --queue"));
		allowed(run("npm run test -- --queue"));
		allowed(run("npm run test"));
	});

	it("logs a refused queued run under the command it was typed as", () => {
		attestedHead();
		denied(run("npm run test -- --queue"));
		expect(refusals()).toMatchObject([
			{ session: SID, command: "npm run test -- --queue" },
		]);
	});

	it.each([
		["npm test", "the script without `run`"],
		["npm run test 2>&1 | tail -20", "piped, with a redirection"],
		["npm run test > out.txt", "redirected to a file"],
		["cd {project} && npm run test --", "after a cd, with a bare --"],
		["timeout 600 npm run test", "behind a wrapper"],
		/* --queue counts as bare (#1153 Q1, #1211). */
		["npm run test -- --queue", "queued after a --"],
		["npm run test --queue", "queued with no --"],
	])("is refused when spelled %s (%s)", (command) => {
		attestedHead();
		denied(run(command.replace("{project}", project)));
	});

	it("is refused as a queued changed run", () => {
		attestedEdit();
		denied(run("npm run test:changed -- --queue"));
	});
});

describe("cover judged on the session's own work, not all of HEAD (#1218)", () => {
	/** This session's commit, covered by RUN-A, under a neighbour's untested one. */
	function neighbourOnTop(...theirPaths: string[]) {
		const own = attestedHead();
		for (const rel of theirPaths)
			fs.writeFileSync(path.join(project, rel), `${rel} by a neighbour\n`);
		git("add", "--", ...theirPaths);
		git("commit", "-q", "-m", "theirs");
		const theirs = git("rev-parse", "HEAD");
		writeCommits(SID, own);
		writeCommits("neighbour", theirs);
		return { own, theirs };
	}

	it("refuses once, naming the covering run and the neighbour commit left out", () => {
		const { theirs } = neighbourOnTop("b.js");
		const reason = denied(run("npm run test"));
		expect(reason).toContain("1 neighbour commit(s) in the range");
		expect(reason).toContain("every file this run would test is covered");
		expect(reason).toContain("RUN-A");
		expect(reason).toContain(theirs.slice(0, 12));
		expect(refusals()).toMatchObject([
			{ own: { paths: ["a.js"], dropped: [theirs] } },
		]);
		allowed(run("npm run test"));
	});

	it("refuses where a green already covers the session's uncommitted edit too, counting the uncommitted files, naming the attesting run and logging the paths", () => {
		const own = attestedEdit();
		git("commit", "-q", "--allow-empty", "-m", "theirs");
		const theirs = git("rev-parse", "HEAD");
		writeCommits(SID, own);
		writeCommits("neighbour", theirs);
		const reason = denied(run("npm run test"));
		expect(reason).toContain("plus this session's 1 uncommitted file(s)");
		expect(reason).toContain("RUN-C");
		expect(refusals()).toMatchObject([
			{ own: { uncommitted: ["c.js"], paths: ["c.js"], dropped: [theirs] } },
		]);
	});

	it("allows an own uncommitted edit made since the covering run", () => {
		neighbourOnTop("b.js");
		fs.writeFileSync(path.join(project, "a.js"), "edited\n");
		writeLedger(SID, "a.js");
		allowed(run("npm run test"));
	});

	it("allows where the neighbour's commit changed a file the covering run read", () => {
		neighbourOnTop("a.js", "b.js");
		allowed(run("npm run test"));
	});

	it("allows where every commit is a neighbour's, the run selecting nothing", () => {
		const { own } = neighbourOnTop("b.js");
		writeCommits(SID);
		writeCommits("other", own);
		allowed(run("npm run test"));
	});

	it("judges test:changed on the session's uncommitted files alone, allowing it where it has none", () => {
		neighbourOnTop("b.js");
		allowed(run("npm run test:changed"));
		denied(run("npm run test"));
	});

	it("falls back to the HEAD test where the commit ledger will not read, and says so", () => {
		neighbourOnTop("b.js");
		const commits = path.dirname(commitLedgerPath(SID));
		fs.rmSync(commits, { recursive: true });
		fs.writeFileSync(commits, "");
		allowed(run("npm run test"));
		expect(failOpenLog()).toContain("own work unreadable");
	});
});

describe("never refused", () => {
	it.each([
		["npm run test -- a.test.ts", "a filtered run"],
		["npm run test -- -t widget", "a name filter"],
		["npm run test -- --full=suite-edit", "a --full= run"],
		["npm run test -- --queue a.test.ts", "a queued filtered run"],
		["npm run test -- --queue --full=suite-edit", "a queued --full= run"],
		["npm run test:py", "another script"],
		["npm run -s test", "a flag before the script"],
	])("%s (%s), and it spends nothing", (command) => {
		attestedHead();
		allowed(run(command));
		denied(run("npm run test"));
	});

	it("a session with an uncommitted file its ledger names", () => {
		attestedHead();
		fs.writeFileSync(path.join(project, "a.js"), "edited\n");
		writeLedger(SID, "a.js");
		allowed(run("npm run test"));
	});

	it("a session whose ledger names a new, untracked file", () => {
		attestedHead();
		fs.writeFileSync(path.join(project, "b.js"), "new\n");
		writeLedger(SID, "b.js");
		allowed(run("npm run test"));
	});

	it("a session whose ledger names only committed files", () => {
		attestedHead();
		writeLedger(SID, "a.js");
		denied(run("npm run test"));
	});

	it("a payload with no session id", () => {
		attestedHead();
		allowed(run("npm run test", { session_id: undefined }));
		expect(refusals()).toEqual([]);
	});

	it("a HEAD no green covers", () => {
		const sha = commitTouching("a.js");
		writeStore(narrowedOn(sha, ["a.js"], "RUN-A"));
		commitTouching("b.js");
		allowed(run("npm run test"));
	});

	it("a run from another checkout", () => {
		attestedHead();
		const other = path.join(dir, "elsewhere");
		git("worktree", "add", "-q", "--detach", other);
		allowed(run(`cd ${other} && npm run test`));
	});
});

/** Symlinks every entry of PATH directory `at` but node into `bin`, an
 * existing link (an earlier spelling) left standing. */
function linkToolsExceptNode(at: string, bin: string) {
	let names: string[] = [];
	try {
		names = fs.readdirSync(at);
	} catch {
		return;
	}
	for (const name of names) {
		const link = path.join(bin, name);
		if (name === "node") continue;
		/* Not existsSync, which reads a dangling link as absent (#1211). */
		try {
			fs.symlinkSync(path.join(at, name), link);
		} catch (e) {
			if (caught(e).code !== "EEXIST") throw e;
		}
	}
}

describe("where it cannot judge", () => {
	it("an unreadable marker store allows and records why", () => {
		attestedHead();
		const store = storePath(project);
		fs.rmSync(store);
		fs.mkdirSync(store);
		allowed(run("npm run test"));
		const log = fs.readFileSync(failOpenLogPath(config, project), "utf8");
		expect(log).toContain("could not judge whether HEAD is covered");
		expect(log).toContain("the pass-marker store could not be read (EISDIR)");
	});

	it("an unreadable ledger allows and records why", () => {
		attestedHead();
		writeLedger(SID, "a.js");
		const ledger = ledgerPath(SID);
		fs.rmSync(ledger);
		fs.mkdirSync(ledger);
		allowed(run("npm run test"));
		const log = fs.readFileSync(failOpenLogPath(config, project), "utf8");
		expect(log).toContain("write ledger could not be read");
	});

	it("a working directory git cannot read allows and records why", () => {
		attestedHead();
		const outside = path.join(dir, "outside");
		fs.mkdirSync(outside);
		allowed(
			run("npm run test", { cwd: outside }, { GIT_CEILING_DIRECTORIES: dir }),
		);
		expect(failOpenLog()).toContain(
			"git could not resolve the run's working directory",
		);
	});

	it("a repository root git cannot read allows and records why", () => {
		attestedHead();
		const outside = path.join(dir, "outside");
		fs.mkdirSync(outside);
		allowed(
			run(
				"npm run test",
				{},
				{ CLAUDE_PROJECT_DIR: outside, GIT_CEILING_DIRECTORIES: dir },
			),
		);
		expect(fs.readFileSync(failOpenLogPath(config, outside), "utf8")).toContain(
			"git could not resolve the repository root",
		);
	});

	it("an uncovered HEAD over malformed store lines allows and records why", () => {
		commitTouching("a.js");
		fs.writeFileSync(storePath(project), `{"torn\n`);
		allowed(run("npm run test"));
		expect(failOpenLog()).toContain("holds 1 malformed line(s)");
	});

	it("an unwritable refusal log still refuses, and records the lost line", () => {
		attestedHead();
		fs.mkdirSync(path.join(MARKERS(), REFUSAL_LOG));
		denied(run("npm run test"));
		expect(failOpenLog()).toContain("a refusal went unrecorded");
	});

	it("an unwritable latch allows and records why, rather than refusing every run", () => {
		attestedHead();
		fs.chmodSync(MARKERS(), 0o555);
		try {
			allowed(run("npm run test"));
			allowed(run("npm run test"));
		} finally {
			fs.chmodSync(MARKERS(), 0o755);
		}
		expect(failOpenLog()).toContain("the refusal latch could not be written");
	});

	it("no node on PATH allows and records why", () => {
		attestedHead();
		const bin = path.join(dir, "bin");
		fs.mkdirSync(bin);
		/* Every tool on PATH but node, the first spelling of each winning. */
		for (const at of (process.env.PATH ?? "").split(":"))
			linkToolsExceptNode(at, bin);
		allowed(run("npm run test", {}, { PATH: bin }));
		expect(failOpenLog()).toContain("node or lib/unasked-rerun.js unavailable");
	});
});
