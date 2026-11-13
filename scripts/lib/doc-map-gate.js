/*
 * doc-map-gate.js — the pre-commit doc-map gate's core (mantahostels#390, #5155): runs
 * check-doc-map.js over this commit's index, refuses only the faults this
 * commit adds, and replays what a held green report must not hide.
 * scripts/precommit-doc-map-gate.js is its shell.
 *
 * THE INDEX CARRIES THE COMMIT'S SCOPE (mantahostels#1922). A pathspec commit
 * (`git commit -m … -- <paths>`) makes git hand the hook its own
 * GIT_INDEX_FILE, so the extraction holds HEAD's files plus this commit's
 * paths and NOT another `git add -N` file. A pathspec-LESS commit extracts the
 * worktree's index, so there every staged doc counts.
 *
 * THE WHOLE INDEX IS EXTRACTED AND THE CHECKER POINTED AT IT WITH --root
 * (mantahostels#1922), so the whole reading sits on one tree and no list of the map's data
 * files has to be kept in step with DATA_FILES (mantahostels#1595). Partial staging is no
 * gap: the index carries every tracked file, so the extraction holds HEAD's
 * blob for one this commit does not stage (mantahostels#1202). What --root deliberately
 * does NOT move is the two untracked-file softeners, which only ever turn a
 * FAIL into a WARN; check-doc-map.js's header owns that ruling.
 *
 * UNREADABLE IS APPARATUS, NOT A FINDING, so it warns and passes and leaves it
 * to the sweeps — with one exception, a staged deletion of the map itself
 * (mantahostels#2902), which is the fault and refuses. The extraction failing outright
 * and the map being absent from it are told apart from a deletion by asking
 * git about the map alone: `checkout-index` exits 0 on an unmerged index and
 * silently omits the conflicted path, so its status cannot answer that.
 *
 * GATED ON DIRECTION (mantahostels#1688): a failing check refuses only where the commit
 * adds a fault. Both readings come from --json, so the comparison is per fault
 * item and never a count. The baseline is HEAD extracted the same way, through
 * a temp index, under GIT_INDEX_FILE as well as --root: --root moves the
 * filesystem reads, and assertion 16's pool delta is an INDEX read
 * (`:<path>`), which no directory can stand in for. Without it the baseline
 * measures this commit's own pool growth and a commit adding pool bytes with no
 * §B entry reads as inherited (mantahostels#1922). HEAD holding no map is no baseline,
 * and refuses rather than reading as "nothing inherited".
 *
 * --map-dirty: the checker reads the map from a path with no git identity, so
 * it cannot tell a genuinely stale sidecar from one stale only because the map
 * is mid-edit (mantahostels#1193). The gate asks git about the real path and passes the
 * verdict on; only diff's exit 1 reads as dirty, so an apparatus failure falls
 * through to the checker's own clean-by-default reading.
 *
 * A CORE (base §T7): every read goes through the ports the shell hands in.
 */

const {
	allowDeleteLine,
	deletionUnknownLine,
	directionVerdict,
	noBaselineLine,
	refuseDeletedLines,
	skipLine,
	substituted,
} = require("./precommit-gate-verdicts.js");
const { greenReport, readsHeadMap } = require("./doc-map-gate-report.js");

const MAP = "docs/doc-map.md";
const LABEL = "doc-map";

/**
 * @typedef {object} DocMapGatePorts
 * @property {() => string} tmpdir a fresh scratch directory the shell removes
 * @property {(prefix: string, indexFile?: string) => boolean} extract
 *   `git checkout-index -a --prefix=<prefix>`, of the hook's index or of
 *   `indexFile`; true on exit 0
 * @property {(indexFile: string) => boolean} readHead `git read-tree HEAD`
 *   into `indexFile`; true on exit 0
 * @property {(file: string) => boolean} isFile
 * @property {() => number | null} mapDiffStatus `git diff --quiet HEAD -- docs/doc-map.md`'s exit
 * @property {(rel: string, dest: string) => boolean} stageOut
 *   `git cat-file -p :<rel>` written to `dest`; true on exit 0
 * @property {(rel: string) => { ok: boolean, deleted: boolean }} deletedByCommit
 *   whether git lists `rel` as a staged deletion; `ok` false where it could not answer
 * @property {(args: string[], out: string) => number} check
 *   check-doc-map.js with `args`, stdout and stderr together into `out`; its exit
 * @property {(args: string[], out: string, indexFile?: string) => void} checkJson
 *   check-doc-map.js with `args`, stdout alone into `out`, stderr dropped
 * @property {(out: string) => string} read a file the gate wrote
 * @property {(staged: string, baseline: string) => { status: number, stdout: string, stderr: string }} newFaults
 *   checker-new-faults.js's doc-map comparison
 * @property {() => string} headMap HEAD's docs/doc-map.md, or "" where unreadable
 */

