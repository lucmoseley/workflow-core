// @vitest-environment node
/*
 * Pins that check-registrations.js holds a host repo's own hooks, guards and
 * checkers to the core's registration rule against .claude/registrations.json
 * and .claude/guard-fire-needles.json, and under --against refuses only what
 * a commit adds (#1456). In the core, which carries the self-plugin's file, it
 * holds .claude/settings.json to the self-plugin canary alone (#2447).
 *
 * Against a fabricated repo in a throwaway git repo, never this one.
 * .husky/pre-commit refuses on this checker, so loosening a case here loosens
 * that gate.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyRegistry } from "./lib/registrations.js";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-registrations.js");
// A guard the plugin's own needles key, read live so a port that drops one
// never strands the fixture (#2996).
const CORE_GUARD = Object.keys(
	JSON.parse(
		fs.readFileSync(path.resolve(__dirname, "guard-fire-needles.json"), "utf8"),
	).guards,
).find((k) => k.startsWith("guard-"));
if (!CORE_GUARD) throw new Error("guard-fire-needles.json keys no guard-*");

let root: string;
let hooks: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: root, stdio: "pipe" });

function write(rel: string, body: string): void {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), body);
}

const json = (value: unknown) => `${JSON.stringify(value, null, "\t")}\n`;

const settings = (...scripts: string[]) =>
	json({
		hooks: {
			PreToolUse: scripts.map((s) => ({
				matcher: "Bash",
				hooks: [
					{ command: `node "$CLAUDE_PROJECT_DIR"/scripts/${s}`, timeout: 10 },
				],
			})),
		},
	});

const CANARY = '"$CLAUDE_PROJECT_DIR"/scripts/self-plugin-canary.sh';

const row = (script: string, over: Record<string, unknown> = {}) => ({
	event: "PreToolUse",
	id: `scripts/${script}`,
	matcher: "Bash",
	covers: ["Bash"],
	...over,
});

const registry = (over: Record<string, unknown> = {}) =>
	json({ hooks: [], registeredElsewhere: {}, calledElsewhere: {}, ...over });

const run = (...args: string[]) => {
	const r = runInProcess(SCRIPT, args, {
		cwd: root,
		env: { ...process.env, GITHUB_ACTIONS: "", CLAUDE_PROJECT_DIR: root },
	});
	return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

/** An adopter whose one guard and one checker are fully registered. */
function registeredAdopter(): void {
	write(".claude/settings.json", settings("guard-a.sh"));
	write(".claude/registrations.json", registry({ hooks: [row("guard-a.sh")] }));
	write(
		".claude/guard-fire-needles.json",
		json({ guards: { "guard-a.sh": { needles: [] } } }),
	);
	write("scripts/guard-a.sh", "#!/usr/bin/env bash\n");
	write("scripts/guard-a.test.js", "// covered\n");
	write("scripts/check-b.js", "// a checker\n");
	write("scripts/check-b.test.py", "# covered\n");
	write(".husky/pre-commit", "node scripts/check-b.js\n");
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "registrations-"));
	hooks = fs.mkdtempSync(path.join(os.tmpdir(), "registrations-hooks-"));
	git("init", "-q", "-b", "main");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	git("config", "core.hooksPath", hooks);
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(hooks, { recursive: true, force: true });
});

