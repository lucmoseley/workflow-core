// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..");
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const readTracked = (glob: string) =>
	execFileSync("git", ["ls-files", glob], { cwd: ROOT, encoding: "utf8" })
		.split("\n")
		.filter(Boolean);

const WINDOWS_TOOLS = [
	"powershell",
	"pwsh",
	"psscriptanalyzer",
	"invoke-scriptanalyzer",
	"invoke-formatter",
	"install-module",
	"parsefile",
	"cscript",
	"wscript",
];

const WINDOWS_CHECKERS = new RegExp(WINDOWS_TOOLS.join("|"), "i");

const WINDOWS_EXTENSIONS = /\.(ps1|psm1|vbs|cmd|bat)\b/i;

describe("Windows-side script tooling is declined (mantahostels#1131)", () => {
	it("still covers exactly the surface the decline measured", () => {
		expect(readTracked("scripts/win-interop-watchdog/*")).toEqual([
			"scripts/win-interop-watchdog/compact-disk.ps1",
			"scripts/win-interop-watchdog/launcher.vbs",
			"scripts/win-interop-watchdog/page-combining.ps1",
			"scripts/win-interop-watchdog/rebuild-disk.ps1",
			"scripts/win-interop-watchdog/task.xml.template",
			"scripts/win-interop-watchdog/watchdog.ps1",
		]);
		for (const ext of ["*.ps1", "*.psm1", "*.vbs", "*.cmd", "*.bat"]) {
			const found = readTracked(ext).filter(
				(f) => !f.startsWith("scripts/win-interop-watchdog/"),
			);
			expect(found, `${ext} outside the watchdog directory`).toEqual([]);
		}
	});

	it("declares no PowerShell or VBScript checker as a dependency", () => {
		const pkg = JSON.parse(read("package.json"));
		const deps = Object.keys({
			...(pkg.dependencies ?? {}),
			...(pkg.devDependencies ?? {}),
		});
		expect(deps.length).toBeGreaterThan(10);
		expect(deps.filter((d) => WINDOWS_CHECKERS.test(d))).toEqual([]);
	});

	it("wires no npm script to one", () => {
		const scripts = JSON.parse(read("package.json")).scripts as Record<
			string,
			string
		>;
		expect(Object.keys(scripts).length).toBeGreaterThan(20);
		for (const [name, cmd] of Object.entries(scripts)) {
			expect(`${name} -> ${cmd}`, name).not.toMatch(WINDOWS_CHECKERS);
			expect(`${name} -> ${cmd}`, name).not.toMatch(WINDOWS_EXTENSIONS);
		}
	});

	it("runs none at any enforcement moment", () => {
		const workflowDir = path.join(ROOT, ".github", "workflows");
		const gates: [string, string][] = [
			...[
				".husky/pre-commit",
				".husky/prepare-commit-msg",
				".husky/pre-merge-commit",
				".husky/post-commit",
				".husky/pre-push",
			].map((h): [string, string] => [
				h,
				fs.readFileSync(path.join(ROOT, h), "utf8"),
			]),
			...fs
				.readdirSync(workflowDir)
				.filter((f) => /\.ya?ml$/.test(f))
				.map((f): [string, string] => [
					`.github/workflows/${f}`,
					fs.readFileSync(path.join(workflowDir, f), "utf8"),
				]),
		];
		expect(gates.length).toBeGreaterThanOrEqual(8);
		for (const [gate, text] of gates) {
			expect(text, gate).not.toMatch(WINDOWS_CHECKERS);
			expect(text, gate).not.toMatch(WINDOWS_EXTENSIONS);
		}
	});

	it("keeps shellcheck on the installer while leaving the payload unchecked", () => {
		const shellCorpus = readTracked("scripts/*.sh");
		expect(shellCorpus).toContain("scripts/install-interop-watchdog.sh");
		expect(shellCorpus.some((f) => WINDOWS_EXTENSIONS.test(f))).toBe(false);
	});

	it("records the decline in §W, where a reader meets it", () => {
		expect(read("docs/code-standards.md")).toMatch(
			/\*\*The Windows-side watchdog scripts — declined, because the only free checker is the thing they exist to catch\*\*/,
		);
	});
});
