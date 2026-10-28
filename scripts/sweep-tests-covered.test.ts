// @vitest-environment node
/*
 * The sweep gate (mantahostels#3502, the ticket that stopped a sweep re-testing a commit an
 * earlier sweep had already taken green): pins that it answers covered only
 * where an earlier sweep on the same sha has every `Full suite` row green,
 * answers covered=false on any error, and always exits 0.
 *
 * Breaking it either skips the suite on a commit nothing ever tested, or
 * reddens or re-runs every scheduled sweep (scheduled-checks.yml keys its
 * suite job on this answer).
 *
 * `gh` is stubbed as a real executable injected at WFC_GH — the seam
 * scripts/lib/gh.js documents — answering each `gh api <path>` from a routing
 * table the fixture writes as JSON, and recording its own argv so a test can
 * assert the call budget.
 *
 * IT SPAWNS RATHER THAN USING `scripts/lib/run-in-process.js` (§X3) because the
 * guarantee under test is that the script NEVER exits non-zero, whatever
 * GitHub answers — the gate job is unconditional, so a throw would redden every
 * sweep. `execFileSync` throws on a non-zero exit, so every `run()` below
 * asserts it in passing.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { stubGhScript } from "./lib/gh-stub";

/* Required rather than imported: js-yaml ships no types and this repo declares
 * no @types/js-yaml. */
const yaml = require("js-yaml") as { load: (s: string) => unknown };

/* A GitHub Actions expression, composed rather than written out: Biome reads a
 * literal `${{ … }}` in a plain string as a mistyped template. */
const expr = (body: string) => `\${{ ${body} }}`;

const SCRIPT = path.join(__dirname, "sweep-tests-covered.js");
const SHA = "a".repeat(40);

const temps: string[] = [];
afterEach(() => {
	for (const t of temps.splice(0))
		fs.rmSync(t, { recursive: true, force: true });
});

interface Job {
	name: string;
	conclusion: string | null;
}
/** One earlier run on this sha, and the jobs its /jobs endpoint returns. */
interface Run {
	id: number;
	jobs: Job[] | "unreadable" | "malformed";
}

interface Fixture {
	env: NodeJS.ProcessEnv;
	/** Everything written to $GITHUB_OUTPUT. */
	output: () => string;
	/** One entry per `gh` invocation, each the api path it was given. */
	apiPaths: () => string[];
}

/**
 * A stub `gh` serving `runs` from the workflow-runs endpoint and each run's
 * jobs from its own. `runsBody` overrides the first response wholesale, for
 * the malformed-answer cases; `failing` swaps in a `gh` that cannot be reached.
 */
function fixture(opts: {
	runs?: Run[];
	runsBody?: string;
	failing?: boolean;
	env?: Record<string, string>;
}): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-gate-"));
	temps.push(root);

	const runs = opts.runs ?? [];
	const routes: Record<string, string> = {};
	for (const r of runs) {
		if (r.jobs === "unreadable") continue;
		routes[`/actions/runs/${r.id}/jobs`] = JSON.stringify({
			jobs: r.jobs === "malformed" ? {} : r.jobs,
		});
	}

	const table = path.join(root, "routes.json");
	fs.writeFileSync(table, JSON.stringify(routes));
	const runsFile = path.join(root, "runs.json");
	fs.writeFileSync(
		runsFile,
		opts.runsBody ??
			JSON.stringify({ workflow_runs: runs.map((r) => ({ id: r.id })) }),
	);
	const log = path.join(root, "calls.log");

	/* Serves by substring match on the api path so a test names the endpoint
	 * rather than the query string. An unrouted path exits 1, which is how the
	 * "jobs unreadable" case is spelled. */
	const stub = stubGhScript(
		root,
		`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const p = args[1] || "";
fs.appendFileSync(${JSON.stringify(log)}, p + "\\n");
if (p.includes("/actions/workflows/")) {
  process.stdout.write(fs.readFileSync(${JSON.stringify(runsFile)}, "utf8"));
  process.exit(0);
}
const routes = JSON.parse(fs.readFileSync(${JSON.stringify(table)}, "utf8"));
for (const [suffix, body] of Object.entries(routes))
  if (p.includes(suffix)) { process.stdout.write(body); process.exit(0); }
process.stderr.write("gh: HTTP 404\\n");
process.exit(1);
`,
		{ failing: opts.failing },
	);

	const outputFile = path.join(root, "github_output");
	fs.writeFileSync(outputFile, "");

	return {
		env: {
			...process.env,
			...stub.env,
			GITHUB_REPOSITORY: "owner/repo",
			GITHUB_SHA: SHA,
			GITHUB_RUN_ID: "999",
			GITHUB_OUTPUT: outputFile,
			...opts.env,
		},
		output: () => fs.readFileSync(outputFile, "utf8"),
		apiPaths: () =>
			fs.existsSync(log)
				? fs.readFileSync(log, "utf8").split("\n").filter(Boolean)
				: [],
	};
}

