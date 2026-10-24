// @vitest-environment node
/*
 * Tests for the rule-text store's two accessors — scripts/lib/rule-text.js and
 * scripts/lib/rule-text.sh (mantahostels#1644, spec mantahostels#1641).
 *
 * ONE SEAM, asked of both halves: "what text does rule id X print?". The two
 * accessors are only safe to relocate a rule behind if they answer identically.
 * Every guard and gate that prints a rule — the bash `PreToolUse` hooks and the
 * Node Stop hooks and `.husky/pre-commit` checkers alike — prints it through one
 * of them, so a loosened case lets a session be refused on blank or wrong text.
 *
 * Most cases build a throwaway fragment directory and point WFC_RULES_DIR at
 * it. The rest read docs/agents/rules/ itself — the cases run with no override,
 * which leaves the core's layer in force, and the lint over every live
 * placeholder — and only those can an edit to a real fragment turn red.
 *
 * The CLI's id-list form (mantahostels#2494) has no Node twin to assert parity against,
 * since `rule-text.js` exposes no CLI at all.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freshSandbox } from "./arbiter-testkit";

const SH = path.join(__dirname, "rule-text.sh");

// biome-ignore lint/suspicious/noExplicitAny: CommonJS module under test
const lib = require("./rule-text") as any;

const temps: string[] = [];

afterEach(() => {
	for (const t of temps.splice(0))
		fs.rmSync(t, { recursive: true, force: true });
	delete process.env.WFC_RULES_DIR;
	delete process.env.WFC_RULES_FALLBACK_DIR;
	delete process.env.WFC_SCRIPT_ROOT;
});

/** A throwaway store, `id` → fragment body, returned as its absolute path. */
function store(fragments: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rule-text-"));
	temps.push(dir);
	for (const [name, body] of Object.entries(fragments))
		fs.writeFileSync(path.join(dir, name), body);
	process.env.WFC_RULES_DIR = dir;
	return dir;
}

/** The bash accessor, run as the command form. */
function sh(dir: string, ...args: string[]) {
	const r = spawnSync("bash", [SH, ...args], {
		encoding: "utf8",
		env: { ...process.env, WFC_RULES_DIR: dir },
	});
	return { code: r.status, out: r.stdout, err: r.stderr };
}

const PATHSPEC =
	"Commit by pathspec, never `git add` first.\n\nThe index is repo-global.\n";

describe("resolving an id to its text", () => {
	it("Node returns the fragment body with trailing newlines trimmed", () => {
		store({ "commit-pathspec.txt": PATHSPEC });
		expect(lib.ruleText("commit-pathspec")).toBe(
			"Commit by pathspec, never `git add` first.\n\nThe index is repo-global.",
		);
	});

	it("bash returns the same bytes for the same id", () => {
		const dir = store({ "commit-pathspec.txt": PATHSPEC });
		const r = sh(dir, "commit-pathspec");
		expect(r.code).toBe(0);
		/* The command form adds the newline a terminal wants; the sourced
		 * function does not, which is what the parity case below pins. */
		expect(r.out).toBe(`${lib.ruleText("commit-pathspec")}\n`);
	});

	it("the sourced function and the Node accessor agree byte for byte", () => {
		const dir = store({
			"file-claim.txt": "A file a live session has written is taken.\n\n\n",
		});
		const r = spawnSync(
			"bash",
			["-c", `source "${SH}"; rule_text file-claim | od -An -c | tr -d " \\n"`],
			{ encoding: "utf8", env: { ...process.env, WFC_RULES_DIR: dir } },
		);
		const nodeBytes = spawnSync("bash", ["-c", "od -An -c | tr -d ' \\n'"], {
			encoding: "utf8",
			input: lib.ruleText("file-claim"),
		});
		expect(r.stdout).toBe(nodeBytes.stdout);
	});

	it("preserves interior whitespace, which is the fragment author's own", () => {
		store({ "shape.txt": "  indented\n\n\ttabbed\n" });
		expect(lib.ruleText("shape")).toBe("  indented\n\n\ttabbed");
	});
});

