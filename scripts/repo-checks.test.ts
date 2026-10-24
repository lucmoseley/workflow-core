// @vitest-environment node
/*
 * repo-checks.test.ts — the daily repo-checks run (#1548, spec #1510). Break
 * it and a check runs where its repo never adopted what it reads, two
 * sessions both sweep, a hung check stops the rest, an unexamined check reads
 * as clean, the run spends the sweep-fire budget, or a repo's standing
 * findings issue is filed twice or rewritten on a still day (#1554).
 *
 * Driven through `runInProcess` against a throwaway git repo per case, the
 * core's scripts replaced through WFC_SCRIPT_ROOT by stubs that log their
 * argv and print what the case tells them to, and `gh` by a fake tracker.
 * Each case asserts only what the run leaves behind.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stubGhScript } from "./lib/gh-stub";
import { initGitRepo } from "./lib/git-fixture";
import { guardErrorsLog } from "./lib/guard-errors-log";
import { fakeIssueBody } from "./lib/issue-body-testkit";
import { projectSlug } from "./lib/project-slug";
import { REPO_CHECKS } from "./lib/repo-checks-registry";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.join(__dirname, "repo-checks.js");
/* The names the runner uses, restated so a rename fails here. */
const STAMP = ".repo-checks-read";
const LOCK = ".repo-checks-read.lock";
const RESULT = ".repo-checks.json";
const NOW = "2026-10-13T06:00:00Z";
/* A node launch costs a few hundred ms here, so a case that needs no more
 * runs the four roadmap entries alone. */
const ROADMAP_ONLY = { contract: 1, founder: "F", modules: ["roadmap"] };
/* Every gate open, so every entry launches. */
const ALL = {
	contract: 1,
	founder: "F",
	tracker: "o/r",
	modules: ["roadmap", "governance", "suites"],
	retro: { weeklyCount: 2 },
};
const ALL_INPUTS = [
	"docs/doc-map.md",
	"docs/machinery-superseded.json",
	"scripts/instruction-surface-anchors.json",
	".github/workflows/ci.yml",
];

interface Stub {
	envelope?: object | null;
	/** Printed instead of `envelope` on a launch passed --rescan. */
	onRescan?: object;
	exit?: number;
	sleepMs?: number;
	/** Written to stderr in place of the one diagnostic line. */
	stderr?: string;
}
const sourceLiteral = (envelope: object) =>
	JSON.stringify(JSON.stringify(envelope));

const okEnvelope = (id: string) => ({
	checker: id,
	outcome: "OK",
	exit: 0,
	count: 0,
	keys: [],
	noun: "finding(s)",
	summary: "OK: nothing found.",
});

const findings = (id: string, keys: string[], outcome = "FAIL") => ({
	envelope: {
		...okEnvelope(id),
		outcome: keys.length > 0 ? outcome : "OK",
		count: keys.length,
		keys,
	},
});

const temps: string[] = [];
afterEach(() => {
	for (const t of temps.splice(0))
		fs.rmSync(t, { recursive: true, force: true });
});

function fixture(
	opts: {
		config?: Record<string, unknown>;
		inputs?: string[];
		stubs?: Record<string, Stub>;
		/** Whether the host is workflow-core itself; ALL makes it so. */
		core?: boolean;
	} = {},
) {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "repo-checks-"));
	temps.push(base);
	const root = path.join(base, "repo");
	const hooks = path.join(base, "hooks");
	fs.mkdirSync(hooks);
	initGitRepo(root, hooks);
	fs.mkdirSync(path.join(root, ".claude"));
	fs.writeFileSync(
		path.join(root, ".claude", "workflow-core.json"),
		JSON.stringify(opts.config ?? ROADMAP_ONLY),
	);
	for (const input of opts.inputs ?? (opts.config === ALL ? ALL_INPUTS : [])) {
		fs.mkdirSync(path.dirname(path.join(root, input)), { recursive: true });
		fs.writeFileSync(path.join(root, input), "{}\n");
	}
	if (opts.core ?? opts.config === ALL) {
		fs.mkdirSync(path.join(root, ".claude-plugin"));
		fs.writeFileSync(
			path.join(root, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "workflow-core" }),
		);
	}

	const launches = path.join(base, "launches.log");
	const scripts = path.join(base, "core", "scripts");
	fs.mkdirSync(scripts, { recursive: true });
	const restub = (id: string, stub: Stub) => {
		const entry = REPO_CHECKS.find((e) => e.id === id);
		if (!entry) throw new Error(`no registry entry ${id}`);
		const json = entry.kind === "check";
		const envelope =
			stub.envelope === undefined && json
				? okEnvelope(entry.id)
				: stub.envelope;
		fs.writeFileSync(
			path.join(scripts, entry.script),
			[
				"const fs = require('node:fs');",
				`fs.appendFileSync(${JSON.stringify(launches)}, JSON.stringify([${JSON.stringify(entry.id)}, ...process.argv.slice(2)]) + '\\n');`,
				stub.sleepMs
					? `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${stub.sleepMs});`
					: "",
				envelope
					? `if (process.argv.includes('--json')) process.stdout.write(${stub.onRescan ? `process.argv.includes('--rescan') ? ${sourceLiteral(stub.onRescan)} : ` : ""}${sourceLiteral(envelope)});`
					: "",
				`process.stderr.write(${JSON.stringify(stub.stderr ?? "a diagnostic line\n")});`,
				`process.exit(${stub.exit ?? 0});`,
			].join("\n"),
		);
	};
	for (const { id } of REPO_CHECKS) restub(id, opts.stubs?.[id] ?? {});

	/* A tracker of one repo: `issue list` serves the issues `issue create`
	 * filed, narrowed by `--label` and `--state open`, `issue view` the body the
	 * fake writer last wrote, and every call fails while `gh-fails` exists. */
	const ghLog = path.join(base, "gh.log");
	const issues = path.join(base, "issues.json");
	const ghFails = path.join(base, "gh-fails");
	const issueBody = fakeIssueBody(base);
	const { gh } = stubGhScript(
		base,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"const a = process.argv.slice(2);",
			`fs.appendFileSync(${JSON.stringify(ghLog)}, a.join(' ') + '\\n');`,
			`if (fs.existsSync(${JSON.stringify(ghFails)})) { process.stderr.write('HTTP 502: Bad Gateway\\n'); process.exit(1); }`,
			`const rows = fs.existsSync(${JSON.stringify(issues)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(issues)}, 'utf8')) : [];`,
			"const flag = (f) => a[a.indexOf(f) + 1];",
			"if (a[1] === 'list') process.stdout.write(JSON.stringify(rows.filter((r) => (!a.includes('--label') || r.labels.some((l) => l.name === flag('--label'))) && (flag('--state') !== 'open' || !r.closedAt))));",
			`else if (a[1] === 'view') process.stdout.write(fs.readFileSync(${JSON.stringify(issueBody.bodyFile)}, 'utf8'));`,
			"else if (a[1] === 'create') {",
			"  const number = rows.length + 1;",
			"  const labels = a.flatMap((x, i) => (a[i - 1] === '--label' ? [{ name: x }] : []));",
			"  rows.push({ number, title: flag('--title'), labels, closedAt: null, createdAt: '2026-10-13T06:00:00Z' });",
			`  fs.writeFileSync(${JSON.stringify(issues)}, JSON.stringify(rows));`,
			`  fs.writeFileSync(${JSON.stringify(issueBody.bodyFile)}, flag('--body'));`,
			"  process.stdout.write('https://github.com/o/r/issues/' + number + '\\n');",
			"}",
		].join("\n"),
	);
	const common = path.join(root, ".git");
	return {
		base,
		root,
		common,
		core: path.join(base, "core"),
		restub,
		gh,
		ghLog,
		ghFails,
		issueBody,
		ghCalls: (): string[] =>
			fs.existsSync(ghLog)
				? fs.readFileSync(ghLog, "utf8").split("\n").filter(Boolean)
				: [],
		issues: (): {
			number: number;
			title: string;
			labels: { name: string }[];
		}[] =>
			fs.existsSync(issues) ? JSON.parse(fs.readFileSync(issues, "utf8")) : [],
		issuesFile: issues,
		config: path.join(base, "config"),
		launched: (): string[][] =>
			fs.existsSync(launches)
				? fs
						.readFileSync(launches, "utf8")
						.split("\n")
						.filter(Boolean)
						.map((l) => JSON.parse(l))
				: [],
		result: () =>
			JSON.parse(fs.readFileSync(path.join(common, RESULT), "utf8")),
	};
}
type Fixture = ReturnType<typeof fixture>;

