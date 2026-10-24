// @vitest-environment node
/*
 * helper-surface.test.ts — every name the helper-surface manifest promises is
 * one its entry point actually provides (#460), the test fixtures on it
 * load in a plain node process outside the core (#462), and each listed
 * command still reads the argv the manifest promises (#655).
 *
 * The commands are spawned, never run in-process: an adopter spawns them, and
 * the argv and exit code a real process sees are the contract. Their refusals
 * assert status alone, stderr wording being off the contract.
 *
 * The manifest is what adopters import and run against, so a loosened case
 * lets a release drop or reshape a promised helper or command line and break
 * an adopter's tests or hooks with nothing on this side going red.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isShipped } from "./plugin-tree.js";
import { TEST_TIMEOUT_MS } from "./test-ceiling";

const ROOT = path.join(__dirname, "..", "..");
interface Command {
	positionals: { name: string; values?: string[] }[];
	flags: { name: string; value?: string }[];
	exit: Record<string, string>;
}
const manifest: {
	entryPoints: Record<string, string[]>;
	commands: Record<string, Command>;
} = JSON.parse(
	fs.readFileSync(path.join(__dirname, "helper-surface.json"), "utf8"),
);
const entries = Object.entries(manifest.entryPoints);
const ofKind = (ext: string) =>
	entries.filter(([file]) => path.extname(file) === ext);
// .ts only where vitest alone loads it (#552):
// the release ships no other TypeScript, so the pre-commit gate harness joins
// as a .js port (#462).
const KINDS = [".js", ".sh", ".py", ".ts"];

describe("the helper-surface manifest", () => {
	it("names at least one entry point, each exporting at least one name", () => {
		expect(entries.length).toBeGreaterThan(0);
		for (const [, names] of entries) expect(names.length).toBeGreaterThan(0);
	});

	it.each(ofKind(".js"))(
		"%s exports every name listed, naming any it lacks",
		(file, names) => {
			const mod = require(path.join(ROOT, file));
			expect(names.filter((n) => !(n in mod))).toEqual([]);
		},
	);

	it.each(ofKind(".ts"))(
		"%s exports every name listed, naming any it lacks",
		async (file, names) => {
			const mod = await import(path.join(ROOT, file));
			expect(names.filter((n) => !(n in mod))).toEqual([]);
		},
	);

	it("lists as .ts entry points exactly the TypeScript the release ships", () => {
		expect(
			ofKind(".ts")
				.map(([f]) => f)
				.sort(),
		).toEqual(
			fs
				.readdirSync(path.join(ROOT, "scripts"))
				.filter((n) => n.endsWith(".ts"))
				.map((n) => `scripts/${n}`)
				.filter((rel) => isShipped(ROOT, rel))
				.sort(),
		);
	});

	it.each(ofKind(".sh"))(
		"%s defines every function listed once sourced, naming any it lacks",
		(file, names) => {
			const r = spawnSync(
				"bash",
				[
					"-c",
					'. "$1"; shift; for f; do declare -F "$f" >/dev/null || echo "$f"; done',
					"_",
					path.join(ROOT, file),
					...names,
				],
				{ encoding: "utf8", input: "" },
			);
			expect(r.stdout.split("\n").filter(Boolean)).toEqual([]);
			expect(r.status).toBe(0);
		},
	);

	// Its own directory on sys.path, as an adopter's conftest puts it (#465):
	// the Python helpers import their siblings by bare name.
	it.each(ofKind(".py"))(
		"%s defines every name listed once imported, naming any it lacks",
		(file, names) => {
			const r = spawnSync(
				"python3",
				[
					"-c",
					"import importlib, sys; sys.path.insert(0, sys.argv[1]); m = importlib.import_module(sys.argv[2]); print('\\n'.join(n for n in sys.argv[3:] if not hasattr(m, n)))",
					path.dirname(path.join(ROOT, file)),
					path.basename(file, ".py"),
					...names,
				],
				{ encoding: "utf8" },
			);
			expect(r.stderr).toBe("");
			expect(r.stdout.split("\n").filter(Boolean)).toEqual([]);
			expect(r.status).toBe(0);
		},
	);

	// Loaded as an adopter's test would: plain node from outside the core, no
	// TypeScript loader and no vitest, so a fixture needing either fails here.
	it("serves the gate harness, in-process runner and test ceiling to plain node outside the core, printing its stderr on a failure", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adopter-"));
		try {
			fs.writeFileSync(
				path.join(dir, "adopter.js"),
				`const fs = require("node:fs");
const path = require("node:path");
const lib = (f) => require(path.join(process.argv[2], "scripts", "lib", f));
const { TEST_TIMEOUT_MS } = lib("test-ceiling.js");
const { runInProcess } = lib("run-in-process.js");
const harness = lib("precommit-gate-harness.js");
const cleanups = [];
const temps = harness.registerTempCleanup((fn) => cleanups.push(fn));
const { root } = harness.newRepo("adopter-repo-", temps);
const hook = "if git diff --cached --quiet -- x; then :; else\\n\\tnode scripts/check-x.js\\nfi\\n";
harness.expectFixtureSupplies("scripts/check-x.js", ["scripts/check-x.js"], hook);
fs.writeFileSync(path.join(root, "hi.js"), "console.log('hi');\\n");
const ran = runInProcess(path.join(root, "hi.js"), [], { cwd: root });
for (const fn of cleanups) fn();
console.log(JSON.stringify({ ceiling: TEST_TIMEOUT_MS, ran: ran.stdout.trim(), cleaned: !fs.existsSync(root) }));
`,
			);
			const r = spawnSync(process.execPath, ["adopter.js", ROOT], {
				cwd: dir,
				encoding: "utf8",
			});
			expect(r.status, r.stderr).toBe(0);
			expect(r.stderr).toBe("");
			expect(JSON.parse(r.stdout)).toEqual({
				ceiling: TEST_TIMEOUT_MS,
				ran: "hi",
				cleaned: true,
			});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fails on an entry point of any other kind, naming it", () => {
		expect(
			entries.map(([f]) => f).filter((f) => !KINDS.includes(path.extname(f))),
		).toEqual([]);
	});
});

/*
 * Each listed command run as an adopter spawns it: argv built from the
 * manifest's own positionals, in their listed order, and every listed flag
 * given and seen to take effect — so a flag the script stops reading, a
 * positional it reads from another place, or an exit code it stops giving
 * fails here, not merely a deleted file. register-doc.js ignores a flag it
 * does not read, so only its effect proves one is still read.
 */
