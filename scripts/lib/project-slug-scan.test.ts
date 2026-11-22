// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("no file under scripts/ regresses to a known-bad spelling", () => {
	const restatements = [
		'.replace(/[^a-zA-Z0-9]/g, "-")',
		'.replace(/[^A-Za-z0-9]/g, "-")',
		'.replace(/\\//g, "-")',
	];
	const shRestatements = ["//[^a-zA-Z0-9]/-}", "//[^A-Za-z0-9]/-}"];
	const literal = '"-home-lucmo-mantahostels"';
	const bareLiteral = "-home-lucmo-mantahostels";
	const pyRestatement = 're.sub(r"[^a-zA-Z0-9]", "-", ';

	const restatementExempt = new Set(["project-slug.js"]);

	const pyBareLiteralExempt: string[] = [];

	const readSources = () =>
		execFileSync(
			"git",
			[
				"ls-files",
				"-z",
				"--",
				"scripts/*.js",
				"scripts/*.sh",
				"scripts/*.ts",
				":!scripts/*.test.ts",
				".husky/*",
				"scripts/*.py",
			],
			{
				cwd: path.join(__dirname, "..", ".."),
				encoding: "utf8",
			},
		)
			.split("\0")
			.filter(Boolean)
			.map((f) => path.join(__dirname, "..", "..", f));

	const holding = (needle: string) =>
		readSources().filter((f) => fs.readFileSync(f, "utf8").includes(needle));

	const isPathSegment = (text: string, needle: string) => {
		let i = text.indexOf(needle);
		while (i !== -1) {
			if (text[i - 1] === "/" && text[i + needle.length] === "/") return true;
			i = text.indexOf(needle, i + 1);
		}
		return false;
	};
	const holdingAsPath = (needle: string) =>
		readSources().filter((f) =>
			isPathSegment(fs.readFileSync(f, "utf8"), needle),
		);

	it("scans a corpus that is actually there", () => {
		// guess, lucmoseley/mantahostels#2148
		expect(readSources().length).toBeGreaterThan(250);
		expect(readSources()).toContain(path.join(__dirname, "project-slug.js"));
		expect(readSources()).toContain(
			path.join(__dirname, "..", "snapshot-memory.sh"),
		);
		expect(readSources()).toContain(
			path.join(__dirname, "..", "proving-run.ts"),
		);
		expect(readSources()).toContain(
			path.join(__dirname, "..", "..", ".husky", "pre-commit"),
		);
		expect(readSources()).toContain(
			path.join(__dirname, "..", "measure-burn", "scan_burn.py"),
		);
	});

	it("the needle can actually see the bug it is scanning for", () => {
		const shippedBug = `src="\${1:-$HOME/.claude/projects/-home-lucmo-mantahostels/memory}"`;
		expect(shippedBug).toContain(bareLiteral);
		expect(shippedBug).not.toContain(literal);
		expect(isPathSegment(shippedBug, bareLiteral)).toBe(true);
		expect(
			isPathSegment(
				"holds `projects/-home-lucmo-mantahostels` as a symlink",
				bareLiteral,
			),
		).toBe(false);
	});

	it("no shell script hard-codes the founder's own slug", () => {
		expect(
			holdingAsPath(bareLiteral).filter(
				(f) => f.endsWith(".sh") || f.includes(`${path.sep}.husky${path.sep}`),
			),
		).toEqual([]);
	});

	it("no python script hard-codes the founder's own slug, beyond the tracked exemptions", () => {
		const exempt = new Set(pyBareLiteralExempt);
		expect(
			holdingAsPath(bareLiteral).filter(
				(f) => f.endsWith(".py") && !exempt.has(f),
			),
		).toEqual([]);
	});

	it("the tracked python exemptions are still tracked, and still hold the literal", () => {
		const tracked = new Set(readSources());
		expect(
			pyBareLiteralExempt.filter(
				(f) =>
					!tracked.has(f) || !fs.readFileSync(f, "utf8").includes(bareLiteral),
			),
		).toEqual([]);
	});

	it("reports a file that does hold the needle", () => {
		expect(holding(restatements[0])).toEqual([
			path.join(__dirname, "project-slug.js"),
		]);
		expect(holding(shRestatements[0])).toEqual([
			path.join(__dirname, "guard-log.sh"),
		]);
		expect(holding(pyRestatement)).toEqual([
			path.join(__dirname, "project_slug.py"),
		]);
	});

	it.each(restatements)("no site restates %s", (needle) => {
		expect(
			holding(needle).filter((f) => !restatementExempt.has(path.basename(f))),
		).toEqual([]);
	});

	it.each(shRestatements)("no other shell site restates %s", (needle) => {
		expect(
			holding(needle).filter((f) => path.basename(f) !== "guard-log.sh"),
		).toEqual([]);
	});

	it("no site hard-codes the founder's own slug", () => {
		expect(holding(literal)).toEqual([]);
	});
});