/* vitest.setup.ts injects WFC_MODULES, which would replace the fixture's
 * declared modules. */
function fixtureEnv(f: Fixture, dir: string, env: Record<string, string>) {
	const { WFC_MODULES: _, ...inherited } = process.env;
	return {
		...inherited,
		CLAUDE_PROJECT_DIR: dir,
		CLAUDE_CONFIG_DIR: f.config,
		WFC_CLAUDE_CONFIG_A: f.config,
		WFC_CLAUDE_CONFIG_B: f.config,
		WFC_CLAUDE_CONFIG_C: f.config,
		...env,
	};
}

function run(
	f: Fixture,
	{
		dir = f.root,
		env = {},
	}: { dir?: string; env?: Record<string, string> } = {},
) {
	return runInProcess(SCRIPT, [], {
		cwd: dir,
		env: fixtureEnv(f, dir, {
			WFC_SCRIPT_ROOT: f.core,
			WFC_GH: f.gh,
			WFC_ISSUE_BODY: f.issueBody.script,
			WFC_NOW: NOW,
			...env,
		}),
	});
}

const job = (f: Fixture, id: string) =>
	f.result().jobs.find((j: { job: string }) => j.job === id);
const ids = (launched: string[][]) => launched.map(([id]) => id);
const ROADMAP_IDS = [
	"digest-version",
	"digest-render",
	"roadmap-valid",
	"roadmap-ceilings",
];

describe("repo-checks: gates and order", () => {
	it("launches every entry once, one at a time in the registry's order, a check asked for its --json envelope and a reporter for nothing", () => {
		const f = fixture({ config: ALL });
		const r = run(f);
		expect(r.status).toBe(0);
		expect(ids(f.launched())).toEqual(REPO_CHECKS.map((e) => e.id));
		expect(f.result().jobs.map((j: { job: string }) => j.job)).toEqual(
			REPO_CHECKS.map((e) => e.id),
		);
		const argv = Object.fromEntries(
			f.launched().map(([id, ...args]) => [id, args]),
		);
		expect(argv["roadmap-valid"]).toEqual(["--tree", "--json"]);
		expect(argv.drift).toEqual(["--json"]);
		expect(argv["manual-staleness"]).toEqual([]);
		expect(guardErrorsLog(f.config)).toBe("");
	});

	it("records a module-off, input-absent, key-absent or tracker-less gate SKIP with its reason and launches nothing for it", () => {
		const f = fixture({
			config: { contract: 1, founder: "F", modules: [] },
		});
		const r = run(f);
		expect(r.status).toBe(0);
		expect(f.launched()).toEqual([]);
		expect(job(f, "superseded")).toMatchObject({
			outcome: "SKIP",
			summary: expect.stringContaining('module "governance" is off'),
		});
		expect(job(f, "doc-map").summary).toContain("keeps no docs/doc-map.md");
		expect(job(f, "retro").summary).toContain('no "retro" key');
		expect(job(f, "criteria").summary).toContain("no tracker resolves");
		expect(
			f.result().jobs.every((j: { outcome: string }) => j.outcome === "SKIP"),
		).toBe(true);
	});

	it("runs the core-only re-measure reporter in workflow-core and SKIPs it in an adopter (#1625)", () => {
		const adopter = fixture({ config: ALL, core: false });
		run(adopter);
		expect(ids(adopter.launched())).not.toContain("remeasure");
		expect(job(adopter, "remeasure")).toMatchObject({
			outcome: "SKIP",
			summary: "SKIP: this repo is not workflow-core itself",
		});
		const core = fixture({ config: ROADMAP_ONLY, core: true });
		run(core);
		expect(ids(core.launched())).toContain("remeasure");
	});

	it("launches an input-gated check in workflow-core with its input missing rather than SKIPping it, and SKIPs it in an adopter (#1722)", () => {
		const core = fixture({ config: ROADMAP_ONLY, core: true });
		run(core);
		const adopter = fixture({ config: ROADMAP_ONLY, core: false });
		run(adopter);
		for (const [id, input] of [
			["machinery", "docs/machinery-superseded.json"],
			["instruction-surface", "scripts/instruction-surface-anchors.json"],
		]) {
			expect(ids(core.launched())).toContain(id);
			expect(job(core, id).outcome).not.toBe("SKIP");
			expect(ids(adopter.launched())).not.toContain(id);
			expect(job(adopter, id)).toMatchObject({
				outcome: "SKIP",
				summary: `SKIP: this repo keeps no ${input}`,
			});
		}
	});

	it("runs the tracker checks a declared tracker opens, skipping the one that also needs the roadmap", () => {
		const f = fixture({
			config: { contract: 1, founder: "F", tracker: "o/r", modules: [] },
		});
		run(f);
		expect(ids(f.launched())).toEqual(
			REPO_CHECKS.filter(
				(e) => e.gate.tracker && !e.gate.modules?.includes("roadmap"),
			).map((e) => e.id),
		);
		expect(job(f, "drift").summary).toContain('module "roadmap" is off');
	});
});

