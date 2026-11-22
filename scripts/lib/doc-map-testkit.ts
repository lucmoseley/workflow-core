import fs from "node:fs";
import { createRequire } from "node:module";

const { REGISTER_HEADER } = createRequire(import.meta.url)("./doc-map.js");
export const emptyDataFile = (name: string) =>
	name === "doc-map-high-water.json" ? '{ "highWaterMark": 0 }\n' : "{}\n";

export const REGISTER_SEP = "|---|---|---|---|---|";

export const syntheticPaths = (count: number, prefix = "docs/synthetic-") =>
	Array.from({ length: count }, (_, i) => `${prefix}${i}.md`);

export const registerRow = (
	file: string,
	role = "a doc",
	cls = "free-edit",
): string => `| \`${file}\` | ${role} | \`${cls}\` | Direct | — |`;

export interface MapSubsection {
	heading: string;
	rows?: string[];
	list?: string[];
	listClass?: string;
}

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

export const syntheticSidecar = (
	paths: string[],
	entryFor: (file: string, i: number) => unknown = () => sidecarEntry(),
): Record<string, unknown> =>
	Object.fromEntries(paths.map((p, i) => [p, entryFor(p, i)]));

export const writeSidecar = (file: string, data: unknown) =>
	fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
