/*
 * The half of the pre-push marker that knows whether the suite passed (mantahostels#987).
 *
 * globalSetup's teardown holds the tree-drift findings and runs last, but is
 * told nothing about the result; a reporter is told the result and runs first.
 * So this records the verdict and `scripts/vitest-tree-watch.ts` writes the
 * marker — see `scripts/lib/suite-handoff.js` for why that hand-off is a
 * module-level variable rather than a file.
 *
 * ANY doubt reads as not-green: an unhandled error outside a test still means
 * the run cannot be attested, and an interrupted run has tests nobody ran.
 *
 * `onInit` is handed the Vitest instance, so the name filter and the file
 * filters are readable off its config — and `globTestSpecifications()` returns
 * the WHOLE corpus even inside a filtered run, which is what gives the marker a
 * denominator without storing one.
 *
 * IT MUST NEVER TURN A PASSING SUITE RED. Every scope read is wrapped: a failure
 * records no scope, which reads as unknown at the push (mantahostels#1230), and says so on
 * stdout so the unknown met hours later is traceable to this run.
 *
 * IMPLICIT:  records every suite run's verdict, scope and closure for the globalSetup teardown to stamp into the pre-push marker, writes that marker itself on an empty selection, and prints a line on a filtered or unrecorded scope.
 * JUSTIFIED: fail-safe — that marker is the only thing keyed to a sha (mantahostels#910), and any doubt leaves no certificate.
 * DEFEAT:    none — naming any reporter replaces the default set, so dropping it means editing vitest.config.ts.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/*
 * What a failing module or test with no id of its own is recorded as. Named
 * rather than inlined because a store reader meets these strings and cannot ask
 * the code what they meant.
 */
const UNKNOWN_MODULE = "(unknown module)";
const UNNAMED_TEST = "(unnamed test)";

const require = createRequire(import.meta.url);
const {
	formatFilteredRun,
	isFullScope,
	EDGES_FILE,
	docsReadBy,
	fullAttestationOf,
} = require("./lib/test-pass-marker.js");
const { readLaunch, fillRunReport } = require("./lib/suite-handoff.js");
const { sample: sampleCpu } = require("./lib/cpu-sample.js");

/*
 * The dependency-graph roots every narrowed closure carries (#189): what the
 * selection rests on without a graph edge to show it — `package.json`,
 * vitest's own force-rerun trigger — so a sha differing from the tree read
 * only there is never cleared by a narrowed certificate. The vitest config
 * file joins them at run time, resolved off the instance rather than spelled
 * here; a sibling `vite.config.*` the instance did not load is outside the
 * closure.
 *
 * NOT THE MANIFEST (#799, #795): it matters only through the documents it
 * maps to the run's tests, so `holdsAt` re-reads it at the sha judged,
 * off the `selected` list recorded beside the closure.
 */
const CLOSURE_ROOTS = ["package.json"];

/**
 * Who writes the marker for a run that selected NOTHING (#189 §6). Vitest
 * 4.1 runs globalSetup only on its way to running files, so with zero
 * specifications the teardown that stamps every other marker never fires;
 * the reporter, which does fire, runs both halves itself — the start
 * snapshot and the end-of-run write, back to back, since no run lies
 * between them.
 */
async function writeEmptyRunMarker(root?: string) {
	const watch = await import("./vitest-tree-watch");
	watch.setup({ config: { root } });
	watch.runTeardown();
}

/** The two `ModuleNode` fields the closure walk reads. */
interface ModuleNodeLike {
	file?: string | null;
	importedModules: Iterable<ModuleNodeLike>;
}

interface TestModuleLike {
	moduleId?: string;
	project?: {
		vite?: {
			environments?: Record<
				string,
				{
					moduleGraph?: {
						getModuleById: (id: string) => ModuleNodeLike | undefined;
					};
				}
			>;
		};
	};
	/* Module-level errors: an import or collection that failed outside any test. */
	errors?: () => readonly unknown[];
	children: {
		allTests: () => Iterable<{
			name?: string;
			result?: () => { state?: string };
		}>;
	};
}

