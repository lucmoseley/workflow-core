// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshSandbox } from "./lib/arbiter-testkit";
import { GH_FAILING_SCRIPT, stubGhScript } from "./lib/gh-stub";
import { keptSpawn } from "./lib/kept-spawn.js";
import { runInProcess } from "./lib/run-in-process";
import { shellQuote } from "./lib/sh-quote.js";
import { sleepSync } from "./lib/sleep-sync.js";

const SCRIPT = path.join(__dirname, "check-ci-status.js");

const sb = freshSandbox();

const RANGE_REPO = fs.mkdtempSync(path.join(os.tmpdir(), "ci-status-range-"));

const AUTOFIRE_MARKER = path.join(RANGE_REPO, ".git", ".sweep-autofire");

const SHAS: string[] = (() => {
	const g = (args: string[]) =>
		execFileSync("git", args, { encoding: "utf8", cwd: RANGE_REPO }).trim();
	g(["init", "-q", "-b", "main"]);
	g(["config", "user.email", "t@example.invalid"]);
	g(["config", "user.name", "Test"]);
	fs.mkdirSync(path.join(RANGE_REPO, ".github", "workflows"), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(RANGE_REPO, ".github", "workflows", "scheduled-checks.yml"),
		"",
	);
	for (let i = 0; i <= 16; i++) {
		fs.writeFileSync(path.join(RANGE_REPO, `f${i}.txt`), String(i));
		g(["add", "-A"]);
		g(["commit", "-m", `commit number ${i}`]);
	}
	return g(["log", "--format=%H"]).split("\n");
})();

const back = (n: number) => SHAS[n];

const BEHIND_REPO = fs.mkdtempSync(path.join(os.tmpdir(), "ci-status-behind-"));
execFileSync("git", ["clone", "-q", RANGE_REPO, BEHIND_REPO]);
execFileSync("git", ["-C", BEHIND_REPO, "checkout", "-q", "--detach", SHAS[3]]);

const HEAD = back(0);

const OTHER = "0123456789abcdef0123456789abcdef01234567";

let runsFile: string;
let sweepsFile: string;
let workflowsFile: string;
let jobsFile: string;
let issuesFile: string;
let issueArgsFile: string;
let ghArgsFile: string;

const notify = createRequire(__filename)(
	"./lib/notify-report.js",
) as typeof import("./lib/notify-report.js");

const stampPath = () => path.join(notify.base(), "ci-status.notified");

interface Run {
	databaseId: number;
	headSha: string;
	status: string;
	conclusion: string | null;
	workflowName: string;
	event?: string;
	url: string;
	createdAt: string;
	displayTitle?: string;
}

function run_(over: Partial<Run> = {}): Run {
	return {
		databaseId: 100,
		headSha: OTHER,
		status: "completed",
		conclusion: "success",
		workflowName: "CI",
		url: "https://example.invalid/1",
		createdAt: "2026-08-04T12:00:00Z",
		...over,
	};
}

beforeEach(() => {
	runsFile = path.join(sb.dir, "runs.json");
	sweepsFile = path.join(sb.dir, "sweeps.json");
	workflowsFile = path.join(sb.dir, "workflows.json");
	jobsFile = path.join(sb.dir, "jobs.json");
	issuesFile = path.join(sb.dir, "issues.json");
	issueArgsFile = path.join(sb.dir, "issue-args.txt");
	ghArgsFile = path.join(sb.dir, "gh-args.txt");
	fs.rmSync(ghArgsFile, { force: true });
	for (const f of [sweepsFile, workflowsFile, issuesFile])
		fs.writeFileSync(f, "[]");
	fs.rmSync(jobsFile, { force: true });
	fs.rmSync(issueArgsFile, { force: true });
	fs.rmSync(AUTOFIRE_MARKER, { force: true, recursive: true });
	vi.stubEnv(
		"WFC_GH",
		stubGhScript(
			sb.dir,
			"#!/bin/sh\n" +
				`echo "$@" >> ${shellQuote(ghArgsFile)}\n` +
				`[ "$1" = "issue" ] && { echo "$@" >> ${shellQuote(issueArgsFile)}; exec cat ${shellQuote(issuesFile)}; }\n` +
				'for a in "$@"; do\n' +
				`  [ "$a" = "view" ] && exec cat ${shellQuote(jobsFile)}\n` +
				`  [ "$a" = "workflow" ] && exec cat ${shellQuote(workflowsFile)}\n` +
				`  [ "$a" = "--workflow" ] && exec cat ${shellQuote(sweepsFile)}\n` +
				"done\n" +
				`exec cat ${shellQuote(runsFile)}\n`,
		).gh,
	);
});

const setRuns = (runs: Run[]) =>
	fs.writeFileSync(runsFile, JSON.stringify(runs));

const setSweeps = (runs: Partial<Run>[]) =>
	fs.writeFileSync(sweepsFile, JSON.stringify(runs.map((r) => run_(r))));

const setWorkflows = (rows: { name: string; state: string; path: string }[]) =>
	fs.writeFileSync(workflowsFile, JSON.stringify(rows));

const check = (args: string[], env: Record<string, string> = {}) =>
	bare([...args, "--write"], env);
const bare = (args: string[], env: Record<string, string> = {}) =>
	runInProcess(SCRIPT, args, {
		env: { ...process.env, WFC_REPO_DIR: RANGE_REPO, ...env },
		cwd: sb.repo,
	});

const at = (iso: string) => ({ WFC_NOW: iso });

const HATCH_TIME = "2026-08-20T09:30:00Z";
const SWEEP_SOON = "2026-08-20T13:30:00Z";

describe("a red run on the branch is reported (mantahostels#143)", () => {
	it("names the failing workflow and links its run", () => {
		setRuns([
			run_({
				databaseId: 200,
				conclusion: "failure",
				url: "https://example.invalid/200",
			}),
		]);

		const r = check(["--notify"]);
		expect(r.stdout).toContain("CI is red");
		expect(r.stdout).toContain("CI: failure");
		expect(r.stdout).toContain("https://example.invalid/200");
		expect(r.status).toBe(0);
	});

	it("says nothing at all when every run on the newest sha passed", () => {
		setRuns([
			run_({ databaseId: 200, workflowName: "CI" }),
			run_({ databaseId: 201, workflowName: "document-guards" }),
		]);

		const r = check(["--notify"]);
		expect(r.stdout.trim()).toBe("");
		expect(r.status).toBe(0);
	});

	it("reports a conclusion it does not recognise, rather than passing it", () => {
		setRuns([run_({ databaseId: 200, conclusion: "some_new_verdict" })]);

		expect(check(["--notify"]).stdout).toContain("some_new_verdict");
	});

	it("reports a cancelled run nothing superseded as unverified, not as red", () => {
		setRuns([run_({ databaseId: 200, conclusion: "cancelled" })]);

		const r = check(["--notify"]);
		expect(r.stdout).toContain("CI never finished");
		expect(r.stdout).toContain("unverified");
		expect(r.stdout).not.toContain("CI is red");
	});
});

describe("a cancelled run superseded by a newer one carries no verdict", () => {
	it("says nothing when a newer run of the same workflow took over", () => {
		setRuns([
			run_({
				databaseId: 202,
				headSha: HEAD,
				status: "queued",
				conclusion: null,
				createdAt: "2026-08-04T14:00:00Z",
			}),
			run_({
				databaseId: 201,
				headSha: HEAD,
				conclusion: "cancelled",
				createdAt: "2026-08-04T13:00:00Z",
			}),
			run_({ databaseId: 200, createdAt: "2026-08-04T12:00:00Z" }),
		]);

		expect(check(["--notify"]).stdout.trim()).toBe("");
	});

	it("keyed per workflow: another workflow's newer run supersedes nothing", () => {
		setRuns([
			run_({
				databaseId: 201,
				workflowName: "document-guards",
				createdAt: "2026-08-04T13:00:00Z",
			}),
			run_({
				databaseId: 200,
				workflowName: "CI",
				conclusion: "cancelled",
				createdAt: "2026-08-04T12:00:00Z",
			}),
		]);

		expect(check(["--notify"]).stdout).toContain("CI never finished");
	});

	it("passes over a superseded sha rather than reading it as all-clear", () => {
		setRuns([
			run_({
				databaseId: 202,
				headSha: HEAD,
				status: "queued",
				conclusion: null,
				createdAt: "2026-08-04T14:00:00Z",
			}),
			run_({
				databaseId: 201,
				headSha: HEAD,
				conclusion: "cancelled",
				createdAt: "2026-08-04T13:00:00Z",
			}),
			run_({
				databaseId: 200,
				conclusion: "failure",
				createdAt: "2026-08-04T12:00:00Z",
			}),
		]);

		const r = check(["--notify"]);
		expect(r.stdout).toContain("CI is red");
		expect(r.stdout).toContain(OTHER.slice(0, 7));
	});

	it("SKIPs rather than passing when nothing in the window carries a verdict", () => {
		setRuns([
			run_({
				databaseId: 202,
				status: "queued",
				conclusion: null,
				createdAt: "2026-08-04T14:00:00Z",
			}),
			run_({
				databaseId: 201,
				conclusion: "cancelled",
				createdAt: "2026-08-04T13:00:00Z",
			}),
		]);

		const r = check([]);
		expect(r.stderr).toContain("SKIP");
		expect(r.stderr).toContain("outside the 50-run window");
		expect(r.stdout).not.toContain("green");
	});

	it("counts a red run and an unfinished one separately on the same sha", () => {
		setRuns([
			run_({ databaseId: 201, workflowName: "CI", conclusion: "failure" }),
			run_({
				databaseId: 200,
				workflowName: "document-guards",
				conclusion: "cancelled",
			}),
		]);

		const r = check(["--notify"]);
		expect(r.stdout).toContain("1 failing run(s)");
		expect(r.stdout).toContain("1 cancelled run(s) nothing superseded");
	});
});

describe("an unverified run is labelled as one wherever it surfaces", () => {
	it("counts them under their own noun, not as failures", () => {
		setRuns([run_({ databaseId: 200, conclusion: "cancelled" })]);

		expect(check(["--notify"]).stdout).toContain(
			"unverified CI run(s) on main",
		);
	});

	it("tags the finding UNVERIFIED-RUN, so a reader can tell it from a red one", () => {
		setRuns([run_({ databaseId: 200, conclusion: "cancelled" })]);

		const out = JSON.parse(check(["--json"]).stdout);
		expect(out.findings.map((f: { tag: string }) => f.tag)).toEqual([
			"UNVERIFIED-RUN",
		]);
	});

	it("says so when suppressing a repeat, rather than calling it red", () => {
		setRuns([run_({ databaseId: 200, conclusion: "cancelled" })]);
		check(["--notify"]);

		expect(check(["--notify", "--json"]).stdout).toContain(
			"CI never finished on main, already reported",
		);
	});
});

