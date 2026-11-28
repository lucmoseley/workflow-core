import { createRequire } from "node:module";
import path from "node:path";

const UNKNOWN_MODULE = "(unknown module)";
const UNNAMED_TEST = "(unnamed test)";

const require = createRequire(import.meta.url);
const {
	formatFilteredRun,
	formatCachedClause,
	isFullScope,
	docsOfTests,
	readDocsByTest,
	fullAttestationOf,
	CLOSURE_ROOTS,
} = require("./lib/test-pass-marker.js");
const { readLaunch, fillRunReport } = require("./lib/suite-handoff.js");
const { sample: sampleCpu } = require("./lib/cpu-sample.js");
const { relativeUnder } = require("./lib/is-under.js");
const { ignoreFailure } = require("./lib/caught.js");
const { foldCached, readCachedHandoff } = require("./lib/pass-store.js");

const scopeUnrecorded = (failure: unknown, cached: string[]): string =>
	[
		`SCOPE UNRECORDED (mantahostels#1230) — this run cannot say how much of the suite it covered: ${failure}`,
		formatCachedClause(cached),
	]
		.filter(Boolean)
		.join("; ");

const cachedFiles = (cached: ReturnType<typeof readCachedHandoff>): string[] =>
	cached ? cached.map((c: { file: string }) => c.file) : [];

// `vitest` runs globalSetup only on its way to running files, so an empty selection gets no teardown.
async function writeEmptyRunMarker(root?: string) {
	const watch = await import("./vitest-tree-watch");
	watch.setup({ config: { root } });
	watch.runTeardown();
}

interface ModuleNodeLike {
	file?: string | null;
	importedModules: Iterable<ModuleNodeLike>;
}

interface ModuleGraphLike {
	getModuleById: (id: string) => ModuleNodeLike | undefined;
}

const graphOf = (module: TestModuleLike) =>
	module.project?.vite?.environments?.ssr?.moduleGraph;

interface TestModuleLike {
	moduleId?: string;
	project?: {
		vite?: {
			environments?: Record<
				string,
				{
					moduleGraph?: ModuleGraphLike;
				}
			>;
		};
	};
	errors?: () => readonly unknown[];
	children: {
		allTests: () => Iterable<{
			name?: string;
			result?: () => { state?: string };
		}>;
	};
}

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
				names.push(test.name || UNNAMED_TEST);
				failures.set(file, names);
			}
		}
	}
	return { tests, passed, skipped, failed, failures };
}

function fullRunFields(launch: import("./lib/suite-handoff.js").Launch) {
	if (launch.full === null) return {};
	return {
		full: launch.full,
		fullCause: launch.fullCause,
	};
}

function touchedFields(launch: import("./lib/suite-handoff.js").Launch) {
	return {
		...(launch.leftOut ? { leftOut: launch.leftOut } : {}),
		...(launch.boundedFrom ? { boundedFrom: launch.boundedFrom } : {}),
		...(launch.touchedBase ? { touchedBase: launch.touchedBase } : {}),
	};
}

function fileVerdicts(
	testModules: TestModuleLike[],
	paths: { inside: (file: string) => boolean; rel: (file: string) => string },
) {
	const files = new Map<string, { failed: boolean; imports: Set<string> }>();
	for (const module of testModules) {
		if (!module.moduleId) continue;
		const test = paths.rel(module.moduleId);
		const entry = files.get(test) ?? { failed: false, imports: new Set() };
		addImportClosure(
			graphOf(module)?.getModuleById(module.moduleId),
			entry.imports,
			paths,
		);
		entry.imports.delete(test);
		const tests = [...module.children.allTests()];
		entry.failed ||=
			(module.errors?.() ?? []).length > 0 ||
			tests.some((t) => t.result?.().state === "failed");
		files.set(test, entry);
	}
	return [...files].map(([file, { failed, imports }]) => ({
		file,
		outcome: failed ? ("fail" as const) : ("pass" as const),
		imports: [...imports].sort(),
	}));
}

export default class TestPassReporter {
	private vitest: {
		config?: {
			testNamePattern?: unknown;
			changed?: string | boolean;
			root?: string;
			shard?: { index: number; count: number };
			setupFiles?: string[];
			bail?: number;
			update?: unknown;
		};
		vite?: { config?: { configFile?: string | false } };
		filenamePattern?: readonly string[];
		globTestSpecifications?: () => Promise<{ moduleId: string }[]>;
	} | null = null;

	private runStartedAtMono: number | null = null;

	onInit(vitest: unknown) {
		this.vitest = vitest as typeof this.vitest;
	}

	// `vitest` fires globalSetup's `setup` once per process, `onTestRunStart` once per run.
	onTestRunStart() {
		this.runStartedAtMono = performance.now();
		fillRunReport({ startedAtMs: Date.now(), machineStart: sampleCpu() });
	}

