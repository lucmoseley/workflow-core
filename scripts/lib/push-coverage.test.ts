// @vitest-environment node
/*
 * lib/push-coverage.js (#5016): the touched tests a queue push holds that no
 * local pass covers, and the warning `session-checkout.js land` prints. Loosen
 * it and a push whose newest commits no local run tested reaches the lander
 * unremarked, or a covered push warns for nothing.
 */
import { expect, it } from "vitest";
import { buildCoverageWarning, readUncovered } from "./push-coverage.js";

type Look = NonNullable<
	NonNullable<Parameters<typeof readUncovered>[1]>["look"]
>;

/** A pass store holding passes for `covered` alone. */
const storeCovering =
	(covered: string[]): Look =>
	(files) => ({
		cached: [],
		run: files.filter((f) => !covered.includes(f)),
		refused: [],
		notice: null,
	});

it("names the touched tests the pass store holds no pass for, of all it touched", () => {
	const c = readUncovered("/w", {
		select: () => ({ files: ["a.test.ts", "b.test.ts", "c.test.ts"] }),
		look: storeCovering(["b.test.ts"]),
		storeRoot: "/root",
	});

	expect(c).toEqual({
		files: ["a.test.ts", "c.test.ts"],
		touched: 3,
		notice: null,
	});
	expect(buildCoverageWarning(c)).toBe(
		[
			"warning: no local pass covers 2 of the 3 test files your work touches, so the lander runs them first, and a red there costs a lander run and a drop (#5016):",
			"  a.test.ts",
			"  c.test.ts",
			"Run them with `npm run test`, which selects them and skips what a pass covers. The push stands: the lander still runs the full suite.",
		].join("\n"),
	);
});

it("asks the pass store about the worktree's own tree, and warns nothing where every touched test is covered", () => {
	const asked: unknown[] = [];
	const c = readUncovered("/w", {
		select: () => ({ files: ["a.test.ts"] }),
		look: (files, at) => {
			asked.push(at);
			return storeCovering(["a.test.ts"])(files, at);
		},
		storeRoot: "/root",
	});

	expect(asked).toEqual([{ root: "/w", storeRoot: "/root" }]);
	expect(buildCoverageWarning(c)).toBeNull();
});

it("warns nothing and asks no store where the work touches no test", () => {
	const c = readUncovered("/w", {
		select: () => ({ files: [] }),
		look: () => {
			throw new Error("asked");
		},
		storeRoot: "/root",
	});

	expect(c).toEqual({ files: [], touched: 0, notice: null });
	expect(buildCoverageWarning(c)).toBeNull();
});

it("carries the pass store's own fault notice under the files it then counts uncovered", () => {
	const c = readUncovered("/w", {
		select: () => ({ files: ["a.test.ts"] }),
		look: (files) => ({
			cached: [],
			run: files,
			refused: [],
			notice: "pass store: unreadable — every selected file runs (#4790).",
		}),
		storeRoot: "/root",
	});

	expect(buildCoverageWarning(c)).toBe(
		[
			"warning: no local pass covers 1 of the 1 test file your work touches, so the lander runs it first, and a red there costs a lander run and a drop (#5016):",
			"  a.test.ts",
			"pass store: unreadable — every selected file runs (#4790).",
			"Run them with `npm run test`, which selects them and skips what a pass covers. The push stands: the lander still runs the full suite.",
		].join("\n"),
	);
});

it("says a selection it could not read, rather than throwing", () => {
	const c = readUncovered("/w", {
		select: () => {
			throw new Error("vitest list failed\n");
		},
		storeRoot: "/root",
	});

	expect(buildCoverageWarning(c)).toBe(
		"warning: which touched tests a local pass covers could not be read (vitest list failed), so any of them may first run in the lander (#5016)",
	);
});
