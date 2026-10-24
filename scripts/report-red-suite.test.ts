// @vitest-environment node
/*
 * The red-suite reporter (mantahostels#2030, the ticket that stopped a red scheduled sweep
 * filing nothing).
 *
 * `gh` is stubbed as a real executable injected at WFC_GH — the named seam
 * scripts/lib/gh.js documents — which records its own argv and answers each
 * subcommand from a file the fixture writes.
 *
 * The fixture is a real throwaway git repo with real commits, because the body
 * carries a commit range that scripts/lib/commit-range.js reads with git.
 *
 * It runs from the daily repo-checks run, the only report a red full suite
 * makes (#1963): loosen a case and a breakage sits on `main` unfiled, or every
 * reading files a duplicate.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.join(__dirname, "report-red-suite.js");
const TITLE = "The scheduled full-suite run is red on main";
const SUITE_JOB = "Full suite";
const RED_URL = "https://github.com/o/code/actions/runs/12345";

const temps: string[] = [];
afterEach(() => {
	for (const t of temps.splice(0))
		fs.rmSync(t, { recursive: true, force: true });
});

interface Fixture {
	root: string;
	env: NodeJS.ProcessEnv;
	shas: string[];
	ghCalls: () => string[][];
}

/** One sweep as `gh run list` returns it, plus the suite job's own verdict. */
interface Sweep {
	databaseId: number;
	headSha?: string;
	url?: string;
	createdAt?: string;
	/** null means the run carries no `Full suite` job at all. */
	suite: string | null;
}

/**
 * A repo with `commits` commits, declaring `o/code` its code repo, and a `gh`
 * stub answering:
 *   issue list --state open  → `openIssues`
 *   issue list --state closed → `closedIssues`
 *   issue view → `issue` (body and comments)
 *   run list → `sweeps`, by default one red sweep of the newest commit
 *   run view <id> → that sweep's jobs
 *   issue create / issue comment → a URL
 */
function fixture(opts: {
	commits?: number;
	openIssues?: unknown;
	closedIssues?: unknown;
	issue?: { body: string; comments: { body: string }[] };
	/** Newest first, exactly as `gh run list` orders them. */
	sweeps?: Sweep[];
}): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "red-suite-"));
	temps.push(root);

	const git = (args: string[]) =>
		execFileSync("git", args, { cwd: root, encoding: "utf8" });
	git(["init", "-q", "-b", "main", "."]);
	git(["config", "user.email", "test@example.com"]);
	git(["config", "user.name", "test"]);
	const shas: string[] = [];
	for (let i = 0; i < (opts.commits ?? 3); i++) {
		fs.writeFileSync(path.join(root, `f${i}.txt`), `contents ${i}\n`);
		git(["add", "--", `f${i}.txt`]);
		git(["commit", "-qm", `commit ${i}`, "--", `f${i}.txt`]);
		shas.push(git(["rev-parse", "HEAD"]).trim());
	}

	fs.mkdirSync(path.join(root, ".claude"));
	fs.writeFileSync(
		path.join(root, ".claude", "workflow-core.json"),
		JSON.stringify({ tracker: "o/tracker", codeRepo: "o/code" }),
	);

	const sweeps = opts.sweeps ?? [
		{
			databaseId: 1,
			headSha: shas.at(-1),
			url: RED_URL,
			createdAt: "2026-08-29T15:00:00Z",
			suite: "failure",
		},
	];
	fs.writeFileSync(
		path.join(root, "runList.json"),
		JSON.stringify(sweeps.map(({ suite: _suite, ...sweep }) => sweep)),
	);
	fs.writeFileSync(
		path.join(root, "issueList.json"),
		JSON.stringify(opts.openIssues ?? []),
	);
	fs.writeFileSync(
		path.join(root, "closedList.json"),
		JSON.stringify(opts.closedIssues ?? []),
	);
	fs.writeFileSync(
		path.join(root, "issueView.json"),
		JSON.stringify(opts.issue ?? { body: "", comments: [] }),
	);
	// One file per run, so `gh run view <id>` answers for that run alone.
	for (const s of sweeps)
		fs.writeFileSync(
			path.join(root, `jobs-${s.databaseId}.json`),
			JSON.stringify(
				s.suite === null
					? [{ name: "Document guards", conclusion: "success" }]
					: [{ name: `${SUITE_JOB} / Lint and tests`, conclusion: s.suite }],
			),
		);

	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	const argvLog = path.join(root, "gh-argv.log");
	const ghStub = path.join(bin, "gh");
	fs.writeFileSync(
		ghStub,
		[
			"#!/bin/sh",
			// One RECORD per call, opened by a marker line and carrying one argument
			// per line. A separator character was tried first and dropped: `\\x1f`
			// is not portable in /bin/sh's printf, which wrote it literally.
			`{ echo '===CALL==='; for a in "$@"; do echo "$a"; done; } >> ${JSON.stringify(argvLog)}`,
			'if [ "$1" = "issue" ] && [ "$2" = "list" ]; then',
			'  case " $* " in *" closed "*) list=closedList ;; *) list=issueList ;; esac',
			`  cat ${JSON.stringify(root)}/"$list".json`,
			'elif [ "$1" = "issue" ] && [ "$2" = "view" ]; then',
			`  cat ${JSON.stringify(path.join(root, "issueView.json"))}`,
			'elif [ "$1" = "run" ] && [ "$2" = "list" ]; then',
			`  cat ${JSON.stringify(path.join(root, "runList.json"))}`,
			'elif [ "$1" = "run" ] && [ "$2" = "view" ]; then',
			`  cat ${JSON.stringify(root)}/jobs-"$3".json`,
			'elif [ "$1" = "issue" ] && [ "$2" = "create" ]; then',
			"  echo https://github.com/o/r/issues/999",
			'elif [ "$1" = "issue" ] && [ "$2" = "comment" ]; then',
			"  echo https://github.com/o/r/issues/500#issuecomment-1",
			"else",
			"  exit 9",
			"fi",
		].join("\n"),
	);
	fs.chmodSync(ghStub, 0o755);

	return {
		root,
		shas,
		env: {
			...process.env,
			WFC_GH: ghStub,
			CLAUDE_PROJECT_DIR: root,
		},
		ghCalls: () =>
			fs.existsSync(argvLog)
				? fs
						.readFileSync(argvLog, "utf8")
						.split("===CALL===\n")
						.filter(Boolean)
						.map((rec) => rec.split("\n"))
				: [],
	};
}

