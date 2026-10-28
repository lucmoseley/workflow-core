// @vitest-environment node
/*
 * Pins the exit code `scripts/bisect-step.sh` hands `git bisect run` for each
 * outcome and check set, and the bisect.yml text that calls it.
 *
 * `scripts/bisect-step.sh` is the body `git bisect run` executes at every step
 * of the hand-fired bisect (mantahostels#947). Its exit code is the only thing bisect
 * reads, and the three codes mean different things: 0 good, 125 skip this
 * commit entirely, anything else bad. Getting 125 wrong is what makes a bisect
 * name the wrong commit — a commit whose install cannot resolve is untestable,
 * not broken.
 *
 * Since mantahostels#967 the checks that decide are selectable, because judging on one CI
 * job's checks when the red lives in another does not fail loudly: git never
 * re-tests either endpoint, so every commit returns good and git names the BAD
 * ENDPOINT — usually the tip of main — as the first bad commit, exiting 0.
 *
 * npm, python3 and node are stubbed at their §N7 vars (WFC_NPM, WFC_PYTHON,
 * WFC_NODE) so the exit codes are ours to drive (#2266); npx is a decoy on PATH.
 * UNVERIFIED, and deliberately: the workflow that calls this, since testing that
 * means running a bisect on a runner (AGENTS.md, mutation rule). The pre-flight
 * is asserted as workflow text for the same reason.
 *
 * Twenty-three mutations run against these tests, each confirmed to fail the named
 * test and then reversed with the inverse edit.
 *
 * The original eight: `exit 125` on a failed install → `exit 1`; `125) exit 1` →
 * `125) exit 125`; `fetch-depth: 0` → `1`; a `schedule:` trigger added to
 * bisect.yml; the Biome check dropped from the step; the short-circuit between
 * the three checks removed; `--branch main` dropped from the good-sha
 * resolution; and the copy-out of the step script replaced by `true`.
 *
 * The fourteen added at mantahostels#967: the lint-and-tests fallback for an unset check set
 * removed; `npm ci` added to the python set; the python set's untestable `return
 * 125` → `return 1`; the manual-staleness reporter added to the documents set;
 * the needle-drift finding fold removed; needle-drift forced always-good;
 * check-guard-registry.js dropped from the documents set; the unknown-set `exit
 * 128` → `exit 1`; `run_check`'s 125 fold removed; and in bisect.yml the
 * `BISECT_CHECK_SET` env line removed, the pre-flight invocation removed, the
 * cannot-reproduce abort removed, the check-set summary row removed, and the
 * choice input's `default: lint-and-tests` → `default: all`.
 *
 * The one added at #2266: a documents gate's `"$node_bin"` → bare `node`.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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
	/* Omit the Biome binary entirely — the pre-Biome half of the range. */
	biomeMissing?: boolean;
	sh?: number;
	test?: number;
	pip?: number;
	testpy?: number;
	/* Exit code per `node scripts/<file>`, keyed by the script path. Any script
	 * not named here exits 0. */
	node?: Record<string, number>;
}

/* The document guards' gates, in the order roadmap-digest.yml's job runs them. */
const DOC_CALLS = [
	"node scripts/check-digest-version.js",
	"node scripts/check-roadmap-valid.js --tree",
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

/* Fake `npm`, `python3` and `node` that exit with whatever the caller asked for,
 * per subcommand, and record the invocations they saw. They sit off PATH, so a
 * bare call that skips its var reaches the real binary and fails the test. */
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
			`#!/usr/bin/env bash\necho "${name} $*" >> "${dir}/calls"\n${body}\n`,
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
	// Poisoned deliberately (mantahostels#1538): nothing here should call npx at all, so a
	// reintroduced one is loud rather than a live registry fetch from a unit test.
	write("npx", `echo "UNEXPECTED npx" >&2\nexit 66`, pathDecoys);

	// Biome is called by path, not as `npx biome` (mantahostels#1538), so its stub has to sit
	// where the script looks — a node_modules/.bin inside the cwd `run` hands it.
	// One left on PATH would never be consulted.
	const localBin = path.join(dir, "node_modules", ".bin");
	fs.mkdirSync(localBin, { recursive: true });
	if (!biomeMissing)
		fs.writeFileSync(
			path.join(localBin, "biome"),
			`#!/usr/bin/env bash\necho "$0 $*" >> "${dir}/calls"\nexit ${biome}\n`,
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
		.map(([script, code]) => `  "${script}") exit ${code} ;;`)
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
	// The biome stub sits in this dir's node_modules/.bin, so the script must run
	// from here — a relative call from anywhere else reaches the REAL biome in
	// whatever cwd vitest chose.
	const cwd = t.dir;
	// Never inherit a real one: it would silently re-point every default test.
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
		// And it stops there: anything run against a half-installed tree would
		// fail for the install's reason and be recorded as this commit's.
		expect(readCalls(t.dir)).toEqual(["npm ci"]);
	});

	// The three checks below are ci.yml's `Lint and tests` job. A sweep goes red
	// on any of them, so judging on the suite alone walks a lint-only red to
	// a confidently wrong culprit.
	it("calls a commit bad when Biome fails, and stops before the rest", () => {
		const t = stubTools({ biome: 1 });
		expect(run(t)).toBe(1);
		expect(readCalls(t.dir)).toEqual([
			"npm ci",
			"node_modules/.bin/biome ci .",
		]);
	});

	// Absent is untestable, never bad. Every commit before Biome was adopted
	// installs cleanly without it, and a missing path exits 127 — which run_check
	// does not fold, so without this arm bisect reads the whole pre-Biome half of
	// the range as bad and names a commit adjacent to the real one (mantahostels#1538).
	it("exits 125 — skip, never bad — when the Biome binary is absent, running nothing after the install", () => {
		const t = stubTools({ biomeMissing: true });
		expect(run(t)).toBe(125);
		// And it stops there, exactly as a failed install does.
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
		// 125 from the suite would silently skip a genuinely bad commit.
		const t = stubTools({ test: 125 });
		expect(run(t)).toBe(1);
	});

	it("runs the lint-and-tests trio when BISECT_CHECK_SET is unset", () => {
		// A direct local run, and any caller predating mantahostels#967, must behave exactly
		// as this script always has.
		const t = stubTools({});
		expect(run(t)).toBe(0);
		expect(readCalls(t.dir)).toEqual(LINT_CALLS);
	});

	it("runs the lint-and-tests trio when BISECT_CHECK_SET is set but empty", () => {
		// What an unset workflow_dispatch input actually delivers.
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
		// ci.yml's Python job has no setup-node and no npm ci; `run-pytest.js`
		// reads nothing out of node_modules.
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
		// Up to and including the failing gate, and nothing after it. Sliced by
		// lookup rather than a literal count, so inserting a step ahead of it —
		// mantahostels#974 added one — moves the boundary instead of reddening this case.
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
		// It files and refreshes a GitHub issue rather than failing, is gated to
		// the schedule, and bisect.yml grants no `issues: write` — so running it
		// would spam the tracker and fail for a reason unrelated to the commit.
		for (const set of ["lint-and-tests", "python", "documents", "all"]) {
			const t = stubTools({});
			run(t, set);
			expect(readCalls(t.dir).join("\n")).not.toContain(
				"report-manual-staleness",
			);
		}
	});

	it("aborts the bisect on an unrecognised check set rather than judging", () => {
		// 128+ aborts. Falling back to the default would judge on checks the
		// operator did not ask for — the failure this ticket exists to close.
		const t = stubTools({});
		expect(run(t, "lint-and-test")).toBe(128);
	});
});

