// @vitest-environment node
/*
 * Pins release-plugin.js: the tag it cuts holds the tree rendered from HEAD,
 * and each refusal holds, among them a dirty tree, a red core, a marketplace
 * pinned elsewhere, a missing or malformed migration note, and a Verify that
 * fails against a dry-run adopter.
 *
 * Each release is cut in a throwaway repo with hooks off, and gh is a stub, so
 * no tag or issue reaches GitHub. Every case drives the program in-process
 * through its CLI; none imports a helper, which §G6 forbids exporting for a
 * test alone (#1369).
 *
 * A release is what every adopter installs, so loosening a refusal ships a
 * broken tag to all of them (#4, #6).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubGhScript } from "./lib/gh-stub";
import { initGitRepo } from "./lib/git-fixture";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "release-plugin.js");
const PLUGIN_ROOT = ["$", "{CLAUDE_PLUGIN_ROOT}"].join("");

let dir: string;
const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const write = (rel: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
	fs.writeFileSync(path.join(dir, rel), body);
};
/* Main holds HEAD unless a case says otherwise: a release ships only a commit
 * `origin/main` holds. */
const landed = () => git("update-ref", "refs/remotes/origin/main", "HEAD");
const run = (env: NodeJS.ProcessEnv = {}, { onMain = true } = {}) => {
	if (onMain) landed();
	return runInProcess(SCRIPT, [], {
		cwd: dir,
		env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...env },
	});
};
const dryRunAdopter = (adopter: string, env: NodeJS.ProcessEnv = {}) => {
	landed();
	return runInProcess(SCRIPT, ["--dry-run-adopter", adopter], {
		cwd: dir,
		env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...env },
	});
};
const migrationNote = (verify: string, residue = "{}") =>
	[
		"# v2.0.0",
		"",
		"## What changed",
		"",
		"Test.",
		"",
		"## Ruling",
		"",
		"#1.",
		"",
		"## Residue",
		"",
		"```json",
		residue,
		"```",
		"",
		"## Manual steps",
		"",
		"- [notice] none",
		"",
		"## Verify",
		"",
		"```sh",
		verify,
		"```",
		"",
	].join("\n");
/* The `--dry-run-adopter` tests below each need a second checkout pinning
 * plugin `p` at some ref — only the ref differs between them. */
