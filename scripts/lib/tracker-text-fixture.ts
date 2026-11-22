import fs from "node:fs";
import path from "node:path";

export const TEXT_MODULE = "scripts/lib/tracker-inject-text.js";

const UNION_FRAGMENTS = [
	"review-deviations-read",
	"review-finding-destination",
];

export function textModuleSource(header: string, extra = ""): string {
	return [
		`const HEADER = ${JSON.stringify(header)};`,
		"module.exports = {",
		'\tCOMMANDS: ["implement", "triage"],',
		"\tTAKES_READ: [],",
		'\ttakesLine: () => "",',
		"\theader: () => HEADER,",
		'\tWAYFINDER_CLAUSES: "",',
		"\tINDEX: {},",
		'\ttrackerIndex: () => "",',
		"\tCLOSING_STEPS: {},",
		'\tPRICED_OPTIONS_POINTER: "",',
		"\tcodeReviewParts: () => [],",
		extra,
		"};",
		"",
	].join("\n");
}

export function writeTextModule(root: string, source: string): string {
	const file = path.join(root, TEXT_MODULE);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, source);
	const rules = path.join(root, "docs", "agents", "rules");
	fs.mkdirSync(rules, { recursive: true });
	for (const id of UNION_FRAGMENTS)
		fs.writeFileSync(path.join(rules, `${id}.txt`), "");
	return file;
}
