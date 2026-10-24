// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { censusRefusal } = require("./census-digest.js") as {
	censusRefusal: (n: number, rows: string[]) => string;
};
const { ladderReason } = require("./research-ladder.js") as {
	ladderReason: (
		lines: string[],
		opts: { missing: string[]; corpus: string[] | null; last: string | null },
	) => string;
};

const CORE = path.join(__dirname, "..", "..");

describe("refusal script paths in an install (#1993)", () => {
	let root: string;

	beforeEach(() => {
		/* No package.json, so script-path.js reads it as an install. */
		root = fs.mkdtempSync(path.join(os.tmpdir(), "refusal-paths-"));
		vi.stubEnv("WFC_SCRIPT_ROOT", root);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		fs.rmSync(root, { recursive: true, force: true });
	});

	function namedScripts(text: string) {
		const names = [...text.matchAll(/node (\S+)/g)].map((m) => m[1]);
		expect(names.length).toBeGreaterThan(0);
		for (const name of names) {
			expect(name.startsWith(`${root}/scripts/`)).toBe(true);
			expect(
				fs.existsSync(path.join(CORE, path.relative(root, name))),
				name,
			).toBe(true);
		}
		return names;
	}

	it("names the census checker at the plugin root", () => {
		expect(namedScripts(censusRefusal(5, ["guard-x.sh"]))).toEqual([
			`${root}/scripts/check-instruction-surface.js`,
			`${root}/scripts/check-instruction-surface.js`,
		]);
	});

	it("names the corpus lister and the decision recorder", () => {
		const reason = ladderReason(["q"], {
			missing: ["rulings"],
			corpus: null,
			last: null,
		});
		expect(namedScripts(reason)).toEqual([
			`${root}/scripts/lib/workflow-core-config.js`,
			`${root}/scripts/record-delegated-decision.js`,
		]);
	});
});