describe("repo-checks: the merged result", () => {
	it("keeps each envelope whole, with its repo key, in the git common directory", () => {
		const finding = {
			...okEnvelope("roadmap-valid"),
			outcome: "WARN",
			count: 2,
			keys: ["#1", "#2"],
			summary: "WARN: 2 finding(s)",
		};
		const f = fixture({
			config: { ...ROADMAP_ONLY, tracker: "o/r" },
			stubs: { "roadmap-valid": { envelope: finding, exit: 0 } },
		});
		run(f);
		const result = f.result();
		expect(Object.keys(result).sort()).toEqual(
			["collectedAt", "jobs", "repo", "workflow"].sort(),
		);
		expect(result.repo).toBe("o.r");
		expect(result.collectedAt).toBe("2026-10-13T06:00:00.000Z");
		expect(job(f, "roadmap-valid")).toEqual({
			job: "roadmap-valid",
			...finding,
		});
	});

	it("records MISSING for a check reached that printed no envelope", () => {
		const f = fixture({
			stubs: { "digest-render": { envelope: null, exit: 2 } },
		});
		run(f);
		expect(job(f, "digest-render")).toMatchObject({
			outcome: "MISSING",
			keys: [],
			summary: expect.stringContaining("exit 2: a diagnostic line"),
		});
		expect(ids(f.launched())).toContain("roadmap-valid");
	});

	it("reads a reporter's non-zero exit as BROKEN, logging the reporter", () => {
		const f = fixture({
			config: { contract: 1, founder: "F", modules: ["governance"] },
			stubs: { "cycle-review": { exit: 2 } },
		});
		const r = run(f);
		expect(r.status).toBe(0);
		expect(job(f, "cycle-review").outcome).toBe("BROKEN");
		const log = guardErrorsLog(f.config).trim().split("\n");
		expect(log).toHaveLength(1);
		expect(log[0]).toContain("repo-checks");
		expect(log[0]).toContain("cycle-review exited 2");
	});
	/* Node's own shape for a require that fails at load: the message line
	 * first, the frames after it, the last line a frame (#2480). */
	const loadFailure = [
		"node:internal/modules/cjs/loader:1228",
		"  throw err;",
		"  ^",
		"",
		"Error: Cannot find module './lib/gone'",
		"Require stack:",
		"- /core/scripts/report-red-suite.js",
		"    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)",
		"    at Module.load (node:internal/modules/cjs/loader:1594:32)",
		"",
	].join("\n");

	it("names a reporter's failed module from its error line, never its last stack frame, and keeps the whole stderr (#2480)", () => {
		const f = fixture({
			config: { contract: 1, founder: "F", modules: ["governance"] },
			stubs: { "cycle-review": { exit: 1, stderr: loadFailure } },
		});
		run(f);
		const broken = job(f, "cycle-review");
		expect(broken.summary).toBe(
			"BROKEN: cycle-review exited 1: Error: Cannot find module './lib/gone'",
		);
		expect(broken.stderr).toBe(loadFailure.trim());
	});

	it("keeps the last line that is no stack frame where stderr carries no error line (#2480)", () => {
		const f = fixture({
			config: { contract: 1, founder: "F", modules: ["governance"] },
			stubs: {
				"cycle-review": {
					exit: 2,
					stderr: "gh refused the label\n    at main (x.js:1:1)\n",
				},
			},
		});
		run(f);
		expect(job(f, "cycle-review").summary).toBe(
			"BROKEN: cycle-review exited 2: gh refused the label",
		);
	});
});

describe("repo-checks: ceilings", () => {
	it("kills a check at its ceiling, records it BROKEN, and still runs the next", () => {
		const f = fixture({
			stubs: { "digest-version": { sleepMs: 10_000 } },
		});
		const started = Date.now();
		run(f, { env: { WFC_REPO_CHECKS_CHECK_MS: "1000" } });
		// §X9: a kill: the ceiling kills a real stub process, and the check after it still has to run.
		expect(Date.now() - started).toBeLessThan(8000);
		expect(job(f, "digest-version")).toMatchObject({
			outcome: "BROKEN",
			summary: expect.stringContaining("killed at its 1 s ceiling"),
		});
		expect(job(f, "digest-render").outcome).toBe("OK");
		expect(ids(f.launched())).toEqual(ROADMAP_IDS);
	});

	it("gives clobbers twice the per-check ceiling, which a whole-history window needs (#1628)", () => {
		const f = fixture({
			config: { contract: 1, founder: "F", tracker: "o/r", modules: [] },
			stubs: { cycles: { sleepMs: 1500 }, clobbers: { sleepMs: 1500 } },
		});
		run(f, { env: { WFC_REPO_CHECKS_CHECK_MS: "1000" } });
		expect(job(f, "cycles")).toMatchObject({
			outcome: "BROKEN",
			summary: expect.stringContaining("killed at its 1 s ceiling"),
		});
		expect(job(f, "clobbers").outcome).toBe("OK");
	});

	it("records every check the run's ceiling leaves unreached MISSING", () => {
		const f = fixture({
			stubs: { "digest-version": { sleepMs: 10_000 } },
		});
		run(f, { env: { WFC_REPO_CHECKS_RUN_MS: "800" } });
		expect(ids(f.launched())).toEqual(["digest-version"]);
		expect(job(f, "digest-version")).toMatchObject({
			outcome: "BROKEN",
			summary: expect.stringContaining("killed at the run's ceiling"),
		});
		for (const id of ROADMAP_IDS.slice(1))
			expect(job(f, id).outcome).toBe("MISSING");
	});
});

