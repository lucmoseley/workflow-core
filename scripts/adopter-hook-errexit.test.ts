// @vitest-environment node

/* Errexit in the hooks an adopter runs (#745). The core runs its hooks through
 * husky's `.husky/_` wrapper, `sh -e`; init-adopter points an adopter's
 * core.hooksPath at `.husky` itself, so git runs each hook file directly. That
 * file is a shim (#1839), which runs the core's hook under `sh -e`, and the
 * core's hook carries its own `set -e` besides.
 *
 * The refusal cases commit for real in a throwaway adopter-shaped repo
 * (`buildAdopter`), with every gate a stub script exiting its own
 * STUB_EXIT_<name>, because only git running the hook file directly shows
 * whether a failing gate stops the commit.
 *
 * Loosen a case and an adopter's hook can print a gate's refusal while the
 * commit lands anyway, every core gate passing silently in every adopter. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HOOKS, renderHookShim } from "./lib/adopter-skeleton";
import {
	newRepo,
	registerTempCleanup,
	stagedRepo,
} from "./lib/precommit-gate-harness";
import { HOOK, LIB, ROOT } from "./lib/precommit-gate-testkit";

const temps = registerTempCleanup();

const SHEBANG = "#!/usr/bin/env sh";
const ERREXIT = /^set -e(\s|$)/;

/** Every line that is not a comment or blank, in file order. */
const parseCodeLines = (text: string) =>
	text.split("\n").filter((l) => !/^\s*(#|$)/.test(l));

const huskyHooks = fs
	.readdirSync(path.join(ROOT, ".husky"), { withFileTypes: true })
	.filter((e) => e.isFile() && !e.name.endsWith(".local"))
	.map((e) => e.name)
	.sort();

describe("every core hook carries its own errexit (#745)", () => {
	it("installs every hook file in .husky, so none escapes the check", () => {
		expect([...HOOKS].sort()).toEqual(huskyHooks);
	});

	it.each(huskyHooks)(
		"%s starts with a shebang and runs `set -e` first",
		(h) => {
			const text = fs.readFileSync(path.join(ROOT, ".husky", h), "utf8");
			expect(text.split("\n")[0]).toBe(SHEBANG);
			expect(parseCodeLines(text)[0]).toMatch(ERREXIT);
		},
	);

	it.each(HOOKS)("%s's shim runs the core's under `sh -e`", (h) => {
		const text = renderHookShim(h);
		expect(text.split("\n")[0]).toBe(SHEBANG);
		expect(parseCodeLines(text).at(-1)).toBe(
			`exec sh -e "$WFC_PLUGIN_ROOT/.husky/${h}" "$@"`,
		);
	});
});

describe("an adopter's pre-push under `set -e` (#745)", () => {
	it("still refuses no push when its plugin holds none of the scripts", () => {
		const { root } = newRepo("hook-errexit-push-", temps);
		const r = spawnSync("sh", ["-e", path.join(ROOT, ".husky", "pre-push")], {
			cwd: root,
			input: "",
			encoding: "utf8",
			env: { ...process.env, WFC_PLUGIN_ROOT: path.join(root, "gone") },
		});
		expect(r.stderr).toContain("Cannot find module");
		expect(r.status).toBe(0);
	});
});

/* An adopter-shaped repo: core.hooksPath = .husky, no .husky/_, the pre-commit
 * shim as init writes it, and a plugin root, which WORKFLOW_CORE_DIR names,
 * holding the core's pre-commit and a stub for every script it calls, each
 * exiting its STUB_EXIT_<name> or 0. */
function buildAdopter(opts: { local?: string; errexit?: boolean }) {
	const { root, git } = stagedRepo("hook-errexit-", temps, {}, {});
	git("branch", "-M", "main");

	const plugin = fs.mkdtempSync(`${root}-plugin-`);
	temps.push(plugin);
	let hook = HOOK;
	if (opts.errexit === false) {
		expect(hook).toMatch(/^set -e.*$/m);
		hook = hook.replace(/^set -e.*$/m, "");
	}
	for (const [, rel, ext] of hook.matchAll(
		/\{WFC_PLUGIN_ROOT:-[^}]*\}"?\/(scripts\/[\w./-]+)\.(js|sh)/g,
	)) {
		const abs = path.join(plugin, `${rel}.${ext}`);
		const exitVar = `STUB_EXIT_${path.basename(rel).replace(/-/g, "_")}`;
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(
			abs,
			ext === "sh"
				? ":\n"
				: `const c = Number(process.env.${exitVar} ?? 0);\nif (c) console.error("STUB ${rel}.${ext} exit " + c);\nprocess.exit(c);\n`,
		);
	}
	fs.writeFileSync(path.join(plugin, "scripts/lib/precommit-gate.sh"), LIB);
	fs.mkdirSync(path.join(plugin, ".husky"));
	fs.writeFileSync(path.join(plugin, ".husky", "pre-commit"), hook);

	fs.mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
	fs.copyFileSync(
		path.join(ROOT, "scripts", "lib", "resolve-core.js"),
		path.join(root, "scripts", "lib", "resolve-core.js"),
	);
	fs.mkdirSync(path.join(root, ".husky"));
	fs.writeFileSync(
		path.join(root, ".husky", "pre-commit"),
		renderHookShim("pre-commit"),
		{ mode: 0o755 },
	);
	if (opts.local !== undefined)
		fs.writeFileSync(path.join(root, ".husky", "pre-commit.local"), opts.local);
	git("config", "core.hooksPath", ".husky");
	fs.writeFileSync(path.join(root, "work.txt"), "work\n");
	git("add", "--", "work.txt");
	return { root, git, plugin };
}

function tryCommit(
	{ root, plugin }: { root: string; plugin: string },
	env: Record<string, string> = {},
) {
	const readHead = () =>
		spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
			.stdout;
	const before = readHead();
	const { HUSKY: _husky, ...inherited } = process.env;
	const r = spawnSync("git", ["commit", "-qm", "work"], {
		cwd: root,
		encoding: "utf8",
		env: {
			...inherited,
			WFC_GITLEAKS: "true",
			WORKFLOW_CORE_DIR: plugin,
			...env,
		},
	});
	return {
		status: r.status,
		landed: readHead() !== before,
		out: `${r.stdout}\n${r.stderr}`,
	};
}

const BROKEN = { STUB_EXIT_check_skill_body_size: "2" };

describe("an adopter's pre-commit refuses on a gate that only fails (#745)", () => {
	it("lands a commit every stub gate passes", () => {
		const r = tryCommit(buildAdopter({}));
		expect(r.out).toBe("\n");
		expect(r.landed).toBe(true);
	});

	it("refuses on check-skill-body-size's BROKEN, exit 2 with no `|| exit`", () => {
		const r = tryCommit(buildAdopter({}), BROKEN);
		expect(r.out).toContain("STUB scripts/check-skill-body-size.js exit 2");
		expect(r.status).not.toBe(0);
		expect(r.landed).toBe(false);
	});

	it("still refuses it once the core's `set -e` is removed, the shim's `sh -e` holding", () => {
		const r = tryCommit(buildAdopter({ errexit: false }), BROKEN);
		expect(r.landed).toBe(false);
	});

	it("refuses on a pre-commit.local whose last command fails, passing its output through", () => {
		const r = tryCommit(
			buildAdopter({ local: 'echo "local ran" >&2\nfalse\n' }),
		);
		expect(r.out).toContain("local ran");
		expect(r.status).not.toBe(0);
		expect(r.landed).toBe(false);
	});

	it("still refuses that commit once the core's `set -e` is removed", () => {
		const r = tryCommit(buildAdopter({ local: "false\n", errexit: false }));
		expect(r.landed).toBe(false);
	});
});
