// @vitest-environment node
/*
 * The host-root seam under a plugin install (#1): pins that every rooted
 * script, loaded from a plugin cache, resolves and reads the host repository
 * and never the cache.
 *
 * Breaking it ships adopters a core whose scripts read the plugin cache's tree
 * as if it were theirs — its rule store, its origin remote, its arbiter state —
 * with no error, since the cache answers as a repository.
 *
 * THE SHAPE IT REPRODUCES. The core's files are copied to a plugin-cache-shaped
 * path OUTSIDE the host repository, and that cache is itself made a git
 * repository — the trap. A script that roots at its own location then resolves
 * the CACHE and every host read lands there; a script that goes through the seam
 * resolves the host, because the working directory is the host and
 * CLAUDE_PROJECT_DIR is unset. Both limbs of the seam are exercised: unset, and
 * set to a symlink with a trailing slash.
 *
 * WHY A GIT REPOSITORY AT THE CACHE (finding F23). A cache that IS a repository
 * fails SILENTLY, answering with the wrong tree, so that is what this fixture
 * builds.
 *
 * THE GENERIC ASSERTION. Every JS or TS script that requires the seam is
 * loaded in a child process whose `fs` reads are recorded, with the working
 * directory at the host. Nothing it reads may sit inside the cache unless it
 * sits under the cache's own `scripts/` — a core file shipping beside the
 * caller, which is what `__dirname` is still for. Its subprocesses are recorded
 * too, and a `git` aimed anywhere inside the cache — by `cwd` or by `-C` — is a
 * stray even under `scripts/`: F23's fault is a git that asks the cache's
 * repository, whichever of its directories it asks from.
 *
 * WHAT IT DOES NOT ASSERT: that the script RUNS against the fixture host. Some
 * do real work at require time and fail on a host that has no settings.json and
 * no ledger, which is a fact about the fixture and not about rooting. The probe
 * therefore writes its record to a FILE rather than stdout, so a script's own
 * output cannot corrupt it.
 *
 * ITS BOUND. Reads made while the script loads and runs to its own exit, through
 * `readFileSync`, `existsSync`, `readdirSync`, `statSync` and `realpathSync`, and
 * subprocesses started through `child_process`'s sync and callback forms. Unseen:
 * `fs.promises` and the callback `fs` forms, a function body the run never
 * calls, and what a subprocess reads on its own. Shell `gr_root` callers are
 * covered for F23 and F24 only, and Python callers not at all — the byte
 * identity of the three halves is `host-root-byte-identity.test.ts`'s.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");

let tmp: string;
/** The plugin cache: the core's files, outside the host, in their own repo. */
let cache: string;
/** The adopter's repository. */
let host: string;
/** A symlink to the host, for the dereference limb. */
let hostLink: string;
let probe: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });

/**
 * The environment a plugin-installed script meets: no CLAUDE_PROJECT_DIR, and a
 * HOME of its own. HOME is redirected because several of these scripts sweep
 * the machine's own Claude transcript corpus, which is gigabytes here and is
 * not this fixture's subject.
 */
const hostEnv = (extra: NodeJS.ProcessEnv = {}) => {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: path.join(tmp, "home"),
		...extra,
	};
	if (!("CLAUDE_PROJECT_DIR" in extra)) delete env.CLAUDE_PROJECT_DIR;
	delete env.WFC_REPO_ROOT;
	/* The suite's setup file defaults WFC_RULES_DIR to THIS checkout's store, so
	 * that a guard run against a throwaway fixture host still finds one. Here the
	 * resolution IS the subject — F24 asks which tree the store came from — and an
	 * inherited override would answer for it. */
	delete env.WFC_RULES_DIR;
	return env;
};