	async onTestRunEnd(
		testModules: readonly unknown[] = [],
		unhandledErrors: readonly unknown[] = [],
		reason?: string,
	) {
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

		const cached = readCachedHandoff();
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

		ignoreFailure(() => {
			fillRunReport({ scope });
			const line = failure
				? scopeUnrecorded(failure, cachedFiles(cached))
				: formatFilteredRun(scope, cachedFiles(cached));
			if (line) process.stdout.write(`${line}\n`);
		});

		let attestation = null;
		let closureFailure: unknown = null;
		try {
			attestation = this.describeAttestation(
				testModules as TestModuleLike[],
				scope,
				cached,
			);
		} catch (error) {
			closureFailure = error;
		}
		ignoreFailure(() => {
			fillRunReport({ attestation });
			if (closureFailure)
				process.stdout.write(
					`CLOSURE UNRECORDED (#189) — this run attests its own sha alone, not the tree it read: ${closureFailure}\n`,
				);
		});

		this.handFiles(testModules as TestModuleLike[], unhandledErrors, reason);

		if (testModules.length === 0) {
			try {
				await writeEmptyRunMarker(this.vitest?.config?.root);
			} catch (error) {
				ignoreFailure(() =>
					process.stdout.write(
						`MARKER UNWRITTEN (#189 §6) — this empty selection recorded no certificate: ${error}\n`,
					),
				);
			}
		}
	}

	private describeAttestation(
		testModules: TestModuleLike[],
		scope: { modulesRun: number; modulesTotal: number } | null,
		cached: ReturnType<typeof readCachedHandoff>,
	) {
		if (scope && isFullScope(scope)) return fullAttestationOf(readLaunch());
		const root = this.vitest?.config?.root;
		if (!root) throw new Error("vitest reported no root to resolve against");
		const rel = (file: string) =>
			path.relative(root, file).split(path.sep).join("/");
		const inside = (file: string) => relativeUnder(root, file) !== null;
		const closure = new Set<string>();
		const imports = new Map<string, Set<string>>();
		for (const module of testModules) {
			if (!module.moduleId) continue;
			const test = rel(module.moduleId);
			const reached = imports.get(test) ?? new Set<string>();
			const graph = graphOf(module);
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
		for (const doc of docsOfTests(readDocsByTest(root), selected))
			closure.add(doc);
		const roots = new Set<string>(CLOSURE_ROOTS);
		const configFile = this.vitest?.vite?.config?.configFile;
		if (configFile && inside(configFile)) roots.add(rel(configFile));
		for (const r of roots) closure.add(r);
		const launch = readLaunch();
		return foldCached(
			{
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
			},
			cached,
		);
	}

	private handFiles(
		testModules: TestModuleLike[],
		unhandledErrors: readonly unknown[],
		reason: string | undefined,
	) {
		try {
			fillRunReport({
				files: this.describeFiles(testModules, unhandledErrors.length, reason),
			});
		} catch (error) {
			ignoreFailure(() =>
				process.stdout.write(
					`FILE RESULTS UNRECORDED (#4790) — no file of this run can be skipped on its result later: ${error}\n`,
				),
			);
		}
	}

	private describeFiles(
		testModules: TestModuleLike[],
		unhandled: number,
		reason: string | undefined,
	) {
		const config = this.vitest?.config;
		const root = config?.root;
		if (!root) return null;
		const paths = {
			rel: (file: string) =>
				path.relative(root, file).split(path.sep).join("/"),
			inside: (file: string) => relativeUnder(root, file) !== null,
		};
		const graph = testModules.map(graphOf).find(Boolean);
		const shared = new Set<string>();
		const configFile = this.vitest?.vite?.config?.configFile;
		if (configFile && paths.inside(configFile))
			shared.add(paths.rel(configFile));
		for (const setup of (config?.setupFiles ?? []).filter(paths.inside)) {
			shared.add(paths.rel(setup));
			addImportClosure(graph?.getModuleById(setup), shared, paths);
		}
		const update = config?.update;
		return {
			results: fileVerdicts(testModules, paths),
			shared: [...shared].sort(),
			clean:
				(reason === "passed" || reason === "failed") &&
				unhandled === 0 &&
				!config?.testNamePattern &&
				!config?.bail &&
				!(update && update !== "none"),
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
			changed: this.vitest?.config?.changed ?? null,
			...(shard ? { shard: { index: shard.index, count: shard.count } } : {}),
			...(launch.admissible ? { admissible: true } : {}),
			...(launch.viaChanged ? { viaChanged: true } : {}),
			...(launch.touched ? { touched: true } : {}),
			...(launch.resolvedFiles === null
				? {}
				: { resolvedFiles: launch.resolvedFiles }),
			...(launch.wholeSlot ? { wholeSlot: true } : {}),
			...touchedFields(launch),
			...fullRunFields(launch),
			...(failures.size > 0
				? {
						failures: [...failures].map(([file, names]) => ({
							file,
							tests: names,
						})),
					}
				: {}),
			...(failures.size > 0 || errors > 0 ? { errors } : {}),
		};
	}
}
