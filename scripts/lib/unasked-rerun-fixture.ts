/*
 * unasked-rerun-fixture.ts — the real repository lib/unasked-rerun-io.js's
 * cases run over (#2913): a throwaway git repo a commit past its own
 * origin/main, with its own marker store and write ledger, copied per case
 * from a template built once (§X8 (1), scripts/lib/git-fixture.ts).
 *
 * Calling `rerunFixture()` registers the per-case copy and env restore, so
 * call it once at a test file's top level.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { defineTemplate } from "./git-fixture";
import { storePath } from "./test-pass-marker.js";

export const SID = "sess-815";
export const REFUSAL_LOG = ".unasked-rerun-refusals.jsonl";
export const LATCH_PREFIX = ".unasked-rerun-refused-";

const { paths } = require("./arbiter-core.js") as {
	paths: {
		ledger: (sid: string) => string;
		commitLedger: (sid: string, root: string) => string;
	};
};

const ENV_KEYS = [
	"CLAUDE_CONFIG_DIR",
	"CLAUDE_PROJECT_DIR",
	"GIT_CEILING_DIRECTORIES",
	"WFC_GIT",
] as const;

export const gitIn = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();

const template = defineTemplate((root) => {
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	gitIn(root, "init", "-q", "-b", "main");
	gitIn(root, "config", "user.email", "t@example.com");
	gitIn(root, "config", "user.name", "t");
	gitIn(root, "commit", "-q", "--allow-empty", "-m", "root");
	fs.writeFileSync(
		path.join(root, ".claude/workflow-core.json"),
		JSON.stringify({ commands: { test: "node scripts/run-vitest.js" } }),
	);
	fs.writeFileSync(path.join(root, ".gitignore"), ".claude/\n");
	gitIn(root, "add", ".gitignore");
	gitIn(root, "commit", "-q", "-m", "ignore");
	gitIn(root, "update-ref", "refs/remotes/origin/main", "HEAD");
});

export function rerunFixture() {
	const f = { dir: "", project: "" };
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		f.dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "unasked-")));
		f.project = template.instantiate(path.join(f.dir, "project"));
		for (const k of ENV_KEYS) saved[k] = process.env[k];
		process.env.CLAUDE_CONFIG_DIR = path.join(f.dir, "config");
		process.env.CLAUDE_PROJECT_DIR = f.project;
		delete process.env.GIT_CEILING_DIRECTORIES;
		delete process.env.WFC_GIT;
	});

	afterEach(() => {
		for (const k of ENV_KEYS) {
			const v = saved[k];
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		fs.rmSync(f.dir, { recursive: true, force: true });
	});

	const git = (...args: string[]) => gitIn(f.project, ...args);
	const markers = () => path.join(f.project, ".claude/tmp/markers");

	function commitTouching(...rels: string[]) {
		for (const rel of rels)
			fs.writeFileSync(path.join(f.project, rel), `${rel}\n`);
		git("add", "--", ...rels);
		git("commit", "-q", "-m", "c");
		return git("rev-parse", "HEAD");
	}

	/** An admissible narrowed certificate on `sha`, selected for `rels` and reading them alone. */
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
			storePath(f.project),
			`${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
		);

	function writeLedger(sid: string, ...rels: string[]) {
		const at = paths.ledger(sid);
		fs.mkdirSync(path.dirname(at), { recursive: true });
		fs.writeFileSync(at, `${rels.join("\n")}\n`);
	}

	/** `sid`'s commit ledger, as `.husky/post-commit` keeps it (#766). */
	function writeCommits(sid: string, ...shas: string[]) {
		const at = paths.commitLedger(sid, f.project);
		fs.mkdirSync(path.dirname(at), { recursive: true });
		fs.writeFileSync(at, `${shas.join("\n")}\n`);
	}

	/** HEAD a commit past origin/main, attested by one narrowed certificate named RUN-A. */
	function attestedHead() {
		const sha = commitTouching("a.js");
		writeStore(narrowedOn(sha, ["a.js"], "RUN-A"));
		return sha;
	}

	/** HEAD plus this session's uncommitted edit to c.js, which its ledger names. */
	function ownEdit() {
		const sha = commitTouching("c.js");
		fs.writeFileSync(path.join(f.project, "c.js"), "edited\n");
		writeLedger(SID, "c.js");
		return sha;
	}

	/** This session's commit, attested by RUN-A, under a neighbour's untested one. */
	function neighbourOnTop(...theirPaths: string[]) {
		const own = attestedHead();
		for (const rel of theirPaths)
			fs.writeFileSync(path.join(f.project, rel), `${rel} by a neighbour\n`);
		git("add", "--", ...theirPaths);
		git("commit", "-q", "-m", "theirs");
		const theirs = git("rev-parse", "HEAD");
		writeCommits(SID, own);
		writeCommits("neighbour", theirs);
		return { own, theirs };
	}

	/** A directory git will not name a repository for. */
	function outside() {
		const at = path.join(f.dir, "outside");
		fs.mkdirSync(at, { recursive: true });
		process.env.GIT_CEILING_DIRECTORIES = f.dir;
		return at;
	}

	const readRefusals = () => {
		const at = path.join(markers(), REFUSAL_LOG);
		if (!fs.existsSync(at)) return [];
		return fs
			.readFileSync(at, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	};

	return {
		f,
		git,
		markers,
		commitTouching,
		narrowedOn,
		writeStore,
		writeLedger,
		writeCommits,
		attestedHead,
		ownEdit,
		neighbourOnTop,
		outside,
		readRefusals,
		ledgerPath: (sid: string) => paths.ledger(sid),
		commitLedgerPath: (sid: string) => paths.commitLedger(sid, f.project),
	};
}
