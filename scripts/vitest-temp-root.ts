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
