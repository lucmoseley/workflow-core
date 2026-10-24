// @vitest-environment node
/*
 * lib/fault-diff.js (mantahostels#1753) — the set difference behind every pre-commit
 * direction gate.
 *
 * What is only reachable here
 * is the three parameters mantahostels#1753 added: which keys hold faults, what makes two faults the
 * same fault, and which faults are gate material.
 *
 * In-process on hand-built envelopes and miniature profiles, so each case
 * states its staged and baseline faults exactly; the CLI's crash and
 * short-write paths run a temp script through runInProcess.
 *
 * Every direction gate in .husky/pre-commit decides on this difference, so a
 * loosened case either refuses a bystander's commit over a fault inherited from
 * `main` or lets a commit's own new fault through.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInProcess } from "./run-in-process";

const { newFaultItems, newFaults } = require("./fault-diff.js");

interface Finding {
	severity: string;
	tag: string;
	file: string;
	message: string;
}

/** The two whole-repo checkers' profile shape, in miniature. */
const findingsOnly = {
	keys: (k: string) => k === "findings",
	identity: (i: Finding) => JSON.stringify([i.severity, i.tag, i.file]),
	gating: (i: Finding) => i.severity === "FAIL",
	label: (i: Finding) => i.message,
};

const finding = (over: Record<string, unknown> = {}) => ({
	severity: "FAIL",
	tag: "T",
	file: "a.ts",
	message: "a.ts is broken",
	...over,
});

describe("newFaults", () => {
	it("compares only the keys the profile names", () => {
		const staged = {
			findings: [finding()],
			other: [finding({ file: "b.ts" })],
		};

		expect(newFaults(staged, { findings: [finding()] }, findingsOnly)).toEqual(
			[],
		);
	});

	it("names a fault the baseline does not carry, through the profile's label", () => {
		const staged = { findings: [finding(), finding({ file: "b.ts" })] };

		expect(newFaults(staged, { findings: [finding()] }, findingsOnly)).toEqual([
			"findings: a.ts is broken",
		]);
	});

	it("ignores the fields identity leaves out", () => {
		const staged = {
			findings: [finding({ message: "anchored 7c36 now b751" })],
		};
		const baseline = {
			findings: [finding({ message: "anchored b751 now 0000" })],
		};

		expect(newFaults(staged, baseline, findingsOnly)).toEqual([]);
	});

	it("never gates on a non-gating item, however new it is", () => {
		const staged = {
			findings: [finding({ severity: "WARN", file: "new.ts" })],
		};

		expect(newFaults(staged, { findings: [] }, findingsOnly)).toEqual([]);
	});

	it("never compares an indexOnly item, gating or not, which the baseline side never computes", () => {
		const staged = { findings: [finding({ tag: "LOOKUP" }), finding()] };
		const profile = {
			...findingsOnly,
			indexOnly: (i: Finding) => i.tag === "LOOKUP",
		};

		expect(newFaults(staged, { findings: [] }, profile)).toEqual([
			"findings: a.ts is broken",
		]);
	});

	it("reads the baseline on the same terms, so a WARN cannot excuse a FAIL", () => {
		// An unfiltered baseline would call this inherited.
		const staged = { findings: [finding()] };
		const baseline = { findings: [finding({ severity: "WARN" })] };

		expect(newFaults(staged, baseline, findingsOnly)).toEqual([
			"findings: a.ts is broken",
		]);
	});

	it("refuses the added fault of a commit that also repaired an inherited one", () => {
		const staged = { findings: [finding({ file: "b.ts", message: "b" })] };
		const baseline = { findings: [finding()] };

		expect(newFaults(staged, baseline, findingsOnly)).toEqual(["findings: b"]);
	});

	it("gates every item when the profile names no `gating`", () => {
		const staged = { findings: [finding({ severity: "WARN" })] };

		expect(
			newFaults(
				staged,
				{ findings: [] },
				{
					keys: findingsOnly.keys,
					identity: findingsOnly.identity,
				},
			),
		).toEqual([`findings: ${JSON.stringify(finding({ severity: "WARN" }))}`]);
	});

	it("treats a key absent from the baseline as carrying nothing", () => {
		expect(newFaults({ findings: [finding()] }, {}, findingsOnly)).toEqual([
			"findings: a.ts is broken",
		]);
	});

	it("skips a key whose staged value is not an array", () => {
		expect(newFaults({ findings: 3 }, {}, findingsOnly)).toEqual([]);
	});

	it("prints a string item as itself and an object as JSON, by default", () => {
		const unlabelled = {
			keys: findingsOnly.keys,
			identity: (i: unknown) => JSON.stringify(i),
		};
		expect(newFaults({ findings: ["a.md", { a: 1 }] }, {}, unlabelled)).toEqual(
			["findings: a.md", 'findings: {"a":1}'],
		);
	});
});

