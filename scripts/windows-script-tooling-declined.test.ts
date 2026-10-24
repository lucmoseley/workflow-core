// @vitest-environment node

/*
 * windows-script-tooling-declined.test.ts — the Windows-side watchdog scripts
 * are checked by nothing on purpose (mantahostels#1131, the map itself; there is no child
 * ticket, this being the last surface the map found).
 *
 * `docs/code-standards.md` §W carries why. This file pins only that no checker
 * is wired, and that the surface is still the one the decline was priced on,
 * so a later ticket wanting a PowerShell checker has to delete these cases and
 * say why rather than adopting one from first principles.
 *
 * §X3 does not bind: nothing here spawns a script, because the subject is the
 * absence of one. Same shape as `scripts/markdown-tooling-declined.test.ts`,
 * which pins the Markdown decline (mantahostels#1540).
 *
 * Loosen it and the Windows surface can grow past what the decline was priced
 * on, or a checker be wired in, with no ticket re-weighing §W. Nothing gates
 * on the decline itself; this test is what fails, in CI.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..");
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const tracked = (glob: string) =>
	execFileSync("git", ["ls-files", glob], { cwd: ROOT, encoding: "utf8" })
		.split("\n")
		.filter(Boolean);

/*
 * The tools that would check this surface. `powershell` before `pwsh` because
 * the route §W declines runs through `powershell.exe` — Windows PowerShell 5.1,
 * the only one installed here — and `parsefile` because that route needs no
 * tool name at all, being a .NET call inside a `-Command` string. `cscript` and
 * `wscript` are the VBScript half. Missing `powershell` is the defect this
 * file's own review caught, and it is the same one caught in the Markdown
 * sibling (mantahostels#1540 review): a hand-written pattern narrower than the surface.
 */
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

/*
 * Derived from the list above, so a tool added there is covered at every gate
 * without a second edit — hand-writing the two separately is what left
 * `powershell` uncovered.
 */
const WINDOWS_CHECKERS = new RegExp(WINDOWS_TOOLS.join("|"), "i");

/*
 * The second spelling: a gate step can name a glob rather than a tool. Both
 * are needed, and neither can tell "wired" from merely "mentioned" — a
 * `paths-ignore:` line naming `*.ps1` would fail these cases despite wiring no
 * checker. That tripwire is accepted: it costs one read of the diff.
 */
const WINDOWS_EXTENSIONS = /\.(ps1|psm1|vbs|cmd|bat)\b/i;

describe("Windows-side script tooling is declined (mantahostels#1131)", () => {
	it("still covers exactly the surface the decline measured", () => {
		/*
		 * A fourth Windows file, or one outside this directory, is a different
		 * surface and re-opens the question. `task.xml.template` is pinned with
		 * the other two because §W prices the decline on all three.
		 */
		expect(tracked("scripts/win-interop-watchdog/*")).toEqual([
			"scripts/win-interop-watchdog/launcher.vbs",
			"scripts/win-interop-watchdog/task.xml.template",
			"scripts/win-interop-watchdog/watchdog.ps1",
		]);
		for (const ext of ["*.ps1", "*.psm1", "*.vbs", "*.cmd", "*.bat"]) {
			const found = tracked(ext).filter(
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
		// The floor: an empty dependency set would satisfy the filter vacuously.
		expect(deps.length).toBeGreaterThan(10);
		expect(deps.filter((d) => WINDOWS_CHECKERS.test(d))).toEqual([]);
	});

	it("wires no npm script to one", () => {
		const scripts = JSON.parse(read("package.json")).scripts as Record<
			string,
			string
		>;
		// The floor: a renamed or emptied `scripts` key would run no assertion.
		expect(Object.keys(scripts).length).toBeGreaterThan(20);
		for (const [name, cmd] of Object.entries(scripts)) {
			expect(`${name} -> ${cmd}`, name).not.toMatch(WINDOWS_CHECKERS);
			expect(`${name} -> ${cmd}`, name).not.toMatch(WINDOWS_EXTENSIONS);
		}
	});

	it("runs none at any enforcement moment", () => {
		/*
		 * Every gate a step could join, not just the two §W names: all four
		 * husky hooks, and every workflow — `Document guards` in
		 * roadmap-digest.yml already runs bespoke checkers, so it is as likely a
		 * home as ci.yml.
		 */
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
		/*
		 * The positive half, and what stops the case above passing vacuously:
		 * shellcheck genuinely reaches this directory's shell installer, so the
		 * gap is the two Windows files specifically, not the whole directory.
		 */
		const shellCorpus = tracked("scripts/*.sh");
		expect(shellCorpus).toContain("scripts/install-interop-watchdog.sh");
		expect(shellCorpus.some((f) => WINDOWS_EXTENSIONS.test(f))).toBe(false);
	});

	it("records the decline in §W, where a reader meets it", () => {
		/*
		 * §W is the owner document for this map's declines (mantahostels#1537), beside
		 * coverage (mantahostels#1136), function length (mantahostels#1518) and Markdown (mantahostels#1540). The
		 * assertion takes the bullet's own heading phrase rather than the issue
		 * number, which appears elsewhere in the file and so would survive the
		 * bullet's deletion (mantahostels#1540 review).
		 */
		expect(read("docs/code-standards.md")).toMatch(
			/\*\*The Windows-side watchdog scripts — declined, because the only free checker is the thing they exist to catch\*\*/,
		);
	});
});
