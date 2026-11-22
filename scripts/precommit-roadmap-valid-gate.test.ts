// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerTempCleanup, stagedRepo } from "./lib/precommit-gate-harness";
import {
	dispatchStubbed,
	patternRow,
	ROOT,
} from "./lib/precommit-gate-testkit";
import { GATES } from "./lib/precommit-gates.js";

const CHECKER = "scripts/check-roadmap-valid.js";
const PAIR = "scripts/check-roadmap-pair.js";
const ROADMAP = "docs/reference-roadmap.html";

const temps = registerTempCleanup();

const ROW = patternRow(CHECKER);
const PATTERN = ROW.arm.pattern;

function parityGap(pattern: RegExp): string | null {
	const checker = fs.readFileSync(path.join(ROOT, CHECKER), "utf8");
	const decl = /const HTML = "([^"]+)"/.exec(checker);
	if (!decl) return `HTML no longer parses out of ${CHECKER}`;
	const judged = decl[1];
	const look = `vendor/${judged}`;
	return pattern.test(judged) && !pattern.test(look)
		? null
		: `the row matches ${pattern}, the checker judges '${judged}'`;
}

async function arms(root: string): Promise<boolean> {
	return (await dispatchStubbed(root, ROW)).ran;
}

const repo = (staged: Record<string, string>, committed = {}) =>
	stagedRepo("roadmap-valid-gate-", temps, committed, staged);

describe("the pre-commit roadmap-validity row", () => {
	it("is a gating checker row the batch set runs", () => {
		expect(ROW).toMatchObject({
			policy: "gate",
			kind: "checker",
			lander: "batch",
		});
	});

	it("runs after the roadmap-pair row", () => {
		const at = (script: string) => GATES.findIndex((g) => g.script === script);
		expect(at(PAIR)).toBeGreaterThan(-1);
		expect(at(CHECKER)).toBeGreaterThan(at(PAIR));
	});

	it("arms on exactly the path the checker judges", () => {
		expect(parityGap(PATTERN)).toBeNull();
	});

	it("reports a gap when the arm and the checker disagree", () => {
		expect(parityGap(/^docs\/roadmap\.html$/)).toMatch(/the row matches/);
		expect(parityGap(/docs\/reference-roadmap\.html$/)).toMatch(
			/the row matches/,
		);
	});

	it("arms on a commit staging the roadmap", async () => {
		expect(await arms(repo({ [ROADMAP]: "<html></html>\n" }).root)).toBe(true);
	});

	it("does not arm on a commit that leaves the roadmap alone", async () => {
		expect(await arms(repo({ "docs/other.md": "x\n" }).root)).toBe(false);
	});

	it("does not arm on a path that only resembles the roadmap", async () => {
		const { root } = repo({
			"vendor/docs/reference-roadmap.html": "x\n",
			"docs/reference-roadmap.html.bak": "x\n",
		});
		expect(await arms(root)).toBe(false);
	});

	it("arms on a deletion of the roadmap", async () => {
		const { root, git } = repo({}, { [ROADMAP]: "<html></html>\n" });
		git("rm", "-q", "--", ROADMAP);
		expect(await arms(root)).toBe(true);
	});
});
