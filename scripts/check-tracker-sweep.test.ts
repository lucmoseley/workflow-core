// @vitest-environment node
/*
 * Pins the hand route (mantahostels#2490): every standing key listed, and a
 * check that drew no conclusion never read as clean. The delta gate is
 * lib/key-delta.js's, pinned in its own test and through repo-checks.test.ts.
 *
 * The fixture is a git repo holding the daily repo-checks run's merged result,
 * `.repo-checks.json`, in its git common directory (#1557).
 *
 * It is `npm run status`'s tracker-sweep line: loosen a case and a check that
 * died or holds a finding reads as quiet.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const { REPO_CHECKS } = require("./lib/repo-checks-registry.js");

const SCRIPT = path.resolve(__dirname, "check-tracker-sweep.js");
const REPO = "o.r";

let dir: string;
let state: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, stdio: "ignore" });

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-sweep-test-"));
	// Keeps the run off the real config directory.
	state = path.join(dir, "claude");
	fs.mkdirSync(state, { recursive: true });
	git(dir, "init", "-q");
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

interface Job {
	job: string;
	outcome: string;
	keys?: string[];
	summary?: string;
}

const resultFile = () => path.join(dir, ".git", ".repo-checks.json");

/**
 * Write the merged result as scripts/repo-checks.js does: every registry
 * entry `jobs` does not name reads OK and clean, as a full reading would.
 */
const reading = (
	jobs: Job[],
	extra: Record<string, unknown> = { repo: REPO },
) => {
	const named = new Set(jobs.map((j) => j.job));
	const rest = (REPO_CHECKS as { id: string }[])
		.filter((e) => !named.has(e.id))
		.map((e) => ({ job: e.id, outcome: "OK" }));
	fs.writeFileSync(
		resultFile(),
		JSON.stringify({
			workflow: "repo-checks",
			collectedAt: "2026-10-14T01:00:00.000Z",
			...extra,
			jobs: [...jobs, ...rest].map((j) => ({
				keys: [],
				summary: `${j.outcome}: fixture`,
				...j,
			})),
		}),
	);
};

const runReader = (
	args: string[] = [],
	{ cwd = dir, PATH = process.env.PATH } = {},
) => {
	const r = runInProcess(SCRIPT, args, {
		cwd,
		env: {
			...process.env,
			PATH,
			GITHUB_ACTIONS: "",
			WFC_NOTIFY_PERSIST: "",
			CLAUDE_CONFIG_DIR: state,
			CLAUDE_PROJECT_DIR: cwd,
			WFC_CLAUDE_CONFIG_A: state,
			WFC_CLAUDE_CONFIG_B: state,
			WFC_CLAUDE_CONFIG_C: state,
		},
	});
	return { status: r.status, stdout: r.stdout, out: `${r.stdout}${r.stderr}` };
};

describe("the hand run", () => {
	it("reports every standing key under a standing header", () => {
		reading([
			{ job: "drift", outcome: "FAIL", keys: ["k1"] },
			{ job: "criteria", outcome: "WARN", keys: ["c1", "c2"] },
		]);
		const out = runReader().out;
		for (const key of ["k1", "c1", "c2"]) expect(out).toContain(key);
		expect(out).toContain("TRACKER-SWEEP-STANDING (3)");
		expect(out).not.toContain("since the last report");
	});

	it("says nothing of a check its gate skipped", () => {
		reading([{ job: "drift", outcome: "SKIP" }]);
		const r = runReader();
		expect(r.out).not.toContain("TRACKER-SWEEP-UNEXAMINED");
		expect(r.out).toContain("OK");
	});

	it("names each standing check's hand command", () => {
		reading([{ job: "drift", outcome: "FAIL", keys: ["k1"] }]);
		expect(runReader().out).toMatch(
			/list them: node \S*check-issue-card-drift\.js/,
		);
	});
});

