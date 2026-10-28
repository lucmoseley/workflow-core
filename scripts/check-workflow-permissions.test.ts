// @vitest-environment node
/*
 * Pins that a workflow job holding any write scope but `issues`, no
 * permissions block, an unrecognised value, or a `git commit`/`git push` step
 * fails the autonomy cap (mantahostels#1169, mantahostels#1209); and that, where
 * the code repo is kept apart from its tracker, any issues access or secret
 * fails too (#1963).
 *
 * Each case writes its workflows into a temp directory handed to the script.
 * No case asserts the live .github/workflows is clean: that would put the gate in
 * two places and make an unrelated workflow edit fail the suite instead of the
 * check.
 *
 * Messages are asserted alongside tags because a tag alone would survive the
 * message being rewritten into nonsense.
 *
 * It is a gate step in the scheduled `.github/workflows/roadmap-digest.yml`
 * sweep: a false pass lets a timed job gain the power to push to `main`, past
 * the R1 ceiling.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-workflow-permissions.js");

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-perms-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, body: string) =>
	fs.writeFileSync(path.join(dir, name), body);

/** A host whose code repo is its tracker, so no case reads this checkout's. */
const sameRepoHost = () => {
	const root = path.join(dir, "same-repo-host");
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(root, ".claude", "workflow-core.json"),
		JSON.stringify({ tracker: "o/code", codeRepo: "o/code" }),
	);
	return root;
};

const run = (...args: string[]) =>
	spawnSync("node", [SCRIPT, dir, ...args], {
		encoding: "utf8",
		env: { ...process.env, CLAUDE_PROJECT_DIR: sameRepoHost() },
	});

interface Envelope {
	outcome: string;
	count: number;
	findings: { severity: string; tag: string; message: string }[];
	jobs: number;
	steps: number;
	files: string[];
}

const json = (...args: string[]): Envelope =>
	JSON.parse(run("--json", ...args).stdout);

const tags = (e: Envelope) => e.findings.map((f) => f.tag);
const messages = (e: Envelope) => e.findings.map((f) => f.message).join("\n");

const workflow = (perms: string, steps = "      - run: npm test\n") =>
	[
		"name: w",
		"on:",
		"  workflow_dispatch:",
		perms,
		"jobs:",
		"  build:",
		"    runs-on: ubuntu-latest",
		"    steps:",
		steps,
	].join("\n");

const noPermsWorkflow = [
	"name: w",
	"on:",
	"  workflow_dispatch:",
	"jobs:",
	"  build:",
	"    runs-on: ubuntu-latest",
	"    steps:",
	"      - run: npm test",
].join("\n");

describe("permission scopes", () => {
	it("passes a job granting only contents: read", () => {
		write("a.yml", workflow("permissions:\n  contents: read"));
		const e = json();
		expect(e.outcome).toBe("OK");
		expect(e.jobs).toBe(1);
	});

	it("passes issues: write — R1 is filing or refreshing an issue", () => {
		write("a.yml", workflow("permissions:\n  contents: read\n  issues: write"));
		expect(json().outcome).toBe("OK");
	});

	it("fails a job granting contents: write, naming the scope and the ceiling", () => {
		write("a.yml", workflow("permissions:\n  contents: write"));
		const e = json();
		expect(e.outcome).toBe("FAIL");
		expect(tags(e)).toEqual(["WRITE-SCOPE"]);
		expect(messages(e)).toContain("grants contents: write");
		expect(messages(e)).toContain("docs/agents/autonomy-ceiling.md");
	});

	it("fails any other write scope, not just contents, tagged WRITE-SCOPE and naming the scope it grants", () => {
		write(
			"a.yml",
			workflow("permissions:\n  contents: read\n  packages: write"),
		);
		const e = json();
		expect(tags(e)).toEqual(["WRITE-SCOPE"]);
		expect(messages(e)).toContain("grants packages: write");
	});

	it("fails the write-all shorthand, tagging it WRITE-SCOPE", () => {
		write("a.yml", workflow("permissions: write-all"));
		const e = json();
		expect(tags(e)).toEqual(["WRITE-SCOPE"]);
		expect(messages(e)).toContain("grants write-all");
	});

	it("passes the read-all shorthand", () => {
		write("a.yml", workflow("permissions: read-all"));
		expect(json().outcome).toBe("OK");
	});

	it("passes an explicit empty mapping, which grants nothing", () => {
		write("a.yml", workflow("permissions: {}"));
		expect(json().outcome).toBe("OK");
	});

	it("reads a workflow-level block a job does not override", () => {
		write("a.yml", workflow("permissions:\n  contents: write"));
		expect(json().outcome).toBe("FAIL");
	});

	it("lets a job-level block override a workflow-level one", () => {
		write(
			"a.yml",
			[
				"name: w",
				"on:",
				"  workflow_dispatch:",
				"permissions:",
				"  contents: write",
				"jobs:",
				"  build:",
				"    runs-on: ubuntu-latest",
				"    permissions:",
				"      contents: read",
				"    steps:",
				"      - run: npm test",
			].join("\n"),
		);
		expect(json().outcome).toBe("OK");
	});

	it("names the file and job on every finding", () => {
		write("a.yml", workflow("permissions:\n  contents: write"));
		expect(messages(json())).toContain("a.yml job `build`");
	});
});

