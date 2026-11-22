import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const { requiredGroup }: typeof import("./lib/regex-group.js") = createRequire(
	import.meta.url,
)("./lib/regex-group.js");

const SIBLING_REQUIRE = /require\("\.\/([^"]+)"\)/g;
const PROGRAM_LIB_REQUIRE = /require\("\.\/lib\/([^"]+)"\)/g;

const requiresOf = (pattern: RegExp) => (text: string) =>
	[...text.matchAll(pattern)]
		.map((m) => {
			const name = requiredGroup(m, 1, pattern);
			return name.endsWith(".js") ? name : `${name}.js`;
		})
		.filter((lib) => fs.existsSync(path.resolve(__dirname, "lib", lib)));

const READ_BY_PATH: Record<string, string[]> = {
	"model-table.js": ["model-routing.json"],
};

const readRequiredLibs = (entry: string): string[] => {
	const libs = [
		entry,
		...readLibClosure(
			fs.readFileSync(path.resolve(__dirname, "lib", entry), "utf8"),
			requiresOf(SIBLING_REQUIRE),
		).filter((lib) => lib !== entry),
	];
	return [...libs, ...libs.flatMap((lib) => READ_BY_PATH[lib] ?? [])];
};

export const readProgramLibs = (program: string): string[] => [
	...new Set(
		requiresOf(PROGRAM_LIB_REQUIRE)(
			fs.readFileSync(path.resolve(__dirname, program), "utf8"),
		).flatMap(readRequiredLibs),
	),
];

export const copyLibs = (
	dest: string,
	libs: string[],
	omit: string[] = [],
): void => {
	fs.mkdirSync(dest, { recursive: true });
	for (const lib of libs.filter((l) => !omit.includes(l)))
		fs.copyFileSync(path.resolve(__dirname, "lib", lib), path.join(dest, lib));
};

const readLibClosure = (text: string, named: (text: string) => string[]) => {
	const out = new Set<string>();
	const queue = named(text);
	for (let lib = queue.shift(); lib !== undefined; lib = queue.shift()) {
		if (out.has(lib)) continue;
		out.add(lib);
		queue.push(
			...named(fs.readFileSync(path.resolve(__dirname, "lib", lib), "utf8")),
		);
	}
	return [...out];
};
