// @vitest-environment node
// full-sweep-only: #2791

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { coreDenyTexts, decideModule } from "./core-deny-text.js";
import { readManifest } from "./guard-cores.js";

const SCRIPTS = path.resolve(__dirname, "..");

const KNOWN_MISSES: Record<string, string> = {
	"dispatch-rewrite.js": "its one refusal is a rule fragment, ctx.ruleText",
	"unasked-rerun-guard.js": "its refusal is another module's out.deny",
};

const refuses = (source: string) =>
	/(?<![\w$.])deny\s*[:(]/.test(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ""));

function liveCores(): string[] {
	const cores = new Set(
		Object.values(readManifest())
			.flat()
			.map((r) => r.core),
	);
	for (const f of fs.readdirSync(SCRIPTS)) {
		if (!/^guard-.*\.js$/.test(f)) continue;
		const lib = decideModule(fs.readFileSync(path.join(SCRIPTS, f), "utf8"));
		if (lib !== null) cores.add(path.basename(lib));
	}
	return [...cores].sort();
}

describe("the live guard cores' deny text (#3001)", () => {
	const cores = liveCores();

	it.each(cores)("%s yields deny text where it refuses", (core) => {
		const source = fs.readFileSync(path.join(SCRIPTS, "lib", core), "utf8");
		if (!refuses(source) || core in KNOWN_MISSES) return;
		const words = coreDenyTexts(source).join(" ").split(/\s+/).filter(Boolean);
		expect(words.length).toBeGreaterThan(0);
	});

	it("lists no known miss that is no longer a live core", () => {
		expect(Object.keys(KNOWN_MISSES).filter((c) => !cores.includes(c))).toEqual(
			[],
		);
	});
});
