// @vitest-environment node
/*
 * The reporter driven against stub Vitest shapes, so what it hands the teardown
 * can be asserted without a suite run to produce it.
 *
 * The invariant asserted hardest is mantahostels#1230's: a scope it cannot read records
 * NOTHING and never throws, because throwing out of `onTestRunEnd` would redden
 * a suite that has already passed.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubLaunch } from "./lib/suite-handoff-testkit";
import TestPassReporter from "./vitest-pass-reporter.js";

/*
 * Reached the way the reporter reaches it. An ESM `import` of this CommonJS
 * module gets a SEPARATE instance under Vite, so the verdict the reporter sets
 * would be invisible here and every assertion would read null.
 */
const { readMarkers, readFailures } = createRequire(import.meta.url)(
	"./lib/test-pass-marker.js",
);
const { takeRunReport, fillRunReport } = createRequire(import.meta.url)(
	"./lib/suite-handoff.js",
);

type State = "passed" | "skipped" | "failed";

const module_ = (moduleId: string, states: State[]) => ({
	moduleId,
	children: {
		allTests: () => states.map((state) => ({ result: () => ({ state }) })),
	},
});

const ctx = (over: Record<string, unknown> = {}) => ({
	config: { testNamePattern: undefined },
	filenamePattern: [],
	globTestSpecifications: async () => [
		{ moduleId: "a.test.ts" },
		{ moduleId: "b.test.ts" },
	],
	...over,
});

