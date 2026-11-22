import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { fileReach } = require("./file-reach.js");

export const ROOT = path.resolve(__dirname, "..", "..");

export const MARKER = /code-edges (loads|caller): /;

export const DECLARING: Record<string, string> = {
	"scripts/count-guard-fires.test.ts": path.join(
		ROOT,
		"scripts/count-guard-fires.test.ts",
	),
	"scripts/file-morning-review.test.ts": path.join(
		ROOT,
		"scripts/file-morning-review.test.ts",
	),
	"scripts/guard-selection-sum.test.ts": path.join(
		ROOT,
		"scripts/guard-selection-sum.test.ts",
	),
	"scripts/guard-uncommitted-work.test.ts": path.join(
		ROOT,
		"scripts/guard-uncommitted-work.test.ts",
	),
	"scripts/hook-registrations.test.ts": path.join(
		ROOT,
		"scripts/hook-registrations.test.ts",
	),
	"scripts/lib/guard-core-load.js": path.join(
		ROOT,
		"scripts/lib/guard-core-load.js",
	),
	"scripts/lib/guard-judge.js": path.join(ROOT, "scripts/lib/guard-judge.js"),
	"scripts/lib/host-git-guard/git": path.join(
		ROOT,
		"scripts/lib/host-git-guard/git",
	),
	"scripts/lost-deny-rates.test.ts": path.join(
		ROOT,
		"scripts/lost-deny-rates.test.ts",
	),
	"vitest.setup.ts": path.join(ROOT, "vitest.setup.ts"),
};

export const reach = (at: string, text: string) =>
	fileReach(at, text, () => undefined, null);

export interface MarkerLine {
	line: string;
	kind: "loads" | "caller";
	words: string[];
	without: string;
	isDeclaration: boolean;
}

export function readMarkerLines(at: string): MarkerLine[] {
	const text = fs.readFileSync(at, "utf8");
	const whole = JSON.stringify(reach(at, text));
	const lines = text.split("\n");
	return lines.flatMap((line, i) => {
		const m = MARKER.exec(line);
		if (!m) return [];
		const without = [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n");
		return [
			{
				line,
				kind: m[1] === "caller" ? "caller" : "loads",
				words: line
					.slice((m.index ?? 0) + m[0].length)
					.trim()
					.split(/\s+/),
				without,
				isDeclaration: JSON.stringify(reach(at, without)) !== whole,
			},
		];
	});
}
