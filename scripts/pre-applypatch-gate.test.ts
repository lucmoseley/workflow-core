// @vitest-environment node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderHookShim } from "./lib/adopter-skeleton";
import { commandPath } from "./lib/command-path-testkit";
import { defineTemplate, mkScratchDir } from "./lib/git-fixture";
import { huskyHooks, installHuskyShim } from "./lib/husky-testkit";
import { newRepo, registerTempCleanup } from "./lib/precommit-gate-harness";
import { ROOT } from "./lib/precommit-gate-testkit";
import { runInProcess } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";

const HOOK_REL = path.join(".husky", "pre-applypatch");
const HOOK = fs.readFileSync(path.join(ROOT, HOOK_REL), "utf8");
const PRINTER_REL = path.join("scripts", "pre-applypatch-refusal.js");

const UNNAMED = "its route could not be named";

const temps = registerTempCleanup();

const LOG = "fired.log";

const SECRET = `AKIA${"2QQ7WZ4KKPFXJ3RN"}`;

const HAS_GITLEAKS = (() => {
	try {
		execFileSync(process.env.WFC_GITLEAKS || "gitleaks", ["version"], {
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
})();

interface Probe {
	root: string;
	git: (...args: string[]) => Buffer;
	fired: () => string[];
	reset: () => void;
	gitDir: () => string;
	base: string;
}

const buildTemplate = (root: string) => {
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
	git("init", "-q", ".");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");

	const husky = path.join(root, ".husky");
	installHuskyShim(root);
	fs.copyFileSync(
		path.join(ROOT, HOOK_REL),
		path.join(husky, "pre-applypatch"),
	);
	fs.mkdirSync(path.join(root, "scripts"));
	fs.copyFileSync(path.join(ROOT, PRINTER_REL), path.join(root, PRINTER_REL));
	fs.symlinkSync(
		path.join(ROOT, "scripts", "lib"),
		path.join(root, "scripts", "lib"),
	);

	const log = path.join(root, LOG);
	for (const f of ["pre-commit", "prepare-commit-msg"])
		fs.writeFileSync(
			path.join(husky, f),
			`echo ${shellQuote(f)} >> ${shellQuote(log)}\nexit 0\n`,
		);

	fs.writeFileSync(path.join(root, "base.txt"), "base\n");
	git("add", "--", "base.txt");
	git("commit", "-qm", "base");
};

const template = defineTemplate(buildTemplate);

function probe(): Probe {
	const root = mkScratchDir("pre-applypatch-gate-");
	temps.push(root);
	template.instantiate(root, {
		extraPaths: [
			path.join(".husky", "pre-commit"),
			path.join(".husky", "prepare-commit-msg"),
		],
	});
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
	const log = path.join(root, LOG);

	return {
		root,
		git,
		fired: () =>
			fs.existsSync(log)
				? fs.readFileSync(log, "utf8").split("\n").filter(Boolean)
				: [],
		reset: () => fs.rmSync(log, { force: true }),
		gitDir: () =>
			execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
				cwd: root,
				encoding: "utf8",
			}).trim(),
		base: execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
			cwd: root,
			encoding: "utf8",
		}).trim(),
	};
}

function run(
	cwd: string,
	args: string[],
	extraEnv: Record<string, string | undefined> = {},
): { code: number; output: string } {
	const env: Record<string, string | undefined> = {
		...process.env,
		GIT_EDITOR: "true",
		...extraEnv,
	};
	for (const [k, v] of Object.entries(extraEnv))
		if (v === undefined) delete env[k];
	const r = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		code: r.status ?? 1,
		output: `${r.stdout ?? ""}${r.stderr ?? ""}`,
	};
}

function attempt(
	cwd: string,
	...args: string[]
): { code: number; output: string } {
	return run(cwd, args);
}