/*
 * A fault that carries a measurement (mantahostels#1834). check-context-budget.js raises one
 * finding per capped surface with the surface's byte total on it, so identity
 * alone gives the wrong answer in both directions: without the total a commit
 * that GROWS an already-over-cap surface reads as inherited and passes, and with
 * it a commit that SHEDS bytes and leaves the surface still over cap reads as a
 * new fault and is refused.
 */
describe("family and worse, for a fault that carries a measurement", () => {
	const capped = {
		keys: (k: string) => k === "findings",
		identity: (i: { tag: string; surface: string; total: number }) =>
			JSON.stringify([i.tag, i.surface, i.total]),
		family: (i: { tag: string; surface: string }) =>
			JSON.stringify([i.tag, i.surface]),
		worse: (a: { total: number }, b: { total: number }) => a.total > b.total,
		label: (i: { message: string }) => i.message,
	};
	const over = (total: number) => ({
		severity: "WARN",
		tag: "OVER-POOL",
		surface: "pool",
		total,
		message: `pool is ${total} B`,
	});

	it("calls a reading that GREW a new fault", () => {
		expect(
			newFaults({ findings: [over(600)] }, { findings: [over(500)] }, capped),
		).toEqual(["findings: pool is 600 B"]);
	});

	it("calls an unchanged reading inherited", () => {
		expect(
			newFaults({ findings: [over(500)] }, { findings: [over(500)] }, capped),
		).toEqual([]);
	});

	/* The one the plain set difference gets wrong, and the reason `worse` exists:
	 * refusing this would block the shed the gate itself demands. */
	it("calls a reading that SHED bytes inherited, though it is still over cap", () => {
		expect(
			newFaults({ findings: [over(400)] }, { findings: [over(500)] }, capped),
		).toEqual([]);
	});

	it("calls a surface the baseline never breached a new fault", () => {
		expect(
			newFaults({ findings: [over(600)] }, { findings: [] }, capped),
		).toEqual(["findings: pool is 600 B"]);
	});

	it("compares each surface only against its own family", () => {
		const inj = { ...over(10), tag: "OVER-INJECTION", surface: "injection" };
		expect(
			newFaults(
				{ findings: [over(400), inj] },
				{ findings: [over(500)] },
				capped,
			),
		).toEqual(["findings: pool is 10 B"]);
	});

	/* Both default away: a profile that sets neither is the shape every other
	 * profile in checker-new-faults.js has, and must be untouched by this. */
	it("falls back to identity when a profile sets neither", () => {
		const plain = { keys: capped.keys, identity: capped.identity };
		expect(
			newFaults({ findings: [over(400)] }, { findings: [over(500)] }, plain),
		).toEqual([`findings: ${JSON.stringify(over(400))}`]);
	});

	/* `worse` alone would be a silent no-op, the ratchet gone (mantahostels#1834). */
	it("refuses a profile that sets `worse` without `family`", () => {
		const lame = {
			keys: capped.keys,
			identity: capped.identity,
			worse: capped.worse,
		};
		expect(() =>
			newFaults({ findings: [over(400)] }, { findings: [over(500)] }, lame),
		).toThrow(/must set `family` too/);
	});
});

/*
 * `newFaultItems`, the shape `newFaults` is a projection of (mantahostels#1939). lib/check.js
 * needs the ITEM to read its measurement out of the baseline envelope, and the
 * printed line has already lost it.
 */
describe("newFaultItems, the item behind the line", () => {
	const capped = {
		keys: (k: string) => k === "findings",
		identity: (i: { tag: string; surface: string; total: number }) =>
			JSON.stringify([i.tag, i.surface, i.total]),
		label: (i: { message: string }) => i.message,
		measure: (
			_i: unknown,
			_k: string,
			envelope: { total?: number },
		): number | undefined => envelope.total,
		unit: "B",
	};
	const over = (total: number) => ({
		severity: "WARN",
		tag: "OVER-POOL",
		surface: "pool",
		total,
		message: `pool is ${total} B`,
	});

	it("carries the envelope key, the item itself and the line", () => {
		expect(
			newFaultItems({ findings: [over(600)] }, { findings: [] }, capped),
		).toEqual([
			{ key: "findings", item: over(600), line: "findings: pool is 600 B" },
		]);
	});

	it("agrees line for line with newFaults, which projects it", () => {
		const staged = { findings: [over(600), over(700)] };
		expect(newFaults(staged, {}, capped)).toEqual(
			newFaultItems(staged, {}, capped).map((f: { line: string }) => f.line),
		);
	});

	it("refuses a profile that sets `measure` without `unit`", () => {
		const { unit: _unit, ...bare } = capped;
		expect(() => newFaultItems({ findings: [over(600)] }, {}, bare)).toThrow(
			/must set `unit` too/,
		);
	});
});

