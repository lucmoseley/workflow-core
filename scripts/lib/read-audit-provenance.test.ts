// @vitest-environment node
/*
 * What the read audit finds a spawned child is (#5057), asked of the
 * module itself over a scratch checkout, temporary directory and installed
 * directory: no traced Node process. Loosen a rule and the audit passes a
 * child whose reads it never saw, and the pass store caches its file.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
	buildVerdictOf,
	GUARD,
	isProvenance,
} = require("./read-audit-provenance.js");

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/**
 * A scratch world: `root` the checkout, `tmp` the temporary directory, `own`
 * a second one a test moved its child's TMPDIR to, and `sys` where
 * installed programs stand, each a real path.
 */
function world({ rootInTmp = false } = {}) {
	const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rap-")));
	dirs.push(base);
	const tmp = path.join(base, "tmp");
	const own = path.join(base, "own");
	const root = rootInTmp ? path.join(tmp, "co") : path.join(base, "co");
	const sys = path.join(base, "usr", "bin");
	for (const d of [tmp, own, root, sys]) fs.mkdirSync(d, { recursive: true });
	const verdictOf = buildVerdictOf({
		root,
		tmps: [tmp, own],
		realpath: fs.realpathSync,
	});
	/** A program file at `abs`, as `binOf` finds it: as found, then real. */
	const program = (abs: string) => {
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, "#!/bin/sh\n", { mode: 0o755 });
		return [abs, fs.realpathSync(abs)];
	};
	const of = (
		file: string,
		bin: string[],
		{
			args = [] as string[],
			envPairs = [] as string[],
			audited = false,
			standing = {} as Record<string, string>,
		} = {},
	) => verdictOf({ file, bin, args, envPairs, audited, standing });
	return { root, tmp, own, sys, program, of };
}

describe("the two rules for the installed program (#4790)", () => {
	it("counts a checkout's node_modules program as installed for reading no variable, not for reading nothing", () => {
		const { root, program, of } = world();
		const biome = program(path.join(root, "node_modules/.bin/biome"));
		expect(of("biome", biome).readsNoVariable).toBe(true);
		const sleep = program(path.join(root, "node_modules/.bin/sleep"));
		expect(of("sleep", sleep).readsNothing).toBe(false);
	});

	it("counts nothing under a temporary directory as installed, a node_modules of a checkout there included", () => {
		const { root, tmp, own, program, of } = world({ rootInTmp: true });
		const biome = program(path.join(root, "node_modules/.bin/biome"));
		expect(of("biome", biome).readsNoVariable).toBe(false);
		const sleep = program(path.join(root, "node_modules/.bin/sleep"));
		expect(of("sleep", sleep).readsNothing).toBe(false);
		for (const dir of [tmp, own]) {
			expect(of("tar", program(path.join(dir, "tar"))).readsNoVariable).toBe(
				false,
			);
			expect(of("sleep", program(path.join(dir, "sleep"))).readsNothing).toBe(
				false,
			);
		}
	});

	it("counts no checkout program outside node_modules, nor a link to one, as installed by either rule", () => {
		const { root, sys, program, of } = world();
		const tar = program(path.join(root, "bin/tar"));
		const sleep = program(path.join(root, "bin/sleep"));
		expect(of("tar", tar).readsNoVariable).toBe(false);
		expect(of("sleep", sleep).readsNothing).toBe(false);
		const linked = (name: string, to: string[]) => {
			const link = path.join(sys, name);
			fs.symlinkSync(to[1] as string, link);
			return [link, fs.realpathSync(link)];
		};
		expect(of("tar", linked("tar", tar)).readsNoVariable).toBe(false);
		expect(of("sleep", linked("sleep", sleep)).readsNothing).toBe(false);
	});

	it("counts a program standing elsewhere as installed by both, and no program at all by neither", () => {
		const { sys, program, of } = world();
		expect(of("tar", program(path.join(sys, "tar"))).readsNoVariable).toBe(
			true,
		);
		expect(of("sleep", program(path.join(sys, "sleep"))).readsNothing).toBe(
			true,
		);
		expect(of("tar", []).readsNoVariable).toBe(false);
		expect(of("sleep", []).readsNothing).toBe(false);
	});
});

