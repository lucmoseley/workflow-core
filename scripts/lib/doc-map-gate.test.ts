// @vitest-environment node

import { describe, expect, it } from "vitest";
import { runDocMapGate } from "./doc-map-gate.js";
import { fakeGatePorts, type GateScene } from "./doc-map-gate-fake";

const gate = (scene: GateScene, allowDelete = false) => {
	const { ports, calls, headMapReads } = fakeGatePorts(scene);
	return { ...runDocMapGate(ports, { allowDelete }), calls, headMapReads };
};

const REPORT = "FAIL: 1 doc-map problem(s)\n  dead: docs/x.md";
const failing = (over: GateScene = {}): GateScene => ({
	check: { status: 1, report: REPORT },
	...over,
});

const SKIP =
	"pre-commit: skipped the doc-map check — not readable from the index: git checkout-index would not write it.\n";

describe("a readable index", () => {
	it("prints nothing and builds no baseline when the checker passes", () => {
		const { exit, stderr, calls } = gate({
			check: { status: 0, report: "OK: a long report-only section\n" },
		});
		expect(exit).toBe(0);
		expect(stderr).toBe("");
		expect(calls).toHaveLength(1);
	});

	it("refuses with the checker's own exit code, its report replayed first", () => {
		const { exit, stderr } = gate(failing());
		expect(exit).toBe(1);
		expect(
			stderr.startsWith(
				`${REPORT}\n  Those paths are inside a throwaway extraction of this commit's index.\n`,
			),
		).toBe(true);
	});

	it("refuses a BROKEN checker run as could-not-run, comparing nothing with HEAD", () => {
		const broken = "BROKEN: could not walk the plugin root: ENOENT";
		const { exit, stderr, calls } = gate(
			failing({ check: { status: 2, report: broken } }),
		);
		expect(exit).toBe(2);
		expect(stderr.startsWith(`${broken}\n`)).toBe(true);
		expect(stderr).toContain(
			"pre-commit: the doc-map checker could not run (BROKEN, above) — refusing.\n",
		);
		expect(stderr).not.toContain("NOT in HEAD");
		expect(calls).toHaveLength(1);
	});

	it("passes a failing check whose every fault is already in HEAD, still replaying the report", () => {
		const { exit, stderr } = gate(
			failing({ newFaults: { status: 0, stdout: "", stderr: "" } }),
		);
		expect(exit).toBe(0);
		expect(stderr).toContain(REPORT);
		expect(stderr).toContain(
			"every FAIL finding the doc-map check reported above is already in HEAD",
		);
	});

	it("refuses a fault absent from HEAD, and names it", () => {
		const { exit, stderr } = gate(
			failing({
				newFaults: {
					status: 1,
					stdout: "dead: docs/research/brand-new.md\n",
					stderr: "",
				},
			}),
		);
		expect(exit).toBe(1);
		expect(stderr).toContain(
			"pre-commit: the doc-map fault(s) below are NOT in HEAD — this commit adds them:\n  dead: docs/research/brand-new.md\n",
		);
	});

	it("fails closed when the comparison cannot answer", () => {
		const { exit, stderr } = gate(
			failing({
				newFaults: { status: 2, stdout: "envelope unreadable\n", stderr: "" },
			}),
		);
		expect(exit).toBe(1);
		expect(stderr).toContain("could not tell inherited doc-map faults");
	});

	it("fails closed when HEAD holds no baseline to compare against", () => {
		const { exit, stderr, calls } = gate(
			failing({
				headHoldsMap: false,
				newFaults: { status: 0, stdout: "", stderr: "" },
			}),
		);
		expect(exit).toBe(1);
		expect(stderr).toContain(
			"pre-commit: no readable HEAD baseline for the doc-map check — refusing.\n",
		);
		expect(stderr).not.toContain("already in HEAD");
		expect(calls).toHaveLength(1);
	});

	it("fails closed when there is no HEAD commit to read a baseline from", () => {
		const { exit, stderr } = gate(
			failing({
				headUnborn: true,
				newFaults: { status: 0, stdout: "", stderr: "" },
			}),
		);
		expect(exit).toBe(1);
		expect(stderr).toContain("no readable HEAD baseline for the doc-map check");
	});

	it("passes --map-dirty to the held and staged runs when the map differs from HEAD, never to the baseline", () => {
		const { calls } = gate(failing({ mapDiffStatus: 1 }));
		expect(calls.map((c) => c.args.includes("--map-dirty"))).toEqual([
			true,
			true,
			false,
		]);
	});

	it("omits --map-dirty when the map matches HEAD or git cannot say", () => {
		for (const mapDiffStatus of [0, 128, null])
			expect(
				gate(failing({ mapDiffStatus })).calls.some((c) =>
					c.args.includes("--map-dirty"),
				),
			).toBe(false);
	});

	it("runs the baseline under HEAD's index over HEAD's tree, and the staged side under this one", () => {
		const { calls } = gate(failing());
		expect(calls.map((c) => c.json)).toEqual([false, true, true]);
		expect(calls[0].indexFile).toBeUndefined();
		expect(calls[1].indexFile).toBeUndefined();
		expect(calls[2].indexFile).toBe("/fake/tmp2/index");
		expect(calls[0].args).toEqual(["--root", "/fake/tmp1/tree"]);
		expect(calls[1].args).toEqual(["--root", "/fake/tmp1/tree", "--json"]);
		expect(calls[2].args).toEqual(["--root", "/fake/tmp2/tree", "--json"]);
	});

	it("reads HEAD's map only for a report holding an untracked block", () => {
		expect(
			gate(
				failing({ newFaults: { status: 0, stdout: "", stderr: "" } }),
			).headMapReads(),
		).toBe(0);
		expect(
			gate({
				check: {
					status: 0,
					report:
						"1 doc-map register entr(ies) name a file present on disk but not yet tracked by git:\n  docs/fresh.md",
				},
			}).headMapReads(),
		).toBe(1);
	});

	it("judges the untracked blocks after a pass on inheritance", () => {
		const { exit, stderr } = gate({
			check: {
				status: 1,
				report:
					"1 doc-map register entr(ies) name a file present on disk but not yet tracked by git:\n  docs/fresh.md\n\nCommit the file, or drop the entry.",
			},
			newFaults: { status: 0, stdout: "", stderr: "" },
			headMap: "# Section A",
		});
		expect(exit).toBe(1);
		expect(stderr).toContain("already in HEAD");
		expect(stderr).toContain(
			"this commit adds the doc-map Section A row(s) below",
		);
	});
});

