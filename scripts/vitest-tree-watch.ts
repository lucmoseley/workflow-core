import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { format, endOfRunTreeIdentity } = require("./lib/tree-drift.js");
const { watchRun, unwatchedRun } = require("./lib/run-steadiness.js");
const {
	markerFrom,
	record,
	recordFailure,
	failureRecoveryCommand,
	FAIL_STORE,
	storePath,
	repoRoot,
} = require("./lib/test-pass-marker.js");
const { readLaunch, takeRunReport } = require("./lib/suite-handoff.js");
const { hasOwnScopeHitCap } = require("./lib/user-scope.js");
const { readAlreadyRedLines } = require("./lib/already-red.js");
const {
	record: recordFileResults,
	isRowlessRun,
} = require("./lib/pass-store.js");
const readAudit = require("./lib/read-audit.js");
const { keepRun } = require("./lib/row-measure.js");
const { caught } = require("./lib/caught.js");
const { readRunAdmission, readRunMemory } = require("./lib/run-memory.js");

let treeRoot = process.cwd();

let watch: import("./lib/run-steadiness.js").Watch | null = null;

let auditDir: string | null = null;

function armAudit() {
	auditDir = isRowlessRun() ? null : readAudit.install(treeRoot);
}

function disarmAudit(recorded: Record<string, unknown> | null) {
	keepRun(auditDir, recorded);
	readAudit.remove(auditDir);
	auditDir = null;
}

export function setup(project?: { config?: { root?: string } }) {
	const root = project?.config?.root;
	if (typeof root === "string" && root) treeRoot = root;
	watch = watchRun(treeRoot);
	armAudit();
}

export function teardown() {
	runTeardown();
}

function recordFiles(
	marker: { sha: string; at?: string; treeAtEnd?: string },
	files: { results: unknown[]; shared: string[]; clean: boolean } | null,
	{
		steadiness,
		root,
	}: {
		steadiness: import("./lib/run-steadiness.js").Steadiness;
		root: string | null;
	},
) {
	if (!files || !marker.at) return null;
	const run = {
		sha: marker.sha,
		at: marker.at,
		tree: marker.treeAtEnd ?? null,
		root: treeRoot,
		files: files.results,
		shared: files.shared,
		clean: files.clean,
		steadiness,
	};
	recordFileResults(
		{ ...run, audits: readAuditsOrNone() },
		{ storeRoot: root },
	);
	return run;
}

function readAuditsOrNone() {
	if (auditDir === null) return null;
	try {
		return readAudit.readAudits(auditDir, treeRoot);
	} catch (e) {
		process.stderr.write(
			`vitest-tree-watch: the read audit will not read (${caught(e).message ?? e}), so no file records a row (workflow-core#4916)\n`,
		);
		return null;
	}
}

// `vitest` calls `teardown()` with no arguments.
export function runTeardown(rootOverride?: string | null) {
	const { before, after, drifted, steadiness } = (
		watch ?? unwatchedRun(treeRoot)
	).close();

	const moved = format(drifted);
	if (moved) process.stderr.write(`${moved}\n`);

	const { outcome, ...report } = takeRunReport();
	const launch = readLaunch();
	const buildMarkerRun = () => ({
		...report,
		isolated: launch.isolated,
		argv: launch.argv,
		memory: readRunMemory(),
		admission: readRunAdmission(),
		treeAtEnd: endOfRunTreeIdentity(treeRoot),
	});

	const root = rootOverride ?? repoRoot(treeRoot);

	let recorded: Record<string, unknown> | null = null;
	const capped = outcome === true && hasOwnScopeHitCap();
	if (outcome === true && after && !capped) {
		const marker = markerFrom(before, after, drifted, buildMarkerRun());
		record(marker, { root });
		recorded = recordFiles(marker, report.files, { steadiness, root });
	}

	if (outcome === false && after) {
		const marker = markerFrom(before, after, drifted, buildMarkerRun());
		const written = recordFailure(marker, { root });
		recorded = recordFiles(marker, report.files, { steadiness, root });
		if (written && rootOverride == null)
			process.stderr.write(
				`\n  The failing test names are recorded in ${storePath(root, FAIL_STORE)}, so this run\n` +
					"  need not be repeated to recover them. This run's line, names only:\n" +
					`    ${failureRecoveryCommand(root, marker)}\n`,
			);
		const owners = readAlreadyRedLines(marker, root);
		if (owners.length > 0) process.stderr.write(`\n${owners.join("\n")}\n`);
	}
	disarmAudit(recorded);
}