function scannerStub(dir: string, code: number): string {
	const bin = path.join(dir, `scanner-exit-${code}`);
	fs.writeFileSync(
		bin,
		`#!/bin/sh\necho "STUB SCANNER RAN" >&2\nexit ${code}\n`,
	);
	fs.chmodSync(bin, 0o755);
	return bin;
}

function pathWithoutGitleaks(): string {
	const guardBin = path.join(ROOT, "scripts", "lib", "host-git-guard");
	const gitBin = (process.env.PATH ?? "")
		.split(path.delimiter)
		.find(
			(d) => path.resolve(d) !== guardBin && fs.existsSync(path.join(d, "git")),
		);
	if (!gitBin) throw new Error("no real git on PATH behind the guard");
	if (fs.existsSync(path.join(gitBin, "gitleaks")))
		throw new Error(`${gitBin} holds both git and gitleaks`);
	const bashBin = mkScratchDir("pre-applypatch-bash-");
	temps.push(bashBin);
	fs.symlinkSync(commandPath("bash"), path.join(bashBin, "bash"));
	fs.symlinkSync(process.execPath, path.join(bashBin, "node"));
	return [guardBin, bashBin, gitBin].join(path.delimiter);
}

function sideBranch(p: Probe, files: Record<string, string>): void {
	p.git("checkout", "-q", "-b", "side");
	for (const [rel, body] of Object.entries(files)) {
		fs.writeFileSync(path.join(p.root, rel), body);
		p.git("add", "--", rel);
		p.git("commit", "-qm", rel);
	}
	p.git("checkout", "-q", p.base);
}

function diverge(p: Probe): void {
	fs.writeFileSync(path.join(p.root, "base.txt"), "moved\n");
	p.git("commit", "-qm", "moved", "--", "base.txt");
}

function patchOfSide(p: Probe): string {
	const dir = path.join(p.root, "patches");
	p.git("format-patch", "-1", "side", "-o", dir, "-q");
	const file = fs
		.readdirSync(dir)
		.map((f) => path.join(dir, f))
		.find((f) => f.endsWith(".patch"));
	if (!file) throw new Error("git format-patch wrote no patch");
	return file;
}

const gitLog = (p: Probe, ...args: string[]) =>
	execFileSync("git", ["log", ...args], { cwd: p.root, encoding: "utf8" });