describe("only the newest COMPLETED sha is judged (mantahostels#143)", () => {
	it("ignores a failure that a later, greener commit has superseded", () => {
		setRuns([
			run_({
				databaseId: 300,
				headSha: HEAD,
				createdAt: "2026-08-04T13:00:00Z",
			}),
			run_({
				databaseId: 200,
				conclusion: "failure",
				createdAt: "2026-08-04T12:00:00Z",
			}),
		]);

		expect(check(["--notify"]).stdout.trim()).toBe("");
	});

	it("still reports the last push's failure while the new push is queued", () => {
		setRuns([
			run_({
				databaseId: 300,
				headSha: HEAD,
				status: "queued",
				conclusion: null,
				createdAt: "2026-08-04T13:00:00Z",
			}),
			run_({
				databaseId: 200,
				conclusion: "failure",
				createdAt: "2026-08-04T12:00:00Z",
			}),
		]);

		const r = check(["--notify"]);
		expect(r.stdout).toContain("CI is red");
		expect(r.stdout).toContain(OTHER.slice(0, 7));
	});

	it("warns that the failure is not on your HEAD when it is not", () => {
		setRuns([run_({ databaseId: 200, conclusion: "failure" })]);

		expect(check(["--notify"]).stdout).toContain("Your HEAD is");
	});

	it("does not warn when the failure is on your own HEAD", () => {
		setRuns([
			run_({ databaseId: 200, headSha: back(0), conclusion: "failure" }),
		]);

		expect(check(["--notify"]).stdout).not.toContain("Your HEAD is");
	});
});

describe("--notify reports each failure once (mantahostels#143)", () => {
	it("stays silent about a failure it has already reported", () => {
		setRuns([run_({ databaseId: 200, conclusion: "failure" })]);

		expect(check(["--notify"]).stdout).toContain("CI is red");
		expect(check(["--notify"]).stdout.trim()).toBe("");
	});

	it("speaks up again for a failure newer than the one it reported", () => {
		setRuns([run_({ databaseId: 200, conclusion: "failure" })]);
		expect(check(["--notify"]).stdout).toContain("CI is red");

		setRuns([
			run_({
				databaseId: 400,
				conclusion: "failure",
				createdAt: "2026-08-04T15:00:00Z",
			}),
		]);
		expect(check(["--notify"]).stdout).toContain("CI is red");
	});

	it("stamps only after the report is out, so a lost report is not suppressed", () => {
		setRuns([run_({ databaseId: 200, conclusion: "failure" })]);
		expect(fs.existsSync(stampPath())).toBe(false);

		check(["--notify"]);
		expect(fs.readFileSync(stampPath(), "utf8")).toBe("max:200");
	});

	it("writes no stamp when the report itself could not be written", () => {
		setRuns([run_({ databaseId: 200, conclusion: "failure" })]);
		const full = fs.openSync("/dev/full", "w");

		const r = keptSpawn("fd").spawnSync(
			process.execPath,
			[SCRIPT, "--notify"],
			{
				encoding: "utf8",
				env: { ...process.env, CLAUDE_PROJECT_DIR: sb.repo },
				cwd: sb.repo,
				stdio: ["ignore", full, "pipe"],
			},
		);
		fs.closeSync(full);

		expect(r.status).not.toBe(0);
		expect(fs.existsSync(stampPath())).toBe(false);
	});

	it("writes no stamp at all when there was nothing to report", () => {
		setRuns([run_({ databaseId: 200 })]);

		check(["--notify"]);
		expect(fs.existsSync(stampPath())).toBe(false);
	});

	describe("under persist mode", () => {
		const persist = () => check(["--notify"], { WFC_NOTIFY_PERSIST: "1" });

		it("writes a fresh report on every run, however stamped", () => {
			setRuns([run_({ databaseId: 200, conclusion: "failure" })]);
			check(["--notify"]);
			expect(fs.readFileSync(stampPath(), "utf8")).toBe("max:200");

			for (const _ of [1, 2]) {
				expect(persist().status).toBe(0);
				const report = notify.readReport("ci-status");
				expect(report?.outcome).toBe("FAIL");
				expect(report?.text).toContain("CI is red");
			}
		});

		it("carries the run id instead of stamping with it", () => {
			setRuns([run_({ databaseId: 200, conclusion: "failure" })]);

			persist();

			expect(fs.existsSync(stampPath())).toBe(false);
			expect(notify.readReport("ci-status")?.stamp).toBe("max:200");
		});
	});

	describe("under --recheck (#856)", () => {
		it("reports a red the stamp says was already delivered", () => {
			setRuns([run_({ databaseId: 200, conclusion: "failure" })]);
			check(["--notify"]);

			expect(check(["--notify", "--recheck"]).stdout).toContain("CI is red");
		});

		it("writes no stamp, so the session-start route still reports it", () => {
			setRuns([run_({ databaseId: 200, conclusion: "failure" })]);
			check(["--notify", "--recheck"]);

			expect(fs.existsSync(stampPath())).toBe(false);
			expect(check(["--notify"]).stdout).toContain("CI is red");
		});
	});
});

describe("a check that cannot see CI never claims all-clear (mantahostels#143)", () => {
	it("exits 0 and silently in --notify when GitHub is unreachable", () => {
		stubGhScript(sb.dir, GH_FAILING_SCRIPT);

		const r = check(["--notify"]);
		expect(r.stdout.trim()).toBe("");
		expect(r.status).toBe(0);
	});

	it("says SKIP rather than OK when GitHub is unreachable, run by hand", () => {
		stubGhScript(sb.dir, GH_FAILING_SCRIPT);

		const r = check([]);
		expect(r.stderr).toContain("SKIP");
		expect(r.stderr).not.toContain("OK:");
		expect(r.status).toBe(0);
	});

	it("says BROKEN, not SKIP, when gh fails with no reason given", () => {
		stubGhScript(sb.dir, "#!/bin/sh\nexit 1\n");

		const r = check([]);
		expect(r.stderr).toContain("BROKEN");
		expect(r.stderr).not.toContain("SKIP");
		expect(r.stdout).not.toContain("OK:");
		expect(r.status).toBe(2);
	});

	it("says BROKEN, not SKIP, when a gh call times out (mantahostels#2134)", () => {
		stubGhScript(sb.dir, "#!/bin/sh\nsleep 12\n");

		const r = check([]);
		expect(r.stderr).toContain("BROKEN");
		expect(r.stderr).toContain("ETIMEDOUT");
		expect(r.stderr).not.toContain("SKIP");
		expect(r.status).toBe(2);
	});

	it("still reports a broken check under --notify, where a skip stays quiet", () => {
		stubGhScript(sb.dir, "#!/bin/sh\nexit 1\n");

		const r = check(["--notify"]);
		expect(r.stdout).toContain("BROKEN");
		expect(r.status).toBe(0);
	});

	it("does not read unparseable gh output as a green build", () => {
		fs.writeFileSync(runsFile, "not json at all");

		const r = check([]);
		expect(r.stderr).toContain("BROKEN");
		expect(r.stdout).not.toContain("OK:");
	});

	it("gives every gh() call site a timeout routed through ghTimeout() (mantahostels#2134, mantahostels#2177)", () => {
		const src = fs
			.readFileSync(SCRIPT, "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/(^|\s)\/\/.*$/gm, "");
		const calls = [...src.matchAll(/\bgh\(/g)];
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			const window = src.slice(call.index, call.index + 300);
			expect(window).toMatch(/timeout(:\s*\w+|\s*[,}])/);
		}
	});

	it("never gives a single gh() call more than 8000ms (mantahostels#2134)", () => {
		const src = fs.readFileSync(SCRIPT, "utf8");
		const fn = /function ghTimeout\(deadline\) \{([\s\S]*?)\n\}/.exec(src);
		expect(fn, "no ghTimeout() in check-ci-status.js").not.toBeNull();
		expect((fn as RegExpExecArray)[1]).toMatch(
			/Math\.min\(\s*SWEEP_GH_TIMEOUT_MS,\s*remaining\s*\)/,
		);
		expect(
			createRequire(__filename)("./lib/sweep-ledger.js").SWEEP_GH_TIMEOUT_MS,
		).toBeLessThanOrEqual(8000);
	});
});