describe("silence is not a grant of read (mantahostels#1169, mantahostels#1209)", () => {
	it("fails a job with no permissions block anywhere, and says to add one", () => {
		write("a.yml", noPermsWorkflow);
		const e = json();
		expect(e.outcome).toBe("FAIL");
		expect(tags(e)).toEqual(["NO-PERMISSIONS"]);
		expect(messages(e)).toContain("repository's default token");
		expect(messages(e)).toContain("Add an explicit block");
	});

	it("fails a permissions key left with no value, and says how to grant none", () => {
		write("a.yml", workflow("permissions:"));
		const e = json();
		expect(tags(e)).toEqual(["NO-PERMISSIONS"]);
		expect(messages(e)).toContain("with no value");
		expect(messages(e)).toContain("permissions: {}");
		// Not the default-token diagnosis: a key IS declared here.
		expect(messages(e)).not.toContain("repository's default token");
	});
});

describe("an unrecognised value is never read as harmless (mantahostels#1209)", () => {
	it("fails a level that is not read, write or none, tagged UNKNOWN-VALUE and saying it will not call it clean", () => {
		write("a.yml", workflow("permissions:\n  contents: WRITE"));
		const e = json();
		expect(tags(e)).toEqual(["UNKNOWN-VALUE"]);
		expect(messages(e)).toContain("not read, write or none");
		expect(messages(e)).toContain("will not call it clean");
	});

	it("fails a shorthand that is neither read-all nor write-all, tagging it UNKNOWN-VALUE", () => {
		write("a.yml", workflow("permissions: write"));
		const e = json();
		expect(tags(e)).toEqual(["UNKNOWN-VALUE"]);
		expect(messages(e)).toContain("neither read-all nor write-all");
	});
});

describe("git writes in a run step", () => {
	const withRun = (script: string) =>
		workflow("permissions:\n  contents: read", `      - run: |\n${script}`);

	it("fails a git push, quoting the line and naming R2", () => {
		write("a.yml", withRun("          git push origin main\n"));
		const e = json();
		expect(tags(e)).toEqual(["GIT-WRITE"]);
		expect(messages(e)).toContain("git push origin main");
		expect(messages(e)).toContain("R2");
	});

	it("fails a git commit, tagged GIT-WRITE", () => {
		write("a.yml", withRun('          git commit -m "x"\n'));
		expect(tags(json())).toEqual(["GIT-WRITE"]);
	});

	it("fails a commit reached through git flags, tagged GIT-WRITE", () => {
		write("a.yml", withRun('          git -c user.email=a@b commit -m "x"\n'));
		expect(tags(json())).toEqual(["GIT-WRITE"]);
	});

	it("passes a read-only git subcommand", () => {
		write(
			"a.yml",
			withRun(
				"          git log -1 --format=%h\n          git rev-list --count HEAD\n",
			),
		);
		expect(json().outcome).toBe("OK");
	});

	it("ignores a git push inside a whole-line shell comment", () => {
		write(
			"a.yml",
			withRun("          # never git push from here\n          npm test\n"),
		);
		expect(json().outcome).toBe("OK");
	});

	it("ignores a git push in a comment tail after real code", () => {
		write("a.yml", withRun("          npm test # do not git push here\n"));
		expect(json().outcome).toBe("OK");
	});

	it("ignores a git push in the workflow's own YAML comments", () => {
		write(
			"a.yml",
			`# this workflow must never git push\n${workflow("permissions:\n  contents: read")}`,
		);
		expect(json().outcome).toBe("OK");
	});

	it("reports at most one finding per step", () => {
		write(
			"a.yml",
			withRun("          git commit -m x\n          git push origin main\n"),
		);
		expect(json().findings).toHaveLength(1);
	});
});