/*
 * A crash mid-list (mantahostels#2314) — runCli routes it to exit 2, never node's
 * default 1, which gate_direction reads with a non-empty stdout as "this commit
 * adds them".
 *
 * PROVOKED BY WRAPPING fs.writeSync, as the short write below is: fd 1 takes
 * part of the list then throws, and the first fd 2 write throws too, so the
 * diagnostic in runCli's own catch is what crashes. No stdio a caller can hand
 * the script fails on cue mid-list and again on its first diagnostic.
 */
describe("runCli, a crash mid-list", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0))
			fs.rmSync(d, { recursive: true, force: true });
	});

	it("turns a crash mid-list into exit 2, the caller's could-not-answer code, saying the list is unfinished and naming the error", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fault-diff-crash-"));
		dirs.push(dir);
		const staged = path.join(dir, "staged.json");
		const baseline = path.join(dir, "baseline.json");
		fs.writeFileSync(staged, JSON.stringify({ findings: ["docs/a.md dead"] }));
		fs.writeFileSync(baseline, JSON.stringify({ findings: [] }));
		const script = path.join(dir, "cmp.js");
		const seam = JSON.stringify(path.join(__dirname, "fault-diff.js"));
		fs.writeFileSync(
			script,
			`const fs = require("node:fs");
const inner = fs.writeSync;
let stderrFailed = false;
fs.writeSync = (fd, data, ...rest) => {
	if (fd === 1) {
		inner(1, String(data).slice(0, 16));
		throw new Error("stdout went away mid-list");
	}
	if (fd === 2 && !stderrFailed) {
		stderrFailed = true;
		throw new Error("stderr went away too");
	}
	return inner(fd, data, ...rest);
};
require(${seam}).runCli("demo", ${JSON.stringify(staged)}, ${JSON.stringify(baseline)}, {
	keys: (k) => k === "findings",
	identity: (i) => i,
});
`,
		);
		const r = runInProcess(script, []);

		expect(r.status).toBe(2);
		expect(r.stdout).toBe("findings: docs/a");
		expect(r.stderr).toContain(
			"demo: crashed before it finished the fault list",
		);
		expect(r.stderr).toContain("stderr went away too");
	});
});

/*
 * A SHORT WRITE (mantahostels#2329) throws nothing, so writeFd must finish it
 * or the list goes out truncated under exit 1.
 *
 * PROVOKED BY WRAPPING fs.writeSync, not by a real short write, which needs a
 * non-blocking fd 1 that neither vitest nor runInProcess's capture can hand a
 * script.
 */
describe("runCli, a short write of the fault list", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0))
			fs.rmSync(d, { recursive: true, force: true });
	});

	/** @param accepted bytes fd 1 takes per write; -1 hands each whole write through. */
	const listWrittenShort = (accepted: number) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fault-diff-short-"));
		dirs.push(dir);
		const staged = path.join(dir, "staged.json");
		const baseline = path.join(dir, "baseline.json");
		fs.writeFileSync(
			staged,
			JSON.stringify({ findings: ["docs/a.md dead", "docs/b.md dead"] }),
		);
		fs.writeFileSync(baseline, JSON.stringify({ findings: [] }));
		const script = path.join(dir, "cmp.js");
		const seam = JSON.stringify(path.join(__dirname, "fault-diff.js"));
		fs.writeFileSync(
			script,
			`const fs = require("node:fs");
const inner = fs.writeSync;
const accepted = ${accepted};
fs.writeSync = (fd, data, offset = 0, ...rest) => {
	if (fd !== 1 || accepted < 0) return inner(fd, data, offset, ...rest);
	const cut = Buffer.from(data).subarray(offset, offset + accepted);
	inner(1, cut);
	return cut.length;
};
require(${seam}).runCli("demo", ${JSON.stringify(staged)}, ${JSON.stringify(baseline)}, {
	keys: (k) => k === "findings",
	identity: (i) => i,
});
`,
		);
		return runInProcess(script, []);
	};

	it("finishes a short write, so the whole list goes out on exit 1 (mantahostels#2329)", () => {
		const r = listWrittenShort(6);

		expect(r.status).toBe(1);
		expect(r.stdout).toBe(
			"findings: docs/a.md dead\nfindings: docs/b.md dead\n",
		);
	});

	it("leaves a whole write on exit 1, the list intact", () => {
		const r = listWrittenShort(-1);

		expect(r.status).toBe(1);
		expect(r.stdout).toContain("findings: docs/a.md dead");
		expect(r.stdout).toContain("findings: docs/b.md dead");
	});
});