describe("refusing loudly on an unknown id", () => {
	it("Node throws, naming the id and what the store does hold", () => {
		store({ "file-claim.txt": "x" });
		expect(() => lib.ruleText("no-such-rule")).toThrow(/no-such-rule/);
		expect(() => lib.ruleText("no-such-rule")).toThrow(/Known ids: file-claim/);
	});

	it("Node says the store is empty rather than listing nothing", () => {
		store({});
		expect(() => lib.ruleText("file-claim")).toThrow(/holds no fragments/);
	});

	it("bash exits non-zero and puts the message on stderr, not stdout, naming the id and the known ids", () => {
		const dir = store({ "file-claim.txt": "x" });
		const r = sh(dir, "no-such-rule");
		expect(r.code).toBe(1);
		expect(r.out).toBe("");
		expect(r.err).toMatch(/no fragment for rule id "no-such-rule"/);
		expect(r.err).toMatch(/Known ids: file-claim/);
	});

	it("the sourced function returns 1 without exiting its caller", () => {
		const dir = store({});
		const r = spawnSync(
			"bash",
			[
				"-c",
				`source "${SH}"; rule_text nope 2>/dev/null || echo "returned $?"; echo alive`,
			],
			{ encoding: "utf8", env: { ...process.env, WFC_RULES_DIR: dir } },
		);
		/* A guard sources this. An `exit` here would abort the guard mid-hook,
		 * which is a refusal the session never sees a reason for. */
		expect(r.stdout).toBe("returned 1\nalive\n");
	});
});

describe("refusing an empty fragment", () => {
	/* The failure the store exists to prevent, and the one route the id check
	 * cannot see: the id resolves, and the guard denies a session with "". */
	it("Node throws rather than returning the empty string", () => {
		store({ "file-claim.txt": "\n\n   \n" });
		expect(() => lib.ruleText("file-claim")).toThrow(/is empty/);
	});

	it("bash exits non-zero rather than printing nothing", () => {
		const dir = store({ "file-claim.txt": "" });
		const r = sh(dir, "file-claim");
		expect(r.code).toBe(1);
		expect(r.out).toBe("");
		expect(r.err).toMatch(/is empty/);
	});
});

describe("accepting the prefixed spelling the trigger indexes hand out", () => {
	it("Node resolves rule:<id> to the same bytes as the bare id", () => {
		store({ "commit-pathspec.txt": PATHSPEC });
		expect(lib.ruleText("rule:commit-pathspec")).toBe(
			lib.ruleText("commit-pathspec"),
		);
	});

	it("bash resolves rule:<id> to the same bytes, exit 0", () => {
		const dir = store({ "commit-pathspec.txt": PATHSPEC });
		const prefixed = sh(dir, "rule:commit-pathspec");
		expect(prefixed.code).toBe(0);
		expect(prefixed.out).toBe(sh(dir, "commit-pathspec").out);
	});

	it("the CLI list takes either spelling and heads both with the bare id", () => {
		const dir = store({
			"commit-pathspec.txt": PATHSPEC,
			"push-cadence.txt": "Push when the suite is green.\n",
		});
		const r = sh(dir, "rule:commit-pathspec", "push-cadence");
		expect(r.code).toBe(0);
		expect(r.out).toBe(sh(dir, "commit-pathspec", "push-cadence").out);
		expect(r.out).toContain("## commit-pathspec");
		expect(r.out).not.toContain("## rule:");
	});

	it("an unknown id prefixed still refuses, naming the bare id it looked for", () => {
		const dir = store({ "commit-pathspec.txt": PATHSPEC });
		expect(() => lib.ruleText("rule:nope")).toThrow(
			/no fragment for rule id "nope"/,
		);
		const r = sh(dir, "rule:nope");
		expect(r.code).toBe(1);
		expect(r.err).toMatch(/no fragment for rule id "nope"/);
	});

	/* The list path passes ids on AS GIVEN so that `rule_text` strips once and
	 * only once. Stripping in the loop as well let `rule:rule:x` resolve on this
	 * path while the single-argument form refused it. */
	it("the LIST path refuses a double prefix, as the single-argument form does, saying it is not a rule id and printing nothing", () => {
		const dir = store({
			"commit-pathspec.txt": PATHSPEC,
			"push-cadence.txt": "Push when the suite is green.\n",
		});
		const r = sh(dir, "rule:rule:commit-pathspec", "push-cadence");
		expect(r.code).toBe(1);
		expect(r.err).toMatch(/is not a rule id/);
		expect(r.out).toBe("");
	});

	it("the LIST path quotes a bad id as given, as the single-argument form does", () => {
		const dir = store({
			"commit-pathspec.txt": PATHSPEC,
			"push-cadence.txt": "Push when the suite is green.\n",
		});
		const r = sh(dir, "rule:../outside", "push-cadence");
		expect(r.code).toBe(1);
		expect(r.err).toContain('"rule:../outside"');
	});

	/* Stripping happens BEFORE the grammar and before any path join, so the
	 * prefix can never smuggle a traversal or a second prefix through. */
	for (const id of ["rule:../outside", "rule:rule:commit-pathspec"]) {
		it(`Node refuses ${JSON.stringify(id)}, quoting it as given`, () => {
			store({ "commit-pathspec.txt": PATHSPEC });
			expect(() => lib.ruleText(id)).toThrow(/is not a rule id/);
			expect(() => lib.ruleText(id)).toThrow(
				new RegExp(`"${id.replace(/\./g, "\\.")}"`),
			);
		});

		it(`bash refuses ${JSON.stringify(id)} the same way, as not a rule id, quoting it`, () => {
			const dir = store({ "commit-pathspec.txt": PATHSPEC });
			const r = sh(dir, id);
			expect(r.code).toBe(1);
			expect(r.err).toMatch(/is not a rule id/);
			expect(r.err).toContain(`"${id}"`);
		});
	}
});

