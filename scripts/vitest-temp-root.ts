/*
 * vitest-temp-root.ts — a vitest globalSetup that gives the run one private temp root (#5083).
 *
 * IMPLICIT:  on every suite run, makes `<os.tmpdir()>/wfc-vitest-<pid>-XXXXXX`,
 *            hands it to the workers, whose setup file points `TMPDIR` at it,
 *            and removes it at teardown, with every fixture a test left in it.
 * JUSTIFIED: fail-safe — a test that never removes its fixture otherwise
 *            leaves it in the machine's `/tmp` for good (#5081).
 * DEFEAT:    none — vitest's own process keeps the real temp root, so the
 *            suite queue and the wrapper's hand-off files never move.
 */

import { createRequire } from "node:module";

const { makeRunRoot, removeRunRoot } = createRequire(import.meta.url)(
	"./lib/run-temp-root.js",
);

declare module "vitest" {
	export interface ProvidedContext {
		wfcTempRoot: string;
	}
}

let root: string | null = null;

export function setup(project: {
	provide: (key: "wfcTempRoot", value: string) => void;
}) {
	root = makeRunRoot("vitest");
	project.provide("wfcTempRoot", root as string);
}

export function teardown() {
	if (root === null) return;
	try {
		removeRunRoot(root);
	} catch (error) {
		process.stderr.write(
			`vitest-temp-root: ${root} would not go (${String(error)}); the next run's wrapper removes it\n`,
		);
	}
	root = null;
}
