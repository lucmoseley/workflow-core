// @vitest-environment node

/* The hook shims an adopter commits (#1839). Each finds the core at run time
 * through the adopter's own scripts/lib/resolve-core.js and runs that core's
 * .husky/<hook>, so a pruned plugin version or a fresh clone never leaves a
 * hook pointing at nothing. */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HOOKS, renderHookShim } from "./lib/adopter-skeleton";
import { newRepo, registerTempCleanup } from "./lib/precommit-gate-harness";

const temps = registerTempCleanup();
const ROOT = path.join(__dirname, "..");
const KEY = "workflow-core@wc";

/** A fake core at `dir`: plugin.json at `version`, and a body for every hook
 * that appends the root it was handed, then its stdin, to `log`. */
function fakeCore(dir: string, version: string, log: string) {
	fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".claude-plugin", "plugin.json"),
		JSON.stringify({ name: "workflow-core", version }),
	);
	fs.mkdirSync(path.join(dir, ".husky"), { recursive: true });
	for (const hook of HOOKS)
		fs.writeFileSync(
			path.join(dir, ".husky", hook),
			`printf '%s %s\\n' ${hook} "$WFC_PLUGIN_ROOT" >> '${log}'\n${
				hook === "pre-push" ? `cat >> '${log}'\n` : ""
			}`,
		);
	return dir;
}

/** The prelude line sourcing hook-root.sh, which every core hook carries. */
const sourcesHookRoot = (text: string) =>
	text.split("\n").find((line) => line.includes("/scripts/lib/hook-root.sh"));
const HOOK_ROOT_LINE = sourcesHookRoot(
	fs.readFileSync(path.join(ROOT, ".husky", "pre-commit"), "utf8"),
);

/** A fake core whose every hook runs the real core's hook-root prelude. */
function rootCore(dir: string, log: string) {
	fakeCore(dir, "1.0.0", log);
	fs.mkdirSync(path.join(dir, "scripts", "lib"), { recursive: true });
	fs.copyFileSync(
		path.join(ROOT, "scripts", "lib", "hook-root.sh"),
		path.join(dir, "scripts", "lib", "hook-root.sh"),
	);
	for (const hook of HOOKS) {
		fs.writeFileSync(
			path.join(dir, ".husky", hook),
			`${HOOK_ROOT_LINE}\nprintf '%s %s\\n' ${hook} "\${CLAUDE_PROJECT_DIR-unset}" >> '${log}'\n${
				hook === "pre-commit"
					? `node '${ROOT}/scripts/lib/workflow-core-config.js' command check_staged >> '${log}' 2>&1 || :\n`
					: ""
			}${hook === "pre-push" ? "cat >/dev/null\n" : ""}`,
		);
	}
	return dir;
}

/** The adopter, pinned at v1.0.0, carrying what init writes for the hooks. */
function buildAdopter() {
	const { root: made, git } = newRepo("hook-shim-", temps);
	const root = fs.realpathSync(made);
	const work = fs.mkdtempSync(`${root}-work-`);
	temps.push(work);
	const log = path.join(work, "hooks.log");
	const config = path.join(work, "config");

	fs.mkdirSync(path.join(root, ".claude"));
	fs.mkdirSync(path.join(root, ".husky"));
	fs.writeFileSync(
		path.join(root, ".claude", "settings.json"),
		JSON.stringify({
			enabledPlugins: { [KEY]: true },
			extraKnownMarketplaces: {
				wc: { source: { source: "url", url: "u", ref: "v1.0.0" } },
			},
		}),
	);
	for (const hook of HOOKS)
		fs.writeFileSync(path.join(root, ".husky", hook), renderHookShim(hook), {
			mode: 0o755,
		});
	fs.mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
	fs.copyFileSync(
		path.join(ROOT, "scripts", "lib", "resolve-core.js"),
		path.join(root, "scripts", "lib", "resolve-core.js"),
	);
	git("config", "core.hooksPath", ".husky");
	git("add", "--all");
	git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "skeleton");

	/** Records `installPath` as this project's install. */
	const record = (installPath: string) => {
		fs.mkdirSync(path.join(config, "plugins"), { recursive: true });
		fs.writeFileSync(
			path.join(config, "plugins", "installed_plugins.json"),
			JSON.stringify({
				plugins: { [KEY]: [{ projectPath: root, installPath }] },
			}),
		);
	};
	const env = (extra: Record<string, string> = {}) => {
		const {
			HUSKY: _h,
			WORKFLOW_CORE_DIR: _d,
			WORKFLOW_CORE_CHECKOUT: _c,
			...inherited
		} = process.env;
		return { ...inherited, CLAUDE_CONFIG_DIR: config, ...extra };
	};
	let n = 0;
	/** A commit from `cwd`, with what landed and what the hooks logged. */
	const commit = (cwd = root, extra: Record<string, string> = {}) => {
		fs.writeFileSync(path.join(cwd, `f${++n}.txt`), `${n}\n`);
		const readHead = () =>
			execFileSync("git", ["rev-parse", "HEAD"], { cwd }).toString();
		const before = readHead();
		fs.rmSync(log, { force: true });
		execFileSync("git", ["add", "--", `f${n}.txt`], { cwd });
		const r = spawnSync("git", ["commit", "-qm", `c${n}`], {
			cwd,
			encoding: "utf8",
			env: env(extra),
		});
		return {
			status: r.status,
			stderr: r.stderr,
			landed: readHead() !== before,
			log: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "",
		};
	};
	return { root, git, work, log, record, env, commit };
}