const adopterFixture = (tmp: string, ref: string) => {
	const adopter = path.join(tmp, "adopter");
	fs.mkdirSync(path.join(adopter, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(adopter, ".claude/settings.json"),
		JSON.stringify({
			enabledPlugins: { "p@m": true },
			extraKnownMarketplaces: {
				m: {
					source: { source: "url", url: "https://example.invalid/p.git", ref },
				},
			},
		}),
	);
	return adopter;
};
const manifests = (version: string, ref: string) => {
	write(".claude-plugin/plugin.json", JSON.stringify({ name: "p", version }));
	write(
		".claude-plugin/marketplace.json",
		JSON.stringify({
			plugins: [
				{ name: "other", source: { source: "url", ref: `v${version}` } },
				{ name: "p", source: { source: "url", ref } },
			],
		}),
	);
};

beforeEach(() => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-release-"));
	dir = path.join(tmp, "repo");
	fs.mkdirSync(path.join(tmp, "no-hooks"));
	initGitRepo(dir, path.join(tmp, "no-hooks"));
	manifests("2.3.4", "v2.3.4");
	write("package.json", "{}");
	write("scripts/guard.sh", "#!/bin/sh\nexit 0\n");
	fs.chmodSync(path.join(dir, "scripts/guard.sh"), 0o755);
	write("scripts/guard.test.ts", "");
	write(".claude/skills/s/SKILL.md", "run `scripts/guard.sh`\n");
	write(
		"self-plugin/hooks/hooks.json",
		JSON.stringify({
			hooks: {
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
	git("add", "--all");
	git("commit", "-qm", "fixture");
});
afterEach(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));

describe("release-plugin", () => {
	it("refuses a HEAD origin/main does not hold, tagging nothing (#2408)", () => {
		landed();
		write("later.txt", "queued on landing\n");
		git("add", "--all");
		git("commit", "-qm", "unlanded");
		const r = run({}, { onMain: false });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("HEAD is not on origin/main");
		expect(git("tag", "--list")).toBe("");
	});

	it("tags the version on a commit holding the tree rendered from HEAD", () => {
		const head = git("rev-parse", "HEAD");

		const r = run();
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("git push origin v2.3.4");

		expect(git("ls-tree", "-r", "--name-only", "v2.3.4").split("\n")).toEqual([
			".claude-plugin/marketplace.json",
			".claude-plugin/plugin.json",
			".claude/skills/s/SKILL.md",
			"hooks/hooks.json",
			"scripts/guard.sh",
		]);
		expect(
			JSON.parse(git("show", "v2.3.4:.claude-plugin/plugin.json")).version,
		).toBe("2.3.4");
		// #117: the shipped marketplace.json must pin the tag actually cut, not
		// just exist — `claude plugin marketplace add <url>#v2.3.4` reads this.
		const shippedMarketplace = JSON.parse(
			git("show", "v2.3.4:.claude-plugin/marketplace.json"),
		);
		expect(
			shippedMarketplace.plugins.find((p: { name: string }) => p.name === "p")
				.source.ref,
		).toBe("v2.3.4");
		expect(git("show", "v2.3.4:.claude/skills/s/SKILL.md")).toBe(
			`run \`${PLUGIN_ROOT}/scripts/guard.sh\``,
		);
		expect(git("ls-tree", "v2.3.4", "scripts/guard.sh")).toMatch(/^100755 /);
		expect(git("log", "--format=%B", "-1", "v2.3.4^{commit}")).toContain(head);
		expect(git("rev-parse", "HEAD")).toBe(head);
		expect(git("status", "--porcelain")).toBe("");
	});

	it("refuses a version already tagged, naming the tag", () => {
		expect(run().status).toBe(0);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/tag v2\.3\.4 already exists/);
	});

	it("refuses where the marketplace pins another ref, naming both refs and tagging nothing", () => {
		manifests("2.3.5", "v2.3.4");
		git("commit", "-qam", "bump without the pin");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/pins p to v2\.3\.4, not v2\.3\.5/);
		expect(git("tag", "--list")).toBe("");
	});

	it("refuses a dirty working tree, tagging nothing", () => {
		write(".claude/skills/s/SKILL.md", "an uncommitted edit\n");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/working tree is dirty/);
		expect(git("tag", "--list")).toBe("");
	});

	describe("the standards base's line pins (#961)", () => {
		const base = (body: string) => {
			write("docs/code-standards-base.md", body);
			git("add", "--all");
			git("commit", "-qm", "write a base");
		};

		it("refuses a base line pin into each kind of file the release leaves behind, naming every pin", () => {
			write("scripts/release-plugin.js", "a\nb\nc\n");
			write("scripts/fixtures/case.json", "{}\n");
			write("lib/core-only.js", "a\nb\n");
			base(
				[
					"# Base",
					"",
					"Left behind — `scripts/release-plugin.js:2-3`.",
					"A test — `scripts/guard.test.ts:1`.",
					"A fixture — `scripts/fixtures/case.json:1`.",
					"Never copied — `lib/core-only.js:2`.",
					"Absent — `scripts/gone.js:1`.",
					"No path on its line — `:4`.",
					"Shipped — `scripts/guard.sh:2`.",
					"",
				].join("\n"),
			);

			const r = run();
			expect(r.status).toBe(1);
			for (const pin of [
				"`scripts/release-plugin.js:2-3` (line 3)",
				"`scripts/guard.test.ts:1` (line 4)",
				"`scripts/fixtures/case.json:1` (line 5)",
				"`lib/core-only.js:2` (line 6)",
				"`scripts/gone.js:1` (line 7)",
				"`:4` (line 8)",
			]) {
				expect(r.stderr).toContain(pin);
			}
			expect(r.stderr).not.toContain("scripts/guard.sh:2");
			expect(r.stderr).toMatch(/write the example into the text/);
			expect(git("tag", "--list")).toBe("");
		});

		it("refuses a base line pin into a directory, which opens no line, saying why (#1259)", () => {
			base("A directory — `scripts:1`.\nShipped — `scripts/guard.sh:2`.\n");
			const r = run();
			expect(r.status).toBe(1);
			expect(r.stderr).toContain(
				"`scripts:1` (line 1), as no file opens at scripts",
			);
			expect(r.stderr).not.toContain("scripts/guard.sh:2");
			expect(git("tag", "--list")).toBe("");
		});

		it("passes a base whose every line pin is into a shipped file", () => {
			base(
				"Shipped — `scripts/guard.sh:2` and `.claude/skills/s/SKILL.md:1`.\n",
			);
			const r = run();
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
			expect(git("tag", "--list")).toBe("v2.3.4");
		});

		it("releases a tree with no base, refusing nothing", () => {
			const r = run();
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
			expect(git("tag", "--list")).toBe("v2.3.4");
		});
	});

	it("refuses a red core where commands.test is declared, saying why", () => {
		write(
			".claude/workflow-core.json",
			JSON.stringify({
				founder: "F",
				commands: { test: "echo 3 tests failed; exit 1" },
			}),
		);
		git("add", "--all");
		git("commit", "-qm", "declare a failing test command");
		const r = run();
		expect(r.status).toBe(1);
		// A suite's verdict is on stdout, which once reached the refusal blank (#1268).
		expect(r.stderr).toMatch(/the core's suite failed.*\n3 tests failed/);
		expect(git("tag", "--list")).toBe("");
	});

	it("skips the red-core check where commands.test is undeclared", () => {
		expect(run().status).toBe(0);
	});

	it("runs the core's suite and a note's Verify under one throwaway CLAUDE_CONFIG_DIR, not the caller's own (#135)", () => {
		const foundersConfigRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "founder-claude-config-"),
		);
		try {
			const foundersConfig = path.join(foundersConfigRoot, ".claude");
			write(
				".claude/workflow-core.json",
				JSON.stringify({
					founder: "F",
					commands: {
						test: 'echo "$CLAUDE_CONFIG_DIR" > core-config-dir.txt',
					},
				}),
			);
			git("tag", "-a", "v1.0.0", "-m", "prior release", "HEAD");
			manifests("2.0.0", "v2.0.0");
			write(
				"migrations/v2.0.0.md",
				migrationNote('echo "$CLAUDE_CONFIG_DIR" > note-config-dir.txt'),
			);
			git("add", "--all");
			git("commit", "-qm", "capture CLAUDE_CONFIG_DIR at verify time");

			const r = run({ CLAUDE_CONFIG_DIR: foundersConfig });
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
			const coreSeen = fs
				.readFileSync(path.join(dir, "core-config-dir.txt"), "utf8")
				.trim();
			const noteSeen = fs
				.readFileSync(path.join(dir, "note-config-dir.txt"), "utf8")
				.trim();
			expect(coreSeen).not.toBe(foundersConfig);
			expect(noteSeen).not.toBe(foundersConfig);
			expect(coreSeen).toBe(noteSeen);
		} finally {
			fs.rmSync(foundersConfigRoot, { recursive: true, force: true });
		}
	});

	it("refuses a major bump with no migrations note, naming the note it expects", () => {
		git("tag", "-a", "v1.0.0", "-m", "prior release", "HEAD");
		manifests("2.0.0", "v2.0.0");
		git("add", "--all");
		git("commit", "-qm", "bump to a major with no note");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(
			/2\.0\.0 is a major bump over v1\.0\.0 and ships no migrations\/v2\.0\.0\.md/,
		);
	});

	it("refuses a minor cut that drops a helper-surface export the last release listed, naming the file and export and tagging nothing (#463)", () => {
		const surface = (names: string[]) =>
			write(
				"scripts/lib/helper-surface.json",
				JSON.stringify({ entryPoints: { "scripts/lib/h.js": names } }),
			);
		surface(["kept", "dropped"]);
		git("add", "--all");
		git("commit", "-qm", "declare a surface");
		git("tag", "-a", "v2.3.3", "-m", "prior release", "HEAD");
		surface(["kept"]);
		git("add", "--all");
		git("commit", "-qm", "drop an export on a minor bump");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(
			/helper surface breaks its contract — scripts\/lib\/h\.js no longer lists dropped, and v2\.3\.4 is not a major bump over v2\.3\.3/,
		);
		expect(git("tag", "--list", "v2.3.4")).toBe("");
	});

	it("refuses a malformed note, naming it", () => {
		git("tag", "-a", "v1.0.0", "-m", "prior release", "HEAD");
		manifests("2.0.0", "v2.0.0");
		write(
			"migrations/v2.0.0.md",
			"# v2.0.0\n\n## What changed\n\nonly one section\n",
		);
		git("add", "--all");
		git("commit", "-qm", "bump with a malformed note");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/migrations\/v2\.0\.0\.md is malformed/);
	});

	it("refuses a note whose manual step carries no type, naming the bullet (#246)", () => {
		git("tag", "-a", "v1.0.0", "-m", "prior release", "HEAD");
		manifests("2.0.0", "v2.0.0");
		write(
			"migrations/v2.0.0.md",
			migrationNote("true").replace(
				"- [notice] none",
				"- [ ] undo the thing by hand",
			),
		);
		git("add", "--all");
		git("commit", "-qm", "bump with an untyped manual step");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/migrations\/v2\.0\.0\.md is malformed/);
		expect(r.stderr).toMatch(/undo the thing by hand/);
	});

	it("refuses where a required note's Verify fails, naming the version and tagging nothing, and passes a note through when it succeeds", () => {
		git("tag", "-a", "v1.0.0", "-m", "prior release", "HEAD");
		manifests("2.0.0", "v2.0.0");
		write("migrations/v2.0.0.md", migrationNote("exit 1"));
		git("add", "--all");
		git("commit", "-qm", "bump with a note whose Verify fails");
		const failing = run();
		expect(failing.status).toBe(1);
		expect(failing.stderr).toMatch(/v2\.0\.0's note Verify failed/);
		expect(git("tag", "--list", "v2.0.0")).toBe("");

		write(
			"migrations/v2.0.0.md",
			fs
				.readFileSync(path.join(dir, "migrations/v2.0.0.md"), "utf8")
				.replace("exit 1", "true"),
		);
		git("commit", "-qam", "fix the note's Verify");
		expect(run().status).toBe(0);
		expect(git("tag", "--list", "v2.0.0")).toBe("v2.0.0");
	});

	it("skips the dry-run adopter check by default", () => {
		const ok = run();
		expect(ok.status).toBe(0);
		expect(ok.stdout).toContain("adopter walk: SKIPPED");
	});

	it("refuses when a given adopter's own upgrade() call returns non-zero, passing on its reason", () => {
		// The adopter's pin (v9.9.9) is newer than the release under test
		// (v2.3.4), so upgrade() takes its own pin-ahead-of-install refusal
		// (upgrade.js).
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dry-run-adopter-"));
		try {
			const adopter = adopterFixture(tmp, "v9.9.9");
			const bad = dryRunAdopter(adopter);
			expect(bad.status).toBe(1);
			expect(bad.stderr).toMatch(/dry-run adopter walk failed/);
			expect(bad.stderr).toMatch(
				/pin v9\.9\.9 is ahead of the installed plugin v2\.3\.4/,
			);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	/*
	 * The Verify passes `pluginInstall: false`; the registry-isolation lever
	 * for a caller that does install is lib/materialise-plugin.test.ts's.
	 */
	it("shells out to claude not at all during a cut, leaving the caller's registry byte-identical (#117)", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dry-run-adopter-"));
		try {
			const adopter = adopterFixture(tmp, "v2.0.0");

			const callerConfig = path.join(tmp, "caller-claude");
			fs.mkdirSync(path.join(callerConfig, "plugins"), { recursive: true });
			const registries = ["known_marketplaces.json", "installed_plugins.json"];
			for (const f of registries) {
				fs.writeFileSync(
					path.join(callerConfig, "plugins", f),
					JSON.stringify({ untouched: true }),
				);
			}
			const before = registries.map((f) =>
				fs.readFileSync(path.join(callerConfig, "plugins", f)),
			);

			/* Writes into whatever CLAUDE_CONFIG_DIR it is handed, as the real
			 * CLI does, so a call that did happen would show in both the log
			 * and the bytes below. */
			const log = path.join(tmp, "claude-calls.log");
			const stub = path.join(tmp, "claude");
			fs.writeFileSync(
				stub,
				"#!/bin/sh\n" +
					`echo "$CLAUDE_CONFIG_DIR|$*" >> ${JSON.stringify(log)}\n` +
					`mkdir -p "$CLAUDE_CONFIG_DIR/plugins"\n` +
					`echo clobbered > "$CLAUDE_CONFIG_DIR/plugins/known_marketplaces.json"\n` +
					"exit 0\n",
			);
			fs.chmodSync(stub, 0o755);

			const r = dryRunAdopter(adopter, {
				CLAUDE_CONFIG_DIR: callerConfig,
				WFC_CLAUDE_BIN: stub,
			});
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
			expect(r.stdout).toContain(`adopter walk: passed against ${adopter}`);
			expect(fs.existsSync(log)).toBe(false);
			for (const [i, f] of registries.entries()) {
				expect(fs.readFileSync(path.join(callerConfig, "plugins", f))).toEqual(
					before[i],
				);
			}
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	/*
	 * Without this the walk line reads "passed" for a run that did nothing
	 * — upgrade() returns 0 for a skip as readily as for a real pass (#117
	 * review F1).
	 */
	it("reports the adopter upgrade's own output under the walk line (#117)", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dry-run-adopter-"));
		try {
			const adopter = adopterFixture(tmp, "v2.0.0");
			const r = dryRunAdopter(adopter);
			expect(r.status).toBe(0);
			const verify = r.stdout.slice(r.stdout.indexOf("adopter walk: passed"));
			/* Indented continuation lines, i.e. upgrade() actually said something. */
			expect(
				verify.split("\n").filter((l) => l.startsWith("  ")).length,
			).toBeGreaterThan(0);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	/*
	 * #291: upgrade() passed no `dryRun`, so `--dry-run-adopter` really
	 * upgraded the adopter — re-pointing its `.husky/*` at a temp `outDir`
	 * the cut then deletes, and advancing its `walkedTo`.
	 */
	it("leaves the adopter's own tree byte-identical (#291)", () => {
		git("tag", "-a", "v1.0.0", "-m", "prior release", "HEAD");
		manifests("2.0.0", "v2.0.0");
		write("migrations/v2.0.0.md", migrationNote("true"));
		write(
			".husky/pre-commit",
			"#!/bin/sh\nWFC_PLUGIN_ROOT=stale\nexport WFC_PLUGIN_ROOT\nexit 0\n",
		);
		fs.chmodSync(path.join(dir, ".husky/pre-commit"), 0o755);
		git("add", "--all");
		git("commit", "-qm", "bump to v2.0.0 with a hook template");

		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dry-run-adopter-"));
		try {
			const adopter = adopterFixture(tmp, "v1.0.0");
			fs.mkdirSync(path.join(adopter, ".husky"), { recursive: true });
			fs.writeFileSync(
				path.join(adopter, ".claude/workflow-core.json"),
				JSON.stringify({ founder: "F" }),
			);
			fs.writeFileSync(
				path.join(adopter, ".husky/pre-commit"),
				"#!/bin/sh\nWFC_PLUGIN_ROOT=/some/old/checkout\nexport WFC_PLUGIN_ROOT\nexit 0\n",
			);
			fs.chmodSync(path.join(adopter, ".husky/pre-commit"), 0o755);

			const snapshot = () =>
				fs
					.readdirSync(adopter, { recursive: true, withFileTypes: true })
					.filter((e) => e.isFile())
					.map((e) => path.relative(adopter, path.join(e.parentPath, e.name)))
					.sort()
					.map((rel) => [
						rel,
						fs.readFileSync(path.join(adopter, rel), "utf8"),
					]);
			const before = snapshot();

			const r = dryRunAdopter(adopter);
			expect(r.status).toBe(0);
			expect(r.stdout).toContain(`adopter walk: passed against ${adopter}`);
			expect(r.stdout).toContain("rewrote .husky/pre-commit");

			expect(snapshot()).toEqual(before);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	/*
	 * The note's Verify logs its cwd, so the log counts how many times it
	 * really ran: once for the core's own check, once for the adopter walk.
	 */
	it("runs the note's own Verify against the adopter copy (#296)", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dry-run-adopter-"));
		try {
			const log = path.join(tmp, "verify-cwds.log");
			git("tag", "-a", "v1.0.0", "-m", "prior release", "HEAD");
			manifests("2.0.0", "v2.0.0");
			write(
				"migrations/v2.0.0.md",
				migrationNote(
					`node -e 'require("node:fs").appendFileSync(${JSON.stringify(
						log,
					)}, process.cwd() + "\\n")'`,
				),
			);
			git("add", "--all");
			git("commit", "-qm", "bump to v2.0.0");

			const adopter = adopterFixture(tmp, "v1.0.0");
			const r = dryRunAdopter(adopter);
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("  verified v2.0.0");

			const cwds = fs.readFileSync(log, "utf8").trim().split("\n");
			expect(cwds).toHaveLength(2);
			expect(cwds[0]).toBe(fs.realpathSync(dir));
			/* The second run is the COPY the cut made under its own tmpdir,
			 * not the adopter. */
			expect(cwds[1]).not.toBe(adopter);
			expect(cwds[1]).toMatch(/plugin-release-[^/]+\/adopter$/);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	/* #780: the negation case is the one a plain read of `.gitignore` would
	 * have passed. */
	it("gives the adopter copy a git repository, so a Verify's git check-ignore reads the copy's .gitignore (#780)", () => {
		git("tag", "-a", "v1.0.0", "-m", "prior release", "HEAD");
		manifests("2.0.0", "v2.0.0");
		/* Not a path the core's own `.gitignore` block names: every run writes
		 * that block into the copy (#1501), which would ignore it either way. */
		write(".gitignore", "notes/\n");
		write("migrations/v2.0.0.md", migrationNote("git check-ignore -q notes/x"));
		git("add", "--all");
		git("commit", "-qm", "bump to v2.0.0 with a git-calling Verify");

		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dry-run-adopter-"));
		try {
			const adopter = adopterFixture(tmp, "v1.0.0");
			fs.writeFileSync(path.join(adopter, ".gitignore"), "notes/*\n!notes/x\n");
			const negated = dryRunAdopter(adopter);
			expect(negated.status).toBe(1);
			expect(negated.stderr).toMatch(/dry-run adopter walk failed: .*v2\.0\.0/);

			fs.writeFileSync(path.join(adopter, ".gitignore"), "notes/\n");
			const passing = dryRunAdopter(adopter);
			expect(passing.stderr).toBe("");
			expect(passing.status).toBe(0);
			expect(passing.stdout).toContain("  verified v2.0.0");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	/*
	 * #296 review F1: cpSync's defaults copy a symlink AS a symlink and
	 * rewrite a relative target to an absolute one pointing back into the
	 * ORIGINAL, so re-pointing the copy's `.husky/pre-commit` wrote the
	 * caller's real file — #291 reopened, and invisible to the #291 test
	 * above, whose fixture has no symlink.
	 */
	it("follows an adopter's symlinks into the copy, not back out (#296)", () => {
		git("tag", "-a", "v1.0.0", "-m", "prior release", "HEAD");
		manifests("2.0.0", "v2.0.0");
		write("migrations/v2.0.0.md", migrationNote("true"));
		write(
			".husky/pre-commit",
			"#!/bin/sh\nWFC_PLUGIN_ROOT=stale\nexport WFC_PLUGIN_ROOT\nexit 0\n",
		);
		fs.chmodSync(path.join(dir, ".husky/pre-commit"), 0o755);
		git("add", "--all");
		git("commit", "-qm", "bump to v2.0.0 with a hook template");

		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dry-run-adopter-"));
		try {
			const adopter = adopterFixture(tmp, "v1.0.0");
			fs.writeFileSync(
				path.join(adopter, ".claude/workflow-core.json"),
				JSON.stringify({ founder: "F" }),
			);
			/* The real hook lives outside .husky, which holds a RELATIVE
			 * symlink to it — the shape that rewrites to an absolute target. */
			fs.mkdirSync(path.join(adopter, "hooks"), { recursive: true });
			const real = path.join(adopter, "hooks/pre-commit");
			const body = "#!/bin/sh\nWFC_PLUGIN_ROOT=/some/old/checkout\nexit 0\n";
			fs.writeFileSync(real, body);
			fs.chmodSync(real, 0o755);
			fs.mkdirSync(path.join(adopter, ".husky"), { recursive: true });
			fs.symlinkSync(
				"../hooks/pre-commit",
				path.join(adopter, ".husky/pre-commit"),
			);

			const r = dryRunAdopter(adopter);
			expect(r.status).toBe(0);
			expect(fs.readFileSync(real, "utf8")).toBe(body);
			expect(
				fs.lstatSync(path.join(adopter, ".husky/pre-commit")).isSymbolicLink(),
			).toBe(true);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	/*
	 * #296 review F2: with `dryRun` gone, every upgrade syncs labels on the
	 * adopter's own tracker — a live write to a real GitHub repo, which no
	 * dry run may make. The walk turns the labels off instead, so the declared
	 * `tracker` stays in the copy (#1501).
	 */
	it("makes no gh label call for an adopter's labels, and keeps its declared tracker (#296, #1501)", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dry-run-adopter-"));
		const record = path.join(tmp, "calls.txt");
		const stub = stubGhScript(
			tmp,
			`#!/bin/sh\nprintf '%s\\n' "$*" >> "${record}"\nexit 0\n`,
		);
		const prevWfcGh = process.env.WFC_GH;
		process.env.WFC_GH = stub.gh;
		try {
			git("tag", "-a", "v1.0.0", "-m", "prior release", "HEAD");
			manifests("2.0.0", "v2.0.0");
			write("migrations/v2.0.0.md", migrationNote("true", '{"labels": true}'));
			git("add", "--all");
			git("commit", "-qm", "bump to v2.0.0 with label residue");

			const adopter = adopterFixture(tmp, "v1.0.0");
			fs.writeFileSync(
				path.join(adopter, ".claude/workflow-core.json"),
				JSON.stringify({ founder: "F", tracker: "someone/their-real-repo" }),
			);

			const r = dryRunAdopter(adopter);
			expect(r.status).toBe(0);
			const calls = fs.existsSync(record)
				? fs.readFileSync(record, "utf8")
				: "";
			expect(calls).not.toMatch(/\blabel\b/);
			expect(r.stdout).toContain(
				"skipped the labels — a release's dry run writes no labels",
			);
		} finally {
			if (prevWfcGh === undefined) delete process.env.WFC_GH;
			else process.env.WFC_GH = prevWfcGh;
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("refuses where a note's Verify fails against the adopter copy, quoting the Verify output and tagging nothing (#296)", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dry-run-adopter-"));
		try {
			git("tag", "-a", "v1.0.0", "-m", "prior release", "HEAD");
			manifests("2.0.0", "v2.0.0");
			/* Passes against the core, which has a package.json, and fails
			 * against the adopter copy, which does not. */
			write(
				"migrations/v2.0.0.md",
				migrationNote(
					"test -f package.json || { echo no package.json here; exit 1; }",
				),
			);
			git("add", "--all");
			git("commit", "-qm", "bump to v2.0.0");

			const adopter = adopterFixture(tmp, "v1.0.0");
			const r = dryRunAdopter(adopter);
			expect(r.status).toBe(1);
			expect(r.stderr).toMatch(/dry-run adopter walk failed/);
			// The Verify's own output, under the one-line reason (#1268).
			expect(r.stderr).toMatch(
				/v2\.0\.0 Verify failed.*\nno package\.json here/,
			);
			expect(git("tag", "--list", "v2.0.0")).toBe("");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("refuses a --dry-run-adopter path that is not a directory, naming the path (#296)", () => {
		const r = dryRunAdopter("/no/such/adopter");
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(
			/--dry-run-adopter \/no\/such\/adopter is not a directory/,
		);
	});

	describe("the adopter's helper check (#464)", () => {
		const resolverPath = path.resolve(__dirname, "lib/resolve-core.js");
		/* `answer` is what the shipped helper exports; the adopter's check
		 * passes only on 42, so any other value fails it against the render. */
		const helperFixture = (tmp: string, declared: boolean, answer = 42) => {
			write(
				"scripts/lib/helper-surface.json",
				JSON.stringify({ entryPoints: { "scripts/lib/h.js": ["answer"] } }),
			);
			write("scripts/lib/h.js", `module.exports = { answer: ${answer} };\n`);
			git("add", "--all");
			git("commit", "-qm", "ship a surface helper");
			const adopter = adopterFixture(tmp, "v2.0.0");
			fs.copyFileSync(resolverPath, path.join(adopter, "resolve-core.js"));
			fs.writeFileSync(
				path.join(adopter, "check.js"),
				[
					'const path = require("node:path");',
					'const { resolveCore } = require("./resolve-core.js");',
					'const { answer } = require(path.join(resolveCore(), "scripts/lib/h.js"));',
					'if (answer !== 42) console.error("check: answer is", answer);',
					"process.exit(answer === 42 ? 0 : 1);",
				].join("\n"),
			);
			fs.writeFileSync(
				path.join(adopter, ".claude/workflow-core.json"),
				JSON.stringify({
					contract: 1,
					...(declared && { commands: { helper_check: "node check.js" } }),
				}),
			);
			return adopter;
		};
		const withTmp = (body: (tmp: string) => void) => {
			const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helper-check-"));
			try {
				body(tmp);
			} finally {
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		};

		it("passes a declared check that imports through the resolver against the render", () =>
			withTmp((tmp) => {
				const adopter = helperFixture(tmp, true);
				const r = dryRunAdopter(adopter);
				expect(r.stderr).toBe("");
				expect(r.status).toBe(0);
				expect(r.stdout).toContain("helper check: passed (`node check.js`)");
			}));

		it("skips where the adopter declares no helper check", () =>
			withTmp((tmp) => {
				const adopter = helperFixture(tmp, false);
				const r = dryRunAdopter(adopter);
				expect(r.status).toBe(0);
				expect(r.stdout).toContain(
					"helper check: SKIPPED (commands.helper_check is undeclared in .claude/workflow-core.json)",
				);
			}));

		/* A render MISSING the entry point no longer reaches this check —
		 * buildTree refuses it first (lib/surface-closure.js) — so the failing
		 * check is one the render answers wrongly, its output riding under the
		 * refusal. */
		it("refuses the cut where the same check fails against the render, carrying its output", () =>
			withTmp((tmp) => {
				const adopter = helperFixture(tmp, true, 41);
				const r = dryRunAdopter(adopter);
				expect(r.status).toBe(1);
				expect(r.stderr).toMatch(
					/the dry-run adopter's helper check failed \(`node check\.js`\)[\s\S]*check: answer is 41/,
				);
				expect(git("tag", "--list")).toBe("");
			}));
	});

	/* Answers as gh does for each bump-filing step: the open-issue listing
	 * (`listed`, one page as a JSON array, slurped) and the create's
	 * `{number, id}`. A tracker named `forbidden-repo` refuses the create;
	 * one named `garbled-repo` lists a page that is not JSON. */
	const bumpStub = (stubDir: string, record: string, listed = "[]") =>
		stubGhScript(
			stubDir,
			`#!/bin/sh\nprintf '%s\\n' "$*" >> "${record}"\ncase "$*" in\n  *"repos/adopter-b/forbidden-repo/issues -f"*) echo "gh: HTTP 403: Resource not accessible" >&2; exit 1 ;;\n  *garbled-repo/issues\\?*) echo "<html>" ;;\n  *"/issues?"*) printf '%s' '[${listed}]' ;;\n  *"POST repos/"*"/issues -f"*) echo '{"number":100,"id":9100}' ;;\nesac\nexit 0\n`,
		);

	const fileBumps = (gh: string, repos: string) =>
		runInProcess(SCRIPT, ["--file-bump-issues", repos], {
			cwd: dir,
			env: { ...process.env, CLAUDE_PROJECT_DIR: dir, WFC_GH: gh },
		});

	const withBumpStub = (
		listed: string,
		fn: (gh: string, calls: () => string) => void,
	) => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gh-stub-"));
		const record = path.join(tmp, "calls.jsonl");
		try {
			landed();
			fn(bumpStub(tmp, record, listed).gh, () =>
				fs.readFileSync(record, "utf8"),
			);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	};

	it("files one bump issue per adopter tracker, labelled for /pick-next", () =>
		withBumpStub("[]", (gh, calls) => {
			const r = fileBumps(gh, "lucmoseley/workflow-core-dryrun-adopter");
			expect(r.status).toBe(0);
			expect(r.stdout).toContain(
				"filed bump issues: lucmoseley/workflow-core-dryrun-adopter",
			);
			expect(calls()).toContain(
				"api --method POST repos/lucmoseley/workflow-core-dryrun-adopter/issues",
			);
			expect(calls()).toContain("title=Bump workflow-core to v2.3.4");
			expect(calls()).toContain("labels[]=takes:implement");
			expect(calls()).not.toContain("dependencies/blocked_by");
			expect(calls()).not.toContain("walks through the notes");
		}));

	it("files the other trackers' bump issues where one tracker refuses, and reports the retry command (#242)", () =>
		withBumpStub("[]", (gh, calls) => {
			const r = fileBumps(
				gh,
				"adopter-a/repo,adopter-b/forbidden-repo,adopter-c/repo",
			);
			expect(r.status).toBe(1);
			expect(r.stdout).toContain("git push origin v2.3.4");
			expect(r.stdout).toContain(
				"filed bump issues: adopter-a/repo, adopter-c/repo",
			);
			expect(r.stdout).toContain(
				"adopter-b/forbidden-repo (gh: HTTP 403: Resource not accessible)",
			);
			// the way out (§X3, docs/code-standards-base.md)
			expect(r.stdout).toContain(
				"retry: gh api --method POST repos/adopter-b/forbidden-repo/issues",
			);
			expect(calls()).toContain("repos/adopter-c/repo/issues -f");
		}));

	it("exits 0 where every bump issue files cleanly", () =>
		withBumpStub("[]", (gh) => {
			const r = fileBumps(gh, "adopter-a/repo,adopter-c/repo");
			expect(r.status).toBe(0);
			expect(r.stdout).toContain(
				"filed bump issues: adopter-a/repo, adopter-c/repo",
			);
			expect(r.stdout).not.toContain("failed bump issues");
		}));

	const bump = (number: number, tag: string, assignees: string[] = []) => ({
		number,
		id: number * 100,
		title: `Bump workflow-core to ${tag}`,
		assignees,
	});

	it("blocks each unassigned older bump on the new one and names them for its session to close (#2562)", () =>
		withBumpStub(
			JSON.stringify([
				bump(91, "v2.3.2"),
				bump(92, "v2.3.3"),
				{ ...bump(93, "x"), title: "Weekly retro due" },
				{ ...bump(94, "v2.3.3"), pull_request: {} },
			]),
			(gh, calls) => {
				const r = fileBumps(gh, "o/r");
				expect(r.stderr).toBe("");
				expect(r.status).toBe(0);
				expect(calls()).toContain(
					"It walks through the notes of #91, #92 too: close each with a comment naming the bump commit.",
				);
				expect(calls()).toContain(
					"api --method POST repos/o/r/issues/91/dependencies/blocked_by -F issue_id=9100",
				);
				expect(calls()).toContain(
					"api --method POST repos/o/r/issues/92/dependencies/blocked_by -F issue_id=9100",
				);
				expect(calls()).not.toContain("issues/93/dependencies");
				expect(calls()).not.toContain("issues/94/dependencies");
			},
		));

	it("blocks the new bump on an assigned older one, which may already be walking (#2562)", () =>
		withBumpStub(
			JSON.stringify([bump(91, "v2.3.2", ["someone"])]),
			(gh, calls) => {
				const r = fileBumps(gh, "o/r");
				expect(r.status).toBe(0);
				expect(calls()).toContain(
					"api --method POST repos/o/r/issues/100/dependencies/blocked_by -F issue_id=9100",
				);
				expect(calls()).not.toContain("issues/91/dependencies");
				expect(calls()).not.toContain("walks through the notes");
			},
		));

	it("files nothing on a tracker whose open bumps it cannot read, and files the next", () =>
		withBumpStub("[]", (gh, calls) => {
			const r = fileBumps(gh, "o/garbled-repo,o/r");
			expect(r.status).toBe(1);
			expect(r.stdout).toContain("filed bump issues: o/r\n");
			expect(r.stdout).toContain(
				"retry: gh api 'repos/o/garbled-repo/issues?state=open&labels=takes:implement&per_page=100'",
			);
			expect(calls()).not.toContain("repos/o/garbled-repo/issues -f");
		}));
});
