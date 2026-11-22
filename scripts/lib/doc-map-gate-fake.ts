import type { DocMapGatePorts } from "./doc-map-gate.js";

export interface GateScene {
	extracts?: boolean;
	mapInIndex?: boolean;
	mapDiffStatus?: number | null;
	deletion?: { ok: boolean; deleted: boolean };
	check?: { status: number; report: string };
	headHoldsMap?: boolean;
	headUnborn?: boolean;
	newFaults?: { status: number; stdout: string; stderr: string };
	headMap?: string;
}

export interface CheckCall {
	args: string[];
	json: boolean;
	indexFile: string | undefined;
}

export function fakeGatePorts(scene: GateScene): {
	ports: DocMapGatePorts;
	calls: CheckCall[];
	headMapReads: () => number;
} {
	const calls: CheckCall[] = [];
	let headMapReads = 0;
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
		readHeadMap: () => {
			headMapReads++;
			return scene.headMap ?? "";
		},
	};
	return { ports, calls, headMapReads: () => headMapReads };
}
