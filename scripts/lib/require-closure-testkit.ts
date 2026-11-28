import fs from "node:fs";
import path from "node:path";
import { localRequires } from "./local-requires.js";

const NAMED_SCRIPT = /(?<![\w.-])scripts\/[\w./-]+\.(?:js|sh)\b/g;

export function launchedScripts(text: string): string[] {
	const code = text
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("#"))
		.join("\n");
	return [...new Set(code.match(NAMED_SCRIPT))];
}

export function requireClosure(source: string, rels: string[]): string[] {
	const seen = new Set<string>();
	const queue = [...rels];
	for (let rel = queue.shift(); rel !== undefined; rel = queue.shift()) {
		if (seen.has(rel)) continue;
		seen.add(rel);
		const text = fs.readFileSync(path.join(source, rel), "utf8");
		if (rel.endsWith(".sh"))
			queue.push(
				...launchedScripts(text).filter((dep) =>
					fs.existsSync(path.join(source, dep)),
				),
			);
		else
			for (const req of localRequires(text)) {
				const dep = path.join(path.dirname(rel), req);
				queue.push(fs.existsSync(path.join(source, dep)) ? dep : `${dep}.js`);
			}
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