describe("repo-checks: the clobbers window", () => {
	const trackerOnly = {
		contract: 1,
		founder: "F",
		tracker: "o/r",
		modules: [],
	};
	const sinceFile = ".repo-checks-since.json";
	const clobbersArgv = (f: Fixture) =>
		f
			.launched()
			.filter(([id]) => id === "clobbers")
			.map((argv) => argv.slice(1));
	const windows = (f: Fixture) => clobbersArgv(f).map(([, days]) => days);
	const at = (f: Fixture, iso: string) => run(f, { env: { WFC_NOW: iso } });

	it("passes --since 30 on a repo's first reading and keeps that reading's start beside the stamp", () => {
		const f = fixture({ config: trackerOnly });
		run(f);
		expect(clobbersArgv(f)).toEqual([["--since", "30", "--json"]]);
		expect(
			JSON.parse(fs.readFileSync(path.join(f.common, sinceFile), "utf8")),
		).toEqual({ clobbers: new Date(NOW).toISOString() });
	});

	it("passes the days since the last completed reading's start, rounded up, plus one, a WARN or FAIL counting as completed", () => {
		const f = fixture({
			config: trackerOnly,
			stubs: {
				clobbers: { envelope: { ...okEnvelope("clobbers"), outcome: "WARN" } },
			},
		});
		run(f);
		at(f, "2026-10-14T06:00:00Z");
		f.restub("clobbers", {
			envelope: { ...okEnvelope("clobbers"), outcome: "FAIL" },
		});
		at(f, "2026-10-15T07:00:00Z");
		at(f, "2026-10-16T07:00:00Z");
		expect(windows(f)).toEqual(["30", "2", "3", "2"]);
	});

	it("leaves the window's start where it was through a reading in which clobbers was BROKEN, MISSING or SKIP", () => {
		const f = fixture({ config: trackerOnly });
		const config = path.join(f.root, ".claude", "workflow-core.json");
		run(f);
		f.restub("clobbers", {
			envelope: { ...okEnvelope("clobbers"), outcome: "BROKEN" },
		});
		at(f, "2026-10-14T06:00:00Z");
		f.restub("clobbers", { envelope: null, exit: 2 });
		at(f, "2026-10-15T06:00:00Z");
		fs.writeFileSync(
			config,
			JSON.stringify({ ...trackerOnly, tracker: undefined }),
		);
		at(f, "2026-10-16T06:00:00Z");
		expect(job(f, "clobbers").outcome).toBe("SKIP");
		fs.writeFileSync(config, JSON.stringify(trackerOnly));
		f.restub("clobbers", {});
		at(f, "2026-10-17T06:00:00Z");
		at(f, "2026-10-18T06:00:00Z");
		expect(job(f, "clobbers").outcome).toBe("OK");
		expect(windows(f)).toEqual(["30", "2", "3", "5", "2"]);
	});

	it("widens the window across a multi-day gap between readings", () => {
		const f = fixture({ config: trackerOnly });
		run(f);
		at(f, "2026-10-22T07:00:00Z");
		expect(windows(f)).toEqual(["30", "11"]);
	});

	it("falls back to 30 days on a since file that will not parse, and logs it", () => {
		const f = fixture({ config: trackerOnly });
		fs.writeFileSync(path.join(f.common, sinceFile), "{");
		run(f);
		expect(clobbersArgv(f)).toEqual([["--since", "30", "--json"]]);
		expect(guardErrorsLog(f.config)).toContain(sinceFile);
	});

	/* #1600: an unfixed clobber on an issue nobody edits again would drop out
	 * once the window passed it. */
	const rescans = (f: Fixture) =>
		clobbersArgv(f).map((argv) =>
			argv.includes("--rescan") ? argv[argv.indexOf("--rescan") + 1] : null,
		);
	const clobberKeys = [
		"CLOBBERED\t#8\t2026-10-01T06:00:00Z",
		"SUSPECT\t#12\t2026-10-02T06:00:00Z",
		"SUSPECT\t#8\t2026-10-03T06:00:00Z",
	];

	it("passes no --rescan on a repo's first reading, then the issues of the last completed reading's CLOBBERED and SUSPECT keys", () => {
		const f = fixture({
			config: trackerOnly,
			stubs: { clobbers: findings("clobbers", clobberKeys) },
		});
		run(f);
		at(f, "2026-10-14T06:00:00Z");
		f.restub(
			"clobbers",
			findings("clobbers", ["SUSPECT\t#3\t2026-10-13T06:00:00Z"], "WARN"),
		);
		at(f, "2026-10-15T06:00:00Z");
		f.restub("clobbers", {});
		at(f, "2026-10-16T06:00:00Z");
		at(f, "2026-10-17T06:00:00Z");
		expect(rescans(f)).toEqual([null, "8,12", "8,12", "3", null]);
	});

	it("re-scans a reviewed SUSPECT's issue, whose key the standing issue leaves out (#1700)", () => {
		const f = fixture({
			config: trackerOnly,
			stubs: {
				clobbers: findings(
					"clobbers",
					["SUSPECT-REVIEWED\t#34\t2026-10-01T06:00:00Z"],
					"WARN",
				),
			},
		});
		run(f);
		at(f, "2026-10-14T06:00:00Z");
		expect(rescans(f)).toEqual([null, "34"]);
	});

	it("keeps the previous re-scan list through a reading in which clobbers was BROKEN or MISSING", () => {
		const f = fixture({
			config: trackerOnly,
			stubs: { clobbers: findings("clobbers", clobberKeys) },
		});
		run(f);
		f.restub("clobbers", {
			envelope: { ...okEnvelope("clobbers"), outcome: "BROKEN" },
		});
		at(f, "2026-10-14T06:00:00Z");
		f.restub("clobbers", { envelope: null, exit: 2 });
		at(f, "2026-10-15T06:00:00Z");
		at(f, "2026-10-16T06:00:00Z");
		expect(rescans(f)).toEqual([null, "8,12", "8,12", "8,12"]);
	});

	it("re-scans nothing on a re-scan file that will not parse, and logs it", () => {
		const f = fixture({ config: trackerOnly });
		fs.writeFileSync(path.join(f.common, ".repo-checks-rescan.json"), "{");
		run(f);
		expect(rescans(f)).toEqual([null]);
		expect(guardErrorsLog(f.config)).toContain(".repo-checks-rescan.json");
	});

	/* A bad value would make the check refuse its arguments, and a BROKEN
	 * reading never rewrites the list that broke it. */
	it("passes only the issue numbers in a damaged re-scan list", () => {
		const f = fixture({ config: trackerOnly });
		fs.writeFileSync(
			path.join(f.common, ".repo-checks-rescan.json"),
			JSON.stringify({ clobbers: ["x", 8, -1, 1.5, 12] }),
		);
		run(f);
		expect(rescans(f)).toEqual(["8,12"]);
	});

	it("leaves `npm run check:clobbers` scanning --all as the hand route", () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
		);
		expect(pkg.scripts["check:clobbers"]).toMatch(/--all\b/);
		expect(pkg.scripts["check:clobbers"]).not.toContain("--since");
	});
});

