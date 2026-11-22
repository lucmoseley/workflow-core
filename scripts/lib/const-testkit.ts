import fs from "node:fs";
import { escapeRe } from "./regex-group.js";

function readConst(file: string, before: string, after: string): number {
	const found = new RegExp(
		`^${escapeRe(before)}(\\d+)${escapeRe(after)}$`,
		"m",
	).exec(fs.readFileSync(file, "utf8"))?.[1];
	if (found === undefined)
		throw new Error(`no ${before}<n>${after} line in ${file}`);
	return Number(found);
}

export const readShellConst = (file: string, name: string): number =>
	readConst(file, `${name}=`, "");

export const readJsConst = (file: string, name: string): number =>
	readConst(file, `const ${name} = `, ";");