/**
 * The verdict where the index will not give up the map: a staged deletion of
 * it refuses unless escaped, and anything else warns and passes.
 * @param {DocMapGatePorts} ports
 * @param {string} dir
 * @param {{ allowDelete: boolean }} env
 * @returns {{ exit: number, stderr: string }}
 */
function unreadableIndex(ports, dir, env) {
	let stderr = "";
	if (!ports.stageOut(MAP, `${dir}/doc-map.md`)) {
		const asked = ports.deletedByCommit(MAP);
		if (!asked.ok) stderr += deletionUnknownLine(MAP);
		if (asked.ok && asked.deleted) {
			if (!env.allowDelete)
				return { exit: 1, stderr: stderr + refuseDeletedLines(LABEL, [MAP]) };
			stderr += allowDeleteLine([MAP]);
		}
	}
	return {
		exit: 0,
		stderr: stderr + skipLine(LABEL, "git checkout-index would not write it"),
	};
}

/**
 * Whether a failing check's faults are all in HEAD: the staged side under this
 * commit's index, the baseline under HEAD's own.
 * @param {DocMapGatePorts} ports
 * @param {string} tree this commit's extraction
 * @param {string[]} dirty
 * @returns {{ pass: boolean, text: string }}
 */
function inheritedOnly(ports, tree, dirty) {
	const base = ports.tmpdir();
	const index = `${base}/index`;
	const baseTree = `${base}/tree`;
	const headRead = ports.readHead(index);
	const headExtracted = ports.extract(`${baseTree}/`, index);
	if (!(headRead && headExtracted && ports.isFile(`${baseTree}/${MAP}`)))
		return { pass: false, text: noBaselineLine(LABEL) };
	ports.checkJson(["--root", tree, ...dirty, "--json"], `${base}/staged.json`);
	ports.checkJson(
		["--root", baseTree, "--json"],
		`${base}/baseline.json`,
		index,
	);
	return directionVerdict(
		LABEL,
		"mantahostels#1688",
		ports.newFaults(`${base}/staged.json`, `${base}/baseline.json`),
	);
}

/**
 * The gate's verdict for one commit.
 * @param {DocMapGatePorts} ports
 * @param {{ allowDelete: boolean }} env WFC_ALLOW_GATE_INPUT_DELETE, set and non-empty
 * @returns {{ exit: number, stderr: string }}
 */
function runDocMapGate(ports, env) {
	const dir = ports.tmpdir();
	const tree = `${dir}/tree`;
	if (!(ports.extract(`${tree}/`) && ports.isFile(`${tree}/${MAP}`)))
		return unreadableIndex(ports, dir, env);

	let stderr = "";
	const dirty = ports.mapDiffStatus() === 1 ? ["--map-dirty"] : [];
	const held = `${dir}/report.txt`;
	const status = ports.check(["--root", tree, ...dirty], held);
	const report = substituted(ports.read(held));

	if (status !== 0) {
		stderr += `${report}\n  Those paths are inside a throwaway extraction of this commit's index.\n`;
		const verdict = inheritedOnly(ports, tree, dirty);
		stderr += verdict.text;
		if (!verdict.pass) return { exit: status, stderr };
	}

	const green = greenReport(
		report,
		readsHeadMap(report) ? ports.headMap() : "",
	);
	return { exit: green.exit, stderr: stderr + green.text };
}

module.exports = { runDocMapGate };
