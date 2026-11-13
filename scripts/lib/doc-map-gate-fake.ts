/*
 * doc-map-gate-fake.ts — the shared fake of lib/doc-map-gate.js's ports
 * (#5155). A case picks the git state and the checker's answers as a
 * `GateScene`; the fake serves them and records each checker call.
 * doc-map-gate.contract.test.ts holds it to lib/doc-map-gate-ports.js, the
 * production adapters, over one list of scenes (base §G7).
 */

import type { DocMapGatePorts } from "./doc-map-gate.js";

export interface GateScene {
	/** `git checkout-index -a` of the hook's index succeeds. Default true. */
	extracts?: boolean;
	/** The index holds docs/doc-map.md. Default true. */
	mapInIndex?: boolean;
	/** `git diff --quiet HEAD -- docs/doc-map.md`'s exit. Default 0. */
	mapDiffStatus?: number | null;
	/** What git answers on a staged deletion of the map, asked when unreadable. */
	deletion?: { ok: boolean; deleted: boolean };
	/** The held check's exit and its combined output. Default a pass printing nothing. */
	check?: { status: number; report: string };
	/** HEAD's tree holds the map. Default true. */
	headHoldsMap?: boolean;
	/** No commit yet, so `git read-tree HEAD` fails. Default false. */
	headUnborn?: boolean;
	/** checker-new-faults.js's answer. Default "this commit adds one fault". */
	newFaults?: { status: number; stdout: string; stderr: string };
	/** HEAD's docs/doc-map.md, or "" where unreadable. Default "". */
	headMap?: string;
}

/** One checker call: its arguments, and the index it ran under. */
export interface CheckCall {
	args: string[];
	json: boolean;
	indexFile: string | undefined;
}

/** The fake ports over `scene`, and the checker calls they received. */
export function fakeGatePorts(scene: GateScene): {
	ports: DocMapGatePorts;
	calls: CheckCall[];
} {
	const calls: CheckCall[] = [];
	const files = new Map<string, string>();
	let dirs = 0;
	const headIndexes = new Set<string>();
	const ports: DocMapGatePorts = {
		tmpdir: () => `/fake/tmp${++dirs}`,
		extract: (prefix, indexFile) => {
			const ok =
				indexFile === undefined
					? (scene.extracts ?? true)
					: headIndexes.has(indexFile);
			const holdsMap =
				indexFile === undefined
					? (scene.mapInIndex ?? true)
					: (scene.headHoldsMap ?? true);
			if (ok && holdsMap) files.set(`${prefix}docs/doc-map.md`, "map");
			return ok;
		},
		readHead: (indexFile) => {
			if (scene.headUnborn) return false;
			headIndexes.add(indexFile);
			return true;
		},
		isFile: (file) => files.has(file),
		mapDiffStatus: () =>
			scene.mapDiffStatus === undefined ? 0 : scene.mapDiffStatus,
		stageOut: (_rel, dest) => {
			if (scene.mapInIndex === false || scene.extracts === false) return false;
			files.set(dest, "map");
			return true;
		},
		deletedByCommit: () => scene.deletion ?? { ok: true, deleted: false },
		check: (args, out) => {
			calls.push({ args, json: false, indexFile: undefined });
			const run = scene.check ?? { status: 0, report: "" };
			files.set(out, run.report);
			return run.status;
		},
		checkJson: (args, out, indexFile) => {
			calls.push({ args, json: true, indexFile });
			files.set(out, "{}");
		},
		read: (out) => files.get(out) ?? "",
		newFaults: () =>
			scene.newFaults ?? {
				status: 1,
				stdout: "dead: docs/new-fault.md\n",
				stderr: "",
			},
		headMap: () => scene.headMap ?? "",
	};
	return { ports, calls };
}
