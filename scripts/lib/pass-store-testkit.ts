import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { watchRun } = require("./run-steadiness.js");

export type Reads = import("./read-audit.js").Reads;
export type Audit = import("./read-audit.js").Audit;

export const NO_READS: Reads = {
	files: [],
	absent: [],
	dirs: [],
	lists: {},
	trees: [],
	scripts: [],
	git: [],
};

export type Steadiness = import("./run-steadiness.js").Steadiness;

export function watched(
	root: string,
	during?: () => void,
	options: Record<string, unknown> = {},
) {
	const watch = watchRun(root, {
		env: {},
		err: { write: () => true },
		...options,
	});
	during?.();
	return watch.close().steadiness as Steadiness;
}
