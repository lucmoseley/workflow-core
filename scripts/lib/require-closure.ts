import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { requiredGroup } = require("./regex-group.js");

const LOCAL_REQUIRE = /\brequire\(\s*["'](\.\.?\/[^"']+)["']\s*\)/g;
const NAMED_SCRIPT = /(?<![\w.-])scripts\/[\w./-]+\.(?:js|sh)\b/g;

function uncommented(text: string, marks: string[]): string {
	return text
		.split("\n")
		.filter((line) => !marks.some((mark) => line.trimStart().startsWith(mark)))
		.join("\n");
}

export function jsCode(text: string): string {
	return uncommented(text, ["//", "/*", "*"]);
}

export function localRequires(text: string): string[] {
	return [...jsCode(text).matchAll(LOCAL_REQUIRE)].map((m) =>
		requiredGroup(m, 1, LOCAL_REQUIRE),
	);
}

export function launchedScripts(text: string): string[] {
	return [...new Set(uncommented(text, ["#"]).match(NAMED_SCRIPT))];
}

export function requireClosure(source: string, rels: string[]): string[] {
	const seen = new Set<string>();
	const queue = [...rels];
	for (let rel = queue.shift(); rel !== undefined; rel = queue.shift()) {
		if (seen.has(rel)) continue;
		seen.add(rel);
		const text = fs.readFileSync(path.join(source, rel), "utf8");
		for (const req of localRequires(text)) {
			const dep = path.join(path.dirname(rel), req);
			queue.push(fs.existsSync(path.join(source, dep)) ? dep : `${dep}.js`);
		}
		if (rel.endsWith(".sh"))
			queue.push(
				...launchedScripts(text).filter((dep) =>
					fs.existsSync(path.join(source, dep)),
				),
			);
	}
	return [...seen];
}

export function copyRequireClosure(
	root: string,
	source: string,
	rels: string[],
): void {
	for (const rel of requireClosure(source, rels)) {
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.copyFileSync(path.join(source, rel), path.join(root, rel));
	}
}
