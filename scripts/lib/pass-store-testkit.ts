/*
 * pass-store-testkit.ts — what the tests of the per-file pass store
 * (lib/pass-store.js) share. FOR TESTS ONLY.
 */

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
