/*
 * pass-store-testkit.ts — what the tests of the per-file pass store
 * (lib/pass-store.js) share. FOR TESTS ONLY. Each test file that hands the
 * pass store a run takes from here the audit of a file that read nothing,
 * and the run's steadiness off a real watch, so a field either gains is one
 * edit, never one per file (#4790, #5073).
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { watchRun } = require("./run-steadiness.js");

export type Reads = import("./read-audit.js").Reads;
export type Audit = import("./read-audit.js").Audit;

/** A file's audit that saw it read nothing beside its inputs (#4916). */
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

/**
 * The steadiness a real watch on `root` saw (lib/run-steadiness.js), with
 * `during` run between its open and its close. It takes its own mark,
 * never one this suite's launcher handed down.
 */
export function watched(root: string, during?: () => void) {
	const watch = watchRun(root, { env: {}, err: { write: () => true } });
	during?.();
	return watch.close().steadiness as Steadiness;
}
