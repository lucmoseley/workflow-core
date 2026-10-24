// @vitest-environment node
/*
 * Pins seedCoreCost, which writes the core's own row into an adopter's
 * .claude/plugin-context-cost.json, and measurerFor, which reads the figure
 * `claude plugin details` prints.
 *
 * The measurement is an injected stub and each adopter a temp dir, so no test
 * runs `claude`, and a test can see the table's other rows come back byte for
 * byte.
 *
 * Breaking it brings back the day-one budget warning about the core in every
 * new adopter, or rewrites rows an adopter set itself (#679).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	COST_TABLE,
	type Measurement,
	measurerFor,
	seedCoreCost,
} from "./core-context-cost.js";

const ID = "workflow-core@workflow-core";
const NOW = new Date(Date.UTC(2026, 8, 28, 12));

const made: string[] = [];
afterAll(() => {
	for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function adopter(enabled: Record<string, boolean> = { [ID]: true }) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "core-cost-"));
	made.push(root);
	fs.mkdirSync(path.join(root, ".claude"));
	fs.writeFileSync(
		path.join(root, ".claude/settings.json"),
		JSON.stringify({ enabledPlugins: enabled }),
	);
	return root;
}

function seed(
	root: string,
	measure = vi.fn<(id: string) => Measurement>(() => ({ tokens: 2273 })),
	dryRun = false,
) {
	const lines: string[] = [];
	seedCoreCost({
		root,
		pluginId: ID,
		measure,
		dryRun,
		out: (l: string) => lines.push(l),
		now: NOW,
	});
	return { lines, measure };
}

const tableAt = (root: string) => path.join(root, COST_TABLE);

describe("measurerFor", () => {
	/** What it reads off a stub `claude plugin details` printing `text`. */
	const measured = (text: string) => {
		const root = adopter();
		const bin = path.join(root, "claude");
		fs.writeFileSync(bin, `#!/bin/sh\ncat <<'END'\n${text}\nEND\n`, {
			mode: 0o755,
		});
		return measurerFor({ root, claudeBin: bin })(ID);
	};

	it("reads the figure in each spelling `claude plugin details` prints", () => {
		expect(measured("  Always-on:   ~22 tok   added")).toEqual({ tokens: 22 });
		expect(measured("  Always-on:   ~2,273 tok   added")).toEqual({
			tokens: 2273,
		});
		expect(measured("  Always-on:   ~2.3k tok   added")).toEqual({
			tokens: 2300,
		});
	});

	it("gives a reason, never a figure, where no always-on line reads", () => {
		expect(measured('Plugin "x" not found.')).toEqual({
			reason: 'no always-on figure in its output: Plugin "x" not found.',
		});
	});
});

describe("seedCoreCost (#679)", () => {
	it("creates the table with the core's row where there is none", () => {
		const root = adopter();
		const { lines } = seed(root);
		const table = JSON.parse(fs.readFileSync(tableAt(root), "utf8"));
		expect(table.plugins).toEqual({
			[ID]: { tokens: 2273, measured: "2026-09-28" },
		});
		expect(typeof table.about).toBe("string");
		expect(lines).toEqual([`wrote   ${COST_TABLE} (the ${ID} row, ~2273 tok)`]);
	});

	it("adds the row to an existing table and leaves every other byte as it was", () => {
		const root = adopter();
		const before = {
			about: "the adopter's own words",
			plugins: { "other@m": { tokens: 105, measured: "2026-01-01" } },
		};
		const text = `${JSON.stringify(before, null, "\t")}\n`;
		fs.writeFileSync(tableAt(root), text);
		seed(root);
		const after = JSON.parse(fs.readFileSync(tableAt(root), "utf8"));
		expect(after.plugins[ID]).toEqual({ tokens: 2273, measured: "2026-09-28" });
		delete after.plugins[ID];
		expect(`${JSON.stringify(after, null, "\t")}\n`).toBe(text);
	});

	it("leaves a table in any other layout alone, naming the row to add by hand", () => {
		const root = adopter();
		const text = '{"about": "x", "plugins": {"other@m": {"tokens": 1}}}\n';
		fs.writeFileSync(tableAt(root), text);
		const { lines } = seed(root);
		expect(fs.readFileSync(tableAt(root), "utf8")).toBe(text);
		expect(lines[0]).toContain("not in canonical layout");
		expect(lines[0]).toContain(`"${ID}": {"tokens":2273`);
	});

	it("touches nothing and measures nothing where the row is already there", () => {
		const root = adopter();
		const text = `${JSON.stringify({ plugins: { [ID]: { tokens: 9 } } }, null, 2)}\n`;
		fs.writeFileSync(tableAt(root), text);
		const { lines, measure } = seed(root);
		expect(fs.readFileSync(tableAt(root), "utf8")).toBe(text);
		expect(measure).not.toHaveBeenCalled();
		expect(lines).toEqual([]);
	});

	it("does nothing where the settings do not enable the core", () => {
		const root = adopter({ [ID]: false });
		const { lines, measure } = seed(root);
		expect(fs.existsSync(tableAt(root))).toBe(false);
		expect(measure).not.toHaveBeenCalled();
		expect(lines).toEqual([]);
	});

	it("writes nothing and names the hand fix where the measurement fails", () => {
		const root = adopter();
		const { lines } = seed(
			root,
			vi.fn<(id: string) => Measurement>(() => ({ reason: "not found" })),
		);
		expect(fs.existsSync(tableAt(root))).toBe(false);
		expect(lines[0]).toMatch(
			/^MISSING the .* not found — run `claude plugin details/,
		);
	});

	it("neither measures nor writes under a dry run", () => {
		const root = adopter();
		const { lines, measure } = seed(root, undefined, true);
		expect(fs.existsSync(tableAt(root))).toBe(false);
		expect(measure).not.toHaveBeenCalled();
		expect(lines).toEqual([`would   add the ${ID} row to ${COST_TABLE}`]);
	});

	it("says so, and writes nothing, where the settings will not parse", () => {
		const root = adopter();
		fs.writeFileSync(path.join(root, ".claude/settings.json"), "{ nope");
		const { lines, measure } = seed(root);
		expect(fs.existsSync(tableAt(root))).toBe(false);
		expect(measure).not.toHaveBeenCalled();
		expect(lines[0]).toContain(".claude/settings.json does not parse");
	});

	it("leaves a table that will not parse alone", () => {
		const root = adopter();
		fs.writeFileSync(tableAt(root), "{ nope");
		const { lines } = seed(root);
		expect(fs.readFileSync(tableAt(root), "utf8")).toBe("{ nope");
		expect(lines[0]).toContain("does not parse");
	});
});