describe("a run that inspected nothing (mantahostels#915, mantahostels#1024)", () => {
	it("fails on an empty directory rather than reporting green", () => {
		const e = json();
		expect(e.outcome).toBe("FAIL");
		expect(tags(e)).toEqual(["NOTHING-INSPECTED"]);
		expect(e.jobs).toBe(0);
		expect(messages(e)).toContain(dir);
		expect(messages(e)).toContain("not the same as finding nothing");
	});

	it("fails a workflow file declaring no jobs, separately from the whole-run case, tagging it NO-JOBS and naming the file", () => {
		write("a.yml", "name: w\non:\n  workflow_dispatch:\n");
		const e = json();
		expect(tags(e)).toEqual(["NO-JOBS", "NOTHING-INSPECTED"]);
		expect(messages(e)).toContain("a.yml declares no jobs");
	});

	it("treats a comment-only file as declaring no jobs, not as unreadable", () => {
		write("a.yml", "# nothing here yet\n");
		expect(tags(json())).toEqual(["NO-JOBS", "NOTHING-INSPECTED"]);
	});

	it("reports the job, file and step counts inspected", () => {
		write("a.yml", workflow("permissions:\n  contents: read"));
		write("b.yml", workflow("permissions:\n  contents: read"));
		const e = json();
		expect(e.jobs).toBe(2);
		expect(e.steps).toBe(2);
		expect(e.files).toEqual(["a.yml", "b.yml"]);
	});

	it("prints the census on a clean run too", () => {
		write("a.yml", workflow("permissions:\n  contents: read"));
		expect(run().stderr).toContain(
			"Inspected 1 job(s) across 1 workflow file(s)",
		);
	});
});

describe("BROKEN, not a finding, when the input cannot be read (mantahostels#155)", () => {
	it("is BROKEN on unparseable YAML, naming the file", () => {
		write("a.yml", "name: w\n  bad: [unclosed\n");
		const r = run("--json");
		expect(r.status).toBe(2);
		const e = JSON.parse(r.stdout);
		expect(e.outcome).toBe("BROKEN");
		expect(e.summary).toContain("a.yml is not parseable YAML");
	});

	it("is BROKEN on a directory that does not exist, naming the path", () => {
		const missing = path.join(dir, "nope");
		const r = spawnSync("node", [SCRIPT, missing, "--json"], {
			encoding: "utf8",
		});
		expect(r.status).toBe(2);
		const e = JSON.parse(r.stdout);
		expect(e.outcome).toBe("BROKEN");
		expect(e.summary).toContain(missing);
	});

	it("is BROKEN, not SKIP, where CLAUDE_PROJECT_DIR names no directory (#43)", () => {
		const missing = path.join(dir, "no-such-project");
		const r = runInProcess(SCRIPT, ["--json"], {
			env: { ...process.env, CLAUDE_PROJECT_DIR: missing },
		});
		expect(r.status).toBe(2);
		const e = JSON.parse(r.stdout);
		expect(e.outcome).toBe("BROKEN");
		expect(e.summary).toContain(missing);
	});

	it("is BROKEN, not SKIP, in workflow-core with no .github/workflows, since the core keeps one (#1722)", () => {
		const core = path.join(dir, "core");
		fs.mkdirSync(path.join(core, ".claude-plugin"), { recursive: true });
		fs.writeFileSync(
			path.join(core, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "workflow-core" }),
		);
		const r = runInProcess(SCRIPT, ["--json"], {
			env: { ...process.env, CLAUDE_PROJECT_DIR: core },
		});
		expect(r.status).toBe(2);
		const e = JSON.parse(r.stdout);
		expect(e.outcome).toBe("BROKEN");
		expect(e.summary).toContain(path.join(".github", "workflows"));
	});

	it("SKIPs in an adopter with no .github/workflows, which may keep none (#1722)", () => {
		const adopter = path.join(dir, "adopter");
		fs.mkdirSync(adopter);
		const r = runInProcess(SCRIPT, ["--json"], {
			env: { ...process.env, CLAUDE_PROJECT_DIR: adopter },
		});
		expect(r.status).toBe(0);
		const e = JSON.parse(r.stdout);
		expect(e.outcome).toBe("SKIP");
		expect(e.summary).toContain("this repo has no .github/workflows");
	});
});