/**
 * Adds every in-repo, non-`node_modules` file the import graph reaches from
 * `start` to `closure`, breadth first.
 * @param closure accumulator: each reached file's repo path is added
 */
function addImportClosure(
	start: ModuleNodeLike | undefined,
	closure: Set<string>,
	paths: { inside: (file: string) => boolean; rel: (file: string) => string },
) {
	const seen = new Set<ModuleNodeLike>();
	const queue = [start];
	while (queue.length > 0) {
		const node = queue.shift();
		if (!node || seen.has(node)) continue;
		seen.add(node);
		if (
			node.file &&
			paths.inside(node.file) &&
			!node.file.split(path.sep).includes("node_modules")
		)
			closure.add(paths.rel(node.file));
		for (const imported of node.importedModules) queue.push(imported);
	}
}

/* The run's test tally, and WHICH files failed, not just how many (mantahostels#1942). */
function countTests(testModules: TestModuleLike[]) {
	let tests = 0;
	let passed = 0;
	let skipped = 0;
	let failed = 0;
	const failures = new Map<string, string[]>();
	for (const module of testModules) {
		for (const test of module.children.allTests()) {
			tests++;
			const state = test.result?.().state;
			if (state === "passed") passed++;
			else if (state === "skipped") skipped++;
			else if (state === "failed") {
				failed++;
				const file = module.moduleId ?? UNKNOWN_MODULE;
				const names = failures.get(file) ?? [];
				// Never skipped: dropping it would leave `tests: []`.
				names.push(test.name || UNNAMED_TEST);
				failures.set(file, names);
			}
		}
	}
	return { tests, passed, skipped, failed, failures };
}

/* `describeRun`'s `full`/`fullCause` pair, or nothing where the launch names no full reason. */
function fullRunFields(launch: import("./lib/suite-handoff.js").Launch) {
	if (launch.full === null) return {};
	return {
		full: launch.full,
		// Why the SESSION typed `--full=<cause>` (#182) — a second
		// vocabulary from `full`'s own, so this is only ever set
		// beside `full: "flag"`; an escalation's cause is the
		// escalation itself, already named in `full`, and carries
		// `fullCause: null`.
		fullCause: launch.fullCause,
	};
}

export default class TestPassReporter {
	private vitest: {
		config?: {
			testNamePattern?: unknown;
			changed?: string | boolean;
			root?: string;
			shard?: { index: number; count: number };
		};
		vite?: { config?: { configFile?: string | false } };
		filenamePattern?: readonly string[];
		globTestSpecifications?: () => Promise<{ moduleId: string }[]>;
	} | null = null;

	/* `performance.now()` at the run's start: the marker's `durationMs` is a
	 * monotonic span, so a host suspend mid-run is not counted (#2829). */
	private runStartedAtMono: number | null = null;

	onInit(vitest: unknown) {
		this.vitest = vitest as typeof this.vitest;
	}

	/*
	 * The run's start, for the marker's `startedAt` and `durationMs` (mantahostels#1953). Here and not in
	 * globalSetup's `setup`, which fires once per PROCESS — in watch mode that
	 * would time the whole session rather than the run the marker describes.
	 *
	 * The CPU counters are read at the same instant and for the same reason: the
	 * marker's `machine` block is a DELTA across the run, so it needs a bracket
	 * at each end, and a bracket taken per-process would describe the watch
	 * session rather than the run. `sampleCpu()` returns null rather than
	 * throwing wherever `/proc` will not answer, so this cannot fail a run.
	 */
	onTestRunStart() {
		this.runStartedAtMono = performance.now();
		fillRunReport({ startedAtMs: Date.now(), machineStart: sampleCpu() });
	}