describe("an unreadable index", () => {
	it("skips with a warning, never running the checker, when the map is in neither HEAD nor the index", () => {
		const { exit, stderr, calls } = gate(
			failing({
				mapInIndex: false,
				newFaults: { status: 0, stdout: "", stderr: "" },
			}),
		);
		expect(exit).toBe(0);
		expect(stderr).toBe(SKIP);
		expect(calls).toEqual([]);
	});

	it("skips with a warning when the index will not extract", () => {
		const { exit, stderr, calls } = gate(failing({ extracts: false }));
		expect(exit).toBe(0);
		expect(stderr).toBe(SKIP);
		expect(calls).toEqual([]);
	});

	it("refuses a staged deletion of the map, before the checker runs", () => {
		const { exit, stderr, calls } = gate(
			failing({ mapInIndex: false, deletion: { ok: true, deleted: true } }),
		);
		expect(exit).toBe(1);
		expect(stderr).toContain(
			"pre-commit: the doc-map check reads docs/doc-map.md, and this commit DELETES it — refusing.\n",
		);
		expect(stderr).toContain("git checkout HEAD --");
		expect(stderr).toContain("WFC_ALLOW_GATE_INPUT_DELETE=1");
		expect(stderr).not.toContain("skipped");
		expect(calls).toEqual([]);
	});

	it("lets the deletion through when the escape is set, saying so", () => {
		const { exit, stderr } = gate(
			failing({ mapInIndex: false, deletion: { ok: true, deleted: true } }),
			true,
		);
		expect(exit).toBe(0);
		expect(stderr).toBe(
			`pre-commit: WFC_ALLOW_GATE_INPUT_DELETE is set — allowing this commit to delete docs/doc-map.md.\n${SKIP}`,
		);
	});

	it("warns and passes when git cannot say whether the map is deleted", () => {
		const { exit, stderr } = gate(
			failing({ extracts: false, deletion: { ok: false, deleted: false } }),
		);
		expect(exit).toBe(0);
		expect(stderr).toBe(
			`pre-commit: could not ask git whether docs/doc-map.md is deleted by this commit — treating it as merely absent.\n${SKIP}`,
		);
	});
});
