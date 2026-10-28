// @vitest-environment node

/*
 * Pins scripts/lib/formatters.js's shell file set (#1828), its install lines
 * and CI's ruff install against the core's pins, and its program route: the skip flags, the lint verdict and the ruff
 * config the pre-commit gates read.
 *
 * Loosen a case and a shell file outside the set goes unformatted and
 * unlinted, or a vendored one is refused for code the repo never wrote.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RUFF_INSTALL, SHFMT_INSTALL } from "./formatters.js";
import { newRepo, registerTempCleanup } from "./precommit-gate-harness";
import { ROOT } from "./precommit-gate-testkit";
import { runInProcess } from "./run-in-process.js";

const temps = registerTempCleanup();
const PROGRAM = path.join(ROOT, "scripts", "lib", "formatters.js");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("the shell file set (#1828)", () => {
	/** `shell-files` over `paths` in a repo holding `files`, all staged. */
	const pick = (
		files: Record<string, string>,
		paths = Object.keys(files),
		mode: string[] = [],
	) => {
		const { root, git } = newRepo("formatters-shell-", temps);
		for (const [rel, body] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
			fs.writeFileSync(path.join(root, rel), body);
		}
		git("add", ".");
		const r = runInProcess(PROGRAM, ["shell-files", ...mode], {
			cwd: root,
			stdin: paths.map((p) => `${p}\n`).join(""),
		});
		expect(r.status, r.stderr).toBe(0);
		return r.stdout.split("\n").filter(Boolean);
	};

	it("takes a .sh or .bash file anywhere, and every husky hook, by name", () => {
		const body = "echo hi\n";
		expect(
			pick({
				"plugin/hooks/pointer.sh": body,
				"test/all.bash": body,
				".husky/pre-commit": body,
				".husky/pre-commit.local": body,
				".husky/.gitignore": "_\n",
				".husky/README.md": body,
				"docs/notes.md": body,
			}),
		).toEqual([
			"plugin/hooks/pointer.sh",
			"test/all.bash",
			".husky/pre-commit",
			".husky/pre-commit.local",
		]);
	});

	it("takes an extensionless file whose shebang names a shell shellcheck reads, and no other", () => {
		expect(
			pick({
				"bin/a": "#!/bin/sh\n",
				"bin/b": "#!/usr/bin/env bash\n",
				"bin/c": "#!/usr/bin/env -S bash -eu\n",
				"bin/d": "#!/bin/dash\n",
				"bin/node": "#!/usr/bin/env node\n",
				"bin/zsh": "#!/bin/zsh\n",
				"bin/shellish": "#!/usr/bin/env shellcheck\n",
				"bin/plain": "echo no shebang\n",
				"bin/tool.js": "#!/bin/sh\n",
			}),
		).toEqual(["bin/a", "bin/b", "bin/c", "bin/d"]);
	});

	it("drops what .gitattributes marks linguist-vendored or linguist-generated", () => {
		const files = {
			".gitattributes":
				"vendor/** linguist-vendored\ngen/** linguist-generated=true\nkept/** -linguist-vendored\n",
			"vendor/x.sh": "echo\n",
			"gen/y.sh": "echo\n",
			"kept/z.sh": "echo\n",
		};
		expect(pick(files)).toEqual(["kept/z.sh"]);
	});

	it.each([[[]], [["--index"]]])(
		"drops a symlink, whose target is judged at its own path (%j)",
		(mode) => {
			const { root, git } = newRepo("formatters-link-", temps);
			fs.mkdirSync(path.join(root, ".husky"));
			fs.writeFileSync(path.join(root, "hook.sh"), "echo\n");
			fs.symlinkSync(
				"../hook.sh",
				path.join(root, ".husky", "pre-commit.local"),
			);
			git("add", ".");
			const r = runInProcess(PROGRAM, ["shell-files", ...mode], {
				cwd: root,
				stdin: ".husky/pre-commit.local\nhook.sh\n",
			});
			expect(r.stdout).toBe("hook.sh\n");
		},
	);

	it("reads the staged blob and staged .gitattributes on --index, never the worktree's", () => {
		const { root, git } = newRepo("formatters-index-", temps);
		fs.mkdirSync(path.join(root, "bin"));
		fs.writeFileSync(path.join(root, "bin", "run"), "#!/bin/sh\n");
		fs.writeFileSync(path.join(root, "v.sh"), "echo\n");
		fs.writeFileSync(
			path.join(root, ".gitattributes"),
			"v.sh linguist-vendored\n",
		);
		git("add", ".");
		// The worktree now says the opposite of the index on both counts.
		fs.writeFileSync(path.join(root, "bin", "run"), "#!/usr/bin/env node\n");
		fs.writeFileSync(path.join(root, ".gitattributes"), "");
		const r = runInProcess(PROGRAM, ["shell-files", "--index"], {
			cwd: root,
			stdin: "bin/run\nv.sh\n",
		});
		expect(r.stdout).toBe("bin/run\n");
		expect(r.status).toBe(0);
	});

	/** This checkout's tracked shell files, as check:sh lists them. */
	const tracked = () =>
		runInProcess(PROGRAM, ["shell-files", "--tracked"], { cwd: ROOT })
			.stdout.split("\n")
			.filter(Boolean);

	it("lists this checkout's every husky hook and scripts/*.sh, and no vendored skill, on --tracked", () => {
		const set = tracked();
		const hooks = fs
			.readdirSync(path.join(ROOT, ".husky"))
			.filter((f) => f !== "_")
			.map((f) => `.husky/${f}`);
		for (const p of [...hooks, "scripts/lib/precommit-gate.sh"])
			expect(set).toContain(p);
		expect(set.filter((p) => p.startsWith(".agents/"))).toEqual([]);
	});

	it("arms precommit-gate.sh's GATE_SHELL_CANDIDATE on every shell file the lister can pick", () => {
		const spelt = read("scripts/lib/precommit-gate.sh").match(
			/^GATE_SHELL_CANDIDATE='([^']+)'$/m,
		)?.[1];
		expect(spelt).toBeDefined();
		const shell = [
			...tracked(),
			"plugin/hooks/pointer.sh",
			"test/all.bash",
			".husky/pre-commit.local",
			"bin/run",
		];
		const grep = (paths: string[]) =>
			execFileSync("grep", ["-cvE", "-e", spelt as string], {
				input: paths.join("\n"),
				encoding: "utf8",
			}).trim();
		// grep exits 1 on a zero count, which is the pass.
		expect(() => grep(shell)).toThrow();
		expect(grep(["scripts/a.js", "docs/x.md", ".husky/README.md"])).toBe("3");
	});

	it("is the one set every route reads: check:sh, check-sh-changed.sh and both pre-commit gates", () => {
		const pkg = JSON.parse(read("package.json"));
		expect(pkg.scripts["check:sh"]).toMatch(
			/\$\(node scripts\/lib\/formatters\.js shell-files --tracked\)$/,
		);
		expect(read("scripts/check-sh-changed.sh")).toMatch(
			/node "\$lib\/formatters\.js" shell-files\)/,
		);
		const hook = read(".husky/pre-commit");
		expect(hook).toContain("if armed_shell; then");
		expect(hook).toContain('armed "\\.py\\$|$GATE_SHELL_CANDIDATE"');
	});
});