/** Run the gate. */
function run(f: Fixture): string {
	return execFileSync(process.execPath, [SCRIPT], {
		encoding: "utf8",
		env: f.env,
	});
}

const green = (id: number): Run => ({
	id,
	jobs: [
		{ name: "Full suite / Lint and tests", conclusion: "success" },
		{ name: "Full suite / Python", conclusion: "success" },
		{ name: "Document guards", conclusion: "success" },
	],
});

describe("sweep-tests-covered", () => {
	it("skips the suite when an earlier sweep took this sha green", () => {
		const f = fixture({ runs: [green(1)] });
		expect(run(f)).toMatch(/already taken green by run 1/);
		expect(f.output()).toBe("covered=true\n");
	});

	it("tests the tree when no earlier sweep has run on this sha", () => {
		const f = fixture({ runs: [] });
		expect(run(f)).toMatch(/No earlier sweep has a green suite/);
		expect(f.output()).toBe("covered=false\n");
	});

	it("reads the SUITE job, not the run: a red Document guards still covers", () => {
		const f = fixture({
			runs: [
				{
					id: 1,
					jobs: [
						{ name: "Full suite / Lint and tests", conclusion: "success" },
						{ name: "Full suite / Python", conclusion: "success" },
						{ name: "Document guards", conclusion: "failure" },
					],
				},
			],
		});
		run(f);
		expect(f.output()).toBe("covered=true\n");
	});

	it("tests the tree when one of the suite's inner jobs failed", () => {
		const f = fixture({
			runs: [
				{
					id: 1,
					jobs: [
						{ name: "Full suite / Lint and tests", conclusion: "success" },
						{ name: "Full suite / Python", conclusion: "failure" },
					],
				},
			],
		});
		run(f);
		expect(f.output()).toBe("covered=false\n");
	});

	it("does not treat a sweep this gate already skipped as a green one", () => {
		const f = fixture({
			runs: [
				{
					id: 2,
					jobs: [
						{ name: "Full suite / Lint and tests", conclusion: "skipped" },
						{ name: "Full suite / Python", conclusion: "skipped" },
						{ name: "Document guards", conclusion: "success" },
					],
				},
			],
		});
		run(f);
		expect(f.output()).toBe("covered=false\n");
	});

	it("does not count a run carrying no Full suite job at all", () => {
		const f = fixture({
			runs: [
				{ id: 1, jobs: [{ name: "Document guards", conclusion: "success" }] },
			],
		});
		run(f);
		expect(f.output()).toBe("covered=false\n");
	});

	it.each(["cancelled", "stale"])(
		"does not count a suite whose inner job was %s",
		(conclusion) => {
			const f = fixture({
				runs: [
					{
						id: 1,
						jobs: [
							{ name: "Full suite / Lint and tests", conclusion: "success" },
							{ name: "Full suite / Python", conclusion },
						],
					},
				],
			});
			run(f);
			expect(f.output()).toBe("covered=false\n");
		},
	);

	it("does not count a suite still running", () => {
		const f = fixture({
			runs: [
				{
					id: 1,
					jobs: [
						{ name: "Full suite / Lint and tests", conclusion: "success" },
						{ name: "Full suite / Python", conclusion: null },
					],
				},
			],
		});
		run(f);
		expect(f.output()).toBe("covered=false\n");
	});

	it("walks past an uncovering run to a green one behind it", () => {
		const f = fixture({
			runs: [
				{
					id: 3,
					jobs: [{ name: "Full suite / Python", conclusion: "failure" }],
				},
				green(2),
			],
		});
		expect(run(f)).toMatch(/run 2/);
		expect(f.output()).toBe("covered=true\n");
	});

	it("never opens this run itself", () => {
		const f = fixture({ runs: [green(999)] });
		run(f);
		expect(f.output()).toBe("covered=false\n");
		expect(f.apiPaths().filter((p) => p.includes("/jobs"))).toEqual([]);
	});

	it("opens at most MAX_CANDIDATES earlier runs, and asks for no more", () => {
		const f = fixture({
			runs: Array.from({ length: 25 }, (_v, i) => ({
				id: i + 1,
				jobs: [{ name: "Full suite / Python", conclusion: "failure" }],
			})),
		});
		run(f);
		expect(f.output()).toBe("covered=false\n");
		expect(f.apiPaths().filter((p) => p.includes("/jobs"))).toHaveLength(20);
		// The listing page and the cap are one number: a candidate not opened
		// is a re-test.
		expect(f.apiPaths()[0]).toMatch(/per_page=20$/);
	});

	it("fails open when gh cannot reach GitHub at all, and says why", () => {
		const f = fixture({ runs: [green(1)], failing: true });
		expect(run(f)).toMatch(/could not read repos\/.*populate the GH_TOKEN/);
		expect(f.output()).toBe("covered=false\n");
	});

	it("fails open on a runs answer that is not JSON at all", () => {
		const f = fixture({ runsBody: "<html>502</html>" });
		expect(run(f)).toMatch(/could not read repos\//);
		expect(f.output()).toBe("covered=false\n");
	});

	it("fails open, and says why, when $GITHUB_OUTPUT cannot be written", () => {
		const f = fixture({ runs: [green(1)], env: { GITHUB_OUTPUT: "/" } });
		const out = run(f);
		expect(out).toMatch(/already taken green/);
		expect(out).toMatch(/could not write the output/);
	});

	it("still prints its answer with $GITHUB_OUTPUT unset", () => {
		const f = fixture({ runs: [green(1)], env: { GITHUB_OUTPUT: "" } });
		expect(run(f)).toMatch(/covered=true/);
		expect(f.output()).toBe("");
	});

	it("fails open when a run's jobs cannot be read", () => {
		const f = fixture({ runs: [{ id: 1, jobs: "unreadable" }] });
		run(f);
		expect(f.output()).toBe("covered=false\n");
	});

	it("fails open on a jobs answer of the wrong shape", () => {
		const f = fixture({ runs: [{ id: 1, jobs: "malformed" }] });
		run(f);
		expect(f.output()).toBe("covered=false\n");
	});

	it.each([
		["null", '{"workflow_runs":null}'],
		// Truthy but not a list — `?? null` would let this reach `.filter`.
		["an object", '{"workflow_runs":{}}'],
		["absent", "{}"],
	])("fails open on a runs answer that is %s", (_what, runsBody) => {
		const f = fixture({ runsBody });
		run(f);
		expect(f.output()).toBe("covered=false\n");
	});

	it("fails open, and spends no gh call, with the run context unset", () => {
		const f = fixture({ runs: [green(1)], env: { GITHUB_SHA: "" } });
		expect(run(f)).toMatch(/GITHUB_REPOSITORY or GITHUB_SHA is unset/);
		expect(f.output()).toBe("covered=false\n");
		expect(f.apiPaths()).toEqual([]);
	});

	/* The workflow expression is the other half of the gate and no unit test can
	 * execute it, so it is pinned by reading. */
	describe("the wiring in scheduled-checks.yml", () => {
		const wf = yaml.load(
			fs.readFileSync(
				path.join(__dirname, "..", ".github/workflows/scheduled-checks.yml"),
				"utf8",
			),
		) as { jobs: Record<string, Record<string, unknown>> };

		it("gates the suite on the gate job, and fails open", () => {
			expect(wf.jobs.suite.needs).toEqual(["gate"]);
			// `!= 'true'`, never `== 'false'`: a gate that wrote no output must test.
			// `!cancelled()` is what makes a FAILED gate run the suite: without it
			// the implicit `success()` would skip the tree silently.
			expect(wf.jobs.suite.if).toBe(
				expr(
					"!cancelled() && github.repository == 'lucmoseley/workflow-core' && needs.gate.outputs.covered != 'true'",
				),
			);
		});

		it("leaves the document guards ungated, so a skipped sweep still fills its slot", () => {
			// The repo guard only keeps the tracker's frozen copy from running (#1963).
			expect(wf.jobs.documents.if).toBe(
				expr("github.repository == 'lucmoseley/workflow-core'"),
			);
			expect(wf.jobs.documents.needs).toBeUndefined();
		});

		describe("the `Suite passed` verdict main's ruleset requires (#2414)", () => {
			const verdict = wf.jobs.verdict;
			const step = (verdict.steps as { run: string }[])[0];
			const passes = (env: Record<string, string>) => {
				try {
					execFileSync("bash", ["-eo", "pipefail", "-c", step.run], {
						env: { PATH: process.env.PATH, ...env },
						stdio: "pipe",
					});
					return true;
				} catch {
					return false;
				}
			};

			it("runs whatever its needs did, so it never skips into a pass", () => {
				expect(verdict.name).toBe("Suite passed");
				expect(verdict.needs).toEqual(["gate", "suite", "documents"]);
				expect(verdict.if).toBe(
					expr(
						"!cancelled() && github.repository == 'lucmoseley/workflow-core'",
					),
				);
			});

			/* suite result, gate's covered output, documents result → green */
			it.each([
				["success", "", "success", true],
				["skipped", "true", "success", true],
				["skipped", "false", "success", false],
				["skipped", "", "success", false],
				["failure", "", "success", false],
				["cancelled", "", "success", false],
				["success", "", "failure", false],
				["success", "", "skipped", false],
			] as const)("suite %s, covered '%s', documents %s → %s", (...row) => {
				const [suite, covered, documents, isGreen] = row;
				expect(
					passes({ SUITE: suite, COVERED: covered, DOCUMENTS: documents }),
				).toBe(isGreen);
			});
		});

		it("gives the gate the actions: read it needs to see earlier runs", () => {
			expect(wf.jobs.gate.permissions).toMatchObject({ actions: "read" });
		});

		it("runs this script, and the gate publishes the output the suite reads", () => {
			const steps = wf.jobs.gate.steps as { run?: string; id?: string }[];
			expect(
				steps.some((s) => s.run === "node scripts/sweep-tests-covered.js"),
			).toBe(true);
			expect(wf.jobs.gate.outputs).toEqual({
				covered: expr("steps.covered.outputs.covered"),
			});
		});
	});

	it("asks GitHub only for completed runs on this sha", () => {
		const f = fixture({ runs: [green(1)] });
		run(f);
		expect(f.apiPaths()[0]).toBe(
			"repos/owner/repo/actions/workflows/scheduled-checks.yml/runs" +
				`?head_sha=${SHA}&status=completed&per_page=20`,
		);
	});
});