describe("repo-checks: the daily cap and the lock", () => {
	it("reads once a day: a second run inside 24 hours launches nothing", () => {
		const f = fixture();
		run(f);
		const first = f.launched().length;
		const again = run(f, { env: { WFC_NOW: "2026-10-14T05:00:00Z" } });
		expect(again.status).toBe(0);
		expect(again.stderr).toContain("under a day ago; nothing read");
		expect(f.launched()).toHaveLength(first);
		run(f, { env: { WFC_NOW: "2026-10-14T06:00:00Z" } });
		expect(f.launched()).toHaveLength(2 * first);
	});

	it("shares the stamp and the result across worktrees of one repo", () => {
		const f = fixture();
		run(f);
		const wt = path.join(f.base, "wt");
		execFileSync("git", [
			"-C",
			f.root,
			"worktree",
			"add",
			"-q",
			"--detach",
			wt,
		]);
		const r = run(f, { dir: wt });
		expect(r.stderr).toContain("nothing read");
		expect(fs.existsSync(path.join(f.common, STAMP))).toBe(true);
		expect(fs.existsSync(path.join(f.common, RESULT))).toBe(true);
	});

	it("stops at a live lock younger than 45 minutes", () => {
		const f = fixture();
		const lock = path.join(f.common, LOCK);
		fs.writeFileSync(lock, "1");
		const recent = new Date(Date.now() - 30 * 60_000);
		fs.utimesSync(lock, recent, recent);
		const r = run(f);
		expect(r.stderr).toContain("Another run is reading");
		expect(f.launched()).toEqual([]);
		expect(fs.existsSync(lock)).toBe(true);
	});

	it("takes over a lock older than 45 minutes, and releases its own", () => {
		const f = fixture();
		const lock = path.join(f.common, LOCK);
		fs.writeFileSync(lock, "1");
		const old = new Date(Date.now() - 46 * 60_000);
		fs.utimesSync(lock, old, old);
		run(f);
		expect(ids(f.launched())).toEqual(ROADMAP_IDS);
		expect(fs.existsSync(lock)).toBe(false);
	});
});

describe("repo-checks: what it never touches", () => {
	it("leaves .sweep-autofire as it found it, and calls no gh where no tracker resolves", () => {
		const f = fixture();
		const marker = path.join(f.common, ".sweep-autofire");
		fs.writeFileSync(marker, "2026-10-13 2\n");
		const old = new Date(Date.now() - 60_000);
		fs.utimesSync(marker, old, old);
		run(f);
		expect(fs.readFileSync(marker, "utf8")).toBe("2026-10-13 2\n");
		expect(fs.statSync(marker).mtimeMs).toBe(old.getTime());
		expect(fs.existsSync(f.ghLog)).toBe(false);
	});
});

describe("repo-checks: a fault logs one line, says so, and exits 0", () => {
	const failedOpen = (f: Fixture, r: { status: number; stderr: string }) => {
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("FAILED OPEN:");
		expect(r.stderr).toContain("the next day's reading retries");
		const log = guardErrorsLog(f.config).trim().split("\n");
		expect(log).toHaveLength(1);
		return log[0];
	};

	it("launches nothing on a config that will not parse", () => {
		const f = fixture();
		fs.writeFileSync(path.join(f.root, ".claude", "workflow-core.json"), "{");
		failedOpen(f, run(f));
		expect(f.launched()).toEqual([]);
	});

	it("launches nothing on a stamp it cannot read or write", () => {
		const f = fixture();
		fs.mkdirSync(path.join(f.common, STAMP));
		failedOpen(f, run(f));
		expect(f.launched()).toEqual([]);
	});

	it.skipIf(process.getuid?.() === 0)(
		"launches nothing on a lock it cannot write",
		() => {
			const f = fixture();
			fs.chmodSync(f.common, 0o555);
			try {
				failedOpen(f, run(f));
			} finally {
				fs.chmodSync(f.common, 0o755);
			}
			expect(f.launched()).toEqual([]);
		},
	);

	it("names the result it cannot write, and releases its lock", () => {
		const f = fixture();
		fs.mkdirSync(path.join(f.common, RESULT));
		expect(failedOpen(f, run(f))).toContain(RESULT);
		expect(fs.existsSync(path.join(f.common, LOCK))).toBe(false);
	});
});