describe("the id grammar is the path-traversal defence", () => {
	const bad = [
		"../../etc/passwd",
		"Commit-Pathspec",
		"commit pathspec",
		"",
		"commit_pathspec",
		"commit-pathspec.txt",
	];

	for (const id of bad) {
		it(`Node refuses ${JSON.stringify(id)} as an id rather than resolving it`, () => {
			store({ "commit-pathspec.txt": PATHSPEC });
			expect(() => lib.ruleText(id)).toThrow(/is not a rule id/);
		});

		it(`bash refuses ${JSON.stringify(id)} the same way, as not a rule id`, () => {
			const dir = store({ "commit-pathspec.txt": PATHSPEC });
			const r = sh(dir, id);
			expect(r.code).toBe(1);
			expect(r.err).toMatch(/is not a rule id/);
		});
	}

	/* A non-string never reaches the prefix strip, so it must still be refused as
	 * an id rather than stringified into one — `String(null)` is "null", which
	 * the grammar accepts. */
	for (const id of [null, undefined, 42, {}]) {
		it(`Node refuses ${JSON.stringify(id) ?? "undefined"} as an id`, () => {
			store({ "commit-pathspec.txt": PATHSPEC });
			expect(() => lib.ruleText(id)).toThrow(/is not a rule id/);
		});
	}

	it("a traversal id cannot read a file that exists outside the store", () => {
		const dir = store({});
		fs.writeFileSync(path.join(dir, "..", "outside.txt"), "secret");
		temps.push(path.join(dir, "..", "outside.txt"));
		expect(() => lib.ruleText("../outside")).toThrow(/is not a rule id/);
	});
});

