import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const inflight = require("./lib/test-inflight.js");
const { TIMINGS_ENV, createTimings } = require("./lib/test-file-timings.js");
const { fillRunReport } = require("./lib/suite-handoff.js");

type SlowFile = import("./lib/test-file-timings.js").SlowFile;

interface ModuleLike {
	moduleId?: string;
}

export default class TestInflightReporter {
	private root: string = process.cwd();

	private timings = createTimings();

	onInit(vitest: unknown) {
		const root = (vitest as { config?: { root?: string } })?.config?.root;
		if (typeof root === "string" && root) this.root = root;
	}

	onTestRunStart(specifications: readonly ModuleLike[] = []) {
		inflight.begin(this.root);
		inflight.schedule(
			this.root,
			specifications.map((s) => s?.moduleId),
		);
		this.timings = createTimings();
	}

	onTestModuleQueued(module: ModuleLike) {
		inflight.enter(this.root, module?.moduleId, "loading");
		this.timings.start(module?.moduleId, performance.now());
	}

	onTestModuleCollected(module: ModuleLike) {
		inflight.enter(this.root, module?.moduleId, "running its tests");
	}

	onTestModuleEnd(module: ModuleLike) {
		inflight.leave(this.root, module?.moduleId);
		this.timings.end(module?.moduleId, performance.now());
	}

	onTestCaseReady() {
		inflight.beat(this.root);
	}

	onTestCaseResult() {
		inflight.beat(this.root);
	}

	onHookStart() {
		inflight.beat(this.root);
	}

	onHookEnd() {
		inflight.beat(this.root);
	}

	onTestRunEnd() {
		inflight.clear(this.root);
		this.timings.save(process.env[TIMINGS_ENV]);
		try {
			fillRunReport({
				slowest: this.timings.slowest().map((s: SlowFile) => ({
					...s,
					file: path.relative(this.root, s.file),
				})),
			});
		} catch (error) {
			process.stderr.write(
				`slowest files not handed to the pass marker (${String(error)})\n`,
			);
		}
	}
}