/** The one `gh issue <sub>` call the run made, or undefined where it made none. */
const callOf = (f: Fixture, sub: string) =>
	f.ghCalls().find((c) => c[0] === "issue" && c[1] === sub);

/** The script's stdout; throws where it exits non-zero, as execFileSync does. */
const run = (f: Fixture) => {
	const r = runInProcess(SCRIPT, [], { cwd: f.root, env: f.env });
	if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr}`);
	return r.stdout;
};

/** `sweepStillRed()`'s result, called out of process against a fixture. */
const sweepStillRedOf = (f: Fixture) =>
	JSON.parse(
		execFileSync(
			"node",
			[
				"-e",
				`const s=require(${JSON.stringify(SCRIPT)});console.log(JSON.stringify(s.sweepStillRed()))`,
			],
			{ cwd: f.root, encoding: "utf8", env: f.env },
		),
	);

describe("filing", () => {
	it("files one issue carrying the run URL, the head sha and the commit range", () => {
		const f = fixture({
			commits: 3,
			sweeps: [], // filled below, once the shas exist
		});
		fs.writeFileSync(
			path.join(f.root, "runList.json"),
			JSON.stringify([
				{
					databaseId: 8,
					headSha: f.shas[2],
					url: RED_URL,
					createdAt: "2026-08-29T21:25:00Z",
				},
				{
					databaseId: 7,
					headSha: f.shas[0],
					url: "https://github.com/o/code/actions/runs/7",
					createdAt: "2026-08-29T15:25:00Z",
				},
			]),
		);
		fs.writeFileSync(
			path.join(f.root, "jobs-8.json"),
			JSON.stringify([{ name: "Full suite / Lint", conclusion: "failure" }]),
		);
		fs.writeFileSync(
			path.join(f.root, "jobs-7.json"),
			JSON.stringify([{ name: "Full suite / Lint", conclusion: "success" }]),
		);
		const out = run(f);
		expect(out).toContain("Filed https://github.com/o/r/issues/999");

		const create = callOf(f, "create");
		expect(create).toBeTruthy();
		const body = (create as string[]).join("\n");
		expect(body).toContain(TITLE);
		expect(body).toContain(RED_URL);
		expect(body).toContain(f.shas[2]);
		expect(body).toContain("2 commit(s) since the last green run");
		expect(body).toContain("commit 2");
	});

	it("carries urgent, a takes: value and its own dedupe label", () => {
		const f = fixture({ commits: 2 });
		run(f);
		const labels = callOf(f, "create") as string[];
		expect(labels).toContain("ci-red");
		expect(labels).toContain("urgent");
		expect(labels).toContain("takes:triage");
	});

	it("still files when no green sweep is in the window, saying so", () => {
		const f = fixture({ commits: 2 });
		run(f);
		const create = (callOf(f, "create") as string[]).join("\n");
		expect(create).toContain(
			"No green `scheduled-checks.yml` run is in the API's window",
		);
	});

	it("says a red sweep is not evidence of a regression", () => {
		const f = fixture({ commits: 2 });
		run(f);
		const create = (callOf(f, "create") as string[]).join("\n");
		expect(create).toContain("not evidence of a regression");
	});

	it("exits 0 on the happy path, the report being the signal", () => {
		const f = fixture({ commits: 2 });
		expect(() => run(f)).not.toThrow();
	});

	it("exits NON-zero when gh refuses, rather than filing nothing quietly", () => {
		const f = fixture({ commits: 2 });
		// The stub answers `issue list` from a file; remove it and gh exits 1.
		fs.rmSync(path.join(f.root, "issueList.json"));
		expect(() => run(f)).toThrow();
	});
});

describe("which sweep it files for (#1963)", () => {
	it("files nothing where the newest judged sweep is green", () => {
		const f = fixture({
			commits: 2,
			sweeps: [
				{
					databaseId: 2,
					headSha: "b",
					url: "u2",
					createdAt: "d2",
					suite: null,
				},
				{
					databaseId: 1,
					headSha: "a",
					url: "u1",
					createdAt: "d1",
					suite: "success",
				},
			],
		});
		expect(run(f)).toContain("nothing to file");
		expect(callOf(f, "create")).toBeUndefined();
	});

	it("reads the runs from the code repo, not gh's default, which is the tracker", () => {
		const f = fixture({ commits: 2 });
		run(f);
		const runCalls = f.ghCalls().filter((c) => c[0] === "run");
		expect(runCalls.length).toBeGreaterThan(0);
		for (const c of runCalls) expect(c.join(" ")).toContain("--repo o/code");
	});
});

describe("which job's verdict counts", () => {
	it("takes the last green end from the SUITE job, not the run", () => {
		const f = fixture({ commits: 3 });
		fs.writeFileSync(
			path.join(f.root, "runList.json"),
			JSON.stringify([
				{ databaseId: 9, headSha: f.shas[2], url: "u9", createdAt: "d9" },
				// The run is red, but only because `documents` failed.
				{ databaseId: 8, headSha: f.shas[1], url: "u8", createdAt: "d8" },
				{ databaseId: 7, headSha: f.shas[0], url: "u7", createdAt: "d7" },
			]),
		);
		fs.writeFileSync(
			path.join(f.root, "jobs-9.json"),
			JSON.stringify([{ name: "Full suite / Lint", conclusion: "failure" }]),
		);
		fs.writeFileSync(
			path.join(f.root, "jobs-8.json"),
			JSON.stringify([
				{ name: "Full suite / Lint", conclusion: "success" },
				{ name: "Document guards", conclusion: "failure" },
			]),
		);
		fs.writeFileSync(
			path.join(f.root, "jobs-7.json"),
			JSON.stringify([{ name: "Full suite / Lint", conclusion: "success" }]),
		);
		run(f);
		const create = (callOf(f, "create") as string[]).join("\n");
		expect(create).toContain("1 commit(s) since the last green run");
	});

	it("reads a run red when one job under the suite prefix failed, even though another matching job passed", () => {
		const f = fixture({
			commits: 2,
			sweeps: [
				{
					databaseId: 8,
					headSha: "a".repeat(40),
					url: "u8",
					createdAt: "d8",
					suite: "success",
				},
			],
		});
		fs.writeFileSync(
			path.join(f.root, "jobs-8.json"),
			JSON.stringify([
				{ name: "Full suite / Python", conclusion: "success" },
				{ name: "Full suite / Lint and tests", conclusion: "failure" },
			]),
		);
		expect(sweepStillRedOf(f).held).toBe(true);
	});

	it("does not call a run green while a job under the suite prefix is still in progress", () => {
		const f = fixture({
			commits: 2,
			sweeps: [
				{
					databaseId: 8,
					headSha: "a".repeat(40),
					url: "u8",
					createdAt: "d8",
					suite: "success",
				},
				{
					databaseId: 7,
					headSha: "b".repeat(40),
					url: "u7",
					createdAt: "d7",
					suite: "success",
				},
			],
		});
		fs.writeFileSync(
			path.join(f.root, "jobs-8.json"),
			JSON.stringify([
				{ name: "Full suite / Python", conclusion: "success" },
				// No `conclusion` at all: the job is still running.
				{ name: "Full suite / Lint and tests" },
			]),
		);
		fs.writeFileSync(
			path.join(f.root, "jobs-7.json"),
			JSON.stringify([
				{ name: "Full suite / Lint and tests", conclusion: "success" },
			]),
		);
		const result = sweepStillRedOf(f);
		// The newest sweep carries no verdict yet, so the older green one judges.
		expect(result.held).toBe(false);
		expect(result.detail).toContain("d7");
	});

	it("reads a run green only once every job under the suite prefix passed", () => {
		const f = fixture({
			commits: 2,
			sweeps: [
				{
					databaseId: 8,
					headSha: "a".repeat(40),
					url: "u8",
					createdAt: "d8",
					suite: "success",
				},
			],
		});
		fs.writeFileSync(
			path.join(f.root, "jobs-8.json"),
			JSON.stringify([
				{ name: "Full suite / Lint and tests", conclusion: "success" },
				{ name: "Full suite / Python", conclusion: "success" },
			]),
		);
		expect(sweepStillRedOf(f).held).toBe(false);
	});

	it("reads a run as carrying no verdict when every job under the suite prefix is cancelled or skipped", () => {
		const f = fixture({
			commits: 2,
			sweeps: [
				{
					databaseId: 8,
					headSha: "a".repeat(40),
					url: "u8",
					createdAt: "d8",
					suite: "success",
				},
				{
					databaseId: 7,
					headSha: "b".repeat(40),
					url: "u7",
					createdAt: "d7",
					suite: "success",
				},
			],
		});
		fs.writeFileSync(
			path.join(f.root, "jobs-8.json"),
			JSON.stringify([
				{ name: "Full suite / Lint and tests", conclusion: "cancelled" },
				{ name: "Full suite / Python", conclusion: "skipped" },
			]),
		);
		fs.writeFileSync(
			path.join(f.root, "jobs-7.json"),
			JSON.stringify([
				{ name: "Full suite / Lint and tests", conclusion: "success" },
			]),
		);
		const result = sweepStillRedOf(f);
		expect(result.held).toBe(false);
		expect(result.detail).toContain("d7");
	});

	it("steps over a run whose suite job is missing entirely", () => {
		const f = fixture({
			commits: 2,
			sweeps: [
				{
					databaseId: 10,
					headSha: "y",
					url: "u10",
					createdAt: "d10",
					suite: "failure",
				},
				{
					databaseId: 9,
					headSha: "x",
					url: "u9",
					createdAt: "d9",
					suite: null,
				},
			],
		});
		run(f);
		const create = (callOf(f, "create") as string[]).join("\n");
		expect(create).toContain("No green `scheduled-checks.yml` run");
	});
});

describe("de-duplication", () => {
	it("comments on the open issue instead of filing a second one", () => {
		const f = fixture({
			commits: 2,
			openIssues: [{ number: 500, title: TITLE }],
		});
		const out = run(f);
		expect(out).toContain("Commented on #500");

		expect(callOf(f, "create")).toBeUndefined();
		const comment = callOf(f, "comment");
		expect(comment).toBeTruthy();
		const text = (comment as string[]).join("\n");
		expect(text).toContain("500");
		expect(text).toContain("Another red sweep");
	});

	it("matches on the exact title, so another ci-red issue does not absorb it", () => {
		const f = fixture({
			commits: 2,
			openIssues: [{ number: 501, title: "Something else entirely" }],
		});
		const out = run(f);
		expect(out).toContain("Filed");
		expect(callOf(f, "comment")).toBeUndefined();
	});

	it("files nothing where the open issue already names the red run", () => {
		const f = fixture({
			commits: 2,
			openIssues: [{ number: 500, title: TITLE }],
			issue: { body: "", comments: [{ body: `- **Run:** ${RED_URL}` }] },
		});
		expect(run(f)).toContain("already names the newest red sweep");
		expect(callOf(f, "comment")).toBeUndefined();
	});

	it("does not refile a red run older than the newest closed issue", () => {
		const closed = (closedAt: string) =>
			fixture({
				commits: 2,
				closedIssues: [{ number: 400, title: TITLE, closedAt }],
			});
		const after = closed("2026-08-30T00:00:00Z");
		expect(run(after)).toContain("not refiling it");
		expect(callOf(after, "create")).toBeUndefined();
		const before = closed("2026-08-29T00:00:00Z");
		expect(run(before)).toContain("Filed");
	});

	it("looks the open issue up under ci-red, not under urgent", () => {
		const f = fixture({ commits: 2 });
		run(f);
		const list = callOf(f, "list") as string[];
		expect(list).toContain("ci-red");
		expect(list).not.toContain("urgent");
	});
});

describe("sweepStillRed", () => {
	const stillRed = (sweeps: Sweep[]) => {
		const f = fixture({ commits: 1, sweeps });
		const out = execFileSync(
			"node",
			[
				"-e",
				`const s=require(${JSON.stringify(SCRIPT)});console.log(JSON.stringify(s.sweepStillRed()))`,
			],
			{ cwd: f.root, encoding: "utf8", env: f.env },
		);
		return JSON.parse(out);
	};
	const sweep = (id: number, suite: string | null): Sweep => ({
		databaseId: id,
		headSha: "a".repeat(40),
		url: `u${id}`,
		createdAt: `d${id}`,
		suite,
	});

	it("holds while the newest judged suite job is red", () => {
		expect(stillRed([sweep(1, "failure")]).held).toBe(true);
	});

	it("clears once the newest judged suite job is green", () => {
		expect(stillRed([sweep(1, "success")]).held).toBe(false);
	});

	it("clears on a green suite under a red RUN — the filer's own distinction", () => {
		// jobs-1.json carries a failing `documents` job alongside the green suite.
		const f = fixture({ commits: 1, sweeps: [sweep(1, "success")] });
		fs.writeFileSync(
			path.join(f.root, "jobs-1.json"),
			JSON.stringify([
				{ name: "Full suite / Lint", conclusion: "success" },
				{ name: "Document guards", conclusion: "failure" },
			]),
		);
		const out = execFileSync(
			"node",
			[
				"-e",
				`const s=require(${JSON.stringify(SCRIPT)});console.log(JSON.stringify(s.sweepStillRed()))`,
			],
			{ cwd: f.root, encoding: "utf8", env: f.env },
		);
		expect(JSON.parse(out).held).toBe(false);
	});

	it("steps over a cancelled suite job rather than reading it as red", () => {
		expect(stillRed([sweep(1, "cancelled"), sweep(2, "success")]).held).toBe(
			false,
		);
	});

	it("reads an unknown conclusion as red, never as green", () => {
		expect(stillRed([sweep(1, "action_required")]).held).toBe(true);
	});

	it("throws rather than calling the condition cleared when nothing is judged", () => {
		expect(() => stillRed([sweep(1, null)])).toThrow();
	});
});

// No open issue, so any fall-through to the default action would file (#1051).
describe("the command line", () => {
	const runWith = (f: Fixture, args: string[]) => {
		const r = runInProcess(SCRIPT, args, { cwd: f.root, env: f.env });
		return { code: r.status, output: r.stdout + r.stderr };
	};

	it("prints usage on --help and -h, exits 0, and calls gh not at all", () => {
		for (const flag of ["--help", "-h"]) {
			const f = fixture({ commits: 1 });

			const { code, output } = runWith(f, [flag]);
			expect(code).toBe(0);
			expect(output).toContain("usage: node scripts/report-red-suite.js");
			expect(f.ghCalls()).toEqual([]);
		}
	});

	it("refuses an unknown argument, naming it and the usage, exits non-zero, and calls gh not at all", () => {
		const f = fixture({ commits: 1 });

		const { code, output } = runWith(f, ["--dry-run"]);
		expect(code).toBe(2);
		expect(output).toContain("unknown flag: --dry-run");
		expect(output).toContain("usage: node scripts/report-red-suite.js");
		expect(f.ghCalls()).toEqual([]);
	});
});