describe("a program measured to read no variable", () => {
	it("passes a plain tar and a checkout's own biome, and no program it does not name", () => {
		const { root, sys, program, of } = world();
		const tar = program(path.join(sys, "tar"));
		expect(of("tar", tar, { args: ["-tf", "a.tar"] }).readsNoVariable).toBe(
			true,
		);
		const biome = program(path.join(root, "node_modules/.bin/biome"));
		expect(of("biome", biome).readsNoVariable).toBe(true);
		const cat = program(path.join(sys, "cat"));
		expect(of("cat", cat).readsNoVariable).toBe(false);
	});

	it.each([
		[["--to-command=cat", "-xf", "a.tar"]],
		[["--to-com=cat", "-xf", "a.tar"]],
		[["-I", "cat", "-xf", "a.tar"]],
		[["xIf", "cat", "a.tar"]],
		[["-F", "x", "-cf", "a.tar"]],
	])("doubts a tar asked to run a command: %j", (args) => {
		const { sys, program, of } = world();
		expect(of("tar", program(path.join(sys, "tar")), { args })).toHaveProperty(
			"readsNoVariable",
			false,
		);
	});

	it.each([
		[["edit"]],
		[["-H", "nowhere.invalid", "is-active"]],
		[["-Hnowhere.invalid", "is-active"]],
		[["--ho=nowhere.invalid", "is-active"]],
	])("doubts a systemctl asked to edit or to reach a host: %j", (args) => {
		const { sys, program, of } = world();
		const bin = program(path.join(sys, "systemctl"));
		expect(of("systemctl", bin, { args }).readsNoVariable).toBe(false);
		expect(of("systemctl", bin, { args: ["is-active"] }).readsNoVariable).toBe(
			true,
		);
	});

	it("doubts one whose variable it heeds was set apart from the settled environment, and passes one set apart only on another's", () => {
		const { sys, program, of } = world();
		const settled = { PATH: "/usr/bin", TAR_OPTIONS: "" };
		const under = (file: string, envPairs: string[]) =>
			of(file, program(path.join(sys, file)), { envPairs, standing: settled });
		const pairs = ["PATH=/usr/bin", "TAR_OPTIONS="];
		expect(under("tar", pairs).readsNoVariable).toBe(true);
		const options = ["PATH=/usr/bin", "TAR_OPTIONS=--to-command=cat"];
		expect(under("tar", options).readsNoVariable).toBe(false);
		expect(under("systemctl", options).readsNoVariable).toBe(true);
		const moved = ["PATH=/stub:/usr/bin", "TAR_OPTIONS="];
		expect(under("tar", moved).readsNoVariable).toBe(false);
		expect(under("systemctl", moved).readsNoVariable).toBe(false);
	});
});

describe("a program measured to read nothing", () => {
	it("passes a sleep on any words, and bash or gitleaks only on the one each was measured on", () => {
		const { sys, program, of } = world();
		const at = (file: string) => program(path.join(sys, file));
		expect(of("sleep", at("sleep"), { args: ["0"] }).readsNothing).toBe(true);
		const bash = at("bash");
		expect(of("bash", bash, { args: ["--version"] }).readsNothing).toBe(true);
		expect(of("bash", bash, { args: ["-c", "true"] }).readsNothing).toBe(false);
		expect(of("bash", bash, { args: [] }).readsNothing).toBe(false);
		const leaks = at("gitleaks");
		expect(of("gitleaks", leaks, { args: ["version"] }).readsNothing).toBe(
			true,
		);
		expect(of("cat", at("cat"), { args: ["--version"] }).readsNothing).toBe(
			false,
		);
	});

	it("doubts a sleep a test could have written: in the checkout, its node_modules, the temporary directory, or a link there to any program", () => {
		const { root, tmp, sys, program, of } = world();
		for (const abs of [
			path.join(root, "bin/sleep"),
			path.join(root, "node_modules/.bin/sleep"),
			path.join(tmp, "sleep"),
		])
			expect(of("sleep", program(abs)).readsNothing).toBe(false);
		const cat = program(path.join(sys, "cat"));
		const link = path.join(tmp, "linked", "sleep");
		fs.mkdirSync(path.dirname(link));
		fs.symlinkSync(cat[1] as string, link);
		expect(of("sleep", [link, fs.realpathSync(link)]).readsNothing).toBe(false);
	});
});