	async onTestRunEnd(
		testModules: readonly unknown[] = [],
		unhandledErrors: readonly unknown[] = [],
		reason?: string,
	) {
		/*
		 * The closing half of both brackets, taken here because this fires per RUN
		 * and the marker's teardown fires per PROCESS — `markerFrom`'s
		 * `finishedAtMs` note owns the reasoning. First in this method, so a later
		 * throw cannot cost the reading.
		 */
		fillRunReport({
			endedAtMs: Date.now(),
			elapsedMs:
				this.runStartedAtMono === null
					? null
					: performance.now() - this.runStartedAtMono,
			machineEnd: sampleCpu(),
		});

		fillRunReport({
			outcome: reason === "passed" && unhandledErrors.length === 0,
		});

		let scope = null;
		let failure: unknown = null;
		try {
			scope = await this.describeRun(
				testModules as TestModuleLike[],
				unhandledErrors.length,
			);
		} catch (error) {
			failure = error;
		}

		try {
			fillRunReport({ scope });
			const line = failure
				? `SCOPE UNRECORDED (mantahostels#1230) — this run cannot say how much of the suite it covered: ${failure}`
				: formatFilteredRun(scope);
			if (line) process.stdout.write(`${line}\n`);
		} catch {
			/* a broken pipe at the end of a green run is not a red run */
		}

		/*
		 * What the verdict depended on (#189), after the scope because a full
		 * scope needs no walk. A failure records nothing — the marker then
		 * attests its own sha alone — and says so.
		 */
		let attestation = null;
		let closureFailure: unknown = null;
		try {
			attestation = this.describeAttestation(
				testModules as TestModuleLike[],
				scope,
			);
		} catch (error) {
			closureFailure = error;
		}
		try {
			fillRunReport({ attestation });
			if (closureFailure)
				process.stdout.write(
					`CLOSURE UNRECORDED (#189) — this run attests its own sha alone, not the tree it read: ${closureFailure}\n`,
				);
		} catch {
			/* as above */
		}

		if (testModules.length === 0) {
			try {
				await writeEmptyRunMarker(this.vitest?.config?.root);
			} catch (error) {
				try {
					process.stdout.write(
						`MARKER UNWRITTEN (#189 §6) — this empty selection recorded no certificate: ${error}\n`,
					);
				} catch {
					/* as above */
				}
			}
		}
	}