beforeAll(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wfc-plugin-")));
	fs.mkdirSync(path.join(tmp, "home"), { recursive: true });

	cache = path.join(tmp, "plugins", "cache", "workflow-core@1.0.0");
	fs.mkdirSync(cache, { recursive: true });
	fs.cpSync(path.join(REPO, "scripts"), path.join(cache, "scripts"), {
		recursive: true,
		filter: (src) => !src.includes("__pycache__"),
	});
	git(cache, "init", "-q");
	git(cache, "config", "user.email", "cache@example.invalid");
	git(cache, "config", "user.name", "Cache");
	/* A plugin install has no node_modules of its own; the suite's requires still
	 * need to resolve, so the real tree is linked rather than copied. */
	fs.symlinkSync(
		path.join(REPO, "node_modules"),
		path.join(cache, "node_modules"),
	);

	host = path.join(tmp, "adopter");
	fs.mkdirSync(path.join(host, "docs", "agents", "rules"), { recursive: true });
	fs.mkdirSync(path.join(host, ".claude"), { recursive: true });
	fs.writeFileSync(path.join(host, "CLAUDE.md"), "# Adopter\n");
	fs.writeFileSync(
		path.join(host, ".claude", "workflow-core.json"),
		JSON.stringify({
			contract: 1,
			login: "owner",
			tracker: "owner/repo",
			name: "adopter",
		}),
	);
	fs.writeFileSync(
		path.join(host, "docs", "agents", "rules", "adopter-rule.txt"),
		"THE ADOPTER'S OWN RULE.\n",
	);
	git(host, "init", "-q");
	git(host, "config", "user.email", "adopter@example.invalid");
	git(host, "config", "user.name", "Adopter");
	git(host, "remote", "add", "origin", "git@github.com:owner/repo.git");
	git(host, "add", "-A");
	git(host, "commit", "-qm", "first");

	hostLink = path.join(tmp, "adopter-link");
	fs.symlinkSync(host, hostLink);

	probe = path.join(tmp, "probe.cjs");
	fs.writeFileSync(
		probe,
		`const fs = require("node:fs");
const cp = require("node:child_process");
const reads = [];
const gits = [];
for (const fn of ["readFileSync", "existsSync", "readdirSync", "statSync", "realpathSync"]) {
	const orig = fs[fn];
	fs[fn] = (p, ...rest) => {
		if (typeof p === "string") reads.push(p);
		return orig.call(fs, p, ...rest);
	};
}
/* Where each git subprocess asks from: its cwd, and every -C argument. */
for (const fn of ["spawnSync", "execFileSync", "spawn", "execFile", "execSync", "exec"]) {
	const orig = cp[fn];
	cp[fn] = (cmd, ...rest) => {
		const args = Array.isArray(rest[0]) ? rest[0] : [];
		const opts = rest.find((r) => r && typeof r === "object" && !Array.isArray(r)) || {};
		const words = typeof cmd === "string" && !args.length ? cmd.split(" ").filter(Boolean) : [cmd, ...args];
		if (String(words[0]).split("/").pop() === "git") {
			gits.push(typeof opts.cwd === "string" ? opts.cwd : process.cwd());
			words.forEach((w, i) => {
				if (w === "-C" && typeof words[i + 1] === "string") gits.push(words[i + 1]);
			});
		}
		return orig.call(cp, cmd, ...rest);
	};
}
let error = null;
let written = false;
const record = () => {
	if (written) return;
	written = true;
	fs.writeFileSync(process.argv[3], JSON.stringify({ error, reads, gits }));
};
/* Most of these scripts are checkers that RUN on require and exit on their own
 * verdict, so the record is written from the exit hook rather than after the
 * require that never returns. */
process.on("exit", record);
try {
	require(process.argv[2]);
} catch (e) {
	error = e && e.message ? e.message : String(e);
}
record();
`,
	);
});

afterAll(() => {
	if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

/** Is `full` a non-test JS/TS script that requires or imports the seam? */
const isSeamCaller = (full: string, name: string): boolean => {
	if (!/\.(?:[cm]?js|ts)$/.test(name) || name.endsWith(".test.ts"))
		return false;
	const text = fs.readFileSync(full, "utf8");
	return /(?:require\(|from )["']\.(?:\/lib)?\/host-root(?:\.js)?["']/.test(
		text,
	);
};

/**
 * Every script that goes through the JS seam, repo-relative — enumerated from
 * the checkout rather than the cache because `it.each` is read at COLLECTION
 * time, before `beforeAll` has built anything. The cache is a copy of this
 * tree, so the two lists are the same list.
 */
const rootedScripts = (): string[] => {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (e.name === "node_modules" || e.name === "__pycache__") continue;
				walk(full);
			} else if (e.isFile() && isSeamCaller(full, e.name)) {
				out.push(path.relative(REPO, full));
			}
		}
	};
	walk(path.join(REPO, "scripts"));
	return out.sort();
};

