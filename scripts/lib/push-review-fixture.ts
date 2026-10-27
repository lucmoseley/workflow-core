/*
 * The fixture lib/push-review.js's adapter is driven over (#2785): a repo, a
 * linked worktree, a session start point, and helpers to commit code billed to
 * a session and to write its review marker.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { defineTemplate, mkScratchDir, trioTemplate } from "./git-fixture";
import { readShellConst } from "./shell-const-testkit";

type Owed = {
	tier: string;
	files: string;
	base: string;
	tierLine: string;
	markerMore: string;
	passFault: string;
	markerScript: string;
} | null;

const { reviewOwed } = require("./push-review.js") as {
	reviewOwed: (o: {
		sessionId: string;
		tree: string;
		log: (what: string, detail?: string) => void;
	}) => Owed;
};

const ARBITER = path.resolve(__dirname, "..", "session-arbiter.js");
export const ME = "review-under-test";

/** Lines past code-signal.sh's review floor. */
export const PAST_FLOOR =
	readShellConst(path.join(__dirname, "code-signal.sh"), "CODE_THRESHOLD") + 1;

export const code = (lines: number) =>
	Array.from({ length: lines }, (_, i) => `export const x${i} = ${i};\n`).join(
		"",
	);

/* Built once and copied (mantahostels#2016); `wt` detached. */
const template = defineTemplate(trioTemplate({ worktree: "detach" }));

/** Registers the per-test fixture; read its fields inside a test. */
export function reviewFixture() {
	const f = {
		dir: "",
		shared: "",
		worktree: "",
		config: "",
		base: "",
		logs: [] as string[],
	};
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8" });
	const markers = () => path.join(f.shared, ".claude", "tmp", "markers");

	beforeEach(() => {
		f.dir = mkScratchDir("push-review-");
		f.config = path.join(f.dir, "config");
		fs.mkdirSync(f.config);
		f.shared = path.join(f.dir, "shared");
		f.worktree = path.join(f.dir, "wt");
		template.instantiate(f.dir);
		f.logs = [];
		vi.stubEnv("CLAUDE_PROJECT_DIR", f.shared);
		vi.stubEnv("CLAUDE_CONFIG_DIR", f.config);
		/* What concision-backstop.sh's `start` records: the start point. */
		f.base = git(f.shared, "rev-parse", "HEAD").trim();
		fs.mkdirSync(markers(), { recursive: true });
		fs.writeFileSync(path.join(markers(), `.concision-base-${ME}`), f.base);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		fs.rmSync(f.dir, { recursive: true, force: true });
	});

	const arbiterEnv = (sid?: string) => ({
		...process.env,
		...(sid ? { CLAUDE_CODE_SESSION_ID: sid } : {}),
	});

	const commitFile = (rel: string, body: string, tree = f.shared) => {
		const abs = path.join(tree, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, body);
		git(tree, "add", rel);
		git(tree, "commit", "-qm", rel, "--", rel);
	};

	/** Credit `rel` to `sid`'s write ledger, as record-write.sh does. */
	const recordWrite = (rel: string, sid = ME) =>
		execFileSync("node", [ARBITER, "record", rel, sid], { env: arbiterEnv() });

	return {
		f,
		git,
		/** A second, independent copy of the template, for the caller to remove. */
		freshCopy: () => {
			const fresh = mkScratchDir("push-review-fresh-");
			try {
				template.instantiate(fresh);
			} catch (err) {
				fs.rmSync(fresh, { recursive: true, force: true });
				throw err;
			}
			return fresh;
		},
		commitFile,
		/** Commit `rel` in `tree`, credited to `sid`'s write ledger. */
		commitBy: (rel: string, body: string, sid = ME, tree = f.shared) => {
			commitFile(rel, body, tree);
			recordWrite(rel, sid);
		},
		recordWrite,
		/** Commit `rel` billed to `sid` by the commit ledger alone (#2390). */
		commitUnwritten: (rel: string, sid: string) => {
			commitFile(rel, code(PAST_FLOOR));
			execFileSync(
				"node",
				[ARBITER, "record-commit", git(f.shared, "rev-parse", "HEAD").trim()],
				{ env: arbiterEnv(sid) },
			);
		},
		/** Name `tree`'s HEAD in `sid`'s commit ledger, as post-commit does. */
		ledgerHead: (sid: string, tree = f.shared) =>
			execFileSync(
				"node",
				[ARBITER, "record-commit", git(tree, "rev-parse", "HEAD").trim()],
				{ env: arbiterEnv(sid) },
			),
		marker: (body: string) =>
			fs.writeFileSync(path.join(markers(), `.codereview-pass-${ME}`), body),
		declareRls: () =>
			fs.writeFileSync(
				path.join(f.shared, ".claude", "workflow-core.json"),
				JSON.stringify({
					sensitivePaths: [
						{
							name: "RLS",
							description: "who may read or write what",
							globs: ["supabase/migrations/**"],
						},
					],
				}),
			),
		owed: (tree = f.shared) =>
			reviewOwed({
				sessionId: ME,
				tree,
				log: (what, detail) =>
					f.logs.push(detail ? `${what}\t${detail}` : what),
			}),
	};
}