describe("the CLI form resolving an id list", () => {
	it("prints each fragment under a heading naming its id, in the order given", () => {
		const dir = store({
			"commit-pathspec.txt": PATHSPEC,
			"file-claim.txt": "A file a live session has written is taken.\n",
			"branch-shared-tree.txt": "The shared tree stays on main.\n",
		});
		const r = sh(dir, "file-claim", "commit-pathspec", "branch-shared-tree");
		expect(r.code).toBe(0);
		expect(r.out).toBe(
			"## file-claim\n\nA file a live session has written is taken.\n\n" +
				"## commit-pathspec\n\nCommit by pathspec, never `git add` first.\n\nThe index is repo-global.\n\n" +
				"## branch-shared-tree\n\nThe shared tree stays on main.\n",
		);
	});

	it("an unknown id FIRST refuses and prints nothing of the ones after it", () => {
		const dir = store({ "file-claim.txt": "x", "branch-shared-tree.txt": "y" });
		const r = sh(dir, "no-such-rule", "file-claim", "branch-shared-tree");
		expect(r.code).toBe(1);
		expect(r.out).toBe("");
		expect(r.err).toMatch(/no fragment for rule id "no-such-rule"/);
	});

	it("an unknown id in the MIDDLE still suppresses the fragment before it", () => {
		const dir = store({ "file-claim.txt": "x", "branch-shared-tree.txt": "y" });
		const r = sh(dir, "file-claim", "no-such-rule", "branch-shared-tree");
		expect(r.code).toBe(1);
		expect(r.out).toBe("");
	});

	it("an unknown id LAST still suppresses every fragment before it", () => {
		const dir = store({ "file-claim.txt": "x", "branch-shared-tree.txt": "y" });
		const r = sh(dir, "file-claim", "branch-shared-tree", "no-such-rule");
		expect(r.code).toBe(1);
		expect(r.out).toBe("");
	});

	it("--ids still lists ids rather than resolving fragments, and a zero-argument call still exits 2", () => {
		const dir = store({ "file-claim.txt": "x", "branch-shared-tree.txt": "y" });
		const idsResult = sh(dir, "--ids");
		expect(idsResult.code).toBe(0);
		expect(idsResult.out.trim().split("\n")).toEqual([
			"branch-shared-tree",
			"file-claim",
		]);
		const r = sh(dir);
		expect(r.code).toBe(2);
		expect(r.err).toMatch(/usage:/);
	});
});

describe("enumerating the store", () => {
	it("lists fragment ids sorted, ignoring everything that is not one", () => {
		store({
			"file-claim.txt": "x",
			"branch-shared-tree.txt": "y",
			"README.md": "not a fragment",
			"notes.json": "{}",
			"Bad-Id.txt": "ignored — the grammar refuses it",
		});
		expect(lib.ruleIds()).toEqual(["branch-shared-tree", "file-claim"]);
	});

	it("bash --ids agrees with the Node enumeration", () => {
		const dir = store({ "file-claim.txt": "x", "branch-shared-tree.txt": "y" });
		expect(sh(dir, "--ids").out.trim().split("\n")).toEqual(lib.ruleIds());
	});

	it("a store directory that does not exist is empty, not an error", () => {
		const dir = store({});
		process.env.WFC_RULES_DIR = path.join(dir, "absent");
		expect(lib.ruleIds()).toEqual([]);
		expect(sh(path.join(dir, "absent"), "--ids").code).toBe(0);
	});
});