/** The tracked files the shim's run left changed. */
const readStatus = (root: string) =>
	execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
		cwd: root,
	}).toString();

/**
 * Commits at N, moves the install record to N+1 and deletes N, then commits
 * again: the deleted-version scenario, which `shim` may mutate.
 */
function survivesPrune(shim?: (text: string, installed: string) => string) {
	const a = buildAdopter();
	const installed = fakeCore(
		path.join(a.work, "cache", "1.0.0"),
		"1.0.0",
		a.log,
	);
	const next = fakeCore(path.join(a.work, "cache", "1.0.1"), "1.0.1", a.log);
	if (shim) {
		const at = path.join(a.root, ".husky", "pre-commit");
		fs.writeFileSync(at, shim(fs.readFileSync(at, "utf8"), installed));
		a.git("add", "--", ".husky/pre-commit");
		a.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "mutant");
	}
	a.record(installed);
	const first = a.commit();
	a.record(next);
	fs.rmSync(installed, { recursive: true });
	const second = a.commit();
	return { a, installed, next, first, second };
}

describe("an adopter's hook shims (#1839)", () => {
	it("commit through the recorded install, and through the next one once it is moved and the old version deleted, with no tracked file changed", () => {
		const { a, installed, next, first, second } = survivesPrune();
		expect(first.landed).toBe(true);
		expect(first.log).toContain(`pre-commit ${installed}\n`);
		expect(first.log).toContain(`commit-msg ${installed}\n`);
		expect(second.landed).toBe(true);
		expect(second.log).toContain(`pre-commit ${next}\n`);
		expect(second.log).not.toContain(`${installed}\n`);
		expect(readStatus(a.root)).toBe("");
	});

	it("fails the deleted-version case once the shim names a fixed path instead of resolving (mutation)", () => {
		const { second } = survivesPrune((text, installed) => {
			const mutant = text.replace(
				/WFC_PLUGIN_ROOT="\$\(node -e '[\s\S]*?\n\}/,
				`WFC_PLUGIN_ROOT="${installed}"`,
			);
			expect(mutant).not.toBe(text);
			return mutant;
		});
		expect(second.landed).toBe(false);
	});

	it("refuses the commit where nothing resolves, naming the pin, the missing record and both fixes", () => {
		const a = buildAdopter();
		const r = a.commit();
		expect(r.landed).toBe(false);
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain("no workflow-core directory for pin v1.0.0");
		expect(r.stderr).toContain(
			`installed_plugins.json records no ${KEY} install for ${a.root}`,
		);
		expect(r.stderr).toContain("pre-commit: refused");
		expect(r.stderr).toContain("open a Claude Code session in this repo");
		expect(r.stderr).toContain("set WORKFLOW_CORE_DIR");
	});

	it("runs the core WORKFLOW_CORE_DIR names over the install record", () => {
		const a = buildAdopter();
		a.record(fakeCore(path.join(a.work, "cache", "1.0.0"), "1.0.0", a.log));
		const checkout = fakeCore(path.join(a.work, "checkout"), "9.9.9", a.log);
		const r = a.commit(a.root, { WORKFLOW_CORE_DIR: checkout });
		expect(r.landed).toBe(true);
		expect(r.log).toContain(`pre-commit ${checkout}\n`);
	});

	it("resolves through the main checkout's install record from a linked worktree", () => {
		const a = buildAdopter();
		const installed = fakeCore(
			path.join(a.work, "cache", "1.0.0"),
			"1.0.0",
			a.log,
		);
		a.record(installed);
		const tree = path.join(a.work, "tree");
		a.git("worktree", "add", "-q", "-b", "side", tree);
		const r = a.commit(tree);
		expect(r.landed).toBe(true);
		expect(r.log).toContain(`pre-commit ${installed}\n`);
	});

	it("hands the core the committed repo as CLAUDE_PROJECT_DIR where an inherited one names another repo (#3307)", () => {
		const a = buildAdopter();
		const core = rootCore(path.join(a.work, "core"), a.log);
		const { root: other } = newRepo("hook-shim-other-", temps);
		const config = (root: string, cmd: string) => {
			fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
			fs.writeFileSync(
				path.join(root, ".claude", "workflow-core.json"),
				JSON.stringify({ founder: "f", commands: { check_staged: cmd } }),
			);
		};
		config(other, "npm run other-repo-gate");
		config(a.root, "npm run adopter-gate");
		const r = a.commit(a.root, {
			WORKFLOW_CORE_DIR: core,
			CLAUDE_PROJECT_DIR: other,
		});
		expect(r.landed).toBe(true);
		expect(r.log).toContain(`pre-commit ${a.root}\n`);
		expect(r.log).toContain(`commit-msg ${a.root}\n`);
		expect(r.log).toContain("npm run adopter-gate");
		expect(r.log).not.toContain(other);
		expect(r.log).not.toContain("other-repo-gate");
	});

	it("keeps an inherited CLAUDE_PROJECT_DIR naming the main tree for a commit in a linked worktree (#3307)", () => {
		const a = buildAdopter();
		const core = rootCore(path.join(a.work, "core"), a.log);
		const tree = path.join(a.work, "tree");
		a.git("worktree", "add", "-q", "-b", "side", tree);
		const r = a.commit(tree, {
			WORKFLOW_CORE_DIR: core,
			CLAUDE_PROJECT_DIR: a.root,
		});
		expect(r.landed).toBe(true);
		expect(r.log).toContain(`pre-commit ${a.root}\n`);
		expect(r.log).not.toContain(tree);
	});

	it("hands the committed repo where CLAUDE_PROJECT_DIR is empty (#3307)", () => {
		const a = buildAdopter();
		const core = rootCore(path.join(a.work, "core"), a.log);
		const r = a.commit(a.root, {
			WORKFLOW_CORE_DIR: core,
			CLAUDE_PROJECT_DIR: "",
		});
		expect(r.log).toContain(`pre-commit ${a.root}\n`);
	});

	it("unsets an inherited CLAUDE_PROJECT_DIR naming another repo for a push from a bare repository (#3307)", () => {
		const a = buildAdopter();
		const core = rootCore(path.join(a.work, "core"), a.log);
		const { root: other } = newRepo("hook-shim-other-", temps);
		const bare = path.join(a.work, "bare.git");
		execFileSync("git", ["clone", "-q", "--bare", a.root, bare], {
			cwd: a.work,
		});
		execFileSync(
			"git",
			["config", "core.hooksPath", path.join(core, ".husky")],
			{
				cwd: bare,
			},
		);
		fs.chmodSync(path.join(core, ".husky", "pre-push"), 0o755);
		const remote = path.join(a.work, "remote.git");
		execFileSync("git", ["init", "-q", "--bare", remote], { cwd: a.work });
		const r = spawnSync("git", ["push", "-q", remote, "HEAD:refs/heads/main"], {
			cwd: bare,
			encoding: "utf8",
			env: a.env({ CLAUDE_PROJECT_DIR: other }),
		});
		expect(r.status).toBe(0);
		expect(fs.readFileSync(a.log, "utf8")).toBe("pre-push unset\n");
	});

	it("hands pre-push its refs on stdin", () => {
		const a = buildAdopter();
		const installed = fakeCore(
			path.join(a.work, "cache", "1.0.0"),
			"1.0.0",
			a.log,
		);
		a.record(installed);
		const remote = path.join(a.work, "remote.git");
		execFileSync("git", ["init", "-q", "--bare", remote], { cwd: a.work });
		const r = spawnSync("git", ["push", "-q", remote, "HEAD:refs/heads/main"], {
			cwd: a.root,
			encoding: "utf8",
			env: a.env(),
		});
		expect(r.status).toBe(0);
		const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: a.root })
			.toString()
			.trim();
		expect(fs.readFileSync(a.log, "utf8")).toContain(
			`pre-push ${installed}\nHEAD ${sha} refs/heads/main `,
		);
	});

	it("lets a push through where nothing resolves, as pre-push refuses none on a checker that cannot run (#1444)", () => {
		const a = buildAdopter();
		const remote = path.join(a.work, "remote.git");
		execFileSync("git", ["init", "-q", "--bare", remote], { cwd: a.work });
		const r = spawnSync("git", ["push", "-q", remote, "HEAD:refs/heads/main"], {
			cwd: a.root,
			encoding: "utf8",
			env: a.env(),
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(
			"pre-push: workflow-core's pre-push checks did not run.",
		);
		expect(r.stderr).toContain("set WORKFLOW_CORE_DIR");
	});
});

