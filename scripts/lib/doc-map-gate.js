const {
	allowDeleteLine,
	brokenLine,
	deletionUnknownLine,
	directionVerdict,
	noBaselineLine,
	refuseDeletedLines,
	skipLine,
	substituted,
} = require("./precommit-gate-verdicts.js");
const { greenReport, hasUntrackedBlock } = require("./doc-map-gate-report.js");

const MAP = "docs/doc-map.md";
const LABEL = "doc-map";
const BROKEN_EXIT = 2;

/**
 * @typedef {object} DocMapGatePorts
 * @property {() => string} tmpdir
 * @property {(prefix: string, indexFile?: string) => boolean} extract
 * @property {(indexFile: string) => boolean} readHead
 * @property {(file: string) => boolean} isFile
 * @property {() => number | null} mapDiffStatus
 * @property {(rel: string, dest: string) => boolean} stageOut
 * @property {(rel: string) => { ok: boolean, deleted: boolean }} deletedByCommit
 * @property {(args: string[], out: string) => number} check
 * @property {(args: string[], out: string, indexFile?: string) => void} checkJson
 * @property {(out: string) => string} read
 * @property {(staged: string, baseline: string) => { status: number, stdout: string, stderr: string }} newFaults
 * @property {() => string} readHeadMap
 */

/**
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
 * @param {DocMapGatePorts} ports
 * @param {string} tree
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
 * @param {DocMapGatePorts} ports
 * @param {{ allowDelete: boolean }} env
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
		if (status === BROKEN_EXIT)
			return { exit: status, stderr: stderr + brokenLine(LABEL) };
		const verdict = inheritedOnly(ports, tree, dirty);
		stderr += verdict.text;
		if (!verdict.pass) return { exit: status, stderr };
	}

	const green = greenReport(
		report,
		hasUntrackedBlock(report) ? ports.readHeadMap() : "",
	);
	return { exit: green.exit, stderr: stderr + green.text };
}

module.exports = { runDocMapGate };
