import fs from "node:fs";
import path from "node:path";
import { localRequires } from "./lib/require-closure-testkit";

const SIBLING = /^\.\/([^/]+)$/;
const PROGRAM_LIB = /^\.\/lib\/([^/]+)$/;

const requiresOf = (pattern: RegExp) => (text: string) =>
	localRequires(text)
		.flatMap((req) => {
			const name = pattern.exec(req)?.[1];
			if (name === undefined) return [];
			return [name.endsWith(".js") ? name : `${name}.js`];
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
			requiresOf(SIBLING),
		).filter((lib) => lib !== entry),
	];
	return [...libs, ...libs.flatMap((lib) => READ_BY_PATH[lib] ?? [])];
};

export const readProgramLibs = (program: string): string[] => [
	...new Set(
		requiresOf(PROGRAM_LIB)(
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