describe("the two states that are never clean", () => {
	it("reports a BROKEN job as drawing no conclusion, failing a hand run", () => {
		reading([{ job: "drift", outcome: "BROKEN" }]);
		const hand = runReader();
		expect(hand.status).toBe(1);
		expect(hand.out).toMatch(/list them: node \S*check-issue-card-drift\.js/);
		expect(hand.out).toContain("drift — BROKEN");
		expect(hand.out).toContain("NO CONCLUSION");
	});

	it("reports a MISSING envelope", () => {
		reading([{ job: "drift", outcome: "MISSING" }]);
		expect(runReader().out).toContain("drift — MISSING");
	});

	/* "We looked and found 19" and "we did not look" are opposite facts, and a
	 * shared word for them merges the two. */
	it("reads BROKEN and MISSING differently from each other and from FAIL", () => {
		reading([
			{ job: "a", outcome: "BROKEN" },
			{ job: "b", outcome: "MISSING" },
			{ job: "c", outcome: "FAIL", keys: ["k"] },
		]);
		const j = JSON.parse(runReader(["--json"]).stdout);
		const tags = (j.findings as { tag: string }[]).map((f) => f.tag);
		expect(tags).toContain("SWEEP-BROKEN");
		expect(tags).toContain("SWEEP-MISSING");
		expect(tags).toContain("SWEEP-STANDING");
	});

	it("reads every registry entry an empty reading lacks as MISSING, never OK", () => {
		fs.writeFileSync(
			resultFile(),
			JSON.stringify({ repo: REPO, collectedAt: "x", jobs: [] }),
		);
		const r = runReader(["--json"]);
		const j = JSON.parse(r.stdout);
		expect(j.outcome).toBe("FAIL");
		expect(r.status).toBe(1);
		expect(
			(j.findings as { tag: string }[]).filter(
				(f) => f.tag === "SWEEP-MISSING",
			),
		).toHaveLength(REPO_CHECKS.length);
		expect(runReader().out).toContain("the reading has no job for drift");
	});

	it("is OK where every job drew a conclusion and none holds a finding", () => {
		reading([{ job: "drift", outcome: "OK", keys: [] }]);
		const r = runReader();
		expect(r.out).toContain("none holds a finding");
		expect(r.status).toBe(0);
	});
});

describe("failing open", () => {
	it("SKIPs, never an all-clear, before the first daily reading", () => {
		const r = runReader(["--json"]);
		expect(r.status).toBe(0);
		const j = JSON.parse(r.stdout);
		expect(j.outcome).toBe("SKIP");
		expect(j.summary).toContain("no daily reading");
	});

	it("is BROKEN, not OK, when the result will not parse, naming the file and the way out", () => {
		fs.writeFileSync(resultFile(), "not json");
		const r = runReader(["--json"]);
		const j = JSON.parse(r.stdout);
		expect(r.status).toBe(2);
		expect(j.outcome).toBe("BROKEN");
		expect(j.summary).toContain(".repo-checks.json");
		expect(j.summary).toContain("delete it");
	});

	it("is BROKEN where the result carries no jobs array", () => {
		fs.writeFileSync(resultFile(), JSON.stringify({ repo: REPO }));
		const r = runReader(["--json"]);
		const j = JSON.parse(r.stdout);
		expect(r.status).toBe(2);
		expect(j.outcome).toBe("BROKEN");
		expect(j.summary).toContain("no jobs array");
	});

	it("SKIPs outside a git checkout", () => {
		const bare = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-sweep-nogit-"));
		try {
			const r = runReader(["--json"], { cwd: bare });
			expect(r.status).toBe(0);
			expect(JSON.parse(r.stdout).outcome).toBe("SKIP");
		} finally {
			fs.rmSync(bare, { recursive: true, force: true });
		}
	});

	it("is BROKEN, not SKIP, where git itself cannot run", () => {
		const r = runReader(["--json"], { PATH: "" });
		expect(r.status).toBe(2);
		const j = JSON.parse(r.stdout);
		expect(j.outcome).toBe("BROKEN");
		expect(j.summary).toContain("git common directory");
	});

	it("lists a result that names no repo", () => {
		reading([{ job: "drift", outcome: "FAIL", keys: ["k1"] }], {});
		expect(runReader().out).toContain("k1");
	});
});

describe("from a linked worktree", () => {
	it("reads the reading in the shared git common directory", () => {
		git(
			dir,
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@t",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"base",
		);
		const wt = path.join(dir, "wt");
		git(dir, "worktree", "add", "-q", "--detach", wt);
		reading([{ job: "drift", outcome: "FAIL", keys: ["k1"] }]);
		expect(runReader([], { cwd: wt }).out).toContain("k1");
	});
});