describe(".husky/pre-applypatch", () => {
	it("is the hook husky actually dispatches", () => {
		expect(fs.existsSync(path.join(ROOT, HOOK_REL))).toBe(true);
		expect(huskyHooks()).toContain("pre-applypatch");
	});

	it("runs gitleaks ALONE, never the gate stack", () => {
		const code = HOOK.split("\n").filter((l) => !l.trimStart().startsWith("#"));
		expect(code.join("\n")).not.toMatch(/sh -e|npm run/);
		expect(code.filter((l) => l.includes("gitleaks")).length).toBe(1);
	});

	it("runs the command .husky/pre-commit runs, spelled once, and exits 0 on its pass", () => {
		const scan = `"\${WFC_GITLEAKS:-gitleaks}" git --staged --redact`;
		expect(HOOK.split(scan).length - 1).toBe(1);
		expect(HOOK).toContain(`${scan} && exit 0`);
		expect(
			fs.readFileSync(path.join(ROOT, ".husky", "pre-commit"), "utf8"),
		).toContain(scan);
	});

	it.each([HOOK_REL, PRINTER_REL])(
		"%s reads its route from lib/commit-route.js and spells no marker of its own",
		(rel) => {
			const text = fs
				.readFileSync(path.join(ROOT, rel), "utf8")
				.split("\n")
				.filter((l) => !/^\s*(#|\/?\*|$)/.test(l))
				.join("\n");
			expect(text).not.toMatch(
				/rebase-merge|\/rebase-apply|rebase-apply\/|CHERRY_PICK_HEAD|REVERT_HEAD|sequencer|MERGE_HEAD|AUTO_MERGE|BISECT_LOG|GIT_REFLOG_ACTION/,
			);
		},
	);

	it("refuses through the printer", () => {
		const printer = fs.readFileSync(path.join(ROOT, PRINTER_REL), "utf8");
		expect(printer).toContain('require("./lib/commit-route.js")');
		expect(printer).toContain('commitRoute("pre-applypatch"');
		expect(HOOK).toContain("/scripts/pre-applypatch-refusal.js");
	});
});

describe("the premise: which hooks these two routes reach", () => {
	it("`git am` reaches pre-applypatch and neither pre-commit nor prepare-commit-msg", () => {
		const p = probe();
		sideBranch(p, { "side.txt": "side\n" });
		const patch = patchOfSide(p);
		p.git("reset", "-q", "--hard", "HEAD");
		p.reset();

		const r = attempt(p.root, "am", patch);
		expect(p.fired()).toEqual([]);
		if (HAS_GITLEAKS) expect(r.code).toBe(0);
	});

	it("`git rebase --apply` reaches it too, so the backend choice is no escape", () => {
		const p = probe();
		sideBranch(p, { "side.txt": "side\n" });
		diverge(p);
		p.git("checkout", "-q", "side");
		p.reset();

		const r = attempt(p.root, "rebase", "--apply", p.base);
		expect(p.fired()).toEqual([]);
		if (HAS_GITLEAKS) expect(r.code).toBe(0);
	});
});

describe("what a refusal actually stops", () => {
	it.skipIf(!HAS_GITLEAKS)(
		"aborts a `git am` applying a secret, naming `git am --abort`",
		() => {
			const p = probe();
			sideBranch(p, { "creds.txt": `${SECRET}\n` });
			const patch = patchOfSide(p);
			p.git("branch", "-qD", "side");
			p.git("reset", "-q", "--hard", "HEAD");
			const before = gitLog(p, "--format=%H", "-1").trim();

			const r = attempt(p.root, "am", patch);
			expect(r.code).not.toBe(0);
			expect(r.output).toContain("git am --abort");
			expect(gitLog(p, "--format=%H", "-1").trim()).toBe(before);
			expect(gitLog(p, "-p", "--all")).not.toContain(SECRET);
			expect(
				fs.existsSync(path.join(p.gitDir(), "rebase-apply", "applying")),
			).toBe(true);
		},
	);

	it.skipIf(!HAS_GITLEAKS)(
		"aborts a `git rebase --apply` replaying a secret, naming `git rebase --abort`",
		() => {
			const p = probe();
			sideBranch(p, { "creds.txt": `${SECRET}\n` });
			diverge(p);
			const onto = gitLog(p, "--format=%H", "-1").trim();
			p.git("checkout", "-q", "side");

			const r = attempt(p.root, "rebase", "--apply", p.base);
			expect(r.code).not.toBe(0);
			expect(r.output).toContain("git rebase --abort");
			expect(r.output).not.toContain("git am --abort");
			expect(gitLog(p, "--format=%H", "-1").trim()).toBe(onto);
			expect(gitLog(p, "-p", "HEAD")).not.toContain(SECRET);
			expect(
				fs.existsSync(path.join(p.gitDir(), "rebase-apply", "rebasing")),
			).toBe(true);
		},
	);

	it.skipIf(!HAS_GITLEAKS)("lets a clean `git am` through", () => {
		const p = probe();
		sideBranch(p, { "side.txt": "side\n" });
		const patch = patchOfSide(p);
		p.git("reset", "-q", "--hard", "HEAD");

		expect(attempt(p.root, "am", patch).code).toBe(0);
		expect(gitLog(p, "--format=%s", "-1").trim()).toBe("side.txt");
	});

	it.skipIf(!HAS_GITLEAKS)("lets a clean `git rebase --apply` through", () => {
		const p = probe();
		sideBranch(p, { "side.txt": "side\n" });
		diverge(p);
		p.git("checkout", "-q", "side");

		expect(attempt(p.root, "rebase", "--apply", p.base).code).toBe(0);
		expect(gitLog(p, "--format=%s", "-1").trim()).toBe("side.txt");
	});

	it("refuses when gitleaks itself cannot run, rather than passing vacuously", () => {
		const p = probe();
		sideBranch(p, { "side.txt": "side\n" });
		const patch = patchOfSide(p);
		p.git("reset", "-q", "--hard", "HEAD");

		const r = run(p.root, ["am", patch], {
			PATH: pathWithoutGitleaks(),
			WFC_GITLEAKS: undefined,
		});
		expect(r.code).not.toBe(0);
		expect(r.output).toContain("did not pass");
		expect(r.output).toContain("gitleaks itself is missing");
	});

	it("runs the scanner WFC_GITLEAKS names, and refuses on its finding", () => {
		const p = probe();
		sideBranch(p, { "side.txt": "side\n" });
		const patch = patchOfSide(p);
		p.git("reset", "-q", "--hard", "HEAD");
		const before = gitLog(p, "--format=%H", "-1").trim();

		const r = run(p.root, ["am", patch], {
			WFC_GITLEAKS: scannerStub(p.root, 1),
		});
		expect(r.code).not.toBe(0);
		expect(r.output).toContain("STUB SCANNER RAN");
		expect(r.output).toContain("did not pass");
		expect(r.output).toContain("Clear it with:  git am --abort");
		expect(gitLog(p, "--format=%H", "-1").trim()).toBe(before);
	});

	it("names `git rebase --abort`, never `git am --abort`, on a `git rebase --apply` the scanner refuses", () => {
		const p = probe();
		sideBranch(p, { "side.txt": "side\n" });
		diverge(p);
		p.git("checkout", "-q", "side");

		const r = run(p.root, ["rebase", "--apply", p.base], {
			WFC_GITLEAKS: scannerStub(p.root, 1),
		});
		expect(r.code).not.toBe(0);
		expect(r.output).toContain("Clear it with:  git rebase --abort");
		expect(r.output).not.toContain("git am --abort");
	});

	it("still refuses when the refusal printer is missing, in one line", () => {
		const p = probe();
		sideBranch(p, { "side.txt": "side\n" });
		const patch = patchOfSide(p);
		p.git("reset", "-q", "--hard", "HEAD");
		fs.rmSync(path.join(p.root, PRINTER_REL));
		const before = gitLog(p, "--format=%H", "-1").trim();

		const r = run(p.root, ["am", patch], {
			WFC_GITLEAKS: scannerStub(p.root, 1),
		});
		expect(r.code).not.toBe(0);
		expect(r.output).toContain("STUB SCANNER RAN");
		const lines = r.output
			.split("\n")
			.filter((l) => l.startsWith("pre-applypatch:"));
		expect(lines).toEqual([
			expect.stringContaining(
				"the secrets scan did not pass, so the apply is refused",
			),
		]);
		expect(lines[0]).toContain(UNNAMED);
		expect(lines[0]).toContain("pre-applypatch-refusal.js would not run");
		expect(r.output).not.toContain("IN PROGRESS");
		expect(gitLog(p, "--format=%H", "-1").trim()).toBe(before);
	});

	it("still refuses in one line when the printer fails, never printing a stack", () => {
		const p = probe();
		sideBranch(p, { "side.txt": "side\n" });
		const patch = patchOfSide(p);
		p.git("reset", "-q", "--hard", "HEAD");
		fs.writeFileSync(
			path.join(p.root, PRINTER_REL),
			'throw new Error("PRINTER BROKE");\n',
		);
		const before = gitLog(p, "--format=%H", "-1").trim();

		const r = run(p.root, ["am", patch], {
			WFC_GITLEAKS: scannerStub(p.root, 1),
		});
		expect(r.code).not.toBe(0);
		expect(r.output).toContain(UNNAMED);
		expect(r.output).not.toContain("PRINTER BROKE");
		expect(r.output).not.toContain("IN PROGRESS");
		expect(gitLog(p, "--format=%H", "-1").trim()).toBe(before);
	});

	it.each([
		["am", "git am", "git am --abort"],
		["rebase-apply", "git rebase --apply", "git rebase --abort"],
	])(
		"prints scanRefusal's three lines byte for byte on a refused %s",
		(route, name, abort) => {
			const p = probe();
			sideBranch(p, { "side.txt": "side\n" });
			let args: string[];
			if (route === "am") {
				const patch = patchOfSide(p);
				p.git("reset", "-q", "--hard", "HEAD");
				args = ["am", patch];
			} else {
				diverge(p);
				p.git("checkout", "-q", "side");
				args = ["rebase", "--apply", p.base];
			}
			const r = run(p.root, args, { WFC_GITLEAKS: scannerStub(p.root, 1) });
			expect(r.code).not.toBe(0);
			expect(r.output).toContain(
				`STUB SCANNER RAN\npre-applypatch: the secrets scan did not pass on this ${name} (mantahostels#1706).\n` +
					"  Its own output is above — a finding, or gitleaks itself is missing.\n" +
					`  The ${name} is left IN PROGRESS. Clear it with:  ${abort}\n`,
			);
			expect(r.output).not.toContain(UNNAMED);
		},
	);

	function nodeSpyPath(dir: string, log: string): string {
		const bin = path.join(dir, "node-spy");
		fs.mkdirSync(bin);
		fs.writeFileSync(
			path.join(bin, "node"),
			`#!/bin/sh\necho node >> ${shellQuote(log)}\nexec ${shellQuote(process.execPath)} "$@"\n`,
			{ mode: 0o755 },
		);
		return [bin, process.env.PATH].join(path.delimiter);
	}

	it("starts no node on a passing apply, and starts it once on a refusal", () => {
		const p = probe();
		sideBranch(p, { "side.txt": "side\n" });
		const patch = patchOfSide(p);
		p.git("reset", "-q", "--hard", "HEAD");
		const log = path.join(p.root, "node-starts.log");
		const Path = nodeSpyPath(p.root, log);
		const starts = () =>
			fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";

		const refused = run(p.root, ["am", patch], {
			PATH: Path,
			WFC_GITLEAKS: scannerStub(p.root, 1),
		});
		expect(refused.code).not.toBe(0);
		expect(refused.output).toContain("Clear it with:  git am --abort");
		expect(starts()).toBe("node\n");
		p.git("am", "--abort");
		fs.rmSync(log);

		const passed = run(p.root, ["am", patch], {
			PATH: Path,
			WFC_GITLEAKS: scannerStub(p.root, 0),
		});
		expect(passed.code).toBe(0);
		expect(starts()).toBe("");
	});

	it("lets the apply through when the scanner WFC_GITLEAKS names passes it", () => {
		const p = probe();
		sideBranch(p, { "side.txt": "side\n" });
		const patch = patchOfSide(p);
		p.git("reset", "-q", "--hard", "HEAD");

		const r = run(p.root, ["am", patch], {
			WFC_GITLEAKS: scannerStub(p.root, 0),
		});
		expect(r.code).toBe(0);
		expect(r.output).toContain("STUB SCANNER RAN");
		expect(gitLog(p, "--format=%s", "-1").trim()).toBe("side.txt");
	});
});

describe("an adopter's pre-applypatch, run from the plugin through its shim (#1839)", () => {
	it("finds its printer under $WFC_PLUGIN_ROOT where set", () => {
		expect(HOOK).toContain(
			`"\${WFC_PLUGIN_ROOT:-$(dirname "$0")/..}/scripts/pre-applypatch-refusal.js"`,
		);
	});

	function adopter() {
		const { root, git } = newRepo("pre-applypatch-adopter-", temps);
		const plugin = fs.mkdtempSync(`${root}-plugin-`);
		temps.push(plugin);
		fs.mkdirSync(path.join(plugin, "scripts"));
		fs.copyFileSync(
			path.join(ROOT, PRINTER_REL),
			path.join(plugin, PRINTER_REL),
		);
		fs.symlinkSync(
			path.join(ROOT, "scripts", "lib"),
			path.join(plugin, "scripts", "lib"),
		);
		fs.mkdirSync(path.join(plugin, ".husky"));
		fs.copyFileSync(
			path.join(ROOT, HOOK_REL),
			path.join(plugin, ".husky", "pre-applypatch"),
		);
		fs.mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
		fs.copyFileSync(
			path.join(ROOT, "scripts", "lib", "resolve-core.js"),
			path.join(root, "scripts", "lib", "resolve-core.js"),
		);
		fs.mkdirSync(path.join(root, ".husky"));
		fs.writeFileSync(
			path.join(root, ".husky", "pre-applypatch"),
			renderHookShim("pre-applypatch"),
			{ mode: 0o755 },
		);
		fs.writeFileSync(path.join(root, "base.txt"), "base\n");
		git("add", "--", "base.txt");
		git("commit", "-qm", "base");
		git("checkout", "-q", "-b", "side");
		fs.writeFileSync(path.join(root, "side.txt"), "side\n");
		git("add", "--", "side.txt");
		git("commit", "-qm", "side");
		git("format-patch", "-q", "-1", "-o", path.join(root, ".git", "p"));
		git("checkout", "-q", "-");
		git("config", "core.hooksPath", ".husky");
		const am = () => {
			const dir = path.join(root, ".git", "p");
			return run(
				root,
				["am", ...fs.readdirSync(dir).map((f) => path.join(dir, f))],
				{ WFC_GITLEAKS: scannerStub(plugin, 1), WORKFLOW_CORE_DIR: plugin },
			);
		};
		return { plugin, am };
	}

	it("runs the plugin's printer, naming `git am --abort` on a refused `git am`", () => {
		const r = adopter().am();
		expect(r.code).not.toBe(0);
		expect(r.output).toContain("STUB SCANNER");
		expect(r.output).toContain("Clear it with:  git am --abort");
	});

	it("still refuses, naming the plugin's path, where the plugin has no printer", () => {
		const a = adopter();
		fs.rmSync(path.join(a.plugin, PRINTER_REL));
		const r = a.am();
		expect(r.code).not.toBe(0);
		expect(r.output).toContain("STUB SCANNER");
		expect(r.output).toContain(
			`its route could not be named (${a.plugin}/scripts/pre-applypatch-refusal.js would not run)`,
		);
		expect(r.output).not.toContain("IN PROGRESS");
	});
});

describe("the pre-applypatch hook's own linting", () => {
	it("is in check:sh's file set, which pre-commit's shell gate shares (#1828)", () => {
		const set = runInProcess(
			path.join(ROOT, "scripts/lib/formatters.js"),
			["shell-files", "--tracked"],
			{ cwd: ROOT },
		).stdout;
		expect(set.split("\n")).toContain(".husky/pre-applypatch");
	});
});

describe("the copied fixture is isolated from its template (mantahostels#2068)", () => {
	it("a commit made in the copy leaves the template untouched", () => {
		const p = probe();
		fs.writeFileSync(path.join(p.root, "only-in-copy.txt"), "x\n");
		p.git("add", "--", "only-in-copy.txt");
		p.git("commit", "-qm", "only in the copy");
		expect(gitLog(p, "--oneline").toString()).toContain("only in the copy");

		const fresh = probe();
		expect(gitLog(fresh, "--oneline").toString()).not.toContain(
			"only in the copy",
		);
	});
});