describe("what else a child is", () => {
	it("calls a program under either temporary directory a stub, and one of the checkout outside node_modules its own", () => {
		const { root, tmp, own, sys, program, of } = world();
		const stub = of("tool", program(path.join(tmp, "tool")));
		expect([stub.stub, stub.ours]).toEqual([true, false]);
		expect(of("tool", program(path.join(own, "tool"))).stub).toBe(true);
		const ours = of("tool", program(path.join(root, "scripts/tool")));
		expect([ours.stub, ours.ours]).toEqual([false, true]);
		const modules = of("biome", program(path.join(root, "node_modules/x")));
		expect([modules.stub, modules.ours]).toEqual([false, false]);
		const installed = of("tool", program(path.join(sys, "tool")));
		expect([installed.stub, installed.ours]).toEqual([false, false]);
	});

	it("calls a git real only where it is no stub and stands outside the checkout", () => {
		const { root, tmp, sys, program, of } = world();
		expect(of("git", program(path.join(sys, "git"))).realGit).toBe(true);
		expect(of("/x/git", program(path.join(sys, "git"))).realGit).toBe(true);
		expect(of("git", program(path.join(tmp, "git"))).realGit).toBe(false);
		const modules = program(path.join(root, "node_modules/.bin/git"));
		expect(of("git", modules).realGit).toBe(false);
		expect(of("git", []).realGit).toBe(false);
	});

	it("knows the guard by its real file alone, and calls a bare git it answers guarded only where it carries the audit", () => {
		const { tmp, program, of } = world();
		const guard = [GUARD, fs.realpathSync(GUARD)];
		expect(of("git", guard).guard).toBe(true);
		expect(of("git", guard).guarded).toBe(false);
		expect(of("git", guard, { audited: true }).guarded).toBe(true);
		expect(of(GUARD, guard, { audited: true }).guarded).toBe(false);
		const named = program(path.join(tmp, "host-git-guard", "git"));
		expect(of("git", named, { audited: true })).toMatchObject({
			guard: false,
			guarded: false,
		});
	});

	it("calls a Node child audited only where it carries the audit", () => {
		const { of } = world();
		const node = [process.execPath, fs.realpathSync(process.execPath)];
		expect(of(process.execPath, node, { audited: true }).auditedNode).toBe(
			true,
		);
		expect(of("node", node, { audited: true }).auditedNode).toBe(true);
		expect(of("node", node).auditedNode).toBe(false);
		expect(of("sh", node, { audited: true }).auditedNode).toBe(false);
	});

	it("names each steering variable set or unset apart from the settled environment", () => {
		const { of } = world();
		const standing = { PATH: "/usr/bin" };
		expect(
			of("x", [], { envPairs: ["PATH=/usr/bin"], standing }).steered,
		).toEqual([]);
		expect(
			of("x", [], { envPairs: ["PATH=/a", "TAR_OPTIONS=-v"], standing })
				.steered,
		).toEqual(["PATH", "TAR_OPTIONS"]);
		expect(of("x", [], { envPairs: [], standing }).steered).toEqual(["PATH"]);
	});
});

describe("a logged verdict, read back", () => {
	it("takes one the module wrote, and no other shape", () => {
		const { sys, program, of } = world();
		const verdict = of("tar", program(path.join(sys, "tar")));
		expect(isProvenance(JSON.parse(JSON.stringify(verdict)))).toBe(true);
		expect(isProvenance(undefined)).toBe(false);
		expect(isProvenance(null)).toBe(false);
		expect(isProvenance({ ...verdict, readsNothing: "yes" })).toBe(false);
		expect(isProvenance({ ...verdict, steered: "PATH" })).toBe(false);
		const { guarded: _, ...short } = verdict;
		expect(isProvenance(short)).toBe(false);
	});
});