describe("the helper-surface commands", () => {
	const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hs-command-"));
	const run = (
		file: string,
		argv: string[],
		opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
	) =>
		spawnSync(process.execPath, [path.join(ROOT, file), ...argv], {
			encoding: "utf8",
			...opts,
		});
	const exitCodes = () => {
		const seen = new Set<string>();
		return {
			add: (status: number | null) => seen.add(String(status)),
			expectListed: (cmd: Command) =>
				expect([...seen].sort()).toEqual(Object.keys(cmd.exit).sort()),
		};
	};
	/** argv in the manifest's positional order, from values keyed by name. */
	const argvOf = (cmd: Command, byName: Record<string, string>) =>
		cmd.positionals.map((p) => byName[p.name]);

	it("lists a probe below for every command, and every command for a probe", () => {
		expect(Object.keys(manifest.commands).sort()).toEqual(
			[
				"scripts/checker-new-faults.js",
				"scripts/lib/formatters.js",
				"scripts/lib/run-cost-report.js",
				"scripts/mutation-hold-gate.js",
				"scripts/register-doc.js",
				"scripts/run-vitest.js",
			].sort(),
		);
	});

	/*
	 * In a scratch repo with a stand-in vitest (`WFC_RUN_VITEST_BIN`, as
	 * run-vitest.test.ts's real-subprocess case uses), which records the argv
	 * it was handed and exits with the code it is told to. Bare argv as well
	 * as the listed flag: an adopter's `test` script passes nothing. Bare argv
	 * is held to its exit code alone: with no read-edge manifest here it
	 * escalates to an isolated whole-suite run, which needs a commit to build
	 * its worktree at, and which argv it hands vitest is the runner's to change.
	 */
	it(
		"scripts/run-vitest.js keeps --changed and its exit codes",
		() => {
			const cmd = manifest.commands["scripts/run-vitest.js"];
			expect(cmd.positionals).toEqual([]);
			expect(cmd.flags.map((f) => f.name)).toEqual(["--changed"]);
			const dir = tmp();
			try {
				const git = (...args: string[]) =>
					spawnSync("git", args, { cwd: dir, encoding: "utf8" });
				git("init", "-q");
				git(
					"-c",
					"user.name=t",
					"-c",
					"user.email=t@t",
					"commit",
					"-q",
					"--allow-empty",
					"-m",
					"init",
				);
				const seen = path.join(dir, "argv.json");
				const bin = path.join(dir, "fake-vitest.js");
				fs.writeFileSync(
					bin,
					`#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)));\nprocess.exitCode = Number(process.env.FAKE_CODE);\n`,
					{ mode: 0o755 },
				);
				const codes = exitCodes();
				const launch = (argv: string[], code: number) => {
					const r = run("scripts/run-vitest.js", argv, {
						cwd: dir,
						env: {
							...process.env,
							WFC_RUN_VITEST_BIN: bin,
							CLAUDE_PROJECT_DIR: dir,
							FAKE_CODE: String(code),
						},
					});
					codes.add(r.status);
					expect(r.status, r.stderr).toBe(code);
					return JSON.parse(fs.readFileSync(seen, "utf8")) as string[];
				};
				for (const code of [0, 1]) {
					launch([], code);
					expect(launch(["--changed"], code)).toContain("--changed");
				}
				codes.expectListed(cmd);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		},
		TEST_TIMEOUT_MS,
	);

	it("scripts/checker-new-faults.js keeps its positional order, profile values and exit codes", () => {
		const cmd = manifest.commands["scripts/checker-new-faults.js"];
		expect(cmd.flags).toEqual([]);
		const dir = tmp();
		try {
			const put = (name: string, findings: object[]) => {
				const abs = path.join(dir, name);
				fs.writeFileSync(abs, JSON.stringify({ findings }));
				return abs;
			};
			const old = { severity: "FAIL", tag: "T", file: "a", match: "old" };
			const added = { ...old, match: "added", message: "the added fault" };
			const codes = exitCodes();
			const verdict = (profile: string, staged: object[]) => {
				const r = run(
					"scripts/checker-new-faults.js",
					argvOf(cmd, {
						profile,
						staged: put("staged.json", staged),
						baseline: put("baseline.json", [old]),
					}),
				);
				codes.add(r.status);
				return r;
			};
			for (const profile of cmd.positionals[0].values ?? []) {
				expect(verdict(profile, [old]).status, profile).toBe(0);
				const r = verdict(profile, [old, added]);
				expect(r.status, profile).toBe(1);
				expect(r.stdout).toContain("the added fault");
			}
			expect(verdict("no-such-profile", [old]).status).toBe(2);
			codes.expectListed(cmd);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("scripts/lib/formatters.js keeps shell-files, --tracked and its exit codes", () => {
		const cmd = manifest.commands["scripts/lib/formatters.js"];
		expect(cmd.flags.map((f) => f.name)).toEqual(["--tracked"]);
		const dir = tmp();
		try {
			const codes = exitCodes();
			const list = (cwd: string) => {
				const r = run(
					"scripts/lib/formatters.js",
					[...argvOf(cmd, { mode: "shell-files" }), "--tracked"],
					{ cwd },
				);
				codes.add(r.status);
				return r;
			};
			// Not a repo yet, so git ls-files fails.
			expect(list(dir).status).toBe(1);
			spawnSync("git", ["init", "-q"], { cwd: dir });
			fs.writeFileSync(path.join(dir, "a.sh"), "echo\n");
			fs.writeFileSync(path.join(dir, "b.js"), "1;\n");
			spawnSync("git", ["add", "."], { cwd: dir });
			const r = list(dir);
			expect(r.status, r.stderr).toBe(0);
			expect(r.stdout).toBe("a.sh\n");
			codes.expectListed(cmd);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("scripts/lib/run-cost-report.js keeps its timings positional and exits 0, fail-open included", () => {
		const cmd = manifest.commands["scripts/lib/run-cost-report.js"];
		expect(cmd.flags).toEqual([]);
		const dir = tmp();
		try {
			spawnSync("git", ["init", "-q"], { cwd: dir });
			spawnSync(
				"git",
				[
					"-c",
					"user.name=t",
					"-c",
					"user.email=t@t",
					"commit",
					"-q",
					"--allow-empty",
					"-m",
					"init",
				],
				{ cwd: dir },
			);
			// Untracked, so new against the HEAD base a repo with no origin/main takes.
			fs.writeFileSync(path.join(dir, "a.test.js"), "\n");
			const codes = exitCodes();
			const report = (body: string) => {
				const timings = path.join(dir, "timings.json");
				fs.writeFileSync(timings, body);
				const r = run(
					"scripts/lib/run-cost-report.js",
					argvOf(cmd, { timings }),
					{
						cwd: dir,
						env: { ...process.env, CI: "", CLAUDE_PROJECT_DIR: dir },
					},
				);
				codes.add(r.status);
				return r;
			};
			expect(report(JSON.stringify({ "a.test.js": 12 })).stdout).toContain(
				"RUN COST: a.test.js took 12.0 s",
			);
			expect(report("{").stdout).toContain("RUN COST: the report failed");
			codes.expectListed(cmd);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("scripts/mutation-hold-gate.js keeps --seed and its exit codes", () => {
		const cmd = manifest.commands["scripts/mutation-hold-gate.js"];
		expect(cmd.positionals).toEqual([]);
		expect(cmd.flags.map((f) => f.name)).toEqual(["--seed"]);
		const dir = tmp();
		try {
			const git = (...args: string[]) =>
				spawnSync(
					"git",
					["-c", "user.name=t", "-c", "user.email=t@t", ...args],
					{ cwd: dir },
				);
			git("init", "-q");
			const put = (rel: string, text: string) => {
				fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
				fs.writeFileSync(path.join(dir, rel), text);
			};
			put(
				".claude/workflow-core.json",
				JSON.stringify({
					sensitivePaths: [
						{ name: "money", description: "fees", globs: ["lib/**"] },
					],
				}),
			);
			put(".gitignore", "node_modules/\n.claude/worktrees/\n");
			put("lib/fee.txt", "not code\n");
			git("add", "-A");
			git("commit", "-qm", "no code on the declared path");
			for (const p of [
				"@stryker-mutator/core",
				"@stryker-mutator/vitest-runner",
				"vitest",
			])
				put(`node_modules/${p}/package.json`, "{}\n");
			// A stand-in Stryker writing an empty report and cache.
			const stub = path.join(dir, "stryker.js");
			fs.writeFileSync(
				stub,
				`#!/usr/bin/env node
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
import(pathToFileURL(process.argv[3]).href).then(({ default: c }) => {
	fs.writeFileSync(c.incrementalFile, "{}");
	fs.writeFileSync(c.jsonReporter.fileName, '{"files":{}}');
});
`,
				{ mode: 0o755 },
			);
			const codes = exitCodes();
			const seed = () => {
				const r = run("scripts/mutation-hold-gate.js", ["--seed"], {
					cwd: dir,
					env: { ...process.env, WFC_STRYKER: stub, CLAUDE_PROJECT_DIR: dir },
				});
				codes.add(r.status);
				return r;
			};
			expect(seed().stderr).toContain("nothing was seeded");
			put("lib/fee.js", "export const fee = 1;\n");
			git("add", "-A");
			git("commit", "-qm", "code");
			expect(seed().stderr).toContain("cached 0 mutant result(s)");
			codes.expectListed(cmd);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("scripts/register-doc.js keeps its positional and every listed flag, and its exit codes", () => {
		const cmd = manifest.commands["scripts/register-doc.js"];
		const dir = tmp();
		try {
			const data = path.join(dir, "sidecar.json");
			fs.writeFileSync(
				data,
				JSON.stringify({ "docs/old.md": { section: "Old", class: "derived" } }),
			);
			const log = path.join(dir, "claims.log");
			const logger = (verb: string) => {
				const abs = path.join(dir, verb);
				fs.writeFileSync(abs, `#!/bin/sh\necho "${verb} $1" >> "${log}"\n`, {
					mode: 0o755,
				});
				return abs;
			};
			const consumes = [{ kind: "path", ref: "docs/old.md", gloss: "g" }];
			/* A value for exactly the listed flags; a mismatch fails the test. */
			const given: Record<string, string | null> = {
				"--class": "derived",
				"--section": "New",
				"--reader": "agent",
				"--qualifier": "q",
				"--consumes": JSON.stringify(consumes),
				"--role": "the role",
				"--route": "the route",
				"--new-section": null,
				"--no-claim": null,
				"--claim-cmd": logger("claim"),
				"--release-cmd": logger("release"),
				"--data-file": data,
			};
			const listed = cmd.flags.map((f) => f.name);
			expect([...listed].sort()).toEqual(Object.keys(given).sort());
			const flags = (names: string[]) =>
				names.flatMap((f) => (given[f] === null ? [f] : [f, given[f] ?? ""]));
			const codes = exitCodes();
			const register = (docPath: string, names: string[]) => {
				const r = run("scripts/register-doc.js", [
					...argvOf(cmd, { path: docPath }),
					...flags(names),
				]);
				codes.add(r.status);
				return r;
			};
			const sidecar = () => JSON.parse(fs.readFileSync(data, "utf8"));
			const claims = () =>
				fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";

			const all = listed.filter((f) => f !== "--no-claim");
			const r = register("docs/new.md", all);
			expect(r.status, r.stderr).toBe(0);
			expect(sidecar()["docs/new.md"]).toEqual({
				section: "New",
				class: "derived",
				classQualifier: "q",
				role: "the role",
				route: "the route",
				consumes,
				reader: "agent",
			});
			expect(claims()).toMatch(/^claim .*docs\/new\.md\n$/);

			expect(register("docs/new.md", all).status).toBe(1);
			expect(claims()).toMatch(/\nclaim .*\nrelease .*docs\/new\.md\n$/);

			const before = claims();
			given["--role"] = "a new role";
			expect(
				register("docs/new.md", [
					"--role",
					"--no-claim",
					"--claim-cmd",
					"--data-file",
				]).status,
			).toBe(0);
			expect(sidecar()["docs/new.md"].role).toBe("a new role");
			expect(claims()).toBe(before);

			given["--data-file"] = path.join(dir, "absent.json");
			expect(
				register("docs/new.md", ["--route", "--no-claim", "--data-file"])
					.status,
			).toBe(2);
			codes.expectListed(cmd);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
