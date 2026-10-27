// @vitest-environment node
/*
 * Every live Node guard core that refuses yields deny text to
 * lib/core-deny-text.js (#3001): each core lib/guard-cores.json runs, and each
 * core a `scripts/guard-*.js` entry takes `decide` from. A core the reader
 * comes back empty on drops out of check-guard-registry.js's REPRINTED check
 * silently, which is how two of them slipped past the first cut of #3001.
 *
 * full-sweep-only: reads every core the manifest and the entries name, a set
 * derived at runtime, so no literal path names them.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { coreDenyTexts, decideModule } from "./core-deny-text.js";
import { readManifest } from "./guard-cores.js";

const SCRIPTS = path.resolve(__dirname, "..");

/* Cores that refuse with wording the reader cannot reach, each for its reason. */
const KNOWN_MISSES: Record<string, string> = {
	"dispatch-rewrite.js": "its one refusal is a rule fragment, ctx.ruleText",
	"unasked-rerun-guard.js": "its refusal is another module's out.deny",
};

/* Whether a core's source holds a deny site at all, comments aside. */
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