describe("layering the host's store over the core's", () => {
	function layered() {
		const host = store({
			"mine.txt": "host text\n",
			"both.txt": "host wins\n",
		});
		const core = store({
			"core.txt": "core text\n",
			"both.txt": "core loses\n",
		});
		process.env.WFC_RULES_DIR = host;
		process.env.WFC_RULES_FALLBACK_DIR = core;
		return { host, core };
	}
	const shLayered = (host: string, core: string, ...args: string[]) => {
		const r = spawnSync("bash", [SH, ...args], {
			encoding: "utf8",
			env: {
				...process.env,
				WFC_RULES_DIR: host,
				WFC_RULES_FALLBACK_DIR: core,
			},
		});
		return { code: r.status, out: r.stdout, err: r.stderr };
	};

	it("Node resolves an id only the core's layer holds, and the host's copy wins", () => {
		layered();
		expect(lib.ruleText("core")).toBe("core text");
		expect(lib.ruleText("mine")).toBe("host text");
		expect(lib.ruleText("both")).toBe("host wins");
		expect(lib.ruleIds()).toEqual(["both", "core", "mine"]);
	});

	it("bash answers the same, list and single form alike", () => {
		const { host, core } = layered();
		expect(shLayered(host, core, "core").out.trimEnd()).toBe("core text");
		expect(shLayered(host, core, "both").out.trimEnd()).toBe("host wins");
		expect(shLayered(host, core, "--ids").out.trim().split("\n")).toEqual([
			"both",
			"core",
			"mine",
		]);
	});

	it("the manifest stays the host's, where the generator writes it", () => {
		const { host } = layered();
		expect(lib.manifestPath()).toBe(path.join(host, "manifest.json"));
	});

	it("an override with no fallback named inherits nothing", () => {
		const { host } = layered();
		delete process.env.WFC_RULES_FALLBACK_DIR;
		expect(lib.ruleIds()).toEqual(["both", "mine"]);
		expect(sh(host, "core").code).not.toBe(0);
	});

	it("with no override, an adopter holding its own store still prints a core fragment", () => {
		const adopter = fs.mkdtempSync(
			path.join(os.tmpdir(), "rule-text-adopter-"),
		);
		temps.push(adopter);
		const own = path.join(adopter, "docs", "agents", "rules");
		fs.mkdirSync(own, { recursive: true });
		fs.writeFileSync(path.join(own, "mine.txt"), "host text\n");
		const coreId = fs
			.readdirSync(path.join(__dirname, "..", "..", "docs", "agents", "rules"))
			.find((f) => f.endsWith(".txt"))
			?.slice(0, -4);
		expect(coreId).toBeTruthy();
		const env: NodeJS.ProcessEnv = {
			...process.env,
			CLAUDE_PROJECT_DIR: adopter,
		};
		delete env.WFC_RULES_DIR;
		delete env.WFC_RULES_FALLBACK_DIR;
		for (const id of ["mine", coreId as string]) {
			const r = spawnSync("bash", [SH, id], { encoding: "utf8", env });
			expect(r.status, r.stderr).toBe(0);
			const n = spawnSync(
				"node",
				[
					"-e",
					`process.stdout.write(require(${JSON.stringify(path.join(__dirname, "rule-text.js"))}).ruleText(${JSON.stringify(id)}))`,
				],
				{ encoding: "utf8", env },
			);
			expect(n.stdout).toBe(r.stdout.trimEnd());
		}
	});
});