describe("check-registrations", () => {
	it("passes an adopter whose every member is registered, tested and counted", () => {
		registeredAdopter();
		const r = run();
		expect(r.out).toContain("OK: every hook, guard and checker");
		expect(r.status).toBe(0);
	});

	it("passes the empty registry init seeds", () => {
		write(".claude/registrations.json", emptyRegistry());
		expect(run().status).toBe(0);
	});

	it("names an unpinned hook with the row to paste", () => {
		registeredAdopter();
		write(".claude/registrations.json", registry());
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			'has no `hooks` row — add {"event":"PreToolUse","id":"scripts/guard-a.sh","matcher":"Bash","covers":["Bash"]}',
		);
	});

	it("names a row whose matcher, covers or timeout drifted from the registration", () => {
		registeredAdopter();
		write(
			".claude/registrations.json",
			registry({
				hooks: [
					row("guard-a.sh", {
						matcher: "Read",
						covers: ["Read"],
						unbounded: true,
					}),
				],
			}),
		);
		const r = run();
		expect(r.out).toContain('pins matcher "Read"');
		expect(r.out).toContain("says it covers Read");
		expect(r.out).toContain("says unbounded");
	});

	it("names a row that matches no registration", () => {
		registeredAdopter();
		write(
			".claude/registrations.json",
			registry({ hooks: [row("guard-a.sh"), row("guard-gone.sh")] }),
		);
		expect(run().out).toContain("matches no registration");
	});

	it("names an unwired guard and an untested one, and takes a registeredElsewhere key", () => {
		registeredAdopter();
		write("scripts/guard-c.sh", "#!/usr/bin/env bash\n");
		const r = run();
		expect(r.out).toContain("scripts/guard-c.sh is run by no hook");
		expect(r.out).toContain("scripts/guard-c.sh has no sibling test");
		write(
			".claude/registrations.json",
			registry({
				hooks: [row("guard-a.sh")],
				registeredElsewhere: { "guard-c.sh": "run by guard-a.sh" },
			}),
		);
		write("scripts/guard-c.test.ts", "// covered\n");
		expect(run().status).toBe(0);
	});

	it("names an uncalled checker, ignoring a mention in a comment, and takes a calledElsewhere key", () => {
		registeredAdopter();
		write(".husky/pre-commit", "# node scripts/check-b.js, someday\n");
		expect(run().out).toContain("scripts/check-b.js is run by no husky hook");
		write(
			".claude/registrations.json",
			registry({
				hooks: [row("guard-a.sh")],
				calledElsewhere: { "check-b.js": "hand-run before a release" },
			}),
		);
		expect(run().status).toBe(0);
	});

	it("never counts a check-<name>.test.js or .spec.js as a checker (#2869)", () => {
		registeredAdopter();
		write("scripts/check-b.test.js", "// a second test\n");
		write("scripts/check-b.spec.js", "// a third test\n");
		const r = run();
		expect(r.out).not.toContain("check-b.test");
		expect(r.out).not.toContain("check-b.spec");
		expect(r.status).toBe(0);
	});

	it("counts a guard-<name>.test.sh as a guard, JS_TEST_FILE naming no shell test (#2869, #3012)", () => {
		registeredAdopter();
		write("scripts/guard-c.test.sh", "#!/usr/bin/env bash\n");
		expect(run().out).toContain("scripts/guard-c.test.sh is run by no hook");
	});

	it("names a calledElsewhere key with no checker and an allowlist key with no reason", () => {
		registeredAdopter();
		write(
			".claude/registrations.json",
			registry({
				hooks: [row("guard-a.sh")],
				calledElsewhere: { "check-gone.js": "retired", "check-b.js": " " },
			}),
		);
		const r = run();
		expect(r.out).toContain("`calledElsewhere` names check-gone.js");
		expect(r.out).toContain("keys check-b.js with no reason");
	});

	it("names an uncounted hook and a stale needle key, and takes a core guard's needle as counted", () => {
		registeredAdopter();
		write(".claude/settings.json", settings("guard-a.sh", CORE_GUARD));
		write(
			".claude/registrations.json",
			registry({ hooks: [row("guard-a.sh"), row(CORE_GUARD)] }),
		);
		write(
			".claude/guard-fire-needles.json",
			json({ guards: { "guard-gone.sh": { needles: [] } } }),
		);
		const r = run();
		expect(r.out).toContain(
			"guard-a.sh is run by a .claude/settings.json hook",
		);
		expect(r.out).toContain("keys guard-gone.sh, which no");
		expect(r.out).not.toContain(`${CORE_GUARD} is run by`);
	});

	it("reads an absent registry as empty, saying how to seed it", () => {
		registeredAdopter();
		fs.rmSync(path.join(root, ".claude/registrations.json"));
		const r = run();
		expect(r.out).toContain(".claude/registrations.json is absent");
		expect(r.out).toContain("`upgrade` seeds it empty");
	});

	it("is BROKEN on a registry of the wrong shape", () => {
		write(".claude/registrations.json", json({ hooks: {} }));
		const r = run();
		expect(r.status).toBe(2);
		expect(r.out).toContain("`hooks` is not an array");
	});

	it("is BROKEN on a settings file whose hooks are not an object, naming it (#2442)", () => {
		registeredAdopter();
		write(".claude/settings.json", json({ hooks: [] }));
		const r = run();
		expect(r.status).toBe(2);
		expect(r.out).toContain(".claude/settings.json at");
		expect(r.out).toContain("carries no hooks object");
	});

	it("judges a repo carrying the self-plugin's file as the core", () => {
		write(
			".claude/settings.json",
			json({
				hooks: {
					PreToolUse: [
						{
							hooks: [
								{
									command: CANARY,
								},
							],
						},
					],
				},
			}),
		);
		write("self-plugin/hooks/hooks.json", settings("guard-a.sh"));
		write("scripts/guard-a.sh", "#!/usr/bin/env bash\n");
		const r = run();
		expect(r.out).toContain("holds its registries in its own tests");
		expect(r.status).toBe(0);
	});

	describe("at the core: settings keeps the canary alone (#2447)", () => {
		const group = (command: string, matcher?: string) => ({
			...(matcher === undefined ? {} : { matcher }),
			hooks: [{ type: "command", command }],
		});

		function core(settingsHooks: object, pluginHooks: object): void {
			write(".claude/settings.json", json({ hooks: settingsHooks }));
			write("self-plugin/hooks/hooks.json", json({ hooks: pluginHooks }));
		}

		const selfHooks = { PreToolUse: [group("guard-a.sh", "Bash")] };

		it("passes settings carrying the canary alone", () => {
			core({ PreToolUse: [group(CANARY)] }, selfHooks);
			const r = run();
			expect(r.out).toContain("registers the self-plugin canary alone");
			expect(r.status).toBe(0);
		});

		it("refuses any settings hook besides the canary, naming where it belongs", () => {
			core(
				{ PreToolUse: [group(CANARY)], Stop: [group("stop.sh")] },
				selfHooks,
			);
			const r = run();
			expect(r.status).toBe(1);
			expect(r.out).toContain(
				".claude/settings.json registers Stop `stop.sh`, but it keeps only the self-plugin canary — register the hook in self-plugin/hooks/hooks.json",
			);
		});

		it("refuses the canary under a matcher", () => {
			core({ PreToolUse: [group(CANARY, "Bash")] }, selfHooks);
			const r = run();
			expect(r.status).toBe(1);
			expect(r.out).toContain("has no PreToolUse hook, with no matcher");
		});

		it("refuses the canary on another event", () => {
			core({ Stop: [group(CANARY)] }, selfHooks);
			const r = run();
			expect(r.status).toBe(1);
			expect(r.out).toContain("registers Stop");
		});

		it("refuses a self-plugin command registered in settings too", () => {
			core(
				{ PreToolUse: [group(CANARY), group("guard-a.sh", "Bash")] },
				selfHooks,
			);
			const r = run();
			expect(r.status).toBe(1);
			expect(r.out).toContain(
				"registers PreToolUse `guard-a.sh`, but it keeps only the self-plugin canary",
			);
		});

		it("is BROKEN on a settings event that is not a list, naming it (#2633)", () => {
			core({ PreToolUse: group(CANARY) }, selfHooks);
			const r = run();
			expect(r.status).toBe(2);
			expect(r.out).toContain(
				".claude/settings.json at " +
					root +
					": its PreToolUse hooks are not a list",
			);
		});

		it("refuses the canary registered in the self-plugin as well", () => {
			core({ PreToolUse: [group(CANARY)] }, { PreToolUse: [group(CANARY)] });
			const r = run();
			expect(r.status).toBe(1);
			expect(r.out).toContain(
				"self-plugin/hooks/hooks.json registers the canary",
			);
		});

		it("refuses only the double registration a commit adds under --against HEAD", () => {
			core({ PreToolUse: [group(CANARY)] }, selfHooks);
			git("add", "-A");
			git("commit", "-qm", "the core, migrated");
			expect(run("--against", "HEAD").status).toBe(0);

			core(
				{ PreToolUse: [group(CANARY)], Stop: [group("stop.sh")] },
				selfHooks,
			);
			git("add", "-A");
			const r = run("--against", "HEAD");
			expect(r.status).toBe(1);
			expect(r.out).toContain("registers Stop `stop.sh`");
		});
	});

	describe("--against HEAD", () => {
		it("lets an adopter's inherited gaps through and refuses one the commit adds", () => {
			registeredAdopter();
			write("scripts/guard-old.sh", "#!/usr/bin/env bash\n");
			git("add", "-A");
			git("commit", "-qm", "an adopter with one inherited gap");
			expect(run("--against", "HEAD").status).toBe(0);

			write("scripts/check-new.js", "// new\n");
			git("add", "scripts/check-new.js");
			const refused = run("--against", "HEAD");
			expect(refused.status).toBe(1);
			expect(refused.out).toContain("scripts/check-new.js");
			expect(refused.out).not.toContain("guard-old.sh");
		});

		it("lets the commit seeding the registry through over every inherited gap", () => {
			registeredAdopter();
			fs.rmSync(path.join(root, ".claude/registrations.json"));
			git("add", "-A");
			git("commit", "-qm", "unseeded");
			write(".claude/registrations.json", emptyRegistry());
			git("add", ".claude/registrations.json");
			expect(run("--against", "HEAD").status).toBe(0);
		});
	});
});

describe("the row an unpinned hook's finding suggests", () => {
	const suggested = (event: string, entry: Record<string, unknown>) => {
		write(".claude/settings.json", json({ hooks: { [event]: [entry] } }));
		write(".claude/registrations.json", registry());
		return run().out;
	};

	it("keys a guarded command line on its script and arguments, dropping the shell around it", () => {
		expect(
			suggested("SessionStart", {
				hooks: [
					{
						command:
							'command -v node >/dev/null 2>&1 && node "$CLAUDE_PROJECT_DIR"/scripts/check-x.js --session-start || true',
					},
				],
			}),
		).toContain(
			'add {"event":"SessionStart","id":"scripts/check-x.js --session-start","matcher":null,"covers":[],"unbounded":true}',
		);
	});

	it("falls back to the script alone where a closing quote splits it from its arguments", () => {
		expect(
			suggested("PreToolUse", {
				matcher: "Read|Edit",
				hooks: [
					{
						command: 'node "$CLAUDE_PROJECT_DIR/scripts/check-x.js" --flag',
						timeout: 5,
					},
				],
			}),
		).toContain(
			'add {"event":"PreToolUse","id":"scripts/check-x.js","matcher":"Read|Edit","covers":["Read","Edit"]}',
		);
	});
});