describe("the seam, from a plugin cache outside the host", () => {
	it("resolves the host from the working directory when CLAUDE_PROJECT_DIR is unset", () => {
		const r = spawnSync(
			process.execPath,
			[
				"-e",
				`process.stdout.write(require(${JSON.stringify(path.join(cache, "scripts", "lib", "host-root.js"))}).hostRoot())`,
			],
			{ cwd: host, env: hostEnv(), encoding: "utf8" },
		);
		expect(r.stderr).toBe("");
		expect(r.stdout).toBe(host);
	});

	it("does NOT resolve the cache, though the cache is a git repository of its own", () => {
		const r = spawnSync(
			process.execPath,
			[
				"-e",
				`process.stdout.write(require(${JSON.stringify(path.join(cache, "scripts", "lib", "host-root.js"))}).hostRoot())`,
			],
			{ cwd: host, env: hostEnv(), encoding: "utf8" },
		);
		expect(r.stdout).not.toContain(cache);
	});

	it("dereferences a symlinked CLAUDE_PROJECT_DIR, trailing slash and all", () => {
		const r = spawnSync(
			process.execPath,
			[
				"-e",
				`process.stdout.write(require(${JSON.stringify(path.join(cache, "scripts", "lib", "host-root.js"))}).hostRoot())`,
			],
			{
				cwd: cache,
				env: hostEnv({ CLAUDE_PROJECT_DIR: `${hostLink}/` }),
				encoding: "utf8",
			},
		);
		expect(r.stdout).toBe(host);
	});

	it("falls open to the working directory where no repository answers, never to the cache", () => {
		/* With the cwd outside any repository, a seam that fell back to its own
		 * location would name the cache. */
		const nowhere = path.join(tmp, "nowhere");
		fs.mkdirSync(nowhere, { recursive: true });
		const r = spawnSync(
			process.execPath,
			[
				"-e",
				`process.stdout.write(require(${JSON.stringify(path.join(cache, "scripts", "lib", "host-root.js"))}).hostRoot())`,
			],
			{
				cwd: nowhere,
				env: hostEnv({ GIT_CEILING_DIRECTORIES: tmp }),
				encoding: "utf8",
			},
		);
		expect(r.stdout).toBe(nowhere);
		expect(r.stdout).not.toContain(cache);
	});

	it("gr_root answers the same, byte for byte", () => {
		const r = spawnSync(
			"bash",
			[
				"-c",
				`source "${path.join(cache, "scripts", "lib", "guard-root.sh")}"; gr_root`,
			],
			{ cwd: host, env: hostEnv(), encoding: "utf8" },
		);
		expect(r.stdout).toBe(host);
	});

	it("host_root() answers the same in Python", () => {
		const r = spawnSync(
			"python3",
			[
				"-c",
				"import sys; sys.path.insert(0, sys.argv[1]); from host_root import host_root; sys.stdout.write(host_root())",
				path.join(cache, "scripts", "lib"),
			],
			{ cwd: host, env: hostEnv(), encoding: "utf8" },
		);
		expect(r.stderr).toBe("");
		expect(r.stdout).toBe(host);
	});
});

describe("the findings the seam closes", () => {
	it("F24 — the rule store is the host's, not the plugin's", () => {
		const r = spawnSync(
			"bash",
			[
				"-c",
				`source "${path.join(cache, "scripts", "lib", "rule-text.sh")}"; rule_text adopter-rule`,
			],
			{ cwd: host, env: hostEnv(), encoding: "utf8" },
		);
		expect(r.stdout).toBe("THE ADOPTER'S OWN RULE.");
	});

	it("F23 — the origin remote is read from the host, not the script's directory", () => {
		const r = spawnSync(
			"bash",
			[path.join(cache, "scripts", "link-sub-issue.sh"), "1", "2"],
			{
				cwd: host,
				env: hostEnv({
					WFC_GH: "true",
					WFC_LINK_RETRIES: "1",
					WFC_LINK_SLEEP: "0",
				}),
				encoding: "utf8",
			},
		);
		/* The remote read is what is under test; what `gh` then does is not. */
		expect(r.stderr).not.toContain("could not read owner/name");
	});

	it("F20 — the arbiter files its state under the host, not the cache", () => {
		const r = spawnSync(
			process.execPath,
			[
				"-e",
				`const a = require(${JSON.stringify(path.join(cache, "scripts", "lib", "arbiter-core.js"))}); process.stdout.write(JSON.stringify([a.repoRoot(), a.stateDir()]))`,
			],
			{
				cwd: host,
				env: hostEnv({ CLAUDE_CONFIG_DIR: path.join(tmp, "config") }),
				encoding: "utf8",
			},
		);
		const [root, state] = JSON.parse(r.stdout);
		expect(root).toBe(host);
		expect(state).not.toContain(path.basename(cache));
	});
});