describe("qualifying a core fragment's citations outside the core (#416)", () => {
	const citing =
		"Commit first (#12, mantahostels#12). Write `Refs #12` instead.\n";
	function layers() {
		const host = store({ "mine.txt": "Mine (#12).\n" });
		const core = store({ "core.txt": citing });
		process.env.WFC_RULES_DIR = host;
		process.env.WFC_RULES_FALLBACK_DIR = core;
	}
	/** An install: a core root holding no package.json. */
	function install() {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "rule-text-install-"));
		temps.push(root);
		process.env.WFC_SCRIPT_ROOT = root;
	}
	const shNow = (...args: string[]) =>
		spawnSync("bash", [SH, ...args], { encoding: "utf8", env: process.env });

	it("in an install, both twins qualify a bare #N and leave the rest", () => {
		layers();
		install();
		const want =
			"Commit first (workflow-core#12, mantahostels#12). Write `Refs #12` instead.";
		expect(lib.ruleText("core")).toBe(want);
		expect(shNow("core").stdout).toBe(`${want}\n`);
	});

	it("in an install, the host's own fragment stays bare", () => {
		layers();
		install();
		expect(lib.ruleText("mine")).toBe("Mine (#12).");
		expect(shNow("mine").stdout).toBe("Mine (#12).\n");
	});

	it("in an install, bash prints the fragment unqualified where node fails", () => {
		layers();
		install();
		const bin = fs.mkdtempSync(path.join(os.tmpdir(), "rule-text-bin-"));
		temps.push(bin);
		fs.writeFileSync(path.join(bin, "node"), "#!/bin/sh\nexit 1\n", {
			mode: 0o755,
		});
		const r = spawnSync("bash", [SH, "core"], {
			encoding: "utf8",
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toBe(citing);
	});

	it("in an install with no override, a live core fragment is qualified alike by both twins", () => {
		const adopter = fs.mkdtempSync(
			path.join(os.tmpdir(), "rule-text-adopter-"),
		);
		temps.push(adopter);
		install();
		const liveDir = path.join(__dirname, "..", "..", "docs", "agents", "rules");
		const id = fs
			.readdirSync(liveDir)
			.find(
				(f) =>
					f.endsWith(".txt") &&
					/\(#\d+\)/.test(fs.readFileSync(path.join(liveDir, f), "utf8")),
			)
			?.slice(0, -4);
		expect(id).toBeTruthy();
		const env: NodeJS.ProcessEnv = {
			...process.env,
			CLAUDE_PROJECT_DIR: adopter,
		};
		delete env.WFC_RULES_DIR;
		delete env.WFC_RULES_FALLBACK_DIR;
		const r = spawnSync("bash", [SH, id as string], { encoding: "utf8", env });
		const n = spawnSync(
			"node",
			[
				"-e",
				`process.stdout.write(require(${JSON.stringify(path.join(__dirname, "rule-text.js"))}).ruleText(${JSON.stringify(id)}))`,
			],
			{ encoding: "utf8", env },
		);
		expect(n.stdout).toMatch(/\(workflow-core#\d+\)/);
		expect(r.stdout.trimEnd()).toBe(n.stdout);
	});

	it("in the core's checkout, a core fragment is byte-identical", () => {
		layers();
		expect(lib.ruleText("core")).toBe(citing.trimEnd());
		expect(shNow("core").stdout).toBe(citing);
	});
});

describe("the twins agree on what they cannot read or spell alike (#101)", () => {
	/** The bash twin's refusal and exit, with both variables as given. */
	const shEnv = (
		env: Record<string, string>,
		cwd: string,
		...args: string[]
	) => {
		const r = spawnSync("bash", [SH, ...args], {
			encoding: "utf8",
			cwd,
			env: { ...process.env, ...env },
		});
		return { code: r.status, out: r.stdout, err: r.stderr };
	};
	const lookedIn = (msg: string) => /\(looked in ([^)]*)\)/.exec(msg)?.[1];

	it("a fallback spelled differently from the primary dedupes in both", () => {
		const host = store({ "a.txt": "x" });
		const spelling = `${host}/../${path.basename(host)}/`;
		process.env.WFC_RULES_FALLBACK_DIR = spelling;
		expect(() => lib.ruleText("absent")).toThrow(`(looked in ${host})`);
		const r = shEnv(
			{ WFC_RULES_DIR: host, WFC_RULES_FALLBACK_DIR: spelling },
			os.tmpdir(),
			"absent",
		);
		expect(lookedIn(r.err)).toBe(host);
	});

	it("a relative override resolves against the working directory in both", () => {
		const host = store({ "a.txt": "x" });
		const parent = path.dirname(host);
		const rel = path.basename(host);
		// A vitest worker cannot process.chdir, so the Node half runs in a child.
		const n = spawnSync(
			"node",
			[
				"-e",
				`try { require(${JSON.stringify(path.join(__dirname, "rule-text.js"))}).ruleText("absent") } catch (e) { process.stdout.write(e.message) }`,
			],
			{
				encoding: "utf8",
				cwd: parent,
				env: { ...process.env, WFC_RULES_DIR: rel, WFC_RULES_FALLBACK_DIR: "" },
			},
		);
		const r = shEnv(
			{ WFC_RULES_DIR: rel, WFC_RULES_FALLBACK_DIR: "" },
			parent,
			"absent",
		);
		expect(lookedIn(n.stdout)).toBe(host);
		expect(lookedIn(r.err)).toBe(host);
	});

	it("a layer that is a file, not a directory, refuses in both, naming the layer", () => {
		const host = store({ "a.txt": "x" });
		const file = path.join(host, "a.txt");
		process.env.WFC_RULES_FALLBACK_DIR = file;
		expect(() => lib.ruleIds()).toThrow(/ENOTDIR/);
		const r = shEnv(
			{ WFC_RULES_DIR: host, WFC_RULES_FALLBACK_DIR: file },
			os.tmpdir(),
			"--ids",
		);
		expect(r.code).toBe(1);
		expect(r.out).toBe("");
		expect(r.err).toContain(file);
	});

	it.skipIf(process.getuid?.() === 0)(
		"an unreadable layer refuses in both",
		() => {
			const host = store({ "a.txt": "x" });
			const locked = store({ "b.txt": "y" });
			process.env.WFC_RULES_DIR = host;
			process.env.WFC_RULES_FALLBACK_DIR = locked;
			fs.chmodSync(locked, 0o000);
			try {
				expect(() => lib.ruleIds()).toThrow(/EACCES/);
				const r = shEnv(
					{ WFC_RULES_DIR: host, WFC_RULES_FALLBACK_DIR: locked },
					os.tmpdir(),
					"--ids",
				);
				expect(r.code).toBe(1);
				expect(r.err).toContain(locked);
			} finally {
				fs.chmodSync(locked, 0o700);
			}
		},
	);

	// Bites only where en_US.UTF-8 is installed; without it bash falls back to C.
	it("both enumerate in byte order, whatever the locale", () => {
		const dir = store({ "ab.txt": "x", "a-c.txt": "y", "a0.txt": "z" });
		expect(lib.ruleIds()).toEqual(["a-c", "a0", "ab"]);
		const r = shEnv(
			{ WFC_RULES_DIR: dir, LC_ALL: "en_US.UTF-8" },
			os.tmpdir(),
			"--ids",
		);
		expect(r.out.trim().split("\n")).toEqual(lib.ruleIds());
	});

	it("a missing id's refusal reads the same from both", () => {
		const dir = store({ "a.txt": "x" });
		let node = "";
		try {
			lib.ruleText("absent");
		} catch (e) {
			node = (e as Error).message;
		}
		expect(sh(dir, "absent").err.trimEnd()).toBe(node);
	});

	it("a file where the host's store belongs falls through to the core in both", () => {
		const adopter = fs.mkdtempSync(path.join(os.tmpdir(), "rule-text-file-"));
		temps.push(adopter);
		fs.mkdirSync(path.join(adopter, "docs", "agents"), { recursive: true });
		fs.writeFileSync(path.join(adopter, "docs", "agents", "rules"), "");
		const env: NodeJS.ProcessEnv = {
			...process.env,
			CLAUDE_PROJECT_DIR: adopter,
		};
		delete env.WFC_RULES_DIR;
		delete env.WFC_RULES_FALLBACK_DIR;
		const n = spawnSync(
			"node",
			[
				"-e",
				`process.stdout.write(require(${JSON.stringify(path.join(__dirname, "rule-text.js"))}).rulesDir())`,
			],
			{ encoding: "utf8", env },
		);
		expect(n.stdout).toBe(lib.CORE_RULES);
		expect(
			spawnSync("bash", [SH, "--ids"], { encoding: "utf8", env }).status,
		).toBe(0);
	});
});

describe("{command:<name>} names the host's own command (#742)", () => {
	const declared = process.env.CLAUDE_PROJECT_DIR;
	afterEach(() => {
		if (declared === undefined) delete process.env.CLAUDE_PROJECT_DIR;
		else process.env.CLAUDE_PROJECT_DIR = declared;
	});

	/** A host root declaring `commands`, or no config at all for null. */
	function host(commands: Record<string, string> | null) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rule-text-host-"));
		temps.push(dir);
		if (commands) {
			fs.mkdirSync(path.join(dir, ".claude"));
			fs.writeFileSync(
				path.join(dir, ".claude", "workflow-core.json"),
				JSON.stringify({ contract: 1, commands }),
			);
		}
		process.env.CLAUDE_PROJECT_DIR = dir;
	}

	function both(id: string) {
		const r = spawnSync("bash", ["-c", `source "${SH}"; rule_text ${id}`], {
			encoding: "utf8",
			env: process.env,
		});
		expect(r.stderr).toBe("");
		return { bash: r.stdout, node: lib.ruleText(id) };
	}

	const recipe = "Run:\n  {command:test}\n  {command:typecheck}\n  git push";

	it("names a declared command and drops the line of an undeclared one", () => {
		store({ "recipe.txt": recipe });
		host({ test: "pytest -q" });
		const r = both("recipe");
		expect(r.node).toBe("Run:\n  pytest -q\n  git push");
		expect(r.bash).toBe(r.node);
	});

	it("drops every such line where the host has no config", () => {
		store({ "recipe.txt": recipe });
		host(null);
		const r = both("recipe");
		expect(r.node).toBe("Run:\n  git push");
		expect(r.bash).toBe(r.node);
	});

	it("the twins agree on every name's default where the host declares none (#810)", () => {
		// The shell asks node only for push_check, so a default added for any
		// other name in workflow-core-config.js reddens here, not in a host.
		const { COMMANDS } = require("./workflow-core-config.js");
		store({
			"recipe.txt": COMMANDS.map((n: string) => `{command:${n}}`).join("\n"),
		});
		host(null);
		const r = both("recipe");
		expect(r.node).toContain("push-check.js");
		expect(r.bash).toBe(r.node);
	});

	it("says so, and declares nothing, where the host's config does not parse", () => {
		store({ "recipe.txt": recipe });
		host({});
		fs.writeFileSync(
			path.join(
				process.env.CLAUDE_PROJECT_DIR as string,
				".claude",
				"workflow-core.json",
			),
			"{ not json",
		);
		const r = spawnSync("bash", ["-c", `source "${SH}"; rule_text recipe`], {
			encoding: "utf8",
			env: process.env,
		});
		expect(r.stdout).toBe("Run:\n  git push");
		expect(r.stderr).toMatch(/does not parse/);
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			expect(lib.ruleText("recipe")).toBe("Run:\n  git push");
			expect(String(write.mock.calls[0]?.[0])).toMatch(
				/does not parse.*\{command:\} line dropped/,
			);
		} finally {
			write.mockRestore();
		}
	});

	it("every placeholder in the live store names a command the config can declare", () => {
		const { COMMANDS } = require("./workflow-core-config.js");
		const live = path.resolve(__dirname, "../../docs/agents/rules");
		for (const f of fs.readdirSync(live).filter((n) => n.endsWith(".txt")))
			for (const [, name] of fs
				.readFileSync(path.join(live, f), "utf8")
				.matchAll(/\{command:([a-z_]+)\}/g))
				expect(COMMANDS, `${f} names {command:${name}}`).toContain(name);
	});

	it("puts a command in verbatim, never expanding what it holds", () => {
		// `&` is bash's replacement back-reference under patsub_replacement, and a
		// command spelling the placeholder itself must not be expanded again.
		store({ "recipe.txt": "a {command:test} b {command:lint}" });
		host({ test: "x && y {command:lint}", lint: "z" });
		const r = both("recipe");
		expect(r.node).toBe("a x && y {command:lint} b z");
		expect(r.bash).toBe(r.node);
	});
});

describe("ruleTextOr, for a guard that must not crash (#1044)", () => {
	const sb = freshSandbox();
	const logged = () =>
		fs.existsSync(sb.errorLog()) ? fs.readFileSync(sb.errorLog(), "utf8") : "";

	it("answers the fragment where it reads, logging nothing", () => {
		store({ "a-rule.txt": "The rule.\n" });
		expect(lib.ruleTextOr("a-rule", "Short.", "guard-x")).toBe("The rule.");
		expect(logged()).toBe("");
	});

	it("answers the fallback and the pointer where it cannot, and logs under the label", () => {
		store({});
		expect(lib.ruleTextOr("a-rule", "Short.", "guard-x")).toBe(
			"Short. The rule itself could not be read here. The full rule: `scripts/lib/rule-text.sh a-rule`.",
		);
		expect(logged()).toContain("guard-x rule-text a-rule");
	});

	it("resolves the pointer through the plugin root in an install", () => {
		store({});
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "rule-text-install-"));
		temps.push(root);
		process.env.WFC_SCRIPT_ROOT = root;
		expect(lib.ruleTextOr("rule:a-rule", "Short.", "guard-x")).toContain(
			`${path.join(root, "scripts/lib/rule-text.sh")} a-rule\``,
		);
	});
});