describe("formatters.js as a program — the pre-commit hook's reading (#1354)", () => {
	const run = (
		args: string[],
		env: object = {},
		hostRoot = newRepo("formatters-host-", temps).root,
	) => {
		const r = runInProcess(PROGRAM, args, {
			cwd: hostRoot,
			env: { ...process.env, ...env },
		});
		return { code: r.status, stdout: r.stdout, stderr: r.stderr };
	};

	/** A plugin root holding a ruff.toml, as a release tree does. */
	const plugin = () => {
		const { root } = newRepo("formatters-plugin-", temps);
		fs.writeFileSync(path.join(root, "ruff.toml"), "[lint]\n");
		return root;
	};

	/** A host whose one workflow and package.json scripts read as given. */
	const host = (workflow?: string, scripts?: Record<string, string>) => {
		const { root } = newRepo("formatters-host-", temps);
		if (workflow !== undefined) {
			fs.mkdirSync(path.join(root, ".github", "workflows"), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(root, ".github", "workflows", "ci.yml"),
				workflow,
			);
		}
		if (scripts)
			fs.writeFileSync(
				path.join(root, "package.json"),
				JSON.stringify({ scripts }),
			);
		return root;
	};
	const neither = {
		WFC_SHFMT: "/nonexistent/shfmt",
		WFC_RUFF: "/nonexistent/ruff",
	};
	const flags = (root: string, env: object = neither) => {
		const { code, stdout } = run(["skip-flags"], env, root);
		return { code, stdout };
	};
	const answer = (line: string) => ({ code: 0, stdout: `${line}\n` });

	it("skips no half where no workflow runs a formatter, however both are missing (#1463)", () => {
		expect(flags(host())).toEqual(answer("flags:"));
		expect(flags(host("    steps:\n      - run: npm test\n"))).toEqual(
			answer("flags:"),
		);
	});

	it("skips each half whose missing formatter a workflow runs, through npm scripts too (#1463)", () => {
		const ci = host(
			"      - run: npm run lint\n      - run: ruff format --check .\n",
			{ lint: "npm run lint:sh", "lint:sh": "node scripts/check-shfmt.js" },
		);
		expect(flags(ci)).toEqual(answer("flags:--skip-shell --skip-python"));
	});

	it("skips only the half whose formatter is missing, never one installed", () => {
		const ci = host("      - run: shfmt -d . && ruff format --check .\n");
		expect(flags(ci, { WFC_RUFF: "/nonexistent/ruff" })).toEqual(
			answer("flags:--skip-python"),
		);
	});

	it("reads no workflow or package.json where both formatters are installed, so a malformed one cannot refuse", () => {
		const { root } = newRepo("formatters-host-", temps);
		fs.writeFileSync(path.join(root, "package.json"), "{ not json");
		// node answers `--version`, standing in for a ruff CI's node job lacks.
		expect(flags(root, { WFC_RUFF: process.execPath })).toEqual(
			answer("flags:"),
		);
	});

	it("reads no comment line as running a formatter", () => {
		const ci = host("      # shfmt and ruff format run elsewhere\n");
		expect(flags(ci)).toEqual(answer("flags:"));
	});

	const lint = (root: string) => run(["lint-missing"], neither, root);

	it("refuses on `lint-missing` where no workflow runs ruff check, ruff format alone and comments not counting (#1563)", () => {
		for (const root of [
			host(),
			host(
				"      - run: ruff format --check .\n      # ruff check runs elsewhere\n",
			),
		]) {
			const { code, stdout, stderr } = lint(root);
			expect(stdout).toBe("lint:refuse\n");
			expect(code).toBe(0);
			expect(stderr).toMatch(
				/is not on PATH and no workflow under \.github\/workflows\/ runs ruff check/,
			);
			expect(stderr).toContain(`Install it: ${RUFF_INSTALL}`);
		}
	});

	it("skips on `lint-missing` where a workflow runs ruff check, through npm scripts too, naming that workflow (#1563)", () => {
		const ci = host("      - run: npm run check:py\n", {
			"check:py": "ruff check . && ruff format --check .",
		});
		const { code, stdout, stderr } = lint(ci);
		expect(stdout).toBe("lint:skip\n");
		expect(code).toBe(0);
		expect(stderr).toContain(
			`ruff check runs in .github/workflows/ci.yml, which can catch what this lets through when it next runs. Install it: ${RUFF_INSTALL}`,
		);
	});

	it("prints the plugin's ruff.toml on `ruff-config` where the host has no ruff config", () => {
		const at = plugin();
		const { code, stdout } = run(["ruff-config"], { WFC_PLUGIN_ROOT: at });
		expect(stdout).toBe(`${path.join(at, "ruff.toml")}\n`);
		expect(code).toBe(0);
	});

	it("prints nothing on `ruff-config` where the host has its own", () => {
		const { root: hostRoot } = newRepo("formatters-host-", temps);
		fs.writeFileSync(path.join(hostRoot, "ruff.toml"), "[lint]\n");
		expect(
			run(["ruff-config"], { WFC_PLUGIN_ROOT: plugin() }, hostRoot).stdout,
		).toBe("");
	});

	it("refuses any other argument with its usage, exiting 2", () => {
		const { code, stderr } = run(["ruff"]);
		expect(stderr).toMatch(
			/usage: node formatters\.js <ruff-config\|skip-flags\|lint-missing\|shell-files/,
		);
		expect(code).toBe(2);
	});
});

describe("the install lines a refusal names, and CI's ruff install, at the core's pins (#1463, #1590)", () => {
	it("install shfmt at package.json's pin and ruff at requirements-dev.in's", () => {
		const pkg = JSON.parse(read("package.json"));
		expect(SHFMT_INSTALL).toMatch(
			new RegExp(`@wasm-fmt/shfmt@${pkg.devDependencies["@wasm-fmt/shfmt"]}$`),
		);
		const pin = read("requirements-dev.in").match(/^ruff==(\S+)$/m)?.[1];
		expect(RUFF_INSTALL).toBe(`python3 -m pip install ruff==${pin}`);
	});

	it("has CI's Vitest job install ruff from requirements-dev.txt's pin, never a version of its own (#1590)", () => {
		const ci = read(".github/workflows/ci.yml");
		const testJob = ci.slice(
			ci.indexOf("name: Vitest ("),
			ci.indexOf("- name: Vitest\n"),
		);
		expect(testJob).toContain(
			`awk '/^ruff==/ { on = 1 } on { print } on && !/\\\\$/ { exit }' \\\n            requirements-dev.txt`,
		);
		expect(ci).not.toMatch(/ruff==\d/);
	});
});