describe("bisect.yml", () => {
	const wf = fs.readFileSync(
		path.join(ROOT, ".github", "workflows", "bisect.yml"),
		"utf8",
	);
	/* Comment lines only, and everything but. Every assertion about the
	 * workflow's prose must not be satisfiable by its runtime output, and vice
	 * versa. */
	const split = (wanted: boolean) =>
		wf
			.split("\n")
			.filter((l) => /^\s*#/.test(l) === wanted)
			.join("\n");
	const comments = split(true);
	const runtime = split(false);

	it("is workflow_dispatch only — never a schedule, push or failure trigger", () => {
		// mantahostels#907 ruled the bisect is fired by hand after a human reads the range
		// report: an automatic one names a flaky test's commit confidently.
		expect(wf).toMatch(/^on:\n {2}workflow_dispatch:/m);
		expect(wf).not.toMatch(/^ {2}(schedule|push|pull_request|workflow_run):/m);
	});

	it("says in its own comment that a flaky test makes the result wrong", () => {
		expect(comments).toMatch(/flak/i);
	});

	it("runs the step script rather than inlining a second copy of it", () => {
		// The `run:` body, not a comment mentioning the path.
		expect(runtime).toMatch(
			/git bisect run bash "\$RUNNER_TEMP\/bisect-step\.sh"/,
		);
	});

	it("copies the step script out of the worktree before starting", () => {
		// Bisect checks out commits predating the script, where an in-tree path
		// does not exist and every step fails identically.
		expect(runtime).toMatch(/cp scripts\/bisect-step\.sh "\$RUNNER_TEMP/);
	});

	it("checks out full history — a shallow clone cannot be bisected", () => {
		// Anchored past any comment: the reason for the setting is written
		// directly above it and would satisfy a looser match on its own.
		expect(runtime).toMatch(/^\s+fetch-depth: 0$/m);
	});

	it("defaults the good sha to the last green scheduled run on main", () => {
		expect(runtime).toMatch(
			/gh run list --workflow scheduled-checks\.yml --branch main/,
		);
		expect(runtime).toMatch(/--status success/);
	});

	it("installs no dependencies itself — every step does its own install", () => {
		// One install at the top would test every commit in the range against
		// the newest lockfile rather than the one it shipped with.
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
		// A `${{ inputs.x }}` inside `run:` is substituted before bash sees it,
		// so a crafted input would execute in the step.
		expect(runtime).toMatch(
			/^\s+BISECT_CHECK_SET: \$\{\{ inputs\.checks \}\}$/m,
		);
		for (const line of wf
			.split("\n")
			.filter((l) => l.includes("inputs.checks")))
			expect(line).toMatch(/^\s+[A-Z_]+: \$\{\{ inputs\.checks \}\}$/);
	});

	it("pre-flights the bad endpoint before it starts the bisect", () => {
		// git never re-tests an endpoint, so a check set that cannot reproduce
		// the red names the bad sha — the tip of main — as the culprit and exits
		// 0. Running the step once against that sha is what makes it loud.
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
		// A red job whose explanation lives only in a step log is the shape this
		// ticket is closing, not one to reintroduce.
		// Regex rather than a literal: a shell `${...}` inside a JS string trips
		// Biome's noTemplateCurlyInString.
		const abort = runtime.search(/if \[ -n "\$\{PREFLIGHT:-\}" \]; then/);
		const culprit = runtime.search(/elif \[ -n "\$\{CULPRIT:-\}" \]; then/);
		expect(abort).toBeGreaterThan(-1);
		expect(culprit).toBeGreaterThan(abort);
		expect(runtime).toMatch(/Aborted before bisecting/);
	});

	it("names the check set it judged on in the run summary", () => {
		// An answer read weeks later has to carry its own scope.
		expect(runtime).toMatch(/Check set \| .*CHECKS:-lint-and-tests/);
	});
});
