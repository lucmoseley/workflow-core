// @vitest-environment node
/*
 * Pins that `hooks/hooks.json` is `self-plugin/hooks/hooks.json`'s hooks with
 * only the `scripts/` prefix rewritten to the plugin root and the marker writer
 * left out, and that the plugin and marketplace pins agree (#4, #946, #2441).
 *
 * The generator is run as a program, in process (§X3), against a throwaway
 * repo, so the fixture proves the one thing a unit cannot: the render writes
 * hooks/hooks.json and nothing else. The two cases against the real core catch
 * a self-plugin edit committed without a re-render, and a version/tag pin that
 * disagree — either ships adopters something other than what the tag names.
 * Its `--check` is a hard gate in `.husky/pre-commit` on a commit touching
 * either file, the generator, its reader or any script.
 *
 * `onFailure: "block"` sits on exactly the deny-capable `PreToolUse` hooks
 * (#2670), asserted over the real manifest and refused in a fixture either way.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderAt } from "./generate-plugin-hooks.js";
import { MARKER_WRITER, SELF_PLUGIN_HOOKS } from "./lib/core-hooks.js";
import { guardDirs, isDenyCapableIn } from "./lib/deny-capable.js";
import { guardKey } from "./lib/guard-fires.js";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "generate-plugin-hooks.js");
const CORE = path.resolve(__dirname, "..");
// Spelled in pieces: a `${…}` literal in a plain string trips Biome's template lint.
const BARE_PLUGIN_ROOT = ["$", "{CLAUDE_PLUGIN_ROOT}"].join("");
const PLUGIN_ROOT = `"${BARE_PLUGIN_ROOT}"`;
const PROJECT_DIR = ["$", "{CLAUDE_PROJECT_DIR}"].join("");

const run = (root: string, ...args: string[]) =>
	runInProcess(SCRIPT, args, {
		cwd: root,
		env: { ...process.env, CLAUDE_PROJECT_DIR: root },
	});

interface Hook {
	type: string;
	command?: string;
	args?: string[];
	timeout?: number;
	onFailure?: string;
}
type Hooks = Record<string, Array<{ matcher?: string; hooks: Hook[] }>>;

/** Every hook in `hooks`, in file order, tagged with its event. */
const flat = (hooks: Hooks) =>
	Object.entries(hooks).flatMap(([event, groups]) =>
		groups.flatMap((group) => group.hooks.map((hook) => ({ event, hook }))),
	);

const isWriter = (hook: Hook) =>
	hook.command?.includes(`/scripts/${MARKER_WRITER}`) ?? false;

