/*
 * pass-store-testkit.ts — what the tests of the per-file pass store
 * (lib/pass-store.js) share. FOR TESTS ONLY. Three test files hand a run
 * the audit of a file that read nothing; they take its one `Reads` shape
 * from here, so a field the audit gains is one edit, never three (#4790).
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