/* The spellings that reach a script in the host's own tree, which an adopter
 * running the hook from the plugin does not have. Each must go through
 * `${WFC_PLUGIN_ROOT:-…}` instead (#142, #442, #1614). */
const HOST_ONLY = [
	/\.\s+\.\/scripts\//,
	/\b(?:node|bash|sh|python3)\s+scripts\//,
	/"\$(?:root|toplevel)\/scripts\//,
	/"\$here\/\.\.\/scripts\//,
];

describe("the core hooks an adopter's shims run (#1839)", () => {
	/* Listed rather than taken from HOOKS, so a change to any hook selects this
	 * file (base §X10); the first case holds the listing to HOOKS. */
	const huskyHooks = fs
		.readdirSync(path.join(ROOT, ".husky"))
		.filter((h) => HOOKS.includes(h));

	it("lists every hook an adopter shims", () => {
		expect([...huskyHooks].sort()).toEqual([...HOOKS].sort());
	});

	it.each(huskyHooks)("%s sources hook-root.sh (#3307)", (hook) => {
		expect(HOOK_ROOT_LINE).toBeDefined();
		expect(
			sourcesHookRoot(fs.readFileSync(path.join(ROOT, ".husky", hook), "utf8")),
		).toBe(HOOK_ROOT_LINE);
	});

	it.each(huskyHooks)(
		"%s reaches no script by a host-only spelling",
		(hook) => {
			const code = fs
				.readFileSync(path.join(ROOT, ".husky", hook), "utf8")
				.split("\n")
				.filter((line) => !/^\s*#/.test(line));
			expect(
				code.filter((line) => HOST_ONLY.some((re) => re.test(line))),
			).toEqual([]);
		},
	);
});

describe("the shim text (#1839)", () => {
	it.each(HOOKS)(
		"%s carries the IMPLICIT / JUSTIFIED / DEFEAT header first",
		(hook) => {
			const header = renderHookShim(hook)
				.split("\n")
				.slice(1)
				.filter((_, i, lines) =>
					lines.slice(0, i + 1).every((l) => l.startsWith("#")),
				);
			expect(header.find((l) => l.startsWith("# IMPLICIT:  "))).toBeDefined();
			expect(
				header.find((l) => /^# JUSTIFIED: fail-safe — \S/.test(l)),
			).toBeDefined();
			expect(header.find((l) => l.startsWith("# DEFEAT:    "))).toBeDefined();
		},
	);

	it("passes shellcheck at --severity=style, as an adopter's pre-commit checks its hooks", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shim-sc-"));
		temps.push(dir);
		const files = HOOKS.map((hook) => {
			const at = path.join(dir, hook);
			fs.writeFileSync(at, renderHookShim(hook));
			return at;
		});
		const r = spawnSync("shellcheck", ["--severity=style", ...files], {
			encoding: "utf8",
		});
		expect(r.error, "shellcheck is not installed").toBeUndefined();
		expect(r.stdout).toBe("");
		expect(r.status).toBe(0);
	});
});
