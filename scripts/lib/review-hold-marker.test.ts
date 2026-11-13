/*
 * The review hold's marker judgement and text, word for word (#1622, #5153):
 * the fault ladder, the stamp's value and the refusal, pinned in-process. The
 * tier and areas faults are compared with concision-marker.sh's
 * marker_tier_fault, which the Stop nag still runs, so the hold and the nag
 * cannot drift apart unseen. A loosened case lets the hold pass a marker that
 * does not clear the commit, or refuse in words the rule file does not match.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mkScratchDir } from "./git-fixture";
import { markerFault, refusal, stampValue } from "./review-hold-marker.js";
import { shellQuote } from "./sh-quote.js";
import { readShellConst } from "./shell-const-testkit";

const MARKER_LIB = path.join(__dirname, "concision-marker.sh");
const TREE = "t".repeat(40);
const clearing = `base=b\ntier=escalated\nareas=secrets, money\ntree=${TREE}\npaths=lib/a.js, lib/b.js\n`;
const without = (key: string) =>
	clearing
		.split("\n")
		.filter((l) => !l.startsWith(`${key}=`))
		.join("\n");
const fault = (text: string | null, owed = ["lib/a.js"]) =>
	markerFault(text, ["secrets"], TREE, owed);

let scratch = "";
afterEach(() => {
	if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
	scratch = "";
});

/** concision-marker.sh's marker_tier_fault on a marker holding `text`, for `areas`. */
const shellTierFault = (text: string, areas: string[]) => {
	scratch = mkScratchDir("review-hold-marker-");
	const marker = path.join(scratch, "marker");
	fs.writeFileSync(marker, text);
	const r = spawnSync(
		"bash",
		[
			"-c",
			`source ${shellQuote(MARKER_LIB)} && marker_tier_fault "$@"`,
			"_",
			marker,
			...areas,
		],
		{ encoding: "utf8" },
	);
	expect(r.stderr).toBe("");
	return r.stdout;
};

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

	it("names the owed paths paths= misses, as many as concision-marker.sh's NAMED_PATHS_MAX", () => {
		const max = Number(readShellConst(MARKER_LIB, "NAMED_PATHS_MAX"));
		const owed = Array.from({ length: max + 2 }, (_, i) => `x/${i}`);
		expect(fault(clearing, owed)).toBe(
			`its paths= does not name ${owed.slice(0, max).join(", ")}`,
		);
	});

	it.each([
		["a clearing tier", clearing, ["secrets"]],
		["no tier= line", without("tier"), ["secrets"]],
		[
			"a standard tier",
			clearing.replace("tier=escalated", "tier=standard"),
			["secrets"],
		],
		[
			"a tier over 40 characters",
			clearing.replace("tier=escalated", `tier=${"x".repeat(50)}`),
			["secrets"],
		],
		[
			"two areas unnamed",
			clearing.replace("areas=secrets, money", "areas=pages"),
			["money", "secrets"],
		],
	])(
		"names the fault of %s as concision-marker.sh's marker_tier_fault does",
		(_, text, areas) => {
			expect(markerFault(text, areas, TREE, [])).toBe(
				shellTierFault(text, areas),
			);
		},
	);
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
		expect(refusal({ ...base, rule: null })).toBe(
			"pre-commit: this commit changes a declared sensitive path, and no escalated review of exactly this change is recorded (#1622).\n" +
				"  Areas touched: money, secrets.\n" +
				"  The marker /m/.codereview-pass-s does not clear it: there is no marker.\n" +
				"  The rule itself could not be read from docs/agents/rules/review-hold.txt. Restore that file from origin/main, or revert the change that removed it, then read it before going on.\n" +
				"pre-commit: the review hold refused this commit (rule:review-hold). Nothing was committed.\n",
		);
	});
});