describe("every rooted script, loaded from the cache against the host", () => {
	it("finds at least the scripts the conversion touched", () => {
		expect(rootedScripts().length).toBeGreaterThan(20);
	});

	/** Load `script` under the probe from the host, and return its record. */
	const probeRun = (script: string) => {
		const record = path.join(
			tmp,
			`probe-${path.relative(cache, script).replace(/\W/g, "_")}.json`,
		);
		const r = spawnSync(process.execPath, [probe, script, record], {
			cwd: host,
			env: hostEnv({ CLAUDE_CONFIG_DIR: path.join(tmp, "config") }),
			encoding: "utf8",
			timeout: 20_000,
		});
		expect(
			fs.existsSync(record),
			`${script} left no probe record; it exited ${r.status}: ${r.stderr}`,
		).toBe(true);
		return JSON.parse(fs.readFileSync(record, "utf8")) as {
			reads: string[];
			gits: string[];
		};
	};

	const within = (p: string, dir: string) =>
		p === dir || p.startsWith(`${dir}${path.sep}`);

	/** Reads inside the cache but outside what ships beside the caller. */
	const strayReads = (reads: string[]) =>
		reads
			.map((p) => path.resolve(host, p))
			.filter((p) => p.startsWith(`${cache}${path.sep}`))
			.filter(
				(p) =>
					!within(p, path.join(cache, "scripts")) &&
					/* Module resolution realpaths the core's own dependencies. */
					!within(p, path.join(cache, "node_modules")) &&
					/* The plugin's own hook manifest and rule-text store are
					 * core-owned, not host content: the registry reads the
					 * manifest to know how an adopter's guards are wired, and a
					 * guard reads the store to print the text behind a deny (#5).
					 * Neither exists in a host repo at all — and the store
					 * alone, not all of docs/agents, whose prose a script must
					 * still read from the host. */
					p !== path.join(cache, "hooks", "hooks.json") &&
					/* The base standards, which check-primitives judges from the
					 * plugin: an adopter writes only its local file. */
					p !== path.join(cache, "docs", "code-standards-base.md") &&
					!within(p, path.join(cache, "docs", "agents", "rules")) &&
					/* script-path.js's checkout-or-install probe, which asks
					 * where the core sits, never what the host holds (#343). */
					p !== path.join(cache, "package.json"),
			);

	const cacheGits = (gits: string[]) =>
		gits.map((p) => path.resolve(host, p)).filter((p) => within(p, cache));

	it("catches a git aimed at the cache, by cwd or by -C", () => {
		const planted = path.join(cache, "scripts", "planted-stray-git.js");
		fs.writeFileSync(
			planted,
			`const cp = require("node:child_process");
try { cp.execFileSync("git", ["-C", __dirname, "status"], { stdio: "ignore" }); } catch {}
try { cp.spawnSync("git", ["status"], { cwd: __dirname, stdio: "ignore" }); } catch {}
`,
		);
		try {
			expect(cacheGits(probeRun(planted).gits)).toHaveLength(2);
		} finally {
			fs.rmSync(planted, { force: true });
		}
	});

	it.each(rootedScripts())(
		"%s reads no host content from inside the plugin cache",
		(rel) => {
			const { reads, gits } = probeRun(path.join(cache, rel));
			/* THE POSITIVE CONTROL. `strays` is derived from `reads`, so a probe that
			 * silently recorded nothing — a patch that stopped taking, a script that
			 * exits before its first read — would pass every case below while proving
			 * nothing at all. */
			expect(
				reads.length,
				`${rel} recorded no reads, so the case that follows proves nothing`,
			).toBeGreaterThan(0);
			expect(
				strayReads(reads),
				`${rel} read host content from the plugin cache`,
			).toEqual([]);
			expect(
				cacheGits(gits),
				`${rel} ran git against the plugin cache`,
			).toEqual([]);
		},
	);
});
