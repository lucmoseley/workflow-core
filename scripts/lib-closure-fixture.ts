import fs from "node:fs";
import path from "node:path";
import { programLibs } from "./lib/program-libs.js";

export const readProgramLibs = (program: string): string[] =>
	programLibs(program, {
		read: (rel) => fs.readFileSync(path.resolve(__dirname, rel), "utf8"),
		exists: (rel) => fs.existsSync(path.resolve(__dirname, rel)),
	});

export const copyLibs = (
	dest: string,
	libs: string[],
	omit: string[] = [],
): void => {
	fs.mkdirSync(dest, { recursive: true });
	for (const lib of libs.filter((l) => !omit.includes(l)))
		fs.copyFileSync(path.resolve(__dirname, "lib", lib), path.join(dest, lib));
};