describe("repo-checks: the notify report (#1553)", () => {
	const replayScript = path.join(__dirname, "replay-notify-reports.js");
	const nextDay = "2026-10-14T07:00:00Z";
	const sessionId = "11111111-2222-3333-4444-555555555555";
	const stubsWith = (keys: string[]) => ({
		"digest-version": findings("digest-version", keys),
	});

	function stored(f: Fixture, configDir = f.config) {
		const dir = path.join(
			configDir,
			"projects",
			projectSlug(fs.realpathSync(f.root)),
			"notify-reports",
		);
		const name = fs
			.readdirSync(dir)
			.find((n) => /^repo-checks-.*\.report\.json$/.test(n));
		if (!name) throw new Error(`no repo-checks report in ${dir}`);
		const file = path.join(dir, name);
		return { dir, file, report: JSON.parse(fs.readFileSync(file, "utf8")) };
	}

	/* The real replay, as `npm run status` runs it: it shows and spends, a
	 * session start holding the report back (#2038). */
	const replay = (f: Fixture, env: Record<string, string> = {}) => {
		const r = runInProcess(replayScript, ["--status"], {
			cwd: f.root,
			env: fixtureEnv(f, f.root, env),
		});
		expect(r.status).toBe(0);
		return r.stderr;
	};

	/* The run always exits 0, a fault included. */
	const runOk = (f: Fixture, opts: Parameters<typeof run>[1] = {}) =>
		expect(run(f, opts).status).toBe(0);

	it("names a check that gained a key, carrying 7 days, its session and one stamp per judged check", () => {
		const f = fixture({ stubs: stubsWith(["k1", "k2"]) });
		runOk(f, { env: { CLAUDE_CODE_SESSION_ID: sessionId } });
		const { report } = stored(f);
		expect(report.text.split("\n")).toEqual([
			expect.stringMatching(/^REPO-CHECKS \(1\) — .*2026-10-13T06:00:00\.000Z/),
			"  digest-version — 2 new finding(s), 2 standing",
			expect.stringContaining(RESULT),
		]);
		expect(report.maxAgeMs).toBe(7 * 24 * 3_600_000);
		expect(report.owner).toBe(sessionId);
		/* Three roadmap checks; the reporter is not judged. */
		expect(Object.keys(report.stamps)).toHaveLength(3);
	});

	it("reads the main checkout from a linked worktree, landing its report where a main-checkout session start replays it (#1555)", () => {
		const f = fixture({ stubs: stubsWith(["k1"]) });
		const wt = path.join(f.base, "wt");
		execFileSync("git", [
			"-C",
			f.root,
			"worktree",
			"add",
			"-q",
			"--detach",
			wt,
		]);
		runOk(f, { dir: wt });
		/* The fixture's config is untracked, so only the main checkout holds
		 * it: a reading of the worktree would skip every roadmap entry. */
		expect(ids(f.launched())).toEqual(ROADMAP_IDS);
		expect(replay(f)).toContain("digest-version — 1 new finding(s)");
	});

	/* A silent reading spends no stamp, so a key that drained and came back
	 * unshown is not news: the delivered set still holds it. */
	it("is silent on a standing or a shrinking set once delivered, and names only what was gained", () => {
		const f = fixture({ stubs: stubsWith(["k1", "k2"]) });
		runOk(f);
		expect(replay(f)).toContain("digest-version — 2 new finding(s)");

		runOk(f, { env: { WFC_NOW: nextDay } });
		expect(stored(f).report.text).toBe("");

		f.restub("digest-version", stubsWith(["k1"])["digest-version"]);
		fs.rmSync(path.join(f.common, STAMP));
		runOk(f, { env: { WFC_NOW: "2026-10-15T07:00:00Z" } });
		expect(stored(f).report.text).toBe("");
		replay(f);

		f.restub("digest-version", stubsWith(["k1", "k2", "k3"])["digest-version"]);
		runOk(f, { env: { WFC_NOW: "2026-10-16T07:00:00Z" } });
		expect(stored(f).report.text).toContain(
			"digest-version — 1 new finding(s), 3 standing",
		);
	});

	it("names a BROKEN or MISSING check at every reading, delivered or not, and never a reporter or a SKIP", () => {
		const f = fixture({
			stubs: {
				"digest-version": {
					envelope: { ...okEnvelope("x"), outcome: "BROKEN" },
				},
				"digest-render": { envelope: null, exit: 2 },
				"roadmap-ceilings": { exit: 2 },
			},
		});
		runOk(f);
		const first = stored(f).report.text;
		expect(first).toMatch(/^REPO-CHECKS \(2\)/);
		expect(first).toContain("  digest-version — ");
		expect(first).toContain("  digest-render — MISSING:");
		expect(first).not.toContain("roadmap-ceilings");
		expect(first).not.toContain("doc-map");
		expect(replay(f)).toContain("digest-render — MISSING:");

		runOk(f, { env: { WFC_NOW: nextDay } });
		expect(stored(f).report.text).toMatch(/^REPO-CHECKS \(2\)/);
		expect(replay(f)).toContain("digest-render — MISSING:");
	});

	it("says only what a check gained once it recovers from a BROKEN reading, never its whole backlog", () => {
		const f = fixture({ stubs: stubsWith(["k1", "k2"]) });
		runOk(f);
		replay(f);
		f.restub("digest-version", {
			envelope: { ...okEnvelope("x"), outcome: "BROKEN" },
		});
		runOk(f, { env: { WFC_NOW: nextDay } });
		expect(replay(f)).toContain("digest-version — ");
		f.restub("digest-version", stubsWith(["k1", "k2", "k3"])["digest-version"]);
		runOk(f, { env: { WFC_NOW: "2026-10-15T07:00:00Z" } });
		expect(stored(f).report.text).toContain(
			"digest-version — 1 new finding(s), 3 standing",
		);
	});

	it("keeps each repo's report and stamps under its own tracker, so one repo's delivery neither silences nor re-shows the other's", () => {
		const a = fixture({
			config: { ...ROADMAP_ONLY, tracker: "o/a" },
			stubs: stubsWith(["k1"]),
		});
		const b = fixture({
			config: { ...ROADMAP_ONLY, tracker: "o/b" },
			stubs: stubsWith(["k1"]),
		});
		const shared = {
			CLAUDE_CONFIG_DIR: a.config,
			WFC_CLAUDE_CONFIG_A: a.config,
			WFC_CLAUDE_CONFIG_B: a.config,
			WFC_CLAUDE_CONFIG_C: a.config,
		};
		runOk(a, { env: shared });
		expect(replay(a, shared)).toContain("o.a's daily checks");
		runOk(b, { env: shared });
		const { file, report } = stored(b, a.config);
		expect(path.basename(file)).toBe("repo-checks-o-b.report.json");
		expect(Object.keys(report.stamps)).toContain(
			"repo-checks.o.b.digest-version",
		);
		expect(report.text).toContain("digest-version — 1 new finding(s)");
		expect(replay(b, shared)).toContain("o.b's daily checks");

		runOk(a, { env: { ...shared, WFC_NOW: nextDay } });
		expect(stored(a, a.config).report.text).toBe("");
	});

	/* #1700: a settled key is no news, but the stamp keeps it, so the hand
	 * route's --notify, sharing the stamp, is not told of it either. */
	it("names no gained settled key, while a gained unsettled key on the same check still speaks", () => {
		const f = fixture({
			config: { contract: 1, founder: "F", tracker: "o/r", modules: [] },
			stubs: {
				criteria: findings(
					"criteria",
					["NO-CRITERIA\t#2", "WAIVED\t#1"],
					"WARN",
				),
			},
		});
		runOk(f);
		expect(stored(f).report.text).toBe("");
		expect(Object.values(stored(f).report.stamps)).toContain(
			JSON.stringify(["NO-CRITERIA\t#2", "WAIVED\t#1"]),
		);

		f.restub(
			"criteria",
			findings("criteria", [
				"NO-CRITERIA\t#2",
				"NO-CRITERIA\t#4",
				"UNVERIFIED\t#5",
				"WAIVED\t#1",
			]),
		);
		runOk(f, { env: { WFC_NOW: nextDay } });
		expect(stored(f).report.text.split("\n")[1]).toBe(
			"  criteria — 1 new finding(s), 1 standing",
		);
	});

	/* #1600: the window has moved past the clobber's issue, so only the
	 * re-scan still finds it — under the same key, so not as news. */
	it("keeps a clobber the re-scan holds out of the report and in the standing issue", () => {
		const key = "CLOBBERED\t#8\t2026-10-01T06:00:00Z";
		const f = fixture({
			config: { contract: 1, founder: "F", tracker: "o/r", modules: [] },
			stubs: { clobbers: findings("clobbers", [key]) },
		});
		runOk(f);
		expect(replay(f)).toContain("clobbers — 1 new finding(s)");
		f.restub("clobbers", {
			envelope: okEnvelope("clobbers"),
			onRescan: findings("clobbers", [key]).envelope,
		});
		const filed = f.issueBody.body();
		runOk(f, { env: { WFC_NOW: nextDay } });
		expect(job(f, "clobbers").keys).toEqual([key]);
		expect(stored(f).report.text).toBe("");
		expect(f.issueBody.body()).toBe(filed);
		expect(filed).toContain("- `clobbers` — FAIL, 1 finding(s).");
	});

	it("reads a stamp that will not parse as nothing delivered, and logs it", () => {
		const f = fixture({
			config: { ...ROADMAP_ONLY, tracker: "o/r" },
			stubs: stubsWith(["k1"]),
		});
		runOk(f);
		replay(f);
		const stamp = path.join(
			stored(f).dir,
			"repo-checks.o.r.digest-version.notified",
		);
		expect(fs.readFileSync(stamp, "utf8")).toBe('["k1"]');
		fs.writeFileSync(stamp, "{not json");
		runOk(f, { env: { WFC_NOW: nextDay } });
		expect(stored(f).report.text).toContain(
			"digest-version — 1 new finding(s), 1 standing",
		);
		expect(guardErrorsLog(f.config)).toContain(
			"delivery stamp repo-checks.o.r.digest-version will not parse",
		);
	});
});