/** Whatever the reporter wrote to stdout during `body`. */
async function captured(body: () => Promise<void>) {
	const original = process.stdout.write.bind(process.stdout);
	const out: string[] = [];
	process.stdout.write = ((chunk: string) => {
		out.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	try {
		await body();
	} finally {
		process.stdout.write = original;
	}
	return out.join("");
}

/** `body` run with stderr's writes handed to `write` — a red marker write prints its recipe there. */
async function withStderr(
	write: (chunk: string) => boolean,
	body: () => Promise<string>,
) {
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = write as typeof process.stderr.write;
	try {
		return await body();
	} finally {
		process.stderr.write = original;
	}
}

const run = async (
	reporter: TestPassReporter,
	modules: unknown[],
	reason = "passed",
	errors: unknown[] = [],
) => reporter.onTestRunEnd(modules, errors, reason);

/* The filter run-vitest.js hands vitest where a selection is empty. */
const EMPTY_SELECTION_FILTER = "wfc-empty-selection";

beforeEach(() => {
	stubLaunch({});
});

afterEach(() => {
	takeRunReport();
});

describe("the verdict the reporter records", () => {
	it("is green only where the run passed with no unhandled error", async () => {
		const r = new TestPassReporter();
		r.onInit(ctx());
		await captured(() => run(r, [module_("a.test.ts", ["passed"])]));
		expect(takeRunReport().outcome).toBe(true);
	});

	it("is not green where an error landed outside any test", async () => {
		const r = new TestPassReporter();
		r.onInit(ctx());
		await captured(() =>
			run(r, [module_("a.test.ts", ["passed"])], "passed", [new Error("boom")]),
		);
		expect(takeRunReport().outcome).toBe(false);
	});
});

describe("the scope the reporter records (mantahostels#1230)", () => {
	it("counts each test by the state it finished in", async () => {
		const r = new TestPassReporter();
		r.onInit(ctx());
		await captured(() =>
			run(r, [
				module_("a.test.ts", ["passed", "skipped"]),
				module_("b.test.ts", ["failed", "passed"]),
			]),
		);
		const scope = takeRunReport().scope;
		expect(scope).toMatchObject({
			tests: 4,
			passed: 2,
			skipped: 1,
			failed: 1,
			modulesRun: 2,
			modulesTotal: 2,
		});
	});

	it("counts one file run under two pools once, so a full run reads full", async () => {
		const r = new TestPassReporter();
		r.onInit(
			ctx({
				globTestSpecifications: async () => [
					{ moduleId: "a.test.ts" },
					{ moduleId: "a.test.ts" },
					{ moduleId: "b.test.ts" },
				],
			}),
		);
		await captured(() =>
			run(r, [
				module_("a.test.ts", ["passed"]),
				module_("a.test.ts", ["passed"]),
				module_("b.test.ts", ["passed"]),
			]),
		);
		const scope = takeRunReport().scope;
		expect(scope.modulesRun).toBe(2);
		expect(scope.modulesTotal).toBe(2);
	});

	it("carries the name filter and the path filters it was narrowed by", async () => {
		const r = new TestPassReporter();
		r.onInit(
			ctx({
				config: { testNamePattern: /ref/ },
				filenamePattern: ["a.test.ts"],
			}),
		);
		await captured(() => run(r, [module_("a.test.ts", ["passed"])]));
		const scope = takeRunReport().scope;
		expect(scope.nameFilter).toBe("/ref/");
		expect(scope.fileFilters).toEqual(["a.test.ts"]);
	});

	/*
	 * mantahostels#2038: `--changed` narrows through the module graph and leaves
	 * `filenamePattern` empty, so `scope.changed` is the only record of it.
	 */
	it("carries the --changed ref off the vitest config, which no path filter records", async () => {
		const r = new TestPassReporter();
		r.onInit(
			ctx({ config: { testNamePattern: undefined, changed: "HEAD~1" } }),
		);
		await captured(() => run(r, [module_("a.test.ts", ["passed"])]));
		expect(takeRunReport().scope.changed).toBe("HEAD~1");
	});

	/*
	 * `npm run test:changed` (package.json) runs bare `--changed`, which vitest
	 * reads as `config.changed === true` rather than a ref string.
	 */
	it("carries a bare --changed flag as true, not just a ref string", async () => {
		const r = new TestPassReporter();
		r.onInit(ctx({ config: { testNamePattern: undefined, changed: true } }));
		await captured(() => run(r, [module_("a.test.ts", ["passed"])]));
		expect(takeRunReport().scope.changed).toBe(true);
	});

	it("records no --changed ref where the config carried none", async () => {
		const r = new TestPassReporter();
		r.onInit(ctx());
		await captured(() => run(r, [module_("a.test.ts", ["passed"])]));
		expect(takeRunReport().scope.changed).toBeNull();
	});

	/*
	 * #3090: a `--shard` run reads `modulesRun` below `modulesTotal`, so the
	 * margin check needs this field to find the lander's shards.
	 */
	it("carries the --shard index and count off the vitest config", async () => {
		const r = new TestPassReporter();
		r.onInit(
			ctx({
				config: { testNamePattern: undefined, shard: { index: 2, count: 2 } },
			}),
		);
		await captured(() => run(r, [module_("a.test.ts", ["passed"])]));
		expect(takeRunReport().scope.shard).toEqual({ index: 2, count: 2 });
	});

	it("records no shard on an unsharded run", async () => {
		const r = new TestPassReporter();
		r.onInit(ctx());
		await captured(() => run(r, [module_("a.test.ts", ["passed"])]));
		expect(takeRunReport().scope).not.toHaveProperty("shard");
	});
});

describe("the line the reporter prints", () => {
	it("names the corpus denominator on a narrowed run", async () => {
		const r = new TestPassReporter();
		r.onInit(ctx({ filenamePattern: ["a.test.ts"] }));
		const out = await captured(() =>
			run(r, [module_("a.test.ts", ["passed", "skipped"])]),
		);
		expect(out).toContain("FILTERED RUN");
		expect(out).toContain("1 of 2 tests in 1 of 2 files");
	});

	it("says nothing at all on a full run", async () => {
		const r = new TestPassReporter();
		r.onInit(ctx());
		const out = await captured(() =>
			run(r, [
				module_("a.test.ts", ["passed"]),
				module_("b.test.ts", ["passed"]),
			]),
		);
		expect(out).toBe("");
	});
});

describe("a scope the reporter cannot read", () => {
	it("records none and says so, rather than throwing out of a green run", async () => {
		const r = new TestPassReporter();
		r.onInit(
			ctx({
				globTestSpecifications: async () => {
					throw new Error("glob refused");
				},
			}),
		);
		const out = await captured(() =>
			expect(
				run(r, [module_("a.test.ts", ["passed"])]),
			).resolves.toBeUndefined(),
		);
		const report = takeRunReport();
		expect(report.scope).toBeNull();
		expect(report.outcome).toBe(true);
		expect(out).toContain("SCOPE UNRECORDED (mantahostels#1230)");
	});

	it("still records the verdict where a module refuses to enumerate its tests", async () => {
		const r = new TestPassReporter();
		r.onInit(ctx());
		await captured(() =>
			run(r, [
				{
					moduleId: "a.test.ts",
					children: {
						allTests: () => {
							throw new Error("collection refused");
						},
					},
				},
			]),
		);
		const report = takeRunReport();
		expect(report.scope).toBeNull();
		expect(report.outcome).toBe(true);
	});
});

/*
 * WHICH files failed (mantahostels#1942), kept on disk so a session that piped the
 * suite's output through `tail` need not re-run it for the names.
 */
describe("the failing files the reporter records (mantahostels#1942)", () => {
	/** A module whose failing tests carry names, which `module_` omits. */
	const named = (moduleId: string, tests: [string, State][]) => ({
		moduleId,
		children: {
			allTests: () =>
				tests.map(([name, state]) => ({ name, result: () => ({ state }) })),
		},
	});

	it("names every failing file and test", async () => {
		const reporter = new TestPassReporter();
		reporter.onInit(ctx());
		await captured(() =>
			run(
				reporter,
				[
					named("a.test.ts", [
						["holds the line", "failed"],
						["is fine", "passed"],
					]),
					named("b.test.ts", [["also breaks", "failed"]]),
				],
				"failed",
			),
		);

		expect(takeRunReport().scope?.failures).toEqual([
			{ file: "a.test.ts", tests: ["holds the line"] },
			{ file: "b.test.ts", tests: ["also breaks"] },
		]);
	});

	it("groups several failures in one file under that one file", async () => {
		const reporter = new TestPassReporter();
		reporter.onInit(ctx());
		await captured(() =>
			run(
				reporter,
				[
					named("a.test.ts", [
						["first", "failed"],
						["second", "failed"],
					]),
				],
				"failed",
			),
		);

		expect(takeRunReport().scope?.failures).toEqual([
			{ file: "a.test.ts", tests: ["first", "second"] },
		]);
	});

	it("counts on a red the unhandled errors and the files that errored outside any test", async () => {
		const reporter = new TestPassReporter();
		reporter.onInit(ctx());
		await captured(() =>
			run(
				reporter,
				[
					module_("a.test.ts", ["failed"]),
					{ ...module_("b.test.ts", []), errors: () => [new Error("import")] },
				],
				"failed",
				[new Error("unhandled")],
			),
		);

		expect(takeRunReport().scope?.errors).toBe(2);
	});

	// `lib/unasked-rerun-io.js`'s `isClassable` keys on `errors === 0`: without
	// this write every red reads as unclassable (#3633).
	it("writes errors: 0 on a red with no module or unhandled error", async () => {
		const reporter = new TestPassReporter();
		reporter.onInit(ctx());
		await captured(() =>
			run(reporter, [module_("a.test.ts", ["failed"])], "failed"),
		);

		expect(takeRunReport().scope?.errors).toBe(0);
	});

	/*
	 * Absent, not empty. A reader asks "did anything fail" by testing the key, and
	 * an empty array answers yes-but-nothing — the shape that invites a bug.
	 */
	it("writes no failures key at all on a green run", async () => {
		const reporter = new TestPassReporter();
		reporter.onInit(ctx());
		await captured(() =>
			run(reporter, [module_("a.test.ts", ["passed", "passed"])]),
		);

		expect(takeRunReport().scope).not.toHaveProperty("failures");
	});

	/* The reporter's own standing rule: it must never turn a passing suite red,
	 * so a module with no id is recorded under a placeholder rather than thrown
	 * on. */
	it("records a failing module with no id rather than throwing", async () => {
		const reporter = new TestPassReporter();
		reporter.onInit(ctx());
		await captured(() =>
			run(
				reporter,
				[
					{
						children: {
							allTests: () => [
								{
									name: "nameless module",
									result: () => ({ state: "failed" }),
								},
							],
						},
					},
				],
				"failed",
			),
		);

		expect(takeRunReport().scope?.failures).toEqual([
			{ file: "(unknown module)", tests: ["nameless module"] },
		]);
	});
});

/*
 * mantahostels#1953. globalSetup's `setup` fires once per PROCESS, so a start stamped there
 * timed a whole watch session — hours — rather than the re-run the marker
 * describes. `onTestRunStart` fires per run.
 */
describe("the run's start", () => {
	it("is stamped when a run begins", () => {
		const before = Date.now();

		new TestPassReporter().onTestRunStart();

		const stamped = takeRunReport().startedAtMs;
		expect(stamped).toBeGreaterThanOrEqual(before);
		expect(stamped).toBeLessThanOrEqual(Date.now());
	});

	it("re-stamps on every run, so a watch session's second re-run is not timed from its first", () => {
		const reporter = new TestPassReporter();

		reporter.onTestRunStart();
		const first = takeRunReport().startedAtMs;
		fillRunReport({ startedAtMs: first - 60_000 });
		reporter.onTestRunStart();

		expect(takeRunReport().startedAtMs).toBeGreaterThan(first - 60_000);
	});
});

describe("the run's span", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("is the monotonic time from the run's start to its end (#2829)", async () => {
		vi.useFakeTimers({ toFake: ["performance"] });
		const r = new TestPassReporter();
		r.onInit(ctx());
		r.onTestRunStart();
		vi.advanceTimersByTime(394_070);
		await captured(() => run(r, [module_("a.test.ts", ["passed"])]));

		expect(takeRunReport().elapsedMs).toBe(394_070);
	});

	it("is unknown where the run's start was never seen (#2829)", async () => {
		const r = new TestPassReporter();
		r.onInit(ctx());
		await captured(() => run(r, [module_("a.test.ts", ["passed"])]));

		expect(takeRunReport().elapsedMs).toBeNull();
	});
});

describe("whether a filtered run meets the push gate (mantahostels#2146, mantahostels#2207)", () => {
	it("records the launcher's flag on the scope", async () => {
		stubLaunch({ admissible: true });
		const r = new TestPassReporter();
		r.onInit(ctx({ filenamePattern: ["a.test.ts"] }));
		await captured(() => run(r, [module_("a.test.ts", ["passed"])]));
		expect(takeRunReport().scope.admissible).toBe(true);
	});

	it("leaves the field off where nothing set the flag", async () => {
		const r = new TestPassReporter();
		r.onInit(ctx({ filenamePattern: ["a.test.ts"] }));
		await captured(() => run(r, [module_("a.test.ts", ["passed"])]));
		expect(takeRunReport().scope).not.toHaveProperty("admissible");
	});

	it("leaves the field off where the launch says not admissible", async () => {
		stubLaunch({ admissible: false });
		const r = new TestPassReporter();
		r.onInit(ctx({ filenamePattern: ["a.test.ts"] }));
		await captured(() => run(r, [module_("a.test.ts", ["passed"])]));
		expect(takeRunReport().scope).not.toHaveProperty("admissible");
	});
});

describe("why a full run was full (mantahostels#3207)", () => {
	it("records the launcher's reason on the scope", async () => {
		stubLaunch({ full: "flag" });
		const r = new TestPassReporter();
		r.onInit(ctx());
		await captured(() => run(r, [module_("a.test.ts", ["passed"])]));
		expect(takeRunReport().scope.full).toBe("flag");
	});

	it("leaves the field off where nothing set the reason", async () => {
		const r = new TestPassReporter();
		r.onInit(ctx());
		await captured(() => run(r, [module_("a.test.ts", ["passed"])]));
		expect(takeRunReport().scope).not.toHaveProperty("full");
	});
});

describe("why the SESSION typed --full=<cause> (#182)", () => {
	it("carries the session's cause beside the flag reason", async () => {
		stubLaunch({ full: "flag", fullCause: "coverage" });
		const r = new TestPassReporter();
		r.onInit(ctx());
		await captured(() => run(r, [module_("a.test.ts", ["passed"])]));
		const scope = takeRunReport().scope;
		expect(scope.full).toBe("flag");
		expect(scope.fullCause).toBe("coverage");
	});

	it("records fullCause: null on an escalation route — the cause is the escalation itself", async () => {
		stubLaunch({ full: "stale-manifest" });
		const r = new TestPassReporter();
		r.onInit(ctx());
		await captured(() => run(r, [module_("a.test.ts", ["passed"])]));
		const scope = takeRunReport().scope;
		expect(scope.full).toBe("stale-manifest");
		expect(scope.fullCause).toBeNull();
	});

	it("records fullCause: null where the launch carries no cause", async () => {
		stubLaunch({ full: "flag" });
		const r = new TestPassReporter();
		r.onInit(ctx());
		await captured(() => run(r, [module_("a.test.ts", ["passed"])]));
		expect(takeRunReport().scope.fullCause).toBeNull();
	});

	it("carries no fullCause at all where `full` itself is absent", async () => {
		stubLaunch({ fullCause: "coverage" });
		const r = new TestPassReporter();
		r.onInit(ctx());
		await captured(() => run(r, [module_("a.test.ts", ["passed"])]));
		expect(takeRunReport().scope).not.toHaveProperty("fullCause");
	});
});

describe("which command started the run (mantahostels#2303)", () => {
	const scopeWith = async (launch: Record<string, unknown>) => {
		stubLaunch(launch);
		const r = new TestPassReporter();
		r.onInit(ctx({ filenamePattern: ["a.test.ts"] }));
		await captured(() => run(r, [module_("a.test.ts", ["passed"])]));
		return takeRunReport().scope;
	};

	it("records the route flag independently of the gate verdict", async () => {
		expect(await scopeWith({ viaChanged: true })).toMatchObject({
			viaChanged: true,
		});
	});

	it("tells a failed test:changed launch from a hand-typed file list", async () => {
		const failed = await scopeWith({ viaChanged: true, admissible: false });
		expect(failed.viaChanged).toBe(true);
		expect(failed).not.toHaveProperty("admissible");
		expect(await scopeWith({})).not.toHaveProperty("viaChanged");
	});

	it("leaves the field off where the launch says not via test:changed", async () => {
		expect(await scopeWith({ viaChanged: false })).not.toHaveProperty(
			"viaChanged",
		);
	});

	it("records a touched-test run, for the ledger's kind (#2930)", async () => {
		expect(await scopeWith({ touched: true })).toMatchObject({
			touched: true,
		});
		expect(await scopeWith({})).not.toHaveProperty("touched");
	});

	it("records the admission weight the run carried, for the ledger (#2931)", async () => {
		expect(
			await scopeWith({ resolvedFiles: 485, wholeSlot: true }),
		).toMatchObject({ resolvedFiles: 485, wholeSlot: true });
		const part = await scopeWith({ resolvedFiles: 3, wholeSlot: false });
		expect(part).toMatchObject({ resolvedFiles: 3 });
		expect(part).not.toHaveProperty("wholeSlot");
		expect(await scopeWith({})).not.toHaveProperty("resolvedFiles");
	});
});

/*
 * #189: what the verdict depended on, handed over in the run report beside the scope.
 * The module graph is faked at the two fields the walk reads; the manifest is
 * a real file under a scratch root.
 */
describe("the closure the reporter records (#189)", () => {
	let root: string;
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0))
			fs.rmSync(d, { recursive: true, force: true });
	});

	interface Node {
		file: string | null;
		importedModules: Node[];
	}
	const node = (file: string | null, ...importedModules: Node[]): Node => ({
		file,
		importedModules,
	});

	/** A root holding a manifest, and a project whose graph answers from `graph`. */
	function scratch(
		edges: Record<string, string[]>,
		graph: Record<string, Node> = {},
	) {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "closure-")));
		dirs.push(root);
		fs.mkdirSync(path.join(root, "docs"));
		fs.writeFileSync(
			path.join(root, "docs", "test-read-edges.json"),
			JSON.stringify({ edges }),
		);
		const project = {
			vite: {
				environments: {
					ssr: { moduleGraph: { getModuleById: (id: string) => graph[id] } },
				},
			},
		};
		const withProject = (moduleId: string, states: State[]) => ({
			...module_(moduleId, states),
			project,
		});
		return { withProject };
	}

	/**
	 * `scratch`'s root made a committed repository, the tree an empty run's
	 * marker is written against. A run of NO modules writes the marker itself
	 * (#189 §6), into the store of the vitest root it was handed — this
	 * checkout's where none is — so every empty run below takes one.
	 */
	function scratchRepo(edges: Record<string, string[]> = {}) {
		const made = scratch(edges);
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: root, stdio: "ignore" });
		fs.writeFileSync(path.join(root, ".gitignore"), ".claude/\n");
		git("init", "-q", ".");
		git("-c", "user.email=t@example.com", "-c", "user.name=t", "add", ".");
		git(
			"-c",
			"user.email=t@example.com",
			"-c",
			"user.name=t",
			"commit",
			"-qm",
			"base",
		);
		return made;
	}

	const vitest = (over: Record<string, unknown> = {}) =>
		ctx({
			config: { testNamePattern: undefined, root },
			vite: { config: { configFile: path.join(root, "vitest.config.ts") } },
			filenamePattern: ["a.test.ts"],
			...over,
		});

	it("records '*' for a full run without walking anything", async () => {
		scratch({});
		const r = new TestPassReporter();
		r.onInit(vitest({ filenamePattern: [] }));
		await captured(() =>
			run(r, [
				module_("a.test.ts", ["passed"]),
				module_("b.test.ts", ["passed"]),
			]),
		);
		expect(takeRunReport().attestation).toEqual({ closure: "*" });
	});

	it("records the launch's base beside a full run's '*', so a full red can be classed (#3646)", async () => {
		scratch({});
		const r = new TestPassReporter();
		r.onInit(vitest({ filenamePattern: [] }));
		stubLaunch({ full: "flag", base: "b".repeat(40) });
		await captured(() =>
			run(r, [
				module_("a.test.ts", ["passed"]),
				module_("b.test.ts", ["passed"]),
			]),
		);
		expect(takeRunReport().attestation).toEqual({
			closure: "*",
			base: "b".repeat(40),
		});
	});

	it("unions the graph walk, the manifest's mapped documents and the roots, repo-relative and sorted", async () => {
		const graph: Record<string, Node> = {};
		const { withProject } = scratch(
			{
				"docs/read-by-a.md": ["a.test.ts"],
				"docs/read-by-nobody-run.md": ["z.test.ts"],
			},
			graph,
		);
		const id = path.join(root, "a.test.ts");
		const helper = node(path.join(root, "lib", "helper.ts"));
		const dep = node(path.join(root, "node_modules", "vitest", "index.js"));
		const outside = node(path.join(os.tmpdir(), "outside.ts"));
		const cyclic = node(id, helper, dep, outside);
		helper.importedModules.push(cyclic);
		graph[id] = cyclic;
		const r = new TestPassReporter();
		r.onInit(vitest());
		stubLaunch({ changedPaths: ["lib/helper.ts"], base: "b".repeat(40) });
		await captured(() => run(r, [withProject(id, ["passed"])]));
		expect(takeRunReport().attestation).toEqual({
			closure: [
				"a.test.ts",
				"docs/read-by-a.md",
				"lib/helper.ts",
				"package.json",
				"vitest.config.ts",
			],
			selected: ["a.test.ts"],
			changedPaths: ["lib/helper.ts"],
			base: "b".repeat(40),
			/* The same closure split by test, so a diff voids only its readers (#1860). */
			imports: { "a.test.ts": ["lib/helper.ts"] },
			roots: ["package.json", "vitest.config.ts"],
		});
	});

	it("carries the manifest where a selected test reads it, as no root does (#799)", async () => {
		const { withProject } = scratch({
			"docs/test-read-edges.json": ["a.test.ts"],
		});
		const r = new TestPassReporter();
		r.onInit(vitest());
		await captured(() =>
			run(r, [withProject(path.join(root, "a.test.ts"), ["passed"])]),
		);
		expect(takeRunReport().attestation.closure).toContain(
			"docs/test-read-edges.json",
		);
	});

	it("records the instruments alone for a run that selected nothing (#189 §6)", async () => {
		scratchRepo({ "docs/x.md": ["a.test.ts"] });
		const r = new TestPassReporter();
		r.onInit(vitest({ filenamePattern: [EMPTY_SELECTION_FILTER] }));
		stubLaunch({ changedPaths: ["docs/notes.md"], base: "b".repeat(40) });
		await captured(() => run(r, []));
		const [marker] = readMarkers({ root });
		expect(marker).toMatchObject({
			closure: ["package.json", "vitest.config.ts"],
			selected: [],
			changedPaths: ["docs/notes.md"],
			base: "b".repeat(40),
		});
	});

	/*
	 * Vitest 4.1 skips globalSetup when it has no file to run, so the teardown
	 * that writes every other marker never fires for an empty selection.
	 */
	it("writes the marker itself for a run vitest gave no globalSetup (#189 §6)", async () => {
		scratchRepo();
		const r = new TestPassReporter();
		r.onInit(vitest({ filenamePattern: [EMPTY_SELECTION_FILTER] }));
		await captured(() => run(r, []));
		expect(readMarkers({ root })).toHaveLength(1);
		expect(readFailures({ root })).toHaveLength(0);
	});

	it("writes a red run that selected nothing to the fail store", async () => {
		scratchRepo();
		const r = new TestPassReporter();
		r.onInit(vitest({ filenamePattern: [EMPTY_SELECTION_FILTER] }));
		await withStderr(
			() => true,
			() => captured(() => run(r, [], "interrupted")),
		);
		expect(readMarkers({ root })).toHaveLength(0);
		expect(readFailures({ root })).toHaveLength(1);
	});

	it("leaves the write to the teardown where the run had a file", async () => {
		const { withProject } = scratchRepo();
		const r = new TestPassReporter();
		r.onInit(vitest());
		await captured(() =>
			run(r, [withProject(path.join(root, "a.test.ts"), ["passed"])]),
		);
		expect(readMarkers({ root })).toHaveLength(0);
		expect(takeRunReport().outcome).toBe(true);
	});

	/*
	 * The store's own append swallows its file errors, so the one throw left
	 * is the recovery recipe a red write prints to stderr.
	 */
	it("says so, rather than throwing, where the empty-run write throws", async () => {
		scratchRepo();
		const r = new TestPassReporter();
		r.onInit(vitest({ filenamePattern: [EMPTY_SELECTION_FILTER] }));
		const out = await withStderr(
			() => {
				throw new Error("stderr closed");
			},
			() => captured(() => run(r, [], "interrupted")),
		);
		expect(out).toContain("MARKER UNWRITTEN (#189 §6)");
		expect(out).toContain("stderr closed");
	});

	it("still records the test itself and the manifest half where the graph has no node for it", async () => {
		const { withProject } = scratch({ "docs/x.md": ["a.test.ts"] });
		const r = new TestPassReporter();
		r.onInit(vitest());
		await captured(() =>
			run(r, [withProject(path.join(root, "a.test.ts"), ["passed"])]),
		);
		const got = takeRunReport().attestation;
		expect(got.closure).toContain("a.test.ts");
		expect(got.closure).toContain("docs/x.md");
		expect(got.changedPaths).toBeNull();
		expect(got.base).toBeNull();
	});

	it("records nothing and says so where the manifest cannot be read", async () => {
		const { withProject } = scratch({});
		fs.rmSync(path.join(root, "docs", "test-read-edges.json"));
		const r = new TestPassReporter();
		r.onInit(vitest());
		const out = await captured(() =>
			run(r, [withProject(path.join(root, "a.test.ts"), ["passed"])]),
		);
		const report = takeRunReport();
		expect(report.attestation).toBeNull();
		expect(out).toContain("CLOSURE UNRECORDED (#189)");
		expect(report.outcome).toBe(true);
	});

	it("records nothing where the manifest has no edges map, as the judge refuses it (#799)", async () => {
		const { withProject } = scratch({});
		fs.writeFileSync(path.join(root, "docs", "test-read-edges.json"), "{}");
		const r = new TestPassReporter();
		r.onInit(vitest());
		const out = await captured(() =>
			run(r, [withProject(path.join(root, "a.test.ts"), ["passed"])]),
		);
		expect(takeRunReport().attestation).toBeNull();
		expect(out).toContain("CLOSURE UNRECORDED (#189)");
	});

	it("never reddens the run: a reporter with no root records nothing and stays green", async () => {
		const r = new TestPassReporter();
		r.onInit(ctx({ filenamePattern: ["a.test.ts"] }));
		const out = await captured(() =>
			run(r, [module_("a.test.ts", ["passed"])]),
		);
		const report = takeRunReport();
		expect(report.attestation).toBeNull();
		expect(out).toContain("CLOSURE UNRECORDED (#189)");
		expect(report.outcome).toBe(true);
	});
});
