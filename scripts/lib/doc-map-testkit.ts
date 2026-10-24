/*
 * doc-map-testkit.ts — a synthetic docs/doc-map.md and its class sidecar
 * (docs/doc-map-classes.json), for tests that need a well-formed pair without
 * reading a host's real one.
 */

import fs from "node:fs";
import { createRequire } from "node:module";

const { REGISTER_HEADER } = createRequire(import.meta.url)("./doc-map.js");
/** A doc-map data file's day-one text: the high-water mark at 0, any other
 * `{}` — check-doc-map.js is BROKEN on a mark file without `highWaterMark`. */
export const emptyDataFile = (name: string) =>
	name === "doc-map-high-water.json" ? '{ "highWaterMark": 0 }\n' : "{}\n";

/** The separator line under a §A register header. */
export const REGISTER_SEP = "|---|---|---|---|---|";

/** `count` distinct synthetic paths, `docs/synthetic-0.md` upwards. */
export const syntheticPaths = (count: number, prefix = "docs/synthetic-") =>
	Array.from({ length: count }, (_, i) => `${prefix}${i}.md`);

/** One five-column §A table row. */
export const registerRow = (
	file: string,
	role = "a doc",
	cls = "free-edit",
): string => `| \`${file}\` | ${role} | \`${cls}\` | Direct | — |`;

export interface MapSubsection {
	heading: string;
	/** A table's rows, under the register header. Ignored where `list` is set. */
	rows?: string[];
	/** A `register-list` block of these paths, marked with `listClass`. */
	list?: string[];
	listClass?: string;
}

/**
 * A doc map: `head`, then §A — its heading, `sectionAProse`, and each
 * subsection as a table or a register-list — then `after`, verbatim (§B on).
 */
export function syntheticDocMap(opts: {
	head?: string[];
	sectionA?: string;
	sectionAProse?: string[];
	subsections: MapSubsection[];
	after: string[];
}): string {
	const subsections = opts.subsections.flatMap((s) => [
		`### ${s.heading}`,
		"",
		...(s.list
			? [
					`<!-- register-list: ${s.listClass ?? "free-edit"} -->`,
					...s.list.map((p) => `- \`${p}\``),
					"<!-- /register-list -->",
				]
			: [REGISTER_HEADER, REGISTER_SEP, ...(s.rows ?? [])]),
		"",
	]);
	return [
		...(opts.head ?? ["# Doc map", ""]),
		opts.sectionA ?? "## Section A — document register",
		"",
		...(opts.sectionAProse ?? []),
		...subsections,
		...opts.after,
	].join("\n");
}

/** A full-shape sidecar entry, every renderable key present. */
export const sidecarEntry = (over: Record<string, unknown> = {}) => ({
	section: "Docs",
	class: "free-edit",
	classQualifier: null,
	role: null,
	route: null,
	consumes: null,
	reader: null,
	...over,
});

/** A sidecar keyed by `paths`, each entry from `entryFor` (full-shape by default). */
export const syntheticSidecar = (
	paths: string[],
	entryFor: (file: string, i: number) => unknown = () => sidecarEntry(),
): Record<string, unknown> =>
	Object.fromEntries(paths.map((p, i) => [p, entryFor(p, i)]));

/** Writes a sidecar as the generator does: two-space JSON, trailing newline. */
export const writeSidecar = (file: string, data: unknown) =>
	fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
