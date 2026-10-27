// @vitest-environment node
/*
 * Every gated check, in a host that has not opted in, exits 0 and prints its
 * one skip line (#2; mantahostels#3515 F3, F11, F12, F19, #33) — and, with the
 * opt-in present, does not print it. The host is an empty git repo with no
 * `.claude/workflow-core.json`.
 *
 * A row here is the whole registration: a newly gated check adds one.
 *
 * Loosen a case and a fresh adopter's first run of a check errors over a module
 * it never switched on, or a host that opted in gets a skip line where the
 * check should have run.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CONFIG = ".claude/workflow-core.json";
const buildModuleLine = (m: string) =>
	`SKIP: module "${m}" is off — ${CONFIG} does not list it under "modules"`;

interface Row {
	script: string;
	args?: string[];
	/** The line printed where the host has not opted in. */
	line: string;
	/** What opts the host in: its modules, or a path laid out under the root. */
	optIn: { modules: string[] } | { path: string; dir?: boolean };
}

/** A check needing several modules names the first, the host having none. */
const byModule = (
	script: string,
	module: string | string[],
	args?: string[],
): Row => {
	const modules = [module].flat();
	return {
		script,
		args,
		line: buildModuleLine(modules[0]),
		optIn: { modules },
	};
};

const MANUAL_HALF = ["governance", "roadmap"];

const ROWS: Row[] = [
	byModule("check-roadmap-pair.js", "roadmap"),
	byModule("check-roadmap-valid.js", "roadmap"),
	byModule("check-digest-version.js", "roadmap"),
	byModule("check-digest-render.js", "roadmap"),
	byModule("check-issue-card-drift.js", "roadmap"),
	byModule("report-roadmap-ceilings.js", "roadmap", ["--dry-run"]),
	byModule("card-restatement-report.js", MANUAL_HALF, ["--audit"]),
	byModule("check-manual-freshness.js", MANUAL_HALF),
	byModule("check-cleared-trackers.js", MANUAL_HALF),
	byModule("check-superseded-values.js", "governance"),
	byModule("check-capture-drain.js", "governance"),
	byModule("report-doc-map-budget.js", "governance", ["--dry-run"]),
	byModule("report-manual-staleness.js", MANUAL_HALF),
	byModule("report-cycle-review-due.js", "governance"),
	byModule("check-website-copy.js", "site"),
	{
		script: "check-skill-body-size.js",
		line: "SKIP: this repo has no .claude/skills or .claude/commands — no skill or command bodies to check",
		optIn: { path: ".claude/skills", dir: true },
	},
	{
		script: "check-workflow-permissions.js",
		line: "SKIP: this repo has no .github/workflows — no workflows to check",
		optIn: { path: ".github/workflows", dir: true },
	},
	{
		script: "check-always-loaded-pass.js",
		line: "SKIP: this repo has no docs/always-loaded-passes.json — no pool-pass cadence to check",
		optIn: { path: "docs/always-loaded-passes.json" },
	},
	{
		script: "check-user-settings-drift.js",
		line: "SKIP: this repo has no docs/claude-user-settings.md — no settings snapshot to compare",
		optIn: { path: "docs/claude-user-settings.md" },
	},
	{
		script: "check-vendored-skills.js",
		line: "SKIP: this repo has no .agents/vendored-skill-edits.json and no .agents/skills — nothing vendored to check",
		optIn: { path: ".agents/skills", dir: true },
	},
];

let host: string;

beforeEach(() => {
	host = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gated-")));
	execFileSync("git", ["init", "-q", host]);
});
afterEach(() => {
	fs.rmSync(host, { recursive: true, force: true });
});

const run = (row: Row, env: Record<string, string | undefined> = {}) => {
	const r = spawnSync(
		process.execPath,
		[path.resolve(__dirname, row.script), ...(row.args ?? [])],
		{
			cwd: host,
			encoding: "utf8",
			timeout: 60_000,
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: host,
				// Never the founder's own ~/.claude: a gh or transcript read is not
				// what these cases are about.
				HOME: host,
				WFC_GH: path.join(host, "no-gh"),
				WFC_MODULES: undefined,
				...env,
			},
		},
	);
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

describe.each(ROWS)("$script", (row) => {
	it("exits 0 with its one skip line where the host has not opted in", () => {
		const r = run(row);
		expect(r.out).toContain(row.line);
		expect(r.status).toBe(0);
	});

	it("does not print that line once the host opts in", () => {
		let env = {};
		if ("modules" in row.optIn) {
			fs.mkdirSync(path.join(host, ".claude"), { recursive: true });
			fs.writeFileSync(
				path.join(host, CONFIG),
				JSON.stringify({ modules: row.optIn.modules }),
			);
		} else {
			const at = path.join(host, row.optIn.path);
			fs.mkdirSync(row.optIn.dir ? at : path.dirname(at), { recursive: true });
			if (!row.optIn.dir) fs.writeFileSync(at, "{}\n");
			// The layout rows read the module list nowhere; keep the suite default.
			env = { WFC_MODULES: process.env.WFC_MODULES };
		}
		expect(run(row, env).out).not.toContain(row.line);
	});
});