describe("run by hand, it is a check with an exit code (mantahostels#143)", () => {
	it("exits 1 and reports on stderr when CI is red", () => {
		setRuns([run_({ databaseId: 200, conclusion: "failure" })]);

		const r = check([]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("CI is red");
	});

	it("exits 0 and says so on stderr when CI is green", () => {
		setRuns([run_({ databaseId: 200 })]);

		const r = check([]);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("CI is green");
	});

	it("ignores the stamp, so a hand run always answers", () => {
		setRuns([run_({ databaseId: 200, conclusion: "failure" })]);

		check(["--notify"]);
		expect(check([]).status).toBe(1);
	});
});

interface Step {
	name: string;
	conclusion: string | null;
}
interface Job {
	name: string;
	conclusion: string | null;
	steps: Step[];
}

function stubRunsAndJobs(jobs: Job[]) {
	fs.writeFileSync(jobsFile, JSON.stringify({ jobs }));
}

describe("the verdict is read off `conclusion`, never off `status` (mantahostels#945)", () => {
	it("reports a run that has concluded while its status still says in_progress", () => {
		setRuns([
			run_({
				databaseId: 200,
				status: "in_progress",
				conclusion: "failure",
				createdAt: "2026-08-04T13:00:00Z",
			}),
			run_({ databaseId: 199, createdAt: "2026-08-04T12:00:00Z" }),
		]);

		expect(check(["--notify"]).stdout).toContain("CI is red");
	});

	it("still passes over a run that has reached no verdict at all", () => {
		setRuns([
			run_({
				databaseId: 300,
				status: "completed",
				conclusion: null,
				createdAt: "2026-08-04T13:00:00Z",
			}),
			run_({
				databaseId: 200,
				conclusion: "failure",
				createdAt: "2026-08-04T12:00:00Z",
			}),
		]);

		expect(check(["--notify"]).stdout).toContain("CI is red");
	});
});

describe("the failing step is named, not just the workflow (mantahostels#945)", () => {
	it("names the job and the step that failed", () => {
		setRuns([run_({ databaseId: 200, conclusion: "failure" })]);
		stubRunsAndJobs([
			{
				name: "Full suite / Lint and tests",
				conclusion: "failure",
				steps: [
					{ name: "Install dependencies", conclusion: "success" },
					{ name: "Biome ci", conclusion: "success" },
					{ name: "Vitest", conclusion: "failure" },
				],
			},
		]);

		expect(check(["--notify"]).stdout).toContain(
			"Full suite / Lint and tests › Vitest",
		);
	});

	it("leaves out the steps cancelled as a consequence of the failing one", () => {
		setRuns([run_({ databaseId: 200, conclusion: "failure" })]);
		stubRunsAndJobs([
			{
				name: "Document guards",
				conclusion: "failure",
				steps: [
					{ name: "Check the doc map", conclusion: "failure" },
					{ name: "Report superseded values", conclusion: "cancelled" },
				],
			},
		]);

		const out = check(["--notify"]).stdout;
		expect(out).toContain("Document guards › Check the doc map");
		expect(out).not.toContain("Report superseded values");
	});

	it("falls back to the job name when no step reached a verdict", () => {
		setRuns([run_({ databaseId: 200, conclusion: "failure" })]);
		stubRunsAndJobs([{ name: "Python", conclusion: "failure", steps: [] }]);

		expect(check(["--notify"]).stdout).toContain("    Python");
	});

	it("says so rather than dying when the step list cannot be read", () => {
		setRuns([run_({ databaseId: 200, conclusion: "failure" })]);

		const r = check(["--notify"]);
		expect(r.stdout).toContain("could not read which step failed");
		expect(r.stdout).toContain("CI is red");
		expect(r.status).toBe(0);
	});
});

const redSuite = createRequire(__filename)(
	"./report-red-suite.js",
) as typeof import("./report-red-suite.js");

describe("a red run says whether an open issue already covers it (#532)", () => {
	const redSweep = (over: Partial<Run> = {}) =>
		setRuns([
			run_({
				databaseId: 200,
				conclusion: "failure",
				workflowName: redSuite.SWEEP_NAME,
				...over,
			}),
		]);
	const suiteJobFailed = (suite = "failure") =>
		stubRunsAndJobs([
			{
				name: `${redSuite.SUITE_JOB} / Lint and tests`,
				conclusion: suite,
				steps: [{ name: "Vitest", conclusion: suite }],
			},
			{ name: "Document guards", conclusion: "success", steps: [] },
		]);
	const setIssues = (rows: { number: number; title: string }[]) =>
		fs.writeFileSync(
			issuesFile,
			JSON.stringify(
				rows.map((r) => ({ ...r, labels: [{ name: redSuite.LABEL }] })),
			),
		);
	const ticket = (answer: string) =>
		`Ticket for ${redSuite.SUITE_JOB}: ${answer}`;

	it("names the open tracking issue, asked for by the filer's own label", () => {
		redSweep();
		suiteJobFailed();
		setIssues([
			{ number: 611, title: "Some other ci-red issue" },
			{ number: 612, title: redSuite.TITLE },
		]);

		const out = check(["--notify"]).stdout;
		expect(out).toContain(ticket("covered by #612"));
		expect(fs.readFileSync(issueArgsFile, "utf8")).toContain(
			`--label ${redSuite.LABEL}`,
		);
	});

	it("names the daily run that files a red no open issue covers (#1963)", () => {
		redSweep();
		suiteJobFailed();
		setIssues([{ number: 611, title: "Some other ci-red issue" }]);

		expect(check(["--notify"]).stdout).toContain(
			ticket(
				"no open issue covers this — the daily repo-checks run files the newest red, unless an issue was closed after it (#1963)",
			),
		);
	});

	describe("where the daily reading shows the filer did not file (#2480)", () => {
		const gitDir = path.join(RANGE_REPO, ".git");
		const manifest = path.join(RANGE_REPO, ".claude-plugin", "plugin.json");
		const reading = path.join(gitDir, ".repo-checks.json");
		const stamp = path.join(gitDir, ".red-suite-fallback");
		const log = path.join(gitDir, ".red-suite-fallback.log");
		const core = () => path.join(sb.dir, "fallback-core");
		const launchedFile = () => path.join(sb.dir, "filer-launched");
		const readAt = "2026-10-23T09:00:00Z";
		const loadFailure =
			"BROKEN: red-suite exited 2: Error: Cannot find module './lib/gone'";

		const setReading = (collectedAt: string, outcome?: string) =>
			fs.writeFileSync(
				reading,
				JSON.stringify({
					collectedAt,
					jobs: outcome
						? [
								{
									job: "red-suite",
									outcome,
									summary:
										outcome === "OK" ? "OK: red-suite exited 0." : loadFailure,
								},
							]
						: [],
				}),
			);
		const filerRan = () => {
			// guess, #2480
			const until = Date.now() + 5000;
			while (
				!fs.existsSync(log) ||
				!fs.readFileSync(log, "utf8").includes("Filed")
			) {
				if (Date.now() > until) return false;
				sleepSync(50);
			}
			return fs.existsSync(launchedFile());
		};
		const checkAt = (iso: string) => {
			fs.rmSync(stampPath(), { force: true });
			return check(["--notify"], { ...at(iso), WFC_SCRIPT_ROOT: core() });
		};

		beforeEach(() => {
			fs.mkdirSync(path.dirname(manifest), { recursive: true });
			fs.writeFileSync(manifest, JSON.stringify({ name: "workflow-core" }));
			fs.mkdirSync(path.join(core(), "scripts"), { recursive: true });
			fs.writeFileSync(
				path.join(core(), "scripts", "report-red-suite.js"),
				`require("node:fs").writeFileSync(${JSON.stringify(launchedFile())}, process.cwd());\nconsole.log("Filed https://example.invalid/issues/9");\n`,
			);
			for (const f of [reading, stamp, log, launchedFile()])
				fs.rmSync(f, { force: true });
			redSweep();
			suiteJobFailed();
		});
		afterEach(() => {
			fs.rmSync(path.dirname(manifest), { recursive: true, force: true });
			for (const f of [reading, stamp, log]) fs.rmSync(f, { force: true });
		});

		it("launches the filer from the host checkout where the reading records it BROKEN, naming the failure", () => {
			setReading("2026-10-23T06:00:00Z", "BROKEN");

			const out = checkAt(readAt).stdout;
			expect(out).toContain(
				ticket(
					`no open issue covers this: the daily reading of 2026-10-23T06:00:00Z recorded ${loadFailure} — filing from here now, in the background; its output lands in ${log} (#2480)`,
				),
			);
			expect(filerRan()).toBe(true);
			expect(fs.readFileSync(launchedFile(), "utf8")).toBe(RANGE_REPO);
		});

		it("launches nothing without --write (#4449)", () => {
			setReading("2026-10-23T06:00:00Z", "BROKEN");
			fs.rmSync(stampPath(), { force: true });

			const out = bare(["--notify"], {
				...at(readAt),
				WFC_SCRIPT_ROOT: core(),
			}).stdout;
			expect(out).toContain(
				ticket(
					"no open issue covers this — `--write` launches the filer where the daily run did not file",
				),
			);
			expect(fs.existsSync(launchedFile())).toBe(false);
		});

		it("launches it at most once a run, however many red runs name the suite job", () => {
			setReading("2026-10-23T06:00:00Z", "MISSING");
			setSweeps([
				{
					databaseId: 200,
					conclusion: "failure",
					workflowName: redSuite.SWEEP_NAME,
					createdAt: "2026-10-23T08:00:00Z",
				},
			]);

			const out = checkAt(readAt).stdout;
			expect(out).toContain("filing from here now");
			expect(out).not.toContain("left no open issue");
			expect(filerRan()).toBe(true);
		});

		it("shows the last launch's last line, and launches nothing, inside the hour after it", () => {
			setReading("2026-10-23T06:00:00Z", "BROKEN");
			checkAt(readAt);
			expect(filerRan()).toBe(true);
			fs.rmSync(launchedFile());

			const out = checkAt("2026-10-23T09:30:00Z").stdout;
			expect(out).toContain(
				`the filer launched from here at 2026-10-23T09:00:00.000Z left no open issue; its last line: Filed https://example.invalid/issues/9 (${log})`,
			);
			expect(fs.existsSync(launchedFile())).toBe(false);
		});

		it("launches it where no reading exists, or where the reading is over a day and a half old", () => {
			expect(checkAt(readAt).stdout).toContain(
				"no daily repo-checks reading exists — filing from here now",
			);
			expect(filerRan()).toBe(true);

			fs.rmSync(stamp);
			setReading("2026-10-21T20:00:00Z", "OK");
			expect(checkAt(readAt).stdout).toContain(
				"the daily repo-checks reading is stale (collected 2026-10-21T20:00:00Z) — filing from here now",
			);
			expect(filerRan()).toBe(true);
		});

		it("leaves filing to the daily run where its fresh reading records the filer OK", () => {
			setReading("2026-10-22T06:00:00Z", "OK");

			expect(checkAt(readAt).stdout).toContain(
				ticket(
					"no open issue covers this — the daily repo-checks run files the newest red, unless an issue was closed after it (#1963)",
				),
			);
			expect(fs.existsSync(stamp)).toBe(false);
		});

		it("launches nothing where an open issue covers the red", () => {
			setReading("2026-10-23T06:00:00Z", "BROKEN");
			setIssues([{ number: 612, title: redSuite.TITLE }]);

			expect(checkAt(readAt).stdout).toContain(ticket("covered by #612"));
			expect(fs.existsSync(stamp)).toBe(false);
		});
	});

	it("reads the runs from the code repo, not gh's default, which is the tracker (#1963)", () => {
		redSweep();
		suiteJobFailed();

		fs.mkdirSync(path.join(sb.repo, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(sb.repo, ".claude", "workflow-core.json"),
			JSON.stringify({ tracker: "o/tracker", codeRepo: "o/code" }),
		);
		check(["--notify"], { CLAUDE_PROJECT_DIR: sb.repo });
		const runCalls = fs
			.readFileSync(ghArgsFile, "utf8")
			.split("\n")
			.filter((l) => l.startsWith("run "));
		expect(runCalls.length).toBeGreaterThan(0);
		for (const call of runCalls) expect(call).toContain("--repo o/code");
	});

	it("says no filer covers a red in any other job, and asks the tracker nothing", () => {
		redSweep();
		stubRunsAndJobs([
			{
				name: "Document guards",
				conclusion: "failure",
				steps: [{ name: "Check the doc map", conclusion: "failure" }],
			},
		]);

		expect(check(["--notify"]).stdout).toContain(
			"Ticket for Document guards: no filer covers this job",
		);
		expect(fs.existsSync(issueArgsFile)).toBe(false);
	});

	it("asks no ticket of the Suite passed aggregate, whose red restates another job's (#2414)", () => {
		redSweep();
		stubRunsAndJobs([
			{
				name: "Document guards",
				conclusion: "failure",
				steps: [{ name: "Check the doc map", conclusion: "failure" }],
			},
			{
				name: "Suite passed",
				conclusion: "failure",
				steps: [{ name: "Run", conclusion: "failure" }],
			},
		]);

		const out = check(["--notify"]).stdout;
		expect(out).toContain(
			"Ticket for Document guards: no filer covers this job",
		);
		expect(out).not.toContain("Ticket for Suite passed");
	});

	it("says no filer covers a Full suite job in a workflow the filer never runs in", () => {
		redSweep({ workflowName: "CI" });
		suiteJobFailed();

		expect(check(["--notify"]).stdout).toContain(
			`Ticket for ${redSuite.SUITE_JOB} / Lint and tests: no filer covers this job`,
		);
	});

	it("says none will be filed where the filer reads the suite job as no verdict", () => {
		redSweep();
		suiteJobFailed("stale");

		expect(check(["--notify"]).stdout).toContain(
			ticket(
				"none will be filed — the filer reads this job as carrying no verdict",
			),
		);
		expect(fs.existsSync(issueArgsFile)).toBe(false);
	});

	it("says it could not ask, rather than uncovered, when the tracker will not answer", () => {
		redSweep();
		suiteJobFailed();
		fs.writeFileSync(issuesFile, "not json");

		const r = check(["--notify"]);
		expect(r.stdout).toContain(
			ticket("could not ask the tracker whether an open issue covers this"),
		);
		expect(r.status).toBe(0);
	});

	it("says it cannot tell, rather than nothing, when the job list cannot be read", () => {
		redSweep();

		const r = check(["--notify"]);
		expect(r.stdout).toContain(
			"Ticket: could not read which job failed, so cannot say whether an issue covers it",
		);
		expect(r.status).toBe(0);
	});
});

describe("the commit range back to the last green run (mantahostels#945)", () => {
	it("counts the commits and lists each one with its files", () => {
		const bad = back(0);
		const good = back(3);
		setRuns([
			run_({
				databaseId: 300,
				headSha: bad,
				conclusion: "failure",
				createdAt: "2026-08-04T13:00:00Z",
			}),
			run_({
				databaseId: 200,
				headSha: good,
				conclusion: "success",
				createdAt: "2026-08-04T12:00:00Z",
			}),
		]);

		const out = check(["--notify"]).stdout;
		expect(out).toContain("3 commit(s) since the last green run");
		expect(out).toContain(`${good.slice(0, 7)}..${bad.slice(0, 7)}`);
		expect(out).toContain(back(1).slice(0, 7));
	});

	it("hands over the bisect command, with full shas on both ends", () => {
		const bad = back(0);
		const good = back(3);
		setRuns([
			run_({
				databaseId: 300,
				headSha: bad,
				conclusion: "failure",
				createdAt: "2026-08-04T13:00:00Z",
			}),
			run_({
				databaseId: 200,
				headSha: good,
				conclusion: "success",
				createdAt: "2026-08-04T12:00:00Z",
			}),
		]);

		expect(check(["--notify"]).stdout).toContain(
			`gh workflow run bisect.yml -f good=${good} -f bad=${bad}`,
		);
	});

	it("takes the last green of the SAME workflow, not of any workflow", () => {
		const bad = back(0);
		setRuns([
			run_({
				databaseId: 300,
				headSha: bad,
				workflowName: "scheduled-checks",
				conclusion: "failure",
				createdAt: "2026-08-04T14:00:00Z",
			}),
			run_({
				databaseId: 250,
				headSha: back(1),
				workflowName: "Dependency Graph",
				conclusion: "success",
				createdAt: "2026-08-04T13:00:00Z",
			}),
			run_({
				databaseId: 200,
				headSha: back(3),
				workflowName: "scheduled-checks",
				conclusion: "success",
				createdAt: "2026-08-04T12:00:00Z",
			}),
		]);

		expect(check(["--notify"]).stdout).toContain(
			"3 commit(s) since the last green run",
		);
	});

	it("says there is nothing to bisect when the range is empty", () => {
		setRuns([
			run_({
				databaseId: 300,
				headSha: back(0),
				conclusion: "failure",
				createdAt: "2026-08-04T13:00:00Z",
			}),
			run_({
				databaseId: 200,
				headSha: back(0),
				conclusion: "success",
				createdAt: "2026-08-04T12:00:00Z",
			}),
		]);

		const out = check(["--notify"]).stdout;
		expect(out).toContain("No commits between the last green run");
		expect(out).toContain("flakiness");
	});

	it("names the query for the green sha when none is inside the window", () => {
		setRuns([
			run_({ databaseId: 200, headSha: back(0), conclusion: "failure" }),
		]);

		const out = check(["--notify"]).stdout;
		expect(out).toContain("No green CI run inside the last 50");
		expect(out).toContain("--status success --limit 1 --json headSha");
	});

	it("quotes a workflow name the shell would split in that query", () => {
		setRuns([
			run_({
				databaseId: 200,
				headSha: back(0),
				conclusion: "failure",
				workflowName: "Nightly CI",
			}),
		]);

		expect(check(["--notify"]).stdout).toContain("--workflow 'Nightly CI' ");
	});

	it.each([
		["absent", undefined],
		["empty", ""],
	])(
		"reports a culprit whose workflow name is %s without naming one (#3976)",
		(_, workflowName) => {
			setRuns([
				run_({
					databaseId: 200,
					headSha: back(0),
					conclusion: "failure",
					workflowName,
				}),
			]);

			const r = check(["--notify"]);
			expect(r.status).toBe(0);
			expect(r.stdout).not.toContain("undefined");
			expect(r.stdout).not.toContain("--workflow");
			expect(r.stdout).toContain("  unnamed workflow: failure\n");
			expect(r.stdout).toContain(
				"No green run of this unnamed workflow inside the last 50",
			);
			expect(r.stdout).toContain("--status success --limit 1 --json headSha");
		},
	);

	it("calls a nameless run unnamed in its finding and its verdict line (#3976)", () => {
		setRuns([
			run_({
				databaseId: 200,
				headSha: back(0),
				conclusion: "failure",
				workflowName: "",
			}),
		]);
		const red = check(["--json"]);
		expect(red.status).toBe(1);
		expect(red.stdout).toContain(
			"unnamed workflow: failure — https://example.invalid/1",
		);

		setRuns([run_({ databaseId: 200, headSha: back(0), workflowName: "" })]);
		const green = check([]);
		expect(green.status).toBe(0);
		expect(green.stderr).toContain(": unnamed workflow success");
	});

	it("reports a range it cannot read rather than claiming there is none", () => {
		setRuns([
			run_({
				databaseId: 300,
				headSha: back(0),
				conclusion: "failure",
				createdAt: "2026-08-04T13:00:00Z",
			}),
			run_({
				databaseId: 200,
				headSha: OTHER,
				conclusion: "success",
				createdAt: "2026-08-04T12:00:00Z",
			}),
		]);

		const out = check(["--notify"]).stdout;
		expect(out).toContain("Commit range unavailable");
		expect(out).toContain("git fetch origin");
	});

	it("does not print a range at all when the only fault is an unverified run", () => {
		setRuns([run_({ databaseId: 200, conclusion: "cancelled" })]);

		const out = check(["--notify"]).stdout;
		expect(out).toContain("CI never finished");
		expect(out).not.toContain("since the last green run");
		expect(out).not.toContain("gh workflow run bisect.yml");
	});
});

describe("where your own tree sits relative to the run (mantahostels#945)", () => {
	it("counts the commits of yours the run never tested", () => {
		setRuns([
			run_({ databaseId: 200, headSha: back(2), conclusion: "failure" }),
		]);

		expect(check(["--notify"]).stdout).toContain(
			"2 commit(s) after this run, which it never tested",
		);
	});
});

describe("the bisect is offered only where it could tell you something (mantahostels#945)", () => {
	const redOver = (good: string, bad: string) =>
		setRuns([
			run_({
				databaseId: 300,
				headSha: bad,
				conclusion: "failure",
				createdAt: "2026-08-04T13:00:00Z",
			}),
			run_({
				databaseId: 200,
				headSha: good,
				conclusion: "success",
				createdAt: "2026-08-04T12:00:00Z",
			}),
		]);

	it("does not offer one for a single commit, which the range already names", () => {
		redOver(back(1), back(0));

		const out = check(["--notify"]).stdout;
		expect(out).toContain("1 commit(s) since the last green run");
		expect(out).not.toContain("gh workflow run bisect.yml");
	});

	it("offers one, plainly, for a range short enough to still read", () => {
		redOver(back(4), back(0));

		const out = check(["--notify"]).stdout;
		expect(out).toContain("Name the commit by bisect:");
		expect(out).not.toContain("Too many to read?");
	});

	it("leads with 'too many to read' once the range is long", () => {
		redOver(back(12), back(0));

		const out = check(["--notify"]).stdout;
		expect(out).toContain("Too many to read? Name the commit:");
		expect(out).toContain("gh workflow run bisect.yml");
	});

	it("still offers one when the range itself could not be read", () => {
		redOver(OTHER, back(0));

		const out = check(["--notify"]).stdout;
		expect(out).toContain("Commit range unavailable");
		expect(out).toContain("gh workflow run bisect.yml");
	});
});

describe("a red Test file CI times job routes to cut tickets, not a bisect (#4362)", () => {
	const fileTimes = {
		name: "Test file CI times",
		conclusion: "failure",
		steps: [{ name: "Judge the last three sweeps", conclusion: "failure" }],
	};
	const verdict = {
		name: "Suite passed",
		conclusion: "failure",
		steps: [{ name: "Run", conclusion: "failure" }],
	};
	const redSweepOver = () =>
		setRuns([
			run_({
				databaseId: 300,
				headSha: back(0),
				workflowName: redSuite.SWEEP_NAME,
				conclusion: "failure",
				createdAt: "2026-08-04T13:00:00Z",
			}),
			run_({
				databaseId: 200,
				headSha: back(3),
				workflowName: redSuite.SWEEP_NAME,
				conclusion: "success",
				createdAt: "2026-08-04T12:00:00Z",
			}),
		]);

	it("names the per-file cut route and prints no bisect range where it is the only red", () => {
		redSweepOver();
		stubRunsAndJobs([fileTimes, verdict]);

		const out = check(["--notify"]).stdout;
		expect(out).toContain(
			"Ticket for Test file CI times: each file over the limit is cut under its own profiled ticket (a sub-issue of #2729)",
		);
		expect(out).not.toContain("no filer covers this job");
		expect(out).toContain("No bisect: each red job judges medians");
		expect(out).not.toContain("since the last green run");
		expect(out).not.toContain("gh workflow run bisect.yml");
	});

	it("routes a red Suite growth budget to cuts, with no bisect, beside the per-file job (#5137)", () => {
		redSweepOver();
		stubRunsAndJobs([
			fileTimes,
			{ ...fileTimes, name: "Suite growth budget" },
			verdict,
		]);

		const out = check(["--notify"]).stdout;
		expect(out).toContain(
			"Ticket for Suite growth budget: the slowest files are cut by measured cost (a sub-issue of #2729)",
		);
		expect(out).not.toContain("no filer covers this job");
		expect(out).toContain("No bisect: each red job judges medians");
	});

	it("still prints the bisect range where the suite is red as well", () => {
		redSweepOver();
		stubRunsAndJobs([
			{
				name: `${redSuite.SUITE_JOB} / Lint and tests`,
				conclusion: "failure",
				steps: [{ name: "Vitest", conclusion: "failure" }],
			},
			fileTimes,
			verdict,
		]);

		const out = check(["--notify"]).stdout;
		expect(out).toContain("3 commit(s) since the last green run");
		expect(out).toContain(
			`gh workflow run bisect.yml -f good=${back(3)} -f bad=${back(0)}`,
		);
		expect(out).not.toContain("No bisect:");
	});

	it("bisects another workflow's red at the same sha, though the newer sweep is red on file times alone", () => {
		setRuns([
			run_({
				databaseId: 400,
				headSha: back(0),
				workflowName: redSuite.SWEEP_NAME,
				conclusion: "failure",
				createdAt: "2026-08-04T14:00:00Z",
			}),
			run_({
				databaseId: 300,
				headSha: back(0),
				conclusion: "failure",
				createdAt: "2026-08-04T13:00:00Z",
			}),
			run_({
				databaseId: 200,
				headSha: back(3),
				conclusion: "success",
				createdAt: "2026-08-04T12:00:00Z",
			}),
		]);
		stubRunsAndJobs([fileTimes, verdict]);

		const out = check(["--notify"]).stdout;
		expect(out).toContain(
			`gh workflow run bisect.yml -f good=${back(3)} -f bad=${back(0)}`,
		);
		expect(out).not.toContain("No bisect:");
	});
});

describe("the trigger is named alongside the verdict (mantahostels#945)", () => {
	it("marks a scheduled sweep as one, so the range is read as covering it", () => {
		setRuns([
			run_({ databaseId: 200, conclusion: "failure", event: "schedule" }),
		]);

		expect(check(["--notify"]).stdout).toContain("CI: failure (schedule)");
	});

	it("says nothing extra when gh reported no event", () => {
		setRuns([run_({ databaseId: 200, conclusion: "failure" })]);

		expect(check(["--notify"]).stdout).toContain("CI: failure\n");
	});
});

describe("a workflow that does not verify the tree cannot key the report (mantahostels#945)", () => {
	it("does not let a newer bisect run report green over a red sweep", () => {
		setRuns([
			run_({
				databaseId: 400,
				headSha: back(0),
				workflowName: "bisect",
				conclusion: "success",
				createdAt: "2026-08-04T15:00:00Z",
			}),
			run_({
				databaseId: 300,
				headSha: back(2),
				workflowName: "scheduled-checks",
				conclusion: "failure",
				createdAt: "2026-08-04T13:00:00Z",
			}),
		]);

		const out = check(["--notify"]).stdout;
		expect(out).toContain("CI is red");
		expect(out).toContain("scheduled-checks: failure");
	});

	it("passes over Dependency Graph, which GitHub runs on its own", () => {
		setRuns([
			run_({
				databaseId: 400,
				headSha: back(0),
				workflowName: "Dependency Graph",
				conclusion: "success",
				createdAt: "2026-08-04T15:00:00Z",
			}),
			run_({
				databaseId: 300,
				headSha: back(2),
				workflowName: "scheduled-checks",
				conclusion: "failure",
				createdAt: "2026-08-04T13:00:00Z",
			}),
		]);

		expect(check(["--notify"]).stdout).toContain("CI is red");
	});

	it("does not aim a bisect at a red issue-card-drift, which never ran the suite", () => {
		setRuns([
			run_({
				databaseId: 400,
				headSha: back(0),
				workflowName: "issue-card-drift",
				conclusion: "failure",
				createdAt: "2026-08-04T15:00:00Z",
			}),
			run_({
				databaseId: 300,
				headSha: back(2),
				workflowName: "scheduled-checks",
				conclusion: "success",
				createdAt: "2026-08-04T13:00:00Z",
			}),
		]);

		const r = check(["--notify"]);
		expect(r.stdout.trim()).toBe("");
		expect(r.status).toBe(0);
	});

	it.each(["Named rerun", "Landing quiet 14h", "Queue ref waiting 2h"])(
		"reports green off CI over a newer red %s at main's sha (#4676)",
		(workflowName) => {
			setRuns([
				run_({
					databaseId: 400,
					headSha: back(0),
					workflowName,
					conclusion: "failure",
					createdAt: "2026-08-04T15:00:00Z",
				}),
				run_({
					databaseId: 300,
					headSha: back(0),
					workflowName: "CI",
					conclusion: "success",
					createdAt: "2026-08-04T13:00:00Z",
				}),
			]);
			stubRunsAndJobs([
				{
					name: "Named files",
					conclusion: "failure",
					steps: [{ name: "Run the named files", conclusion: "failure" }],
				},
			]);

			const r = check(["--notify"]);
			expect(r.stdout.trim()).toBe("");
			expect(r.status).toBe(0);
		},
	);

	it("lists only CI's failure when a red Named rerun shares its sha (#4676)", () => {
		setRuns([
			run_({
				databaseId: 400,
				headSha: back(0),
				workflowName: "Named rerun",
				conclusion: "failure",
				createdAt: "2026-08-04T15:00:00Z",
			}),
			run_({
				databaseId: 300,
				headSha: back(0),
				workflowName: "CI",
				conclusion: "failure",
				createdAt: "2026-08-04T13:00:00Z",
			}),
		]);

		const out = check(["--notify"]).stdout;
		expect(out).toContain("CI: failure");
		expect(out).not.toContain("Named rerun");
	});

	it("reports a workflow it has never heard of, rather than ignoring it", () => {
		setRuns([
			run_({
				databaseId: 400,
				headSha: back(0),
				workflowName: "some-new-workflow",
				conclusion: "failure",
			}),
		]);

		expect(check(["--notify"]).stdout).toContain("some-new-workflow: failure");
	});

	it("falls back to the denylisted runs rather than claiming green over nothing", () => {
		setRuns([
			run_({
				databaseId: 400,
				headSha: back(0),
				workflowName: "bisect",
				conclusion: "failure",
			}),
		]);

		expect(check(["--notify"]).stdout).toContain("CI is red");
	});
});

describe("the green path says what the last sweep actually covered (mantahostels#976)", () => {
	it("names the run, its trigger and its age instead of a bare sha", () => {
		setRuns([
			run_({
				databaseId: 200,
				headSha: back(3),
				event: "schedule",
				createdAt: "2026-08-20T11:00:00Z",
			}),
		]);

		const r = check([], at("2026-08-20T14:12:00Z"));
		expect(r.stderr).toContain("CI success (schedule)");
		expect(r.stderr).toContain("3h 12m ago");
		expect(r.status).toBe(0);
	});

	it("states how many commits the run never tested", () => {
		setRuns([run_({ databaseId: 200, headSha: back(5) })]);

		const out = check([], at(HATCH_TIME)).stderr;
		expect(out).toContain("5 commit(s) after this run, which it never tested");
		expect(out).toContain("5 commit(s) behind your HEAD");
	});

	it("says nothing about coverage when the run tested HEAD itself", () => {
		setRuns([run_({ databaseId: 200, headSha: back(0) })]);

		const r = check([], at(HATCH_TIME));
		expect(r.stderr).not.toContain("Your HEAD is");
		expect(r.stderr).toContain("CI is green");
	});

	it("stays silent at session start even when HEAD is uncovered (mantahostels#949 decision 2)", () => {
		setRuns([run_({ databaseId: 200, headSha: back(3) })]);

		const r = check(["--notify"], at(HATCH_TIME));
		expect(r.stdout.trim()).toBe("");
		expect(r.status).toBe(0);
	});
});

describe("how long HEAD stays untested is reported, never offered (mantahostels#976, mantahostels#2203)", () => {
	it("says how far off the next sweep is, and offers no command for it", () => {
		setRuns([run_({ databaseId: 200, headSha: back(3) })]);

		const out = check([], at(HATCH_TIME)).stderr;
		expect(out).toContain("Nothing has tested HEAD");
		expect(out).toContain("15:00 UTC");
		expect(out).not.toContain("gh workflow run scheduled-checks.yml");
	});

	it("withholds the report when the next sweep is less than two hours away", () => {
		setRuns([run_({ databaseId: 200, headSha: back(3) })]);

		expect(check([], at(SWEEP_SOON)).stderr).not.toContain(
			"Nothing has tested HEAD",
		);
	});

	it("withholds it when HEAD is already covered", () => {
		setRuns([run_({ databaseId: 200, headSha: back(0) })]);

		expect(check([], at(HATCH_TIME)).stderr).not.toContain(
			"Nothing has tested HEAD",
		);
	});

	it("holds the same sweep schedule the workflow it points at does", () => {
		const workflow = fs.readFileSync(
			path.join(
				__dirname,
				"..",
				".github",
				"workflows",
				"scheduled-checks.yml",
			),
			"utf8",
		);
		const cron = /cron:\s*"0\s+([\d,]+)\s+\*\s+\*\s+\*"/.exec(workflow);
		expect(
			cron,
			'no `cron: "0 <hours> * * *"` in scheduled-checks.yml',
		).not.toBeNull();

		const declared = /const SWEEP_HOURS_UTC = \[([\d,\s]+)\];/.exec(
			fs.readFileSync(path.join(__dirname, "lib", "sweep-ledger.js"), "utf8"),
		);
		expect(
			declared,
			"no SWEEP_HOURS_UTC in lib/sweep-ledger.js",
		).not.toBeNull();

		expect((declared as RegExpExecArray)[1].split(",").map(Number)).toEqual(
			(cron as RegExpExecArray)[1].split(",").map(Number),
		);
	});
});

describe("the green report's edges (mantahostels#976)", () => {
	it("rolls over to the next day's first sweep after the last one of today", () => {
		setRuns([run_({ databaseId: 200, headSha: back(3) })]);

		const out = check([], at("2026-08-20T22:00:00Z")).stderr;
		expect(out).toContain("03:00 UTC");
		expect(out).toContain("5h 0m away");
	});

	it("says the age is unreadable rather than inventing one", () => {
		setRuns([
			run_({ databaseId: 200, headSha: back(0), createdAt: "not a date" }),
		]);

		const r = check([], at(HATCH_TIME));
		expect(r.stderr).toContain("age unreadable");
		expect(r.stderr).toContain("undated verdict");
		expect(r.status).toBe(0);
	});

	it("gives a sweep older than a day in days and hours", () => {
		setRuns([
			run_({
				databaseId: 200,
				headSha: back(0),
				createdAt: "2026-08-17T08:30:00Z",
			}),
		]);

		expect(check([], at("2026-08-20T12:30:00Z")).stderr).toContain("3d 4h ago");
	});

	it("tells you to fetch when the run is AHEAD of your HEAD", () => {
		setRuns([run_({ databaseId: 200, headSha: back(0) })]);

		const r = runInProcess(SCRIPT, [], {
			env: { ...process.env, WFC_REPO_DIR: BEHIND_REPO, ...at(HATCH_TIME) },
			cwd: sb.repo,
		});
		expect(r.stderr).toContain("3 commit(s) behind this run");
		expect(r.stderr).toContain("Fetch before chasing it");
		expect(r.stderr).not.toContain("Nothing has tested HEAD");
	});

	it("withholds the untested report when it cannot tell what HEAD is", () => {
		setRuns([run_({ databaseId: 200, headSha: OTHER })]);

		const out = check([], at(HATCH_TIME)).stderr;
		expect(out).toContain("which is not the sha this run tested");
		expect(out).not.toContain("Nothing has tested HEAD");
	});

	it("does not read a broken git as a covered HEAD", () => {
		const notARepo = fs.mkdtempSync(
			path.join(os.tmpdir(), "ci-status-norepo-"),
		);
		setRuns([run_({ databaseId: 200, headSha: back(3) })]);

		const r = runInProcess(SCRIPT, [], {
			env: { ...process.env, WFC_REPO_DIR: notARepo, ...at(HATCH_TIME) },
			cwd: sb.repo,
		});
		expect(r.stderr).not.toContain("on your HEAD");
		expect(r.stderr).toContain(`at ${back(3).slice(0, 7)}`);
		expect(r.stderr).not.toContain("Nothing has tested HEAD");
	});

	it("refuses to run on an injected clock it cannot parse, naming WFC_NOW", () => {
		setRuns([run_({ databaseId: 200, headSha: back(3) })]);

		const r = check([], at("half past tuesday"));
		expect(r.stderr).toContain("WFC_NOW is not a date");
		expect(r.status).toBe(2);
	});
});

const SWEEP_NOW = "2026-08-21T21:30:00Z";
const slot = (hm: string) => `2026-08-21T${hm}:00Z`;

const sweepAt = (hm: string, over: Partial<Run> = {}) => ({
	workflowName: "scheduled-checks",
	event: "schedule",
	headSha: back(3),
	createdAt: slot(hm),
	...over,
});

const ACTIVE = [
	{
		name: "scheduled-checks",
		state: "active",
		path: ".github/workflows/scheduled-checks.yml",
	},
	{ name: "CI", state: "active", path: ".github/workflows/ci.yml" },
];

describe("a scheduled sweep that never fired is reported (mantahostels#1024)", () => {
	beforeEach(() => {
		setRuns([run_({ databaseId: 200, headSha: back(3) })]);
		setWorkflows(ACTIVE);
	});

	it("counts the missed slots and names each one", () => {
		setSweeps([sweepAt("03:00")]);

		const out = check(["--notify"], at(SWEEP_NOW)).stdout;
		expect(out).toContain("2 of 3 slots in the last 24h produced no run");
		expect(out).toContain("missed 09:00 UTC, 15:00 UTC");
	});

	it("says the workflow is still active, so the reader reads it as a drop", () => {
		setSweeps([sweepAt("03:00")]);

		expect(check(["--notify"], at(SWEEP_NOW)).stdout).toContain(
			"scheduled-checks.yml reads `active` — GitHub dropped queued runs",
		);
	});

	it("tells 3 of 3 from a partial miss, which need opposite responses", () => {
		setSweeps([sweepAt("03:00", { createdAt: "2026-08-20T03:00:00Z" })]);

		expect(check(["--notify"], at(SWEEP_NOW)).stdout).toContain(
			"3 of 3 slots in the last 24h produced no run",
		);
	});

	it("names the newest sweep, its age and how far HEAD has moved past it", () => {
		setSweeps([sweepAt("03:00"), sweepAt("09:00")]);

		const out = check(["--notify"], at(SWEEP_NOW)).stdout;
		expect(out).toContain("newest sweep 09:00 UTC, 12h 30m ago");
		expect(out).toContain("3 commit(s) behind your HEAD");
	});

	it("keeps quiet when every slot fired", () => {
		setSweeps([
			sweepAt("03:00"),
			sweepAt("09:00"),
			sweepAt("15:00"),
			sweepAt("21:00"),
		]);

		const r = check(["--notify"], at(SWEEP_NOW));
		expect(r.stdout.trim()).toBe("");
		expect(r.status).toBe(0);
	});
});

describe("the grace period, and a run that was merely late (mantahostels#1024)", () => {
	beforeEach(() => {
		setRuns([run_({ databaseId: 200, headSha: back(3) })]);
		setWorkflows(ACTIVE);
	});

	const filledBefore15 = () =>
		setSweeps([
			sweepAt("21:00", { createdAt: "2026-08-20T21:00:00Z" }),
			sweepAt("03:00"),
			sweepAt("09:00"),
		]);

	it("says nothing about a slot that has only just passed", () => {
		filledBefore15();

		const r = check(["--notify"], at("2026-08-21T15:30:00Z"));
		expect(r.stdout.trim()).toBe("");
	});

	it("holds a slot two hours past unjudged", () => {
		filledBefore15();

		expect(
			check(["--notify"], at("2026-08-21T17:00:00Z")).stdout,
		).not.toContain("missed 15:00 UTC");
	});

	it("reports the same slot once the grace has run out", () => {
		filledBefore15();

		expect(check(["--notify"], at("2026-08-21T20:01:00Z")).stdout).toContain(
			"missed 15:00 UTC",
		);
	});

	it("counts a late run as having filled its slot, not as a miss", () => {
		setSweeps([
			sweepAt("03:00"),
			sweepAt("09:37"),
			sweepAt("15:00"),
			sweepAt("21:00"),
		]);

		expect(check(["--notify"], at(SWEEP_NOW)).stdout.trim()).toBe("");
	});

	it("counts one late by almost a whole slot as having filled its slot too", () => {
		setSweeps([
			sweepAt("08:59"),
			sweepAt("09:00"),
			sweepAt("15:00"),
			sweepAt("21:00"),
		]);

		expect(check(["--notify"], at(SWEEP_NOW)).stdout.trim()).toBe("");
	});

	it("judges only the last 24h, not every slot since the last green", () => {
		setSweeps([sweepAt("03:00", { createdAt: "2026-08-14T03:00:00Z" })]);

		expect(check(["--notify"], at(SWEEP_NOW)).stdout).toContain("3 of 3 slots");
	});

	it("judges all four slots once the newest clears the grace", () => {
		setSweeps([sweepAt("03:00", { createdAt: "2026-08-14T03:00:00Z" })]);

		expect(check(["--notify"], at("2026-08-22T02:30:00Z")).stdout).toContain(
			"4 of 4 slots",
		);
	});
});

describe("a workflow GitHub has disabled outright (mantahostels#1024)", () => {
	beforeEach(() => setRuns([run_({ databaseId: 200, headSha: back(3) })]));

	it("says no sweep will fire again, and how to re-enable it", () => {
		setWorkflows([
			{
				name: "scheduled-checks",
				state: "disabled_inactivity",
				path: ".github/workflows/scheduled-checks.yml",
			},
		]);
		setSweeps([sweepAt("03:00"), sweepAt("09:00")]);

		const out = check(["--notify"], at(SWEEP_NOW)).stdout;
		expect(out).toContain(
			"scheduled-checks.yml is disabled_inactivity — no sweep will fire again",
		);
		expect(out).toContain("gh workflow enable scheduled-checks.yml");
		expect(out).toContain("Newest sweep 09:00 UTC");
	});

	it("does not also report the slots that stopping it caused to be missed", () => {
		setWorkflows([
			{
				name: "scheduled-checks",
				state: "disabled_inactivity",
				path: ".github/workflows/scheduled-checks.yml",
			},
		]);
		setSweeps([sweepAt("03:00"), sweepAt("09:00")]);

		const out = check(["--notify"], at(SWEEP_NOW)).stdout;
		expect(out).not.toContain("slots in the last 24h produced no run");
		expect(out).not.toContain("gh workflow run scheduled-checks.yml");
	});

	it("reports any other workflow that is not active, on one call", () => {
		setWorkflows([
			...ACTIVE,
			{
				name: "issue-card-drift",
				state: "disabled_manually",
				path: ".github/workflows/issue-card-drift.yml",
			},
		]);
		setSweeps([
			sweepAt("03:00"),
			sweepAt("09:00"),
			sweepAt("15:00"),
			sweepAt("21:00"),
		]);

		const out = check(["--notify"], at(SWEEP_NOW)).stdout;
		expect(out).toContain("issue-card-drift.yml is disabled_manually");
		expect(out).toContain("gh workflow enable issue-card-drift.yml");
	});

	it("asks with --all, without which a disabled workflow is simply absent", () => {
		const argvFile = path.join(sb.dir, "argv.txt");
		vi.stubEnv(
			"WFC_GH",
			stubGhScript(
				sb.dir,
				`#!/bin/sh\necho "$@" >> ${shellQuote(argvFile)}\nfor a in "$@"; do\n  [ "$a" = "workflow" ] && exec echo '[]'\n  [ "$a" = "--workflow" ] && exec echo '[]'\ndone\nexec cat ${shellQuote(runsFile)}\n`,
			).gh,
		);

		check([], at(SWEEP_NOW));
		const argv = fs.readFileSync(argvFile, "utf8");
		expect(argv).toContain("workflow list --all --json name,state,path");
		expect(argv).toContain("run list --workflow scheduled-checks.yml");
	});
});

describe("a missed slot reports the miss and offers no firing (mantahostels#2203)", () => {
	beforeEach(() => {
		setRuns([run_({ databaseId: 200, headSha: back(3) })]);
		setWorkflows(ACTIVE);
	});

	it("names the missed slots, with no command and no price beside them", () => {
		setSweeps([sweepAt("03:00")]);

		const out = check(["--notify"], at(SWEEP_NOW)).stdout;
		expect(out).toContain("Scheduled sweeps missing: 2 of 3");
		expect(out).not.toContain("Fire one now");
		expect(out).not.toContain("gh workflow run scheduled-checks.yml");
	});

	it("says the newest sweep is red there, and which step broke", () => {
		setSweeps([
			sweepAt("03:00"),
			sweepAt("09:00", { conclusion: "failure", databaseId: 900 }),
		]);
		stubRunsAndJobs([
			{
				name: "sweep",
				conclusion: "failure",
				steps: [{ name: "npm run test", conclusion: "failure" }],
			},
		]);

		const out = check(["--notify"], at(SWEEP_NOW)).stdout;
		expect(out).toContain("The newest sweep concluded failure");
		expect(out).toContain("sweep › npm run test");
	});
});

describe("an established red sweep is reported (mantahostels#2203)", () => {
	beforeEach(() => {
		setRuns([run_({ databaseId: 200, headSha: back(3) })]);
		setWorkflows(ACTIVE);
		stubRunsAndJobs([
			{
				name: "sweep",
				conclusion: "failure",
				steps: [{ name: "npm run test", conclusion: "failure" }],
			},
		]);
	});

	const allFour = (over: Partial<Run> = {}) =>
		setSweeps([
			sweepAt("03:00"),
			sweepAt("09:00"),
			sweepAt("15:00"),
			sweepAt("21:00", over),
		]);

	it("names the red and the failing job › step on the green-CI path", () => {
		allFour({ conclusion: "failure", databaseId: 900 });

		const out = check([], at(SWEEP_NOW)).stderr;
		expect(out).toContain("The newest sweep concluded failure");
		expect(out).toContain("firing another tests the same tree");
		expect(out).toContain("sweep › npm run test");
	});

	it("says whether the red sweep is ticketed (#532)", () => {
		allFour({ conclusion: "failure", databaseId: 900 });
		stubRunsAndJobs([
			{
				name: redSuite.SUITE_JOB,
				conclusion: "failure",
				steps: [{ name: "npm run test", conclusion: "failure" }],
			},
		]);
		fs.writeFileSync(
			issuesFile,
			JSON.stringify([{ number: 612, title: redSuite.TITLE, labels: [] }]),
		);

		expect(check([], at(SWEEP_NOW)).stderr).toContain(
			`  Ticket for ${redSuite.SUITE_JOB}: covered by #612`,
		);
	});

	it("says nothing about a red when the newest sweep passed", () => {
		allFour();

		expect(check([], at(SWEEP_NOW)).stderr).not.toContain(
			"The newest sweep concluded",
		);
	});

	it("reports a verdict GitHub spells some other way, not just failure", () => {
		allFour({ conclusion: "timed_out", databaseId: 900 });

		expect(check([], at(SWEEP_NOW)).stderr).toContain(
			"The newest sweep concluded timed_out",
		);
	});

	it("holds its tongue on a cancelled sweep, which failed nothing", () => {
		allFour({ conclusion: "cancelled", databaseId: 900 });

		expect(check([], at(SWEEP_NOW)).stderr).not.toContain(
			"The newest sweep concluded",
		);
	});

	it("degrades to naming the red when the steps cannot be read", () => {
		allFour({ conclusion: "failure", databaseId: 900 });
		fs.rmSync(jobsFile);

		const out = check([], at(SWEEP_NOW)).stderr;
		expect(out).toContain("The newest sweep concluded failure");
		expect(out).toContain("could not read which step failed");
	});

	it("links the red run, so the reader can open it", () => {
		allFour({ conclusion: "failure", databaseId: 900 });

		expect(check([], at(SWEEP_NOW)).stderr).toContain(
			"https://example.invalid/1",
		);
	});

	it("says so when the run names no failing step at all", () => {
		allFour({ conclusion: "failure", databaseId: 900 });
		stubRunsAndJobs([]);

		expect(check([], at(SWEEP_NOW)).stderr).toContain(
			"the run reports no failing step",
		);
	});

	it("still names the red when GitHub has disabled the workflow", () => {
		setWorkflows([
			{
				name: "scheduled-checks",
				state: "disabled_inactivity",
				path: ".github/workflows/scheduled-checks.yml",
			},
		]);
		allFour({ conclusion: "failure", databaseId: 900 });

		const out = check([], at(SWEEP_NOW)).stderr;
		expect(out).toContain("gh workflow enable scheduled-checks.yml");
		expect(out).toContain("The newest sweep concluded failure");
	});

	it("prints it once when a missed slot has already said it", () => {
		setSweeps([
			sweepAt("03:00"),
			sweepAt("09:00", { conclusion: "failure", databaseId: 900 }),
		]);

		const out = check([], at(SWEEP_NOW)).stderr;
		expect(out.split("The newest sweep concluded").length - 1).toBe(1);
	});
});

describe("the sweep ledger prints on demand even when healthy (mantahostels#1024)", () => {
	beforeEach(() => {
		setRuns([run_({ databaseId: 200, headSha: back(3) })]);
		setWorkflows(ACTIVE);
	});

	const healthy = () =>
		setSweeps([
			sweepAt("03:00"),
			sweepAt("09:00"),
			sweepAt("15:00"),
			sweepAt("21:00"),
		]);

	it("states the count, so a dead detector is not mistaken for a live one", () => {
		healthy();

		const out = check([], at(SWEEP_NOW)).stderr;
		expect(out).toContain(
			"Sweep ledger: 3 of 3 judgeable slots fired in the last 24h",
		);
		expect(out).toContain("newest sweep 21:00 UTC, 30m ago");
	});

	it("keeps it off the session-start path, which means only 'something is red'", () => {
		healthy();

		expect(check(["--notify"], at(SWEEP_NOW)).stdout.trim()).toBe("");
	});

	it("says the ledger is unreadable rather than claiming a miss", () => {
		fs.rmSync(sweepsFile);

		const out = check([], at(SWEEP_NOW)).stderr;
		expect(out).toContain("Sweep ledger unreadable");
		expect(out).not.toContain("produced no run");
	});

	it("judges no slot when the workflow has never run at all", () => {
		setSweeps([]);

		const out = check([], at(SWEEP_NOW)).stderr;
		expect(out).toContain("no scheduled-checks.yml run on record yet");
		expect(out).not.toContain("produced no run");
	});
});

describe("what a missed sweep does to the exit code (mantahostels#1024)", () => {
	beforeEach(() => {
		setRuns([run_({ databaseId: 200, headSha: back(3) })]);
		setWorkflows(ACTIVE);
		setSweeps([sweepAt("03:00")]);
	});

	it("exits 0 at session start, which a hook must never be blocked by", () => {
		const r = check(["--notify"], at(SWEEP_NOW));
		expect(r.stdout).toContain("Scheduled sweeps missing");
		expect(r.status).toBe(0);
	});

	it("exits 1 run by hand, saying scheduled sweeps are missing, meaning a human should look", () => {
		const r = check([], at(SWEEP_NOW));
		expect(r.stderr).toContain("Scheduled sweeps missing");
		expect(r.status).toBe(1);
	});

	it("tags the finding, so a --json reader can tell it from a red run", () => {
		const out = JSON.parse(check(["--json"], at(SWEEP_NOW)).stdout);
		expect(out.findings.map((f: { tag: string }) => f.tag)).toEqual([
			"SWEEP-MISSED",
		]);
	});

	it("still reports it while CI is red, counting the runs separately", () => {
		setRuns([
			run_({ databaseId: 300, headSha: back(3), conclusion: "failure" }),
		]);

		const r = check([], at(SWEEP_NOW));
		expect(r.stderr).toContain("CI is red");
		expect(r.stderr).toContain("Scheduled sweeps missing");
		expect(r.stderr).toContain(
			"1 failing CI run(s) on main, plus 1 CI liveness fault(s)",
		);
	});

	it("speaks even when the red itself was already reported", () => {
		setRuns([
			run_({ databaseId: 300, headSha: back(3), conclusion: "failure" }),
		]);
		check(["--notify"], at(SWEEP_NOW));

		const r = check(["--notify"], at(SWEEP_NOW));
		expect(r.stdout).toContain("Scheduled sweeps missing");
		expect(r.stdout).not.toContain("CI is red on main —");
	});
});

describe("a window that straddles midnight names the day (mantahostels#1024)", () => {
	it("dates a missed slot that fell yesterday, so the list reads in order", () => {
		setRuns([run_({ databaseId: 200, headSha: back(3) })]);
		setWorkflows(ACTIVE);
		setSweeps([sweepAt("15:00", { createdAt: "2026-08-20T15:00:00Z" })]);

		const out = check(["--notify"], at("2026-08-21T09:30:00Z")).stdout;
		expect(out).toContain("missed 20 Aug 21:00 UTC, 03:00 UTC");
	});
});

describe("what fills a slot, and what merely covers the tree (mantahostels#1024)", () => {
	beforeEach(() => {
		setRuns([run_({ databaseId: 200, headSha: back(3) })]);
		setWorkflows(ACTIVE);
	});

	it("does not let a hand-fired sweep fill the slot it was fired over", () => {
		setSweeps([
			sweepAt("03:00"),
			sweepAt("09:00"),
			sweepAt("16:00", { event: "workflow_dispatch" }),
		]);

		const out = check(["--notify"], at(SWEEP_NOW)).stdout;
		expect(out).toContain("missed 15:00 UTC");
	});

	it("lets a dispatch titled for the slot fill it, and says so (#4447)", () => {
		setSweeps([
			sweepAt("03:00"),
			sweepAt("09:00"),
			sweepAt("20:10", {
				event: "workflow_dispatch",
				displayTitle: "sweep slot 2026-08-21T15:00Z",
			}),
		]);

		expect(check(["--notify"], at(SWEEP_NOW)).stdout).not.toContain("missed");
		expect(check([], at(SWEEP_NOW)).stderr).toContain(
			"Sweep ledger: 3 of 3 judgeable slots fired in the last 24h (1 by slot repair)",
		);
	});

	it("judges slots off main's runs alone, which the lander's pushes cannot crowd out (#4447)", () => {
		setSweeps([sweepAt("03:00"), sweepAt("09:00"), sweepAt("15:00")]);
		fs.writeFileSync(ghArgsFile, "");

		check(["--notify"], at(SWEEP_NOW));
		const ledgerReads = fs
			.readFileSync(ghArgsFile, "utf8")
			.split("\n")
			.filter((l) => l.includes("--workflow") && l.includes("--branch main"));
		expect(ledgerReads).toHaveLength(1);
	});

	it("does not let a dispatch titled for another slot fill this one (#4447)", () => {
		setSweeps([
			sweepAt("03:00"),
			sweepAt("09:00"),
			sweepAt("20:10", {
				event: "workflow_dispatch",
				displayTitle: "sweep slot 2026-08-21T09:00Z",
			}),
		]);

		expect(check(["--notify"], at(SWEEP_NOW)).stdout).toContain(
			"missed 15:00 UTC",
		);
	});

	it("does not let a push run fill a slot either (#1994)", () => {
		setSweeps([
			sweepAt("03:00"),
			sweepAt("09:00"),
			sweepAt("15:10", { event: "push" }),
		]);

		const out = check(["--notify"], at(SWEEP_NOW)).stdout;
		expect(out).toContain("missed 15:00 UTC");
	});

	it("still reads that hand-fired run as the newest coverage there is", () => {
		setSweeps([
			sweepAt("03:00"),
			sweepAt("19:30", { event: "workflow_dispatch", headSha: back(1) }),
		]);

		const out = check(["--notify"], at(SWEEP_NOW)).stdout;
		expect(out).toContain("newest sweep 19:30 UTC");
		expect(out).toContain("1 commit(s) behind your HEAD");
	});
});

describe("the ledger says what it could not see (mantahostels#1024)", () => {
	beforeEach(() => setRuns([run_({ databaseId: 200, headSha: back(3) })]));

	it("does not count a slot still inside its grace as one that failed to fire", () => {
		setWorkflows(ACTIVE);
		setSweeps([
			sweepAt("21:00", { createdAt: "2026-08-20T21:00:00Z" }),
			sweepAt("03:00"),
			sweepAt("09:00"),
		]);

		const out = check([], at("2026-08-21T15:30:00Z")).stderr;
		expect(out).toContain("3 of 3 judgeable slots fired");
		expect(out).toContain("1 still inside its grace");
	});

	it("says so when it could not read whether a workflow is disabled", () => {
		fs.rmSync(workflowsFile);
		setSweeps([
			sweepAt("03:00"),
			sweepAt("09:00"),
			sweepAt("15:00"),
			sweepAt("21:00"),
		]);

		expect(check([], at(SWEEP_NOW)).stderr).toContain(
			"Workflow states unreadable",
		);
	});

	it("does not claim no sweep ever ran when gh merely refused the query", () => {
		setWorkflows([
			{
				name: "scheduled-checks",
				state: "disabled_inactivity",
				path: ".github/workflows/scheduled-checks.yml",
			},
		]);
		fs.rmSync(sweepsFile);

		const out = check(["--notify"], at(SWEEP_NOW)).stdout;
		expect(out).toContain("disabled_inactivity");
		expect(out).not.toContain("No sweep has ever run");
		expect(out).toContain("GitHub would not say when the last sweep was");
	});
});

describe("every `gh workflow` line says who can actually run it (mantahostels#1069)", () => {
	const qualifier =
		"any session — a 403 here means the PAT lost Actions: write";

	it("qualifies re-enabling the sweep workflow GitHub stopped", () => {
		setRuns([run_({ databaseId: 200, headSha: back(3) })]);
		setWorkflows([
			{
				name: "scheduled-checks",
				state: "disabled_inactivity",
				path: ".github/workflows/scheduled-checks.yml",
			},
		]);
		setSweeps([sweepAt("03:00")]);

		expect(check(["--notify"], at(SWEEP_NOW)).stdout).toContain(
			`Re-enable (${qualifier}): gh workflow enable scheduled-checks.yml`,
		);
	});

	it("qualifies re-enabling any other stopped workflow", () => {
		setRuns([run_({ databaseId: 200, headSha: back(3) })]);
		setWorkflows([
			...ACTIVE,
			{
				name: "issue-card-drift",
				state: "disabled_manually",
				path: ".github/workflows/issue-card-drift.yml",
			},
		]);
		setSweeps([
			sweepAt("03:00"),
			sweepAt("09:00"),
			sweepAt("15:00"),
			sweepAt("21:00"),
		]);

		expect(check(["--notify"], at(SWEEP_NOW)).stdout).toContain(
			`Re-enable (${qualifier}): gh workflow enable issue-card-drift.yml`,
		);
	});
});

describe("a stale verdict fires its own sweep (mantahostels#1816)", () => {
	beforeEach(() => {
		setRuns([run_({ databaseId: 200, headSha: back(3) })]);
		setWorkflows(ACTIVE);
	});

	it("fires one when the newest sweep is older than the schedule allows", () => {
		setSweeps([sweepAt("03:00"), sweepAt("09:00")]);

		expect(check(["--notify"], at(SWEEP_NOW)).stdout).toContain(
			"Fired one automatically",
		);
	});

	it("fires nothing without --write, and says --write fires it (#4449)", () => {
		setSweeps([sweepAt("03:00"), sweepAt("09:00")]);

		const out = bare(["--notify"], at(SWEEP_NOW)).stdout;
		expect(out).toContain("Not firing one: `--write` fires it.");
		expect(out).not.toContain("Fired one automatically");
		expect(fs.existsSync(AUTOFIRE_MARKER)).toBe(false);
	});

	it("says nothing at 7h59m, just inside the 8h threshold", () => {
		setSweeps([sweepAt("03:00"), sweepAt("13:31")]);

		expect(check(["--notify"], at(SWEEP_NOW)).stdout).not.toContain(
			"Fired one automatically",
		);
	});

	it("fires at 8h01m, just past the 8h threshold", () => {
		setSweeps([sweepAt("03:00"), sweepAt("13:29")]);

		expect(check(["--notify"], at(SWEEP_NOW)).stdout).toContain(
			"Fired one automatically",
		);
	});

	it("says nothing while the newest sweep is inside the window", () => {
		setSweeps([
			sweepAt("03:00"),
			sweepAt("09:00"),
			sweepAt("15:00"),
			sweepAt("21:00"),
		]);

		expect(check(["--notify"], at(SWEEP_NOW)).stdout).not.toContain(
			"Fired one automatically",
		);
	});

	it("withholds it when the newest sweep already covered HEAD", () => {
		setSweeps([sweepAt("03:00"), sweepAt("09:00", { headSha: back(0) })]);

		expect(check(["--notify"], at(SWEEP_NOW)).stdout).not.toContain(
			"Fired one automatically",
		);
	});

	it("fires once, then holds the cooldown for the second session start", () => {
		setSweeps([sweepAt("03:00"), sweepAt("09:00")]);

		const first = check(["--notify"], at(SWEEP_NOW)).stdout;
		const second = check(["--notify"], at(SWEEP_NOW)).stdout;
		expect(first).toContain("Fired one automatically");
		expect(second).not.toContain("Fired one automatically");
		expect(second).toContain("Scheduled sweeps missing");
	});

	it("holds the cooldown short of 2 minutes", () => {
		setSweeps([sweepAt("03:00"), sweepAt("09:00")]);

		check(["--notify"], at(SWEEP_NOW));
		const stillCooling = check(["--notify"], at("2026-08-21T21:31:59Z")).stdout;
		expect(stillCooling).not.toContain("Fired one automatically");
	});

	it("fires again once the 2-minute cooldown has run out", () => {
		setSweeps([sweepAt("03:00"), sweepAt("09:00")]);

		check(["--notify"], at(SWEEP_NOW));
		const later = check(["--notify"], at("2026-08-21T21:32:01Z")).stdout;
		expect(later).toContain("Fired one automatically");
	});

	it("fires nothing under --recheck, and still says the verdict is stale (#856)", () => {
		setSweeps([sweepAt("03:00"), sweepAt("09:00")]);

		const out = check(["--notify", "--recheck"], at(SWEEP_NOW)).stdout;
		expect(out).not.toContain("Fired one automatically");
		expect(out).toContain("Newest sweep is");
		expect(fs.existsSync(AUTOFIRE_MARKER)).toBe(false);
	});

	it("fires nothing on the on-demand form, and offers nothing either", () => {
		setSweeps([sweepAt("03:00"), sweepAt("09:00")]);

		const r = check([], at(SWEEP_NOW));
		const out = r.stdout + r.stderr;
		expect(out).not.toContain("Fired one automatically");
		expect(out).not.toContain("gh workflow run scheduled-checks.yml");
		expect(out).toContain("Nothing has tested HEAD");
	});

	it("fires on a schedule with no missed slot at all, the overnight case", () => {
		setSweeps([
			sweepAt("21:00", { createdAt: "2026-08-20T21:00:00Z" }),
			sweepAt("03:00"),
			sweepAt("09:00"),
		]);

		const out = check(["--notify"], at("2026-08-21T19:00:00Z")).stdout;
		expect(out).not.toContain("Scheduled sweeps missing");
		expect(out).toContain("Newest sweep is 10h 0m old");
		expect(out).toContain("Fired one automatically");
	});

	it("reports the staleness even when the cooldown withholds the firing", () => {
		setSweeps([sweepAt("03:00"), sweepAt("09:00")]);

		check(["--notify"], at(SWEEP_NOW));
		const second = check(["--notify"], at(SWEEP_NOW)).stdout;
		expect(second).toContain("Newest sweep is 12h 30m old");
		expect(second).not.toContain("Fired one automatically");
	});

	it("stops at the daily cap, however many sessions start", () => {
		setSweeps([sweepAt("03:00"), sweepAt("09:00")]);
		const clocks = [
			"2026-08-21T21:30:00Z",
			"2026-08-21T21:51:00Z",
			"2026-08-21T22:12:00Z",
		];
		for (const c of clocks)
			expect(check(["--notify"], at(c)).stdout).toContain(
				"Fired one automatically",
			);

		const overCap = check(["--notify"], at("2026-08-21T22:33:00Z")).stdout;
		expect(overCap).toContain("3 sweeps already fired today");
		expect(overCap).not.toContain("Fired one automatically");
	});

	it("does not wedge on a marker dated in the future", () => {
		setSweeps([sweepAt("03:00"), sweepAt("09:00")]);
		fs.writeFileSync(
			AUTOFIRE_MARKER,
			JSON.stringify({ last: Date.parse("2027-01-01T00:00:00Z"), count: 1 }),
		);

		expect(check(["--notify"], at(SWEEP_NOW)).stdout).toContain(
			"Fired one automatically",
		);
	});

	it("fires nothing when the cooldown cannot be read, and says which", () => {
		setSweeps([sweepAt("03:00"), sweepAt("09:00")]);
		fs.mkdirSync(AUTOFIRE_MARKER);

		const out = check(["--notify"], at(SWEEP_NOW)).stdout;
		expect(out).toContain("Could not read the sweep autofire cooldown");
		expect(out).not.toContain("Fired one automatically");
		fs.rmSync(AUTOFIRE_MARKER, { recursive: true, force: true });
	});

	it("says so when GitHub refuses the dispatch, rather than dying", () => {
		setSweeps([sweepAt("03:00"), sweepAt("09:00")]);
		vi.stubEnv(
			"WFC_GH",
			stubGhScript(
				sb.dir,
				"#!/bin/sh\n" +
					'case "$*" in\n' +
					"  *'workflow run'*) echo 'HTTP 403' >&2; exit 1 ;;\n" +
					"esac\n" +
					'for a in "$@"; do\n' +
					`  [ "$a" = "workflow" ] && exec cat ${shellQuote(workflowsFile)}\n` +
					`  [ "$a" = "--workflow" ] && exec cat ${shellQuote(sweepsFile)}\n` +
					"done\n" +
					`exec cat ${shellQuote(runsFile)}\n`,
			).gh,
		);

		const r = check(["--notify"], at(SWEEP_NOW));
		expect(r.stdout).toContain("Could not fire one automatically");
		expect(r.status).toBe(0);
	});
});

describe("an adopter whose tree has no sweep workflow is never judged on one (#403)", () => {
	const noSweepRepo = fs.mkdtempSync(
		path.join(os.tmpdir(), "ci-status-nosweep-"),
	);
	const g = (args: string[]) =>
		execFileSync("git", ["-C", noSweepRepo, ...args]);
	execFileSync("git", ["clone", "-q", RANGE_REPO, noSweepRepo]);
	g(["rm", "-q", ".github/workflows/scheduled-checks.yml"]);
	g([
		"-c",
		"user.email=t@example.invalid",
		"-c",
		"user.name=Test",
		"commit",
		"-q",
		"-m",
		"cut the sweep",
	]);
	const marker = path.join(noSweepRepo, ".git", ".sweep-autofire");
	const checkNoSweep = (args: string[]) =>
		check(args, { WFC_REPO_DIR: noSweepRepo, ...at(SWEEP_NOW) });

	beforeEach(() => {
		fs.rmSync(marker, { force: true });
		setRuns([run_({ databaseId: 200, headSha: back(3) })]);
		setSweeps([sweepAt("03:00")]);
	});

	it("fires on the same history where the tree still has the file", () => {
		setWorkflows(ACTIVE);

		expect(check(["--notify"], at(SWEEP_NOW)).stdout).toContain(
			"Fired one automatically",
		);
	});

	it("fires nothing, writes no marker and says nothing under --notify", () => {
		setWorkflows(ACTIVE);

		const r = checkNoSweep(["--notify"]);
		expect(r.stdout.trim()).toBe("");
		expect(r.status).toBe(0);
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("does not ask to re-enable a sweep workflow GitHub has disabled", () => {
		setWorkflows([
			{
				name: "scheduled-checks",
				state: "disabled_manually",
				path: ".github/workflows/scheduled-checks.yml",
			},
		]);

		expect(checkNoSweep(["--notify"]).stdout).not.toContain(
			"scheduled-checks.yml",
		);
	});

	it("still reports another workflow that is disabled", () => {
		setWorkflows([
			{
				name: "CI",
				state: "disabled_manually",
				path: ".github/workflows/ci.yml",
			},
		]);

		expect(checkNoSweep(["--notify"]).stdout).toContain(
			"ci.yml is disabled_manually",
		);
	});

	it("says on demand why no ledger is kept", () => {
		setWorkflows(ACTIVE);

		const r = checkNoSweep([]);
		expect(r.stderr).toContain(
			"no .github/workflows/scheduled-checks.yml in this tree",
		);
		expect(r.stderr).not.toContain("Scheduled sweeps missing");
		expect(r.stderr).not.toContain("next sweep is");
		expect(r.status).toBe(0);
	});
});

describe("aggregate gh() latency under --notify is budgeted (mantahostels#2177)", () => {
	it("skips a later gh() call once the budget is spent, rather than firing it on a near-zero timeout", () => {
		setRuns([run_({ databaseId: 200, headSha: back(3) })]);
		setWorkflows(ACTIVE);
		setSweeps([sweepAt("03:00"), sweepAt("09:00")]);
		vi.stubEnv(
			"WFC_GH",
			stubGhScript(
				sb.dir,
				"#!/bin/sh\n" +
					'for a in "$@"; do\n' +
					`  [ "$a" = "view" ] && exec cat ${shellQuote(jobsFile)}\n` +
					`  [ "$a" = "workflow" ] && exec cat ${shellQuote(workflowsFile)}\n` +
					`  [ "$a" = "--workflow" ] && exec cat ${shellQuote(sweepsFile)}\n` +
					"done\n" +
					"sleep 0.5\n" +
					`exec cat ${shellQuote(runsFile)}\n`,
			).gh,
		);

		const r = check(["--notify"], {
			...at(SWEEP_NOW),
			WFC_NOTIFY_BUDGET_MS: "1300",
		});
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("Newest sweep is");
		expect(r.stdout).not.toContain("Fired one automatically");
	});

	it("leaves the on-demand form unbudgeted, which no hook times out", () => {
		setRuns([run_({ databaseId: 200, headSha: back(3) })]);
		setWorkflows(ACTIVE);
		setSweeps([sweepAt("03:00"), sweepAt("09:00")]);
		vi.stubEnv(
			"WFC_GH",
			stubGhScript(
				sb.dir,
				"#!/bin/sh\n" +
					'for a in "$@"; do\n' +
					`  [ "$a" = "view" ] && exec cat ${shellQuote(jobsFile)}\n` +
					`  [ "$a" = "workflow" ] && exec cat ${shellQuote(workflowsFile)}\n` +
					`  [ "$a" = "--workflow" ] && exec cat ${shellQuote(sweepsFile)}\n` +
					"done\n" +
					"sleep 0.5\n" +
					`exec cat ${shellQuote(runsFile)}\n`,
			).gh,
		);

		const r = check([], {
			...at(SWEEP_NOW),
			WFC_NOTIFY_BUDGET_MS: "1300",
		});
		expect(r.stdout + r.stderr).toContain("Scheduled sweeps missing");
	});

	it("holds NOTIFY_BUDGET_MS under the SessionStart hook's own timeout", () => {
		const registration = JSON.parse(
			fs.readFileSync(
				path.join(__dirname, "..", "self-plugin", "hooks", "hooks.json"),
				"utf8",
			),
		);
		let hookTimeoutS: number | null = null;
		for (const matcherGroup of registration.hooks?.SessionStart ?? [])
			for (const hook of matcherGroup.hooks ?? [])
				if (
					typeof hook.command === "string" &&
					hook.command.includes("check-ci-status.js")
				)
					hookTimeoutS = hook.timeout;
		expect(
			hookTimeoutS,
			"no check-ci-status.js SessionStart hook in self-plugin/hooks/hooks.json",
		).not.toBeNull();

		const declared = /const NOTIFY_BUDGET_MS =[\s\S]*?\|\|\s*(\d[\d_]*);/.exec(
			fs.readFileSync(SCRIPT, "utf8"),
		);
		expect(
			declared,
			"no NOTIFY_BUDGET_MS in check-ci-status.js",
		).not.toBeNull();

		expect(
			Number((declared as RegExpExecArray)[1].replaceAll("_", "")),
		).toBeLessThan((hookTimeoutS as number) * 1000);
	});
});