describe("the committed plugin hook manifest", () => {
	it("is the current render of self-plugin/hooks/hooks.json", () => {
		const r = run(CORE, "--check");
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
	});

	// #946: the plugin's entry module, which loads both mods in an adopter.
	it("names the committed entry module under modules, beside hooks", () => {
		const manifest = JSON.parse(
			fs.readFileSync(path.join(CORE, "hooks/hooks.json"), "utf8"),
		);
		expect(Object.keys(manifest)).toEqual(["description", "hooks", "modules"]);
		expect(manifest.modules).toEqual(["./register.ts"]);
		expect(fs.existsSync(path.join(CORE, "hooks/register.ts"))).toBe(true);
	});

	it("differs from the self-plugin file only in the scripts/ prefix, entry for entry, its marker writer left out", () => {
		const hooksOf = (text: string): Hooks => JSON.parse(text).hooks;
		const source = flat(
			hooksOf(
				fs.readFileSync(
					path.join(CORE, "self-plugin/hooks/hooks.json"),
					"utf8",
				),
			),
		).filter(({ hook }) => !isWriter(hook));
		const manifest = flat(
			hooksOf(fs.readFileSync(path.join(CORE, "hooks/hooks.json"), "utf8")),
		);
		expect(manifest.map(({ event }) => event)).toEqual(
			source.map(({ event }) => event),
		);
		const pairs = source.map(({ hook }, i) => ({
			hook,
			shipped: manifest[i].hook,
		}));
		expect(pairs.length).toBeGreaterThan(0);
		for (const { hook, shipped } of pairs) {
			expect(shipped.command).toMatch(
				Array.isArray(hook.args)
					? /^\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\//
					: /^[^$]*"\$\{CLAUDE_PLUGIN_ROOT\}"\/scripts\//,
			);
			const script = shipped.command?.match(/\/scripts\/([^\s"]+)/)?.[1] ?? "";
			expect(fs.existsSync(path.join(CORE, "scripts", script))).toBe(true);
			expect({ ...shipped, command: undefined }).toEqual({
				...hook,
				command: undefined,
			});
		}
	});
});

describe("the shipped manifest's onFailure", () => {
	const isDenyCapable = isDenyCapableIn(guardDirs(CORE, CORE));
	const hooks = flat(
		JSON.parse(fs.readFileSync(path.join(CORE, "hooks/hooks.json"), "utf8"))
			.hooks,
	).map(({ event, hook }) => ({
		event,
		hook,
		guard: guardKey(hook.command ?? "", hook.args).split(" ")[0],
	}));

	it("is block on every PreToolUse hook whose script can refuse", () => {
		const capable = hooks.filter(
			({ event, guard }) => event === "PreToolUse" && isDenyCapable(guard),
		);
		expect(capable.length).toBeGreaterThan(0);
		expect(capable.filter(({ hook }) => hook.onFailure !== "block")).toEqual(
			[],
		);
		// Named by hand, so a fault in the derivation the generator shares
		// cannot pass both sides.
		expect(
			hooks.find(({ guard }) => guard === "guard-branch.sh")?.hook.onFailure,
		).toBe("block");
	});

	it("is absent from every other hook", () => {
		const rest = hooks.filter(
			({ event, guard }) => event !== "PreToolUse" || !isDenyCapable(guard),
		);
		expect(rest.length).toBeGreaterThan(0);
		expect(rest.filter(({ hook }) => "onFailure" in hook)).toEqual([]);
	});
});

describe("renderAt", () => {
	let root: string;
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-hooks-unit-"));
		fs.mkdirSync(path.dirname(path.join(root, SELF_PLUGIN_HOOKS)), {
			recursive: true,
		});
	});
	afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

	const render = (source: unknown) => {
		fs.writeFileSync(
			path.join(root, SELF_PLUGIN_HOOKS),
			JSON.stringify(source),
		);
		return JSON.parse(renderAt(root)).hooks;
	};
	/** The command `hook` ships as, rendered from a self-plugin file holding it alone. */
	const shipped = (hook: Hook): string | undefined =>
		render({ hooks: { Stop: [{ hooks: [hook] }] } }).Stop[0].hooks[0].command;

	it("rewrites both project-dir spellings to the quoted plugin root", () => {
		expect(
			shipped({
				type: "command",
				command: '"$CLAUDE_PROJECT_DIR"/scripts/a.sh',
			}),
		).toBe(`${PLUGIN_ROOT}/scripts/a.sh`);
		expect(
			shipped({
				type: "command",
				command: `node ${PROJECT_DIR}/scripts/b.js --x`,
			}),
		).toBe(`node ${PLUGIN_ROOT}/scripts/b.js --x`);
	});

	it("leaves an exec-form hook's plugin root unquoted, since no shell strips the quotes", () => {
		expect(
			shipped({
				type: "command",
				command: `${PROJECT_DIR}/scripts/c.sh`,
				args: [],
			}),
		).toBe(`${BARE_PLUGIN_ROOT}/scripts/c.sh`);
	});

	it("refuses a project-dir use it cannot read as a scripts/ prefix", () => {
		expect(() =>
			shipped({ type: "command", command: 'x --root "$CLAUDE_PROJECT_DIR"' }),
		).toThrow(/CLAUDE_PROJECT_DIR/);
	});

	it("refuses a source with no hooks", () => {
		expect(() => render({})).toThrow(/no hooks/);
	});

	describe("the self-plugin's marker writer", () => {
		const writer = (spelling: string): Hook => ({
			type: "command",
			command: `bash ${spelling}/scripts/${MARKER_WRITER}`,
		});
		const guard: Hook = {
			type: "command",
			command: '"$CLAUDE_PROJECT_DIR"/scripts/guard.sh',
		};
		const shippedGuard = () => ({
			...guard,
			command: `${PLUGIN_ROOT}/scripts/guard.sh`,
		});

		it.each([['"$CLAUDE_PROJECT_DIR"'], [PROJECT_DIR]])(
			"is left out of the adopters' render, spelt %s",
			(spelling) => {
				expect(
					render({
						hooks: {
							SessionStart: [{ hooks: [writer(spelling), guard] }],
							Stop: [{ hooks: [guard] }],
						},
					}),
				).toEqual({
					SessionStart: [{ hooks: [shippedGuard()] }],
					Stop: [{ hooks: [shippedGuard()] }],
				});
			},
		);

		it("takes its emptied matcher group and event with it, and leaves a group empty in the source", () => {
			expect(
				render({
					hooks: {
						SessionStart: [
							{ matcher: "startup", hooks: [writer(PROJECT_DIR)] },
						],
						Stop: [{ hooks: [guard] }, { matcher: "x", hooks: [] }],
					},
				}),
			).toEqual({
				Stop: [{ hooks: [shippedGuard()] }, { matcher: "x", hooks: [] }],
			});
		});

		it("is matched by its own script name only, not a longer one sharing its stem", () => {
			const stem = MARKER_WRITER.replace(/\.sh$/, "");
			const neighbour: Hook = {
				type: "command",
				command: `"$CLAUDE_PROJECT_DIR"/scripts/${stem}-sweep.sh`,
			};
			expect(shipped(neighbour)).toBe(
				`${PLUGIN_ROOT}/scripts/${stem}-sweep.sh`,
			);
		});
	});
});

describe("the plugin and marketplace manifests", () => {
	it("pin the marketplace ref to the tag the plugin version names", () => {
		const read = (f: string) =>
			JSON.parse(fs.readFileSync(path.join(CORE, f), "utf8"));
		const { version } = read(".claude-plugin/plugin.json");
		const [entry] = read(".claude-plugin/marketplace.json").plugins;
		expect(version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(entry.source.ref).toBe(`v${version}`);
	});
});

describe("a render in a fixture repo", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-hooks-"));
		fs.mkdirSync(path.join(dir, "self-plugin/hooks"), { recursive: true });
		fs.mkdirSync(path.join(dir, "scripts"));
		/* The fixture is a repo that SHIPS a plugin; without the manifest the
		 * render skips, which is the adopter case (#5). */
		fs.mkdirSync(path.join(dir, ".claude-plugin"));
		fs.writeFileSync(
			path.join(dir, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "fixture", version: "1.0.0" }),
		);
		fs.writeFileSync(
			path.join(dir, "scripts", "guard.sh"),
			"#!/bin/sh\nexit 0\n",
		);
		fs.writeFileSync(
			path.join(dir, SELF_PLUGIN_HOOKS),
			JSON.stringify({
				hooks: {
					SessionStart: [
						{
							hooks: [
								{
									type: "command",
									command: `"$CLAUDE_PROJECT_DIR"/scripts/${MARKER_WRITER}`,
								},
							],
						},
					],
					Stop: [
						{
							hooks: [
								{
									type: "command",
									command: '"$CLAUDE_PROJECT_DIR"/scripts/guard.sh',
								},
							],
						},
					],
				},
			}),
		);
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	const tree = () =>
		fs
			.readdirSync(dir, { recursive: true, withFileTypes: true })
			.filter((e) => e.isFile())
			.map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
			.sort();

	it("writes hooks/hooks.json and touches no script", () => {
		const before = fs.readFileSync(
			path.join(dir, "scripts", "guard.sh"),
			"utf8",
		);
		expect(run(dir).status).toBe(0);
		expect(tree()).toEqual([
			".claude-plugin/plugin.json",
			"hooks/hooks.json",
			"scripts/guard.sh",
			SELF_PLUGIN_HOOKS,
		]);
		expect(fs.readFileSync(path.join(dir, "scripts", "guard.sh"), "utf8")).toBe(
			before,
		);
	});

	it("names the entry module under modules only where the repo carries one", () => {
		const modules = () =>
			JSON.parse(fs.readFileSync(path.join(dir, "hooks/hooks.json"), "utf8"))
				.modules;
		expect(run(dir).status).toBe(0);
		expect(modules()).toBeUndefined();
		fs.writeFileSync(path.join(dir, "hooks/register.ts"), "");
		expect(run(dir).status).toBe(0);
		expect(modules()).toEqual(["./register.ts"]);
	});

	it("SKIPs where the repo ships no plugin to render from", () => {
		fs.rmSync(path.join(dir, ".claude-plugin"), { recursive: true });
		const r = run(dir);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("SKIP: this repo ships no plugin");
		expect(tree()).not.toContain("hooks/hooks.json");
	});

	it("renders the self-plugin file, its marker writer left out", () => {
		expect(run(dir).status).toBe(0);
		const { description, hooks } = JSON.parse(
			fs.readFileSync(path.join(dir, "hooks/hooks.json"), "utf8"),
		);
		expect(description).toContain(SELF_PLUGIN_HOOKS);
		expect(hooks).toEqual({
			Stop: [
				{
					hooks: [
						{ type: "command", command: `${PLUGIN_ROOT}/scripts/guard.sh` },
					],
				},
			],
		});
	});

	it("refuses with exit 2 a self-plugin command naming CLAUDE_PROJECT_DIR off the scripts/ prefix", () => {
		fs.writeFileSync(
			path.join(dir, SELF_PLUGIN_HOOKS),
			JSON.stringify({
				hooks: {
					Stop: [
						{
							hooks: [
								{ type: "command", command: 'x --root "$CLAUDE_PROJECT_DIR"' },
							],
						},
					],
				},
			}),
		);
		const r = run(dir, "--check");
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(
			/^generate-plugin-hooks: .*CLAUDE_PROJECT_DIR other than as a scripts\/ prefix/,
		);
		expect(tree()).not.toContain("hooks/hooks.json");
	});

	it("--check exits 1 on a stale manifest, naming the command to regenerate it, and 2 on an unreadable self-plugin file", () => {
		const stale = run(dir, "--check");
		expect(stale.status).toBe(1);
		expect(stale.stderr).toContain("hooks/hooks.json is stale");
		expect(stale.stderr).toContain("run node scripts/generate-plugin-hooks.js");
		fs.writeFileSync(path.join(dir, SELF_PLUGIN_HOOKS), "{");
		const broken = run(dir, "--check");
		expect(broken.status).toBe(2);
		expect(broken.stderr).toMatch(/^generate-plugin-hooks: .*JSON/);
	});

	describe("onFailure on a guard that can refuse", () => {
		const source = (hook: Hook) =>
			fs.writeFileSync(
				path.join(dir, SELF_PLUGIN_HOOKS),
				`${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [hook] }] } }, null, "\t")}\n`,
			);
		const sourceHook = (): Hook =>
			JSON.parse(fs.readFileSync(path.join(dir, SELF_PLUGIN_HOOKS), "utf8"))
				.hooks.PreToolUse[0].hooks[0];
		beforeEach(() => {
			fs.writeFileSync(
				path.join(dir, "scripts", "deny.sh"),
				"#!/bin/sh\ngp_deny 'no'\n",
			);
			expect(run(dir).status).toBe(0);
		});

		it("--check exits 1 naming a deny-capable PreToolUse guard that lacks it", () => {
			source({
				type: "command",
				command: '"$CLAUDE_PROJECT_DIR"/scripts/deny.sh',
			});
			const r = run(dir, "--check");
			expect(r.status).toBe(1);
			expect(r.stderr).toContain(
				'self-plugin/hooks/hooks.json: deny.sh on PreToolUse Bash lacks onFailure "block"',
			);
			expect(r.stderr).toContain("run node scripts/generate-plugin-hooks.js");
		});

		it("--check exits 1 naming a guard that cannot refuse but carries it", () => {
			source({
				type: "command",
				command: '"$CLAUDE_PROJECT_DIR"/scripts/guard.sh',
				onFailure: "block",
			});
			const r = run(dir, "--check");
			expect(r.status).toBe(1);
			expect(r.stderr).toContain(
				'guard.sh on PreToolUse Bash carries onFailure "block"',
			);
			expect(r.stderr).toContain("run node scripts/generate-plugin-hooks.js");
		});

		it("a run writes it into the self-plugin file and the render, after which --check passes", () => {
			source({
				type: "command",
				command: '"$CLAUDE_PROJECT_DIR"/scripts/deny.sh',
			});
			expect(run(dir).status).toBe(0);
			expect(sourceHook().onFailure).toBe("block");
			const shipped = JSON.parse(
				fs.readFileSync(path.join(dir, "hooks/hooks.json"), "utf8"),
			).hooks.PreToolUse[0].hooks[0];
			expect(shipped.onFailure).toBe("block");
			expect(run(dir, "--check").status).toBe(0);
		});
	});
});