	/**
	 * The paths the verdict depended on: `"*"` for a full run
	 * (`fullAttestationOf`); otherwise the
	 * selected tests, their transitive imports off vitest's module graph, the
	 * documents the manifest maps to those tests, and the dependency-graph
	 * roots — repo-relative, sorted, deduplicated — with the selected tests
	 * themselves, the diff the selection was computed from, the base it was
	 * diffed against, each test's own imports and the roots apart (#1860),
	 * beside it. A run that selected nothing (#189 §6)
	 * reduces to the roots: the instruments the selection trusted.
	 *
	 * THE GRAPH SEES LITTLE IN THIS REPO. Its tests reach their subjects
	 * through `createRequire`, which Vite's transform never records, so for
	 * most of them the walk yields the test file and `vitest.setup.ts` and the
	 * manifest supplies the subject — the same two sources, in the same
	 * proportion, that selected the run (mantahostels#2095). Verified live, not
	 * only against the fake graph the tests drive: a narrowed `npm run test` on
	 * this checkout stamped a 161-path closure through this walk (#189).
	 *
	 * Throws where the manifest cannot be read or is malformed: a closure missing its
	 * manifest half would attest a sha it never read.
	 */
	private describeAttestation(
		testModules: TestModuleLike[],
		scope: { modulesRun: number; modulesTotal: number } | null,
	) {
		if (scope && isFullScope(scope)) return fullAttestationOf(readLaunch());
		const root = this.vitest?.config?.root;
		if (!root) throw new Error("vitest reported no root to resolve against");
		const rel = (file: string) =>
			path.relative(root, file).split(path.sep).join("/");
		const inside = (file: string) =>
			!path.relative(root, file).startsWith("..");
		const closure = new Set<string>();
		// Per test as well as in union (#1860), so the judge can void one test
		// without the rest; a file run under two pools merges its two walks.
		const imports = new Map<string, Set<string>>();
		for (const module of testModules) {
			if (!module.moduleId) continue;
			const test = rel(module.moduleId);
			const reached = imports.get(test) ?? new Set<string>();
			const graph = module.project?.vite?.environments?.ssr?.moduleGraph;
			addImportClosure(graph?.getModuleById(module.moduleId), reached, {
				inside,
				rel,
			});
			reached.delete(test);
			imports.set(test, reached);
			closure.add(test);
			for (const p of reached) closure.add(p);
		}
		const selected = new Set(imports.keys());
		const docs: Set<string> | null = docsReadBy(
			JSON.parse(fs.readFileSync(path.join(root, EDGES_FILE), "utf8")),
			selected,
		);
		if (!docs) throw new Error(`${EDGES_FILE} is not {edges: {doc: [test]}}`);
		for (const doc of docs) closure.add(doc);
		const roots = new Set(CLOSURE_ROOTS);
		const configFile = this.vitest?.vite?.config?.configFile;
		if (configFile && inside(configFile)) roots.add(rel(configFile));
		for (const r of roots) closure.add(r);
		const launch = readLaunch();
		return {
			closure: [...closure].sort(),
			selected: [...selected].sort(),
			changedPaths: launch.changedPaths,
			base: launch.base,
			imports: Object.fromEntries(
				[...imports]
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([test, reached]) => [test, [...reached].sort()]),
			),
			roots: [...roots].sort(),
		};
	}

	private async describeRun(testModules: TestModuleLike[], unhandled: number) {
		const { tests, passed, skipped, failed, failures } =
			countTests(testModules);
		const errors =
			unhandled +
			testModules.filter((m) => (m.errors?.() ?? []).length > 0).length;
		const launch = readLaunch();

		const pattern = this.vitest?.config?.testNamePattern;
		const shard = this.vitest?.config?.shard;
		const specs = (await this.vitest?.globTestSpecifications?.()) ?? [];
		// One entry per file PER POOL on both sides, so the same file can appear
		// twice; count distinct module ids or a full run reads as run > total.
		const distinct = (ids: (string | undefined)[]) =>
			new Set(ids.filter(Boolean)).size;

		return {
			modulesRun: distinct(testModules.map((m) => m.moduleId)),
			modulesTotal: distinct(specs.map((s) => s.moduleId)),
			tests,
			passed,
			skipped,
			failed,
			nameFilter: pattern ? String(pattern) : null,
			fileFilters: [...(this.vitest?.filenamePattern ?? [])],
			// `--changed` narrows through the module graph and leaves
			// `filenamePattern` EMPTY, so without this the marker records a run
			// narrowed to 3 of 228 files and cannot say by what (mantahostels#2031).
			changed: this.vitest?.config?.changed ?? null,
			// vitest shards after `globTestSpecifications`, so a `--shard` run
			// reads `modulesRun` below `modulesTotal`; this says which shard (#3090).
			...(shard ? { shard: { index: shard.index, count: shard.count } } : {}),
			// The launch's own facts, which only the launcher knows
			// (`lib/suite-handoff.js` says what each means).
			...(launch.admissible ? { admissible: true } : {}),
			...(launch.viaChanged ? { viaChanged: true } : {}),
			...(launch.touched ? { touched: true } : {}),
			...(launch.resolvedFiles === null
				? {}
				: { resolvedFiles: launch.resolvedFiles }),
			...(launch.wholeSlot ? { wholeSlot: true } : {}),
			...fullRunFields(launch),
			// Absent rather than empty on a green run: a reader testing for the key
			// is asking "did anything fail", and [] would answer yes-but-nothing.
			...(failures.size > 0
				? {
						failures: [...failures].map(([file, names]) => ({
							file,
							tests: names,
						})),
					}
				: {}),
			// On a red, the unhandled errors plus the files that errored outside any
			// test (`Scope.errors`): a red with any is never read as already red on
			// its base (#3633), its cause being unnamed.
			...(failures.size > 0 || errors > 0 ? { errors } : {}),
		};
	}
}
