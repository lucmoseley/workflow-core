// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shellQuote } from "./lib/sh-quote.js";

const ROOT = path.join(__dirname, "..");
const STEP = path.join(ROOT, "scripts", "bisect-step.sh");

const dirs: string[] = [];

afterEach(() => {
	for (const d of dirs.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

interface Exits {
	ci?: number;
	biome?: number;
	biomeMissing?: boolean;
	sh?: number;
	test?: number;
	pip?: number;
	testpy?: number;
	node?: Record<string, number>;
}

const DOC_CALLS = [
	"node scripts/check-doc-map.js",
	"node scripts/check-doc-map-markers.js",
	"node scripts/check-guard-registry.js",
];

const LINT_CALLS = [
	"npm ci",
	"node_modules/.bin/biome ci .",
	"npm run check:sh",
	"npm run test -- --full=coverage",
];

const PY_CALLS = [
	"python3 -m pip install --require-hashes --only-binary :all: -r requirements-dev.txt",
	"npm run test:py -- --full",
];

function stubTools({
	ci = 0,
	biome = 0,
	biomeMissing = false,
	sh = 0,
	test = 0,
	pip = 0,
	testpy = 0,
	node = {},
}: Exits) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bisect-step-"));
	dirs.push(dir);
	const stubs = path.join(dir, "stubs");
	const pathDecoys = path.join(dir, "path-decoys");
	fs.mkdirSync(stubs);
	fs.mkdirSync(pathDecoys);

	const write = (name: string, body: string, into = stubs) =>
		fs.writeFileSync(
			path.join(into, name),
			`#!/usr/bin/env bash\necho ${shellQuote(`${name} `)}"$*" >> ${shellQuote(`${dir}/calls`)}\n${body}\n`,
			{ mode: 0o755 },
		);

	write(
		"npm",
		`case "$*" in
  ci)             exit ${ci} ;;
  "run check:sh") exit ${sh} ;;
  "run test:py -- --full") exit ${testpy} ;;
  *)              exit ${test} ;;
esac`,
	);
	write("npx", `echo "UNEXPECTED npx" >&2\nexit 66`, pathDecoys);

	const localBin = path.join(dir, "node_modules", ".bin");
	fs.mkdirSync(localBin, { recursive: true });
	if (!biomeMissing)
		fs.writeFileSync(
			path.join(localBin, "biome"),
			`#!/usr/bin/env bash\necho "$0 $*" >> ${shellQuote(`${dir}/calls`)}\nexit ${biome}\n`,
			{ mode: 0o755 },
		);
	write(
		"python3",
		`case "$*" in
  "-m pip install --require-hashes --only-binary :all: -r requirements-dev.txt") exit ${pip} ;;
  *) exit 0 ;;
esac`,
	);
	const arms = Object.entries(node)
		.map(([script, code]) => `  ${shellQuote(script)}) exit ${code} ;;`)
		.join("\n");
	write("node", `case "\${1:-}" in\n${arms}\n  *) exit 0 ;;\nesac`);

	return { dir, stubs, pathDecoys };
}

function run(t: ReturnType<typeof stubTools>, checkSet?: string) {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: `${t.pathDecoys}:${process.env.PATH}`,
		WFC_NPM: path.join(t.stubs, "npm"),
		WFC_PYTHON: path.join(t.stubs, "python3"),
		WFC_NODE: path.join(t.stubs, "node"),
	};
	const cwd = t.dir;
	delete env.BISECT_CHECK_SET;
	if (checkSet !== undefined) env.BISECT_CHECK_SET = checkSet;

	try {
		execFileSync("bash", [STEP], { cwd, env, encoding: "utf8", stdio: "pipe" });
		return 0;
	} catch (e) {
		return (e as { status: number }).status;
	}
}

const readCalls = (dir: string) =>
	fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n");

describe("bisect-step.sh — the default check set", () => {
	it("exits 0 when the install and the whole job pass — a good commit", () => {
		const t = stubTools({});
		expect(run(t)).toBe(0);
	});

	it("exits 125 — skip, never bad — when the install fails, running nothing after the install", () => {
		const t = stubTools({ ci: 1 });
		expect(run(t)).toBe(125);
		expect(readCalls(t.dir)).toEqual(["npm ci"]);
	});

	it("calls a commit bad when Biome fails, and stops before the rest", () => {
		const t = stubTools({ biome: 1 });
		expect(run(t)).toBe(1);
		expect(readCalls(t.dir)).toEqual([
			"npm ci",
			"node_modules/.bin/biome ci .",
		]);
	});

	it("exits 125 — skip, never bad — when the Biome binary is absent, running nothing after the install", () => {
		const t = stubTools({ biomeMissing: true });
		expect(run(t)).toBe(125);
		expect(readCalls(t.dir)).toEqual(["npm ci"]);
	});

	it("calls a commit bad when shellcheck fails, and stops before the suite", () => {
		const t = stubTools({ sh: 2 });
		expect(run(t)).toBe(2);
		expect(readCalls(t.dir)).toEqual([
			"npm ci",
			"node_modules/.bin/biome ci .",
			"npm run check:sh",
		]);
	});

	it("calls a commit bad when the suite fails", () => {
		const t = stubTools({ test: 1 });
		expect(run(t)).toBe(1);
		expect(readCalls(t.dir)).toContain("npm run test -- --full=coverage");
	});

	it("never lets the suite's own 125 reach bisect as a skip", () => {
		const t = stubTools({ test: 125 });
		expect(run(t)).toBe(1);
	});

	it("runs the lint-and-tests trio when BISECT_CHECK_SET is unset", () => {
		const t = stubTools({});
		expect(run(t)).toBe(0);
		expect(readCalls(t.dir)).toEqual(LINT_CALLS);
	});

	it("runs the lint-and-tests trio when BISECT_CHECK_SET is set but empty", () => {
		const t = stubTools({});
		expect(run(t, "")).toBe(0);
		expect(readCalls(t.dir)).toEqual(LINT_CALLS);
	});
});

describe("bisect-step.sh — the python check set", () => {
	it("runs the pip install and the pytest suite, and nothing from the Node job", () => {
		const t = stubTools({});
		expect(run(t, "python")).toBe(0);
		expect(readCalls(t.dir)).toEqual(PY_CALLS);
	});

	it("runs no npm ci — the pip install is this job's install step", () => {
		const t = stubTools({});
		run(t, "python");
		expect(readCalls(t.dir)).not.toContain("npm ci");
	});

	it("exits 125 — untestable — when the pinned requirements cannot resolve, running nothing after the install", () => {
		const t = stubTools({ pip: 1 });
		expect(run(t, "python")).toBe(125);
		expect(readCalls(t.dir)).toEqual([PY_CALLS[0]]);
	});

	it("calls a commit bad when pytest fails", () => {
		const t = stubTools({ testpy: 1 });
		expect(run(t, "python")).toBe(1);
	});

	it("never lets pytest's own 125 reach bisect as a skip", () => {
		const t = stubTools({ testpy: 125 });
		expect(run(t, "python")).toBe(1);
	});
});

describe("bisect-step.sh — the documents check set", () => {
	it("runs the document guards in the job's own order", () => {
		const t = stubTools({});
		expect(run(t, "documents")).toBe(0);
		expect(readCalls(t.dir)).toEqual(DOC_CALLS);
	});

	it("installs nothing — which is most of what makes this set cheap", () => {
		const t = stubTools({});
		run(t, "documents");
		expect(readCalls(t.dir)).not.toContain("npm ci");
		expect(readCalls(t.dir)).not.toContain(PY_CALLS[0]);
	});

	it("calls a commit bad when a gate fails, and stops there", () => {
		const t = stubTools({
			node: { "scripts/check-doc-map.js": 1 },
		});
		expect(run(t, "documents")).toBe(1);
		const failed = DOC_CALLS.indexOf("node scripts/check-doc-map.js");
		expect(readCalls(t.dir)).toEqual(DOC_CALLS.slice(0, failed + 1));
	});
});

describe("bisect-step.sh — check-set selection", () => {
	it("runs all three sets in order under `all`, stopping at the first failure", () => {
		const t = stubTools({});
		expect(run(t, "all")).toBe(0);
		expect(readCalls(t.dir)).toEqual([
			...LINT_CALLS,
			...PY_CALLS,
			...DOC_CALLS,
		]);
	});

	it("stops `all` at the Node install and reports untestable, not bad", () => {
		const t = stubTools({ ci: 1 });
		expect(run(t, "all")).toBe(125);
		expect(readCalls(t.dir)).toEqual(["npm ci"]);
	});

	it("stops `all` before the documents when the pytest suite fails", () => {
		const t = stubTools({ testpy: 3 });
		expect(run(t, "all")).toBe(3);
		expect(readCalls(t.dir)).toEqual([...LINT_CALLS, ...PY_CALLS]);
	});

	it("never runs the manual-staleness reporter, in any set", () => {
		for (const set of ["lint-and-tests", "python", "documents", "all"]) {
			const t = stubTools({});
			run(t, set);
			expect(readCalls(t.dir).join("\n")).not.toContain(
				"report-manual-staleness",
			);
		}
	});

	it("aborts the bisect on an unrecognised check set rather than judging", () => {
		const t = stubTools({});
		expect(run(t, "lint-and-test")).toBe(128);
	});
});

describe("bisect.yml", () => {
	const wf = fs.readFileSync(
		path.join(ROOT, ".github", "workflows", "bisect.yml"),
		"utf8",
	);
	const split = (wanted: boolean) =>
		wf
			.split("\n")
			.filter((l) => /^\s*#/.test(l) === wanted)
			.join("\n");
	const comments = split(true);
	const runtime = split(false);

	it("is workflow_dispatch only — never a schedule, push or failure trigger", () => {
		expect(wf).toMatch(/^on:\n {2}workflow_dispatch:/m);
		expect(wf).not.toMatch(/^ {2}(schedule|push|pull_request|workflow_run):/m);
	});

	it("says in its own comment that a flaky test makes the result wrong", () => {
		expect(comments).toMatch(/flak/i);
	});

	it("runs the step script rather than inlining a second copy of it", () => {
		expect(runtime).toMatch(
			/git bisect run bash "\$RUNNER_TEMP\/bisect-step\.sh"/,
		);
	});

	it("copies the step script out of the worktree before starting", () => {
		expect(runtime).toMatch(/cp scripts\/bisect-step\.sh "\$RUNNER_TEMP/);
	});

	it("checks out full history — a shallow clone cannot be bisected", () => {
		expect(runtime).toMatch(/^\s+fetch-depth: 0$/m);
	});

	it("defaults the good sha to the last green scheduled run on main", () => {
		expect(runtime).toMatch(
			/gh run list --workflow scheduled-checks\.yml --branch main/,
		);
		expect(runtime).toMatch(/--status success/);
	});

	it("installs no dependencies itself — every step does its own install", () => {
		expect(wf).not.toMatch(/^\s+run: npm ci$/m);
	});

	it("offers the four check sets, defaulting to lint-and-tests", () => {
		expect(runtime).toMatch(/^ {6}checks:$/m);
		expect(runtime).toMatch(/^ {8}type: choice$/m);
		expect(runtime).toMatch(/^ {8}default: lint-and-tests$/m);
		for (const set of ["lint-and-tests", "python", "documents", "all"])
			expect(runtime).toMatch(new RegExp(`^ {10}- ${set}$`, "m"));
	});

	it("passes the check set through the environment, never into a run body", () => {
		expect(runtime).toMatch(
			/^\s+BISECT_CHECK_SET: \$\{\{ inputs\.checks \}\}$/m,
		);
		for (const line of wf
			.split("\n")
			.filter((l) => l.includes("inputs.checks")))
			expect(line).toMatch(/^\s+[A-Z_]+: \$\{\{ inputs\.checks \}\}$/);
	});

	it("pre-flights the bad endpoint before it starts the bisect", () => {
		const checkout = runtime.indexOf('git checkout --quiet --detach "$BAD"');
		const preflight = runtime.indexOf(
			'bash "$RUNNER_TEMP/bisect-step.sh" || preflight=$?',
		);
		const start = runtime.indexOf("git bisect start");
		expect(checkout).toBeGreaterThan(-1);
		expect(preflight).toBeGreaterThan(checkout);
		expect(start).toBeGreaterThan(preflight);
	});

	it("aborts, naming all three causes, when the pre-flight comes back good", () => {
		expect(runtime).toMatch(/preflight=cannot-reproduce/);
		expect(runtime).toMatch(/wrong check set was selected/);
		expect(runtime).toMatch(/mislabelled/);
		expect(runtime).toMatch(/flake/);
	});

	it("aborts when the bad endpoint is itself untestable", () => {
		expect(runtime).toMatch(/preflight=untestable/);
		expect(runtime).toMatch(/\[ "\$preflight" -eq 125 \]/);
	});

	it("reports a pre-flight abort in the summary, and names no culprit there", () => {
		const abort = runtime.search(/if \[ -n "\$\{PREFLIGHT:-\}" \]; then/);
		const culprit = runtime.search(/elif \[ -n "\$\{CULPRIT:-\}" \]; then/);
		expect(abort).toBeGreaterThan(-1);
		expect(culprit).toBeGreaterThan(abort);
		expect(runtime).toMatch(/Aborted before bisecting/);
	});

	it("names the check set it judged on in the run summary", () => {
		expect(runtime).toMatch(/Check set \| .*CHECKS:-lint-and-tests/);
	});
});