describe("repo-checks: the standing issue (#1554)", () => {
	const title = "Repo checks: standing findings";
	const tracked = { ...ROADMAP_ONLY, tracker: "o/r" };
	const broken = { envelope: { ...okEnvelope("x"), outcome: "BROKEN" } };
	const day = (n: number) =>
		`2026-10-${String(13 + n).padStart(2, "0")}T07:00:00Z`;

	/* The daily stamp is lifted, so each call is a fresh reading. */
	function reading(f: Fixture, n: number) {
		fs.rmSync(path.join(f.common, STAMP), { force: true });
		const r = run(f, { env: { WFC_NOW: day(n) } });
		expect(r.status).toBe(0);
		return r;
	}
	const writes = (f: Fixture) =>
		f
			.ghCalls()
			.filter((c) => /^issue (create|edit|close)/.test(c))
			.concat(f.issueBody.calls());

	it("files exactly one issue on the first reading a check holds a key, labelled takes:triage, with each check's outcome, its own count and hand command", () => {
		const warn = findings("roadmap-valid", ["r1"], "WARN");
		const f = fixture({
			config: tracked,
			stubs: {
				"digest-version": findings("digest-version", ["k1", "k2"]),
				"roadmap-valid": { envelope: { ...warn.envelope, count: 3 } },
			},
		});
		reading(f, 0);
		expect(f.issues()).toEqual([
			expect.objectContaining({
				title,
				labels: [{ name: "takes:triage" }],
			}),
		]);
		const body = f.issueBody.body();
		expect(body).toContain("As of 2026-10-13, 2 check(s) hold findings:");
		expect(body).toContain(
			`- \`digest-version\` — FAIL, 2 finding(s). List them: \`node ${f.core}/scripts/check-digest-version.js\``,
		);
		expect(body).toContain(
			`- \`roadmap-valid\` — WARN, 3 finding(s). List them: \`node ${f.core}/scripts/check-roadmap-valid.js --tree\``,
		);
		expect(body).not.toContain("digest-render");
		expect(guardErrorsLog(f.config)).toBe("");
	});

	it("refreshes that same issue when a key set changes, and never files a second", () => {
		const f = fixture({
			config: tracked,
			stubs: { "digest-version": findings("digest-version", ["k1"]) },
		});
		reading(f, 0);
		f.restub("digest-version", findings("digest-version", ["k1", "k2"]));
		reading(f, 1);
		expect(f.issues()).toHaveLength(1);
		expect(f.issueBody.calls()).toEqual([
			expect.stringMatching(/^replace 1 --file /),
		]);
		expect(f.issueBody.body()).toContain("FAIL, 2 finding(s)");
	});

	it("refreshes the issue triage relabelled, found by its title, and never files a second", () => {
		const f = fixture({
			config: tracked,
			stubs: { "digest-version": findings("digest-version", ["k1"]) },
		});
		reading(f, 0);
		const [filed] = f.issues();
		fs.writeFileSync(
			f.issuesFile,
			JSON.stringify([{ ...filed, labels: [{ name: "takes:implement" }] }]),
		);
		f.restub("digest-version", findings("digest-version", ["k1", "k2"]));
		reading(f, 1);
		expect(f.issues()).toHaveLength(1);
		expect(f.issueBody.body()).toContain("FAIL, 2 finding(s)");
	});

	it("makes no tracker call where a gate switches a clear check off and no held set changed", () => {
		const governed = { ...tracked, modules: ["roadmap", "governance"] };
		const f = fixture({
			config: governed,
			stubs: { "digest-version": findings("digest-version", ["k1"]) },
		});
		reading(f, 0);
		fs.rmSync(f.ghLog);
		fs.writeFileSync(
			path.join(f.root, ".claude", "workflow-core.json"),
			JSON.stringify(tracked),
		);
		reading(f, 1);
		expect(f.ghCalls()).toEqual([]);
	});

	it("makes no tracker call at all on a reading where no key set changed, a BROKEN check counting as unchanged", () => {
		const f = fixture({
			config: tracked,
			stubs: { "digest-version": findings("digest-version", ["k1"]) },
		});
		reading(f, 0);
		fs.rmSync(f.ghLog);
		reading(f, 1);
		f.restub("digest-version", broken);
		reading(f, 2);
		expect(f.ghCalls()).toEqual([]);
		expect(f.issueBody.calls()).toEqual([]);
	});

	it("names a BROKEN check's standing keys from its last completed reading when another check's change rewrites the body", () => {
		const f = fixture({
			config: tracked,
			stubs: { "digest-version": findings("digest-version", ["k1", "k2"]) },
		});
		reading(f, 0);
		f.restub("digest-version", broken);
		f.restub("roadmap-valid", findings("roadmap-valid", ["r1"]));
		reading(f, 1);
		expect(f.issueBody.body()).toContain(
			"- `digest-version` — BROKEN at this reading; 2 finding(s) standing from its last that completed.",
		);
	});

	it("writes the dated all-clear body once every set empties, and never closes the issue", () => {
		const f = fixture({
			config: tracked,
			stubs: { "digest-version": findings("digest-version", ["k1"]) },
		});
		reading(f, 0);
		f.restub("digest-version", findings("digest-version", []));
		reading(f, 1);
		expect(f.issueBody.body()).toContain(
			"As of 2026-10-14, every check is clear: none holds a finding.",
		);
		reading(f, 2);
		expect(f.issues()).toHaveLength(1);
		expect(f.ghCalls().filter((c) => c.startsWith("issue close"))).toEqual([]);
	});

	it("files nothing on a reading where every set is empty and no issue is open", () => {
		const f = fixture({ config: tracked });
		reading(f, 0);
		reading(f, 1);
		expect(f.issues()).toEqual([]);
		expect(writes(f)).toEqual([]);
	});

	it("logs one line naming the issue and gh's error, and exits 0 where gh fails filing, and files at the next reading though nothing changed", () => {
		const f = fixture({
			config: tracked,
			stubs: { "digest-version": findings("digest-version", ["k1"]) },
		});
		fs.writeFileSync(f.ghFails, "");
		reading(f, 0);
		const log = guardErrorsLog(f.config).trim().split("\n");
		expect(log).toHaveLength(1);
		expect(log[0]).toContain(`could not file or refresh "${title}"`);
		expect(log[0]).toContain("HTTP 502");
		expect(f.issues()).toEqual([]);

		fs.rmSync(f.ghFails);
		reading(f, 1);
		expect(f.issues()).toHaveLength(1);
	});

	/* #1700: settled keys stay in the merged result and the hand route. */
	it("leaves settled keys off the body, counting only what is left, and writes the all-clear when only they remain", () => {
		const trackerOnly = {
			contract: 1,
			founder: "F",
			tracker: "o/r",
			modules: [],
		};
		const settled = ["NO-CRITERIA\t#2", "WAIVED\t#1"];
		const f = fixture({
			config: trackerOnly,
			stubs: {
				criteria: findings("criteria", [...settled, "UNVERIFIED\t#5"]),
				clobbers: findings(
					"clobbers",
					["SUSPECT-REVIEWED\t#3\t2026-10-01T06:00:00Z"],
					"WARN",
				),
			},
		});
		reading(f, 0);
		const body = f.issueBody.body();
		expect(body).toContain("As of 2026-10-13, 1 check(s) hold findings:");
		expect(body).toContain("- `criteria` — FAIL, 1 finding(s).");

		f.restub("criteria", findings("criteria", settled, "WARN"));
		reading(f, 1);
		expect(f.issueBody.body()).toContain(
			"As of 2026-10-14, every check is clear: none holds a finding.",
		);
		expect(job(f, "criteria").keys).toEqual(settled);

		const sweep = runInProcess(
			path.join(__dirname, "check-tracker-sweep.js"),
			[],
			{ cwd: f.root, env: fixtureEnv(f, f.root, {}) },
		);
		const listed = `${sweep.stdout}${sweep.stderr}`;
		expect(listed).toContain("    WAIVED  #1");
		expect(listed).toContain("    SUSPECT-REVIEWED  #3");
	});

	it("rewrites the issue, never refiling it, where the landed record will not parse, and logs it", () => {
		const f = fixture({
			config: tracked,
			stubs: { "digest-version": findings("digest-version", ["k1"]) },
		});
		reading(f, 0);
		fs.writeFileSync(path.join(f.common, ".repo-checks-issue.json"), "{");
		reading(f, 1);
		expect(f.issues()).toHaveLength(1);
		expect(guardErrorsLog(f.config)).toContain(".repo-checks-issue.json");
	});
});
