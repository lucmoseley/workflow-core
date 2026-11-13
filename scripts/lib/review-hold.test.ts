/*
 * The review hold's core: the marker's fault ladder, the stamp's value and the
 * refusal, word for word. The hold over real git is scripts/review-hold-gate.test.ts.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	markerFault,
	NAMED_PATHS_MAX,
	refusal,
	stampValue,
} from "./review-hold.js";
import { readShellConst } from "./shell-const-testkit";

const TREE = "t".repeat(40);
const clearing = `base=b\ntier=escalated\nareas=secrets, money\ntree=${TREE}\npaths=lib/a.js, lib/b.js\n`;
const without = (key: string) =>
	clearing
		.split("\n")
		.filter((l) => !l.startsWith(`${key}=`))
		.join("\n");
const fault = (text: string | null, owed = ["lib/a.js"]) =>
	markerFault(text, ["secrets"], TREE, owed);

describe("markerFault", () => {
	it("clears an escalated marker naming every area, this tree and every owed path", () => {
		expect(fault(clearing, ["lib/a.js", "lib/b.js"])).toBe("");
	});

	it("clears at the mission-critical tier", () => {
		expect(
			fault(clearing.replace("tier=escalated", "tier=mission-critical")),
		).toBe("");
	});

	it.each([
		["no marker", null, "there is no marker"],
		["no tier= line", without("tier"), "it has no tier= line"],
		[
			"a standard tier",
			clearing.replace("tier=escalated", "tier=standard"),
			"its tier= is 'standard', and only escalated or mission-critical covers a declared sensitive path",
		],
		[
			"a tier cut to 40 characters",
			clearing.replace("tier=escalated", `tier=${"x".repeat(50)}`),
			`its tier= is '${"x".repeat(40)}', and only escalated or mission-critical covers a declared sensitive path`,
		],
		[
			"an area unnamed",
			clearing.replace("areas=secrets, money", "areas=money"),
			"its areas= does not name secrets",
		],
		["no tree= line", without("tree"), "it has no tree= line"],
		[
			"another tree",
			clearing.replace(TREE, "u".repeat(40)),
			"its tree= is not the tree this commit carries, so something changed after it was written",
		],
		["no paths= line", without("paths"), "it has no paths= line"],
		[
			"paths= naming nothing",
			clearing.replace("paths=lib/a.js, lib/b.js", "paths= , "),
			"its paths= names no path",
		],
	])("names %s", (_, text, expected) => {
		expect(fault(text)).toBe(expected);
	});

	it("names every owed path paths= misses, up to NAMED_PATHS_MAX", () => {
		const owed = Array.from({ length: 12 }, (_, i) => `x/${i}`);
		expect(fault(clearing, owed)).toBe(
			`its paths= does not name ${owed.slice(0, 10).join(", ")}`,
		);
	});

	it("names as many paths as concision-marker.sh's NAMED_PATHS_MAX", () => {
		expect(NAMED_PATHS_MAX).toBe(
			readShellConst(
				path.join(__dirname, "concision-marker.sh"),
				"NAMED_PATHS_MAX",
			),
		);
	});
});

describe("stampValue", () => {
	it("carries the tier, areas, base, tree and paths, spaces dropped", () => {
		expect(stampValue(clearing, TREE)).toBe(
			`escalated; areas=secrets,money; base=b; tree=${TREE}; paths=lib/a.js,lib/b.js`,
		);
	});
});

describe("refusal", () => {
	const base = {
		areas: ["money", "secrets"],
		offSides: null,
		marker: "/m/.codereview-pass-s",
		fault: "there is no marker",
		stagedFault: "",
		rule: "THE RULE\n",
	};

	it("says the areas, the marker's fault and the rule, then that nothing was committed", () => {
		expect(refusal(base)).toBe(
			"pre-commit: this commit changes a declared sensitive path, and no escalated review of exactly this change is recorded (#1622).\n" +
				"  Areas touched: money, secrets.\n" +
				"  The marker /m/.codereview-pass-s does not clear it: there is no marker.\n" +
				"\nTHE RULE\n\n" +
				"pre-commit: the review hold refused this commit (rule:review-hold). Nothing was committed.\n",
		);
	});

	it("names a merge's off-side paths and a staged declaration's fault", () => {
		expect(
			refusal({ ...base, offSides: ["lib/a.js"], stagedFault: "bad json" }),
		).toBe(
			"pre-commit: this commit changes a declared sensitive path, and no escalated review of exactly this change is recorded (#1622).\n" +
				"  Areas touched: money, secrets.\n" +
				"  This merge's paths no merged-in side carries, the ones to review: lib/a.js.\n" +
				"  The marker /m/.codereview-pass-s does not clear it: there is no marker.\n" +
				"  The staged .claude/workflow-core.json will not read, and a review would land it broken, so correct it first: bad json\n" +
				"\nTHE RULE\n\n" +
				"pre-commit: the review hold refused this commit (rule:review-hold). Nothing was committed.\n",
		);
	});

	it("says how to restore the rule where it cannot be read", () => {
		expect(refusal({ ...base, rule: null })).toContain(
			"  The rule itself could not be read from docs/agents/rules/review-hold.txt. Restore that file from origin/main, or revert the change that removed it, then read it before going on.\n" +
				"pre-commit: the review hold refused this commit (rule:review-hold). Nothing was committed.\n",
		);
	});
});