describe("a code repo kept apart from its tracker (#1963)", () => {
	const host = (codeRepo: string) => {
		const root = path.join(dir, "host");
		fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".claude", "workflow-core.json"),
			JSON.stringify({ tracker: "o/tracker", codeRepo }),
		);
		return root;
	};
	const judged = (body: string, codeRepo = "o/code"): Envelope => {
		write("a.yml", body);
		const root = host(codeRepo);
		return JSON.parse(
			runInProcess(SCRIPT, [dir, "--json"], {
				env: { ...process.env, CLAUDE_PROJECT_DIR: root },
			}).stdout,
		);
	};

	it("fails a job granted issues: read or write, and passes issues: none", () => {
		for (const level of ["read", "write"]) {
			const e = judged(
				workflow(`permissions:\n  contents: read\n  issues: ${level}`),
			);
			expect(tags(e)).toEqual(["TRACKER-SCOPE"]);
			expect(messages(e)).toContain("job `build`");
			expect(messages(e)).toContain("File issues from a session instead");
		}
		expect(
			tags(judged(workflow("permissions:\n  contents: read\n  issues: none"))),
		).toEqual([]);
	});

	it("fails read-all, which carries issues", () => {
		const e = judged(workflow("permissions: read-all"));
		expect(tags(e)).toEqual(["TRACKER-SCOPE"]);
		expect(messages(e)).toContain("File issues from a session instead");
	});

	it("fails a job reading a secret, by expression or by passing them on", () => {
		const e = judged(
			workflow(
				"permissions:\n  contents: read",
				// The `$` is interpolated: a literal `${{` in a JS string trips Biome's
				// noTemplateCurlyInString.
				`      - run: deploy\n        env:\n          T: ${"$"}{{ secrets.TOKEN }}\n`,
			),
		);
		expect(tags(e)).toEqual(["SECRET"]);
		expect(messages(e)).toContain("job `build`");
		expect(messages(e)).toContain("Move the step that needs it into a session");
		const passed = judged(
			[
				"name: w",
				"on:",
				"  workflow_dispatch:",
				"permissions:",
				"  contents: read",
				"jobs:",
				"  call:",
				"    uses: ./.github/workflows/b.yml",
				"    secrets: inherit",
			].join("\n"),
		);
		expect(tags(passed)).toEqual(["SECRET"]);
		expect(messages(passed)).toContain("job `call`");
	});

	it("judges neither where the code repo is the tracker", () => {
		expect(
			tags(judged(workflow("permissions:\n  issues: write"), "o/tracker")),
		).toEqual([]);
	});
});

describe("invocation", () => {
	it("exits 1 on a breach and 0 when clean", () => {
		write("a.yml", workflow("permissions:\n  contents: write"));
		expect(run().status).toBe(1);
		write("a.yml", workflow("permissions:\n  contents: read"));
		expect(run().status).toBe(0);
	});

	it("--warn caps a breach to a non-gating warning", () => {
		write("a.yml", workflow("permissions:\n  contents: write"));
		const r = run("--warn");
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("WARN:");
	});

	it("defaults to the repo's own .github/workflows and inspects jobs there", () => {
		const r = spawnSync("node", [SCRIPT, "--json"], {
			encoding: "utf8",
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: path.resolve(__dirname, ".."),
			},
		});
		const e: Envelope = JSON.parse(r.stdout);
		expect(e.jobs).toBeGreaterThan(0);
		expect(e.files.length).toBeGreaterThan(0);
	});
});
