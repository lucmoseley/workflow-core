import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { ledgerHead } from "./arbiter-testkit";
import { readShellConst } from "./const-testkit";
import { declareArea } from "./declare-area-testkit";
import { defineTemplate, mkScratchDir, trioTemplate } from "./git-fixture";

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

export const PAST_FLOOR =
	readShellConst(path.join(__dirname, "code-signal.sh"), "CODE_THRESHOLD") + 1;

export const code = (lines: number) =>
	Array.from({ length: lines }, (_, i) => `export const x${i} = ${i};\n`).join(
		"",
	);

const template = defineTemplate(trioTemplate({ worktree: "detach" }));

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
		f.base = git(f.shared, "rev-parse", "HEAD").trim();
		fs.mkdirSync(markers(), { recursive: true });
		fs.writeFileSync(path.join(markers(), `.concision-base-${ME}`), f.base);
	});

	afterEach(() => {
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

	const recordWrite = (rel: string, sid = ME, tree = f.shared) =>
		execFileSync("node", [ARBITER, "record", rel, sid], {
			env: arbiterEnv(),
			cwd: tree,
		});

	return {
		f,
		git,
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
		commitBy: (rel: string, body: string, sid = ME, tree = f.shared) => {
			commitFile(rel, body, tree);
			recordWrite(rel, sid, tree);
		},
		recordWrite,
		commitUnwritten: (rel: string, sid: string) => {
			commitFile(rel, code(PAST_FLOOR));
			ledgerHead(f.shared, arbiterEnv(sid));
		},
		ledgerHead: (sid: string, tree = f.shared) =>
			ledgerHead(tree, arbiterEnv(sid)),
		marker: (body: string) =>
			fs.writeFileSync(path.join(markers(), `.codereview-pass-${ME}`), body),
		declareArea,
		declareRls: (tree = f.shared) =>
			declareArea(tree, "RLS", ["supabase/migrations/**"]),
		owed: (tree = f.shared) =>
			reviewOwed({
				sessionId: ME,
				tree,
				log: (what, detail) =>
					f.logs.push(detail ? `${what}\t${detail}` : what),
			}),
	};
}
