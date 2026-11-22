// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keptSpawn } from "./lib/kept-spawn.js";
import { shellQuote } from "./lib/sh-quote.js";
import { isApparatus } from "./lib/suite-apparatus.js";
import { isJsExt } from "./lib/test-kind.js";

const REPO = path.resolve(__dirname, "..");

let tmp: string;
let cache: string;
let host: string;
let hostLink: string;
let probe: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });

const hostEnv = (extra: NodeJS.ProcessEnv = {}) => {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: path.join(tmp, "home"),
		...extra,
	};
	if (!("CLAUDE_PROJECT_DIR" in extra)) delete env.CLAUDE_PROJECT_DIR;
	delete env.WFC_REPO_ROOT;
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

const isSeamCaller = (rel: string): boolean => {
	if (!isJsExt(path.extname(rel)) || isApparatus(rel)) return false;
	const text = fs.readFileSync(path.join(REPO, rel), "utf8");
	return /(?:require\(|from )["']\.(?:\/lib)?\/host-root(?:\.js)?["']/.test(
		text,
	);
};

const rootedScripts = (): string[] => {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (e.name === "node_modules" || e.name === "__pycache__") continue;
				walk(full);
			} else if (e.isFile() && isSeamCaller(path.relative(REPO, full))) {
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
				`source ${shellQuote(path.join(cache, "scripts", "lib", "guard-root.sh"))}; gr_root`,
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
				`source ${shellQuote(path.join(cache, "scripts", "lib", "rule-text.sh"))}; rule_text adopter-rule`,
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

	const probeRun = (script: string) => {
		const record = path.join(
			tmp,
			`probe-${path.relative(cache, script).replace(/\W/g, "_")}.json`,
		);
		const r = keptSpawn("timeout").spawnSync(
			process.execPath,
			[probe, script, record],
			{
				cwd: host,
				env: hostEnv({ CLAUDE_CONFIG_DIR: path.join(tmp, "config") }),
				encoding: "utf8",
				timeout: 20_000,
			},
		);
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

	const strayReads = (reads: string[]) =>
		reads
			.map((p) => path.resolve(host, p))
			.filter((p) => p.startsWith(`${cache}${path.sep}`))
			.filter(
				(p) =>
					!within(p, path.join(cache, "scripts")) &&
					!within(p, path.join(cache, "node_modules")) &&
					p !== path.join(cache, "hooks", "hooks.json") &&
					p !== path.join(cache, ".claude-plugin", "plugin.json") &&
					p !== path.join(cache, "docs", "code-standards-base.md") &&
					!within(p, path.join(cache, "docs", "agents", "rules")) &&
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
