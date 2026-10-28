// @vitest-environment node
/*
 * write-secret.js writes one secret into the host's `.env` (#640).
 *
 * Every CLI case drives the script in-process against a throwaway git repo,
 * the value on piped stdin, and reads back only what the founder sees: the
 * exit, the printed lines, the file's bytes and mode. The repo shuts out the
 * developer's global git excludes, which would silence the git-ignore warning
 * whatever the script did. Every run is checked for the value leaking into
 * stdout or stderr. The mount cases spawn the script under `unshare`, as
 * a mount needs a mount namespace the in-process runner cannot enter.
 *
 * It is the route the founder hands a secret over by: loosen a case and a key
 * leaks into a terminal a session reads, lands in a git-tracked `.env`, or
 * mangles the file's other entries.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "write-secret.js");

const SECRET = "plain-test-value";

let host: string;
let home: string;
const env = () => path.join(host, ".env");

const isolatedEnv = (extra: Record<string, string> = {}) => ({
	PATH: process.env.PATH ?? "",
	HOME: home,
	XDG_CONFIG_HOME: home,
	GIT_CONFIG_NOSYSTEM: "1",
	...extra,
});

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: host, env: isolatedEnv() });

const gitInit = (dir: string) =>
	execFileSync("git", ["init", "-q", dir], { env: isolatedEnv() });

/** A bare repository planted as `dir`'s `.git`. */
const initBare = (dir: string) =>
	execFileSync("git", ["init", "-q", "--bare", path.join(dir, ".git")], {
		env: isolatedEnv(),
	});

const commitAll = (cwd = host) =>
	execFileSync(
		"git",
		["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x"],
		{ cwd, env: isolatedEnv() },
	);

beforeEach(() => {
	host = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "write-secret-")),
	);
	home = fs.mkdtempSync(path.join(os.tmpdir(), "write-secret-home-"));
	git("init", "-q");
	fs.writeFileSync(path.join(host, ".gitignore"), ".env*\n");
});
afterEach(() => {
	fs.rmSync(host, { recursive: true, force: true });
	fs.rmSync(home, { recursive: true, force: true });
});

const run = (
	args: string[],
	stdin: string,
	cwd = host,
	extra: Record<string, string> = {},
) => {
	const r = runInProcess(SCRIPT, args, {
		cwd,
		env: isolatedEnv({ CLAUDE_PROJECT_DIR: host, ...extra }),
		stdin,
	});
	expect(r.stderr).not.toContain("stale-copy-value");
	const value = stdin.trim();
	if (value) {
		expect(r.stdout).not.toContain(value);
		expect(r.stderr).not.toContain(value);
	}
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

/**
 * A writable directory whose filesystem folds case: the temp dir where it
 * does, as on macOS, else a Windows drive's under WSL; null where none.
 * Probed at load, not in beforeEach, as skipIf reads it when tests register.
 */
const findFoldingDir = (): string | null => {
	let windows: string[] = [];
	try {
		windows = fs
			.readdirSync("/mnt/c/Users")
			.map((u) => path.join("/mnt/c/Users", u, "AppData", "Local", "Temp"));
	} catch {
		// No Windows drive: not WSL.
	}
	for (const dir of [os.tmpdir(), ...windows]) {
		try {
			const probe = fs.mkdtempSync(path.join(dir, "write-secret-probe-"));
			try {
				fs.writeFileSync(path.join(probe, "a"), "");
				if (fs.existsSync(path.join(probe, "A"))) return dir;
			} finally {
				fs.rmSync(probe, { recursive: true, force: true });
			}
		} catch {
			// Not writable here: try the next.
		}
	}
	return null;
};
const foldingDir = findFoldingDir();

const read = () => fs.readFileSync(env(), "utf8");
const readMode = () => fs.statSync(env()).mode & 0o777;

describe("write-secret", () => {
	it("creates .env owner-only holding exactly the one line", () => {
		const r = run(["API_KEY"], `${SECRET}\n`);
		expect(r.status).toBe(0);
		expect(read()).toBe(`API_KEY=${SECRET}\n`);
		expect(readMode()).toBe(0o600);
		expect(r.stdout).toBe(`write-secret: added API_KEY in ${env()}\n`);
		expect(r.stderr).toBe("");
		expect(fs.readdirSync(host).sort()).toEqual([".env", ".git", ".gitignore"]);
	});

	it("replaces only that name's value, keeping every other byte, the order, the mode and the missing final newline", () => {
		const before = "# keys\nA=1\r\nexport API_KEY = old\r\n\nB='two words'";
		fs.writeFileSync(env(), before, { mode: 0o640 });
		fs.chmodSync(env(), 0o640);
		const r = run(["API_KEY"], SECRET);
		expect(r.status).toBe(0);
		expect(read()).toBe(
			`# keys\nA=1\r\nexport API_KEY = ${SECRET}\r\n\nB='two words'`,
		);
		expect(readMode()).toBe(0o640);
		expect(r.stdout).toBe(`write-secret: replaced API_KEY in ${env()}\n`);
	});

	it("a second run for the same name replaces the first value", () => {
		run(["API_KEY"], "first-value");
		fs.appendFileSync(env(), "OTHER=x\n");
		run(["API_KEY"], SECRET);
		expect(read()).toBe(`API_KEY=${SECRET}\nOTHER=x\n`);
	});

	it("does not match a name that only shares a prefix", () => {
		fs.writeFileSync(env(), "API_KEY_OLD=x\nXAPI_KEY=y\n");
		expect(run(["API_KEY"], SECRET).status).toBe(0);
		expect(read()).toBe(`API_KEY_OLD=x\nXAPI_KEY=y\nAPI_KEY=${SECRET}\n`);
	});

	it.each([
		["with a final newline", "A=1\n", `A=1\nK=${SECRET}\n`],
		["without one", "A=1", `A=1\nK=${SECRET}`],
	])(
		"appends a new name to a file %s, keeping that ending",
		(_l, before, after) => {
			fs.writeFileSync(env(), before);
			expect(run(["K"], SECRET).status).toBe(0);
			expect(read()).toBe(after);
		},
	);

	it("trims the value, as the readers do", () => {
		run(["K"], `  ${SECRET} \n`);
		expect(read()).toBe(`K=${SECRET}\n`);
	});

	it.each(["1KEY", "API-KEY", "API KEY", "", SECRET])(
		"refuses the name %j with exit 2, without echoing it",
		(name) => {
			fs.writeFileSync(env(), "A=1\n");
			const r = run([name], "unused-value");
			expect(r.status).toBe(2);
			expect(r.stderr).toMatch(
				/^write-secret: refused, \.env untouched — the argument is not a shell variable name/,
			);
			if (name) expect(r.stderr).not.toContain(name);
			expect(read()).toBe("A=1\n");
		},
	);

	it.each([
		[
			"a value holding a line break",
			"one\ntwo\n",
			"the value holds a line break, which one .env line cannot carry. Re-run and give it on one line.",
		],
		[
			"a value needing quotes that holds a single quote",
			"it's#mine",
			"the value holds a single quote as well as #, $, a backtick or a quote at an end, which no .env quoting reads back intact. Store it elsewhere, or rotate to a value without them.",
		],
	])("refuses %s with exit 2, .env untouched", (_l, stdin, why) => {
		fs.writeFileSync(env(), "A=1\n");
		const r = run(["K"], stdin);
		expect(r.status).toBe(2);
		expect(r.stderr).toBe(`write-secret: refused, .env untouched — ${why}\n`);
		expect(r.stdout).toBe("");
		expect(read()).toBe("A=1\n");
	});

	it.each([
		["an empty", ""],
		["a whitespace-only", "  \n"],
	])(
		"refuses %s value on a stdin that is no terminal, naming that cause and the own-terminal line, .env untouched (#2554)",
		(_l, stdin) => {
			fs.writeFileSync(env(), "A=1\n");
			const r = run(["K"], stdin);
			expect(r.status).toBe(2);
			expect(r.stderr).toBe(
				"write-secret: refused, .env untouched — the value for K is empty: stdin is not a terminal, as under Claude Code's `!` prefix, so no hidden prompt could ask for it. " +
					`Run this in your own terminal instead:\ncd ${host} && node ${SCRIPT} K\n`,
			);
			expect(r.stdout).toBe("");
			expect(read()).toBe("A=1\n");
		},
	);

	it("refuses an empty value without creating .env", () => {
		expect(run(["K"], "").status).toBe(2);
		expect(fs.existsSync(env())).toBe(false);
	});

	it("refuses a .env tracked by git with exit 1, untouched", () => {
		fs.writeFileSync(path.join(host, ".gitignore"), "");
		fs.writeFileSync(env(), "A=1\n");
		git("add", ".env");
		const r = run(["K"], SECRET);
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(
			`write-secret: refused, .env untouched — ${env()} is tracked by git, so a secret written there would be committed. Untrack it (git rm --cached .env, then commit that) and ignore it first.\n`,
		);
		expect(read()).toBe("A=1\n");
	});

	it("warns, and still writes, when git does not ignore .env, naming the repo and offering .gitignore as the way out", () => {
		fs.writeFileSync(path.join(host, ".gitignore"), "");
		fs.writeFileSync(env(), "A=1\n");
		const r = run(["K"], SECRET);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe(
			`write-secret: warning — git does not ignore .env in ${host}, so it could be committed. Add .env and .env.*.tmp to .gitignore.\n`,
		);
		expect(read()).toBe(`A=1\nK=${SECRET}\n`);
	});

	const asideWarning = () =>
		`write-secret: warning — git ignores .env in ${host} but not .env.<pid>.<hex>.tmp, the copy of .env an interrupted write leaves, so it could be committed. Add .env.*.tmp to .gitignore.\n`;

	it("warns, and still writes, when git ignores .env but not the aside an interrupted write leaves (#2255)", () => {
		fs.writeFileSync(path.join(host, ".gitignore"), ".env\n");
		const r = run(["K"], SECRET);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe(asideWarning());
		expect(read()).toBe(`K=${SECRET}\n`);
	});

	it("warns of an unignored aside on a run whose write fails, where an aside may be left (#2255)", () => {
		fs.writeFileSync(path.join(host, ".gitignore"), ".env\n");
		fs.mkdirSync(env());
		const r = run(["K"], SECRET);
		expect(r.status).toBe(1);
		expect(r.stderr.startsWith(asideWarning())).toBe(true);
	});

	it("is silent where .gitignore names .env and .env.*.tmp, which leaves .env.example trackable", () => {
		fs.writeFileSync(path.join(host, ".gitignore"), ".env\n.env.*.tmp\n");
		const r = run(["K"], SECRET);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
	});

	const StaleCopy = "OLD_KEY=stale-copy-value\n";
	/** Above Linux's 2^22 pid ceiling, so no process ever holds it. */
	const DeadPid = 4_194_305;

	const aside = (pid: number, tag = "0a1b2c3d") =>
		path.join(host, `.env.${pid}.${tag}.tmp`);
	const left = "a copy of .env an earlier interrupted write left";
	/** The warning for an aside left at `stale` since git could not say it is tracked. */
	const leftWarning = (stale: string, when = "") =>
		`write-secret: warning — ${stale}, ${left}, was left: git could not say whether it is tracked. If it is, its secrets are in history. Rotate them, then git rm --cached it; either way, delete it${when}.\n`;

	it("removes an aside of .env an earlier run left, naming it (#2320)", () => {
		const stale = aside(DeadPid);
		fs.writeFileSync(stale, StaleCopy);
		const r = run(["K"], SECRET);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe(`write-secret: removed ${stale}, ${left}.\n`);
		expect(fs.existsSync(stale)).toBe(false);
		expect(read()).toBe(`K=${SECRET}\n`);
	});

	it("removes a stale aside on a run that then refuses a tracked .env (#2320)", () => {
		const stale = aside(DeadPid);
		fs.writeFileSync(stale, StaleCopy);
		fs.writeFileSync(env(), "A=1\n");
		git("add", "-f", ".env");
		const r = run(["K"], SECRET);
		expect(r.status).toBe(1);
		expect(
			r.stderr.startsWith(`write-secret: removed ${stale}, ${left}.\n`),
		).toBe(true);
		expect(fs.existsSync(stale)).toBe(false);
	});

	it("names and leaves an aside whose pid is running (#2320)", () => {
		const live = aside(process.pid);
		fs.writeFileSync(live, StaleCopy);
		const r = run(["K"], SECRET);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe(
			`write-secret: left ${live}, a copy of .env: its pid ${process.pid} is running, so it may be a run still writing. Delete it once no write-secret runs.\n`,
		);
		expect(fs.readFileSync(live, "utf8")).toBe(StaleCopy);
	});

	it("names and leaves an aside git tracks (#2320)", () => {
		const tracked = aside(DeadPid);
		fs.writeFileSync(tracked, StaleCopy);
		git("add", "-f", path.basename(tracked));
		const r = run(["K"], SECRET);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe(
			`write-secret: warning — ${tracked}, ${left}, is tracked by git, so its secrets are in history. Rotate them, then git rm --cached it.\n`,
		);
		expect(fs.readFileSync(tracked, "utf8")).toBe(StaleCopy);
	});

	it.each([
		["dead", DeadPid, ""],
		["running", process.pid, " once no write-secret runs"],
	])(
		"names and leaves an aside git cannot say is tracked, its pid %s, keeping the rotate warning (#2736)",
		(_l, pid, when) => {
			const stale = aside(pid);
			fs.writeFileSync(stale, StaleCopy);
			const r = run(["K"], SECRET, host, { PATH: "" });
			expect(r.status).toBe(1);
			expect(r.stderr.startsWith(leftWarning(stale, when))).toBe(true);
			expect(fs.readFileSync(stale, "utf8")).toBe(StaleCopy);
		},
	);

	/** Each breaks `ls-files` with git's fatal 128 inside a repository (#2777). */
	const fatalInRepo: [string, () => void, Record<string, string>][] = [
		[
			"a corrupt index",
			// Under the index's 12-byte header, so git reads it as too small.
			() => fs.truncateSync(path.join(host, ".git", "index"), 10),
			{},
		],
		[
			"dubious ownership",
			() => undefined,
			{ GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" },
		],
		// The next two print git's not-a-repository message from inside one.
		["a missing HEAD", () => fs.rmSync(path.join(host, ".git", "HEAD")), {}],
		[
			"a .git file naming a missing gitdir",
			() => {
				fs.rmSync(path.join(host, ".git"), { recursive: true });
				fs.writeFileSync(path.join(host, ".git"), `gitdir: ${home}/gone\n`);
			},
			{},
		],
	];

	const removeRepo = () =>
		fs.rmSync(path.join(host, ".git"), { recursive: true });

	it.each(fatalInRepo)(
		"names and leaves a tracked aside under %s, keeping the rotate warning (#2777)",
		(_l, breakRepo, extra) => {
			const stale = aside(DeadPid);
			fs.writeFileSync(stale, StaleCopy);
			git("add", "-f", path.basename(stale));
			breakRepo();
			const r = run(["K"], SECRET, host, extra);
			expect(r.status).toBe(1);
			expect(r.stderr.startsWith(leftWarning(stale))).toBe(true);
			expect(fs.readFileSync(stale, "utf8")).toBe(StaleCopy);
		},
	);

	it("removes an aside outside any repository, where nothing can commit it (#2777)", () => {
		removeRepo();
		const stale = aside(DeadPid);
		fs.writeFileSync(stale, StaleCopy);
		const r = run(["K"], SECRET);
		expect(r.status).toBe(0);
		expect(
			r.stderr.startsWith(`write-secret: removed ${stale}, ${left}.\n`),
		).toBe(true);
		expect(fs.existsSync(stale)).toBe(false);
	});

	it("leaves a near-shaped name, a symlink and a directory under an aside's name (#2320)", () => {
		const near = aside(DeadPid, "notahex1");
		const link = aside(DeadPid);
		const dir = aside(DeadPid, "ffffffff");
		const target = path.join(home, "outside");
		fs.writeFileSync(near, StaleCopy);
		fs.writeFileSync(target, StaleCopy);
		fs.symlinkSync(target, link);
		fs.mkdirSync(dir);
		const r = run(["K"], SECRET);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
		expect(fs.readFileSync(near, "utf8")).toBe(StaleCopy);
		expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
		expect(fs.readFileSync(target, "utf8")).toBe(StaleCopy);
		expect(fs.statSync(dir).isDirectory()).toBe(true);
	});

	it("names a stale aside it cannot remove (#2320)", () => {
		const stale = aside(DeadPid);
		fs.writeFileSync(stale, StaleCopy);
		fs.chmodSync(host, 0o555);
		try {
			const r = run(["K"], SECRET);
			expect(
				r.stderr.startsWith(
					`write-secret: warning — ${stale}, ${left}, could not be removed (EACCES). Delete it by hand.\n`,
				),
			).toBe(true);
		} finally {
			fs.chmodSync(host, 0o755);
		}
		expect(fs.readFileSync(stale, "utf8")).toBe(StaleCopy);
	});

	it("refuses with exit 1 when .env cannot be written, leaving no temp file", () => {
		fs.mkdirSync(env());
		const r = run(["K"], SECRET);
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(
			/could not be written \(E[A-Z]+\)\. Check it is a regular file you can write, then re-run\.\n$/,
		);
		expect(fs.readdirSync(host).sort()).toEqual([".env", ".git", ".gitignore"]);
	});

	it("refuses a symlinked .env with exit 1, since its target may be tracked", () => {
		const target = path.join(host, "real.env");
		fs.writeFileSync(target, "A=1\n");
		git("add", "real.env");
		fs.symlinkSync(target, env());
		const r = run(["K"], SECRET);
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(
			`write-secret: refused, .env untouched — ${env()} is a symlink, whose target git may track. Replace it with a regular file, then re-run.\n`,
		);
		expect(fs.readFileSync(target, "utf8")).toBe("A=1\n");
	});

	it("refuses with exit 1 when git cannot say whether .env is tracked", () => {
		const r = run(["K"], SECRET, host, { PATH: "" });
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/git could not say whether .+ is tracked/);
		expect(fs.existsSync(env())).toBe(false);
	});

	it.each(fatalInRepo)(
		"refuses a tracked .env with exit 1, untouched, under %s (#2777)",
		(_l, breakRepo, extra) => {
			fs.writeFileSync(env(), "A=1\n");
			git("add", "-f", ".env");
			breakRepo();
			const r = run(["K"], SECRET, host, extra);
			expect(r.status).toBe(1);
			expect(r.stderr).toBe(
				`write-secret: refused, .env untouched — git could not say whether ${env()} is tracked, so the secret might be committed. Check git runs in ${host}, then re-run.\n`,
			);
			expect(read()).toBe("A=1\n");
		},
	);

	it.each([
		["GIT_DIR", () => path.join(home, ".git")],
		["GIT_INDEX_FILE", () => path.join(home, ".git", "index")],
	])(
		"refuses a tracked .env with exit 1 under an inherited %s naming another repository (#2777)",
		(name, value) => {
			fs.writeFileSync(env(), "A=1\n");
			git("add", "-f", ".env");
			gitInit(home);
			const r = run(["K"], SECRET, host, { [name]: value() });
			expect(r.status).toBe(1);
			expect(r.stderr).toBe(
				`write-secret: refused, .env untouched — ${env()} is tracked by git, so a secret written there would be committed. Untrack it (git rm --cached .env, then commit that) and ignore it first.\n`,
			);
			expect(read()).toBe("A=1\n");
		},
	);

	/**
	 * A bare repository with its work tree under `base`, entered the yadm/vcsh
	 * way: GIT_DIR and GIT_WORK_TREE inherited, no project dir.
	 */
	const buildBareEntered = (base: () => string) => {
		const store = path.join(base(), "store.git");
		const tree = path.join(base(), "w");
		fs.mkdirSync(tree);
		const redirect = { GIT_DIR: store, GIT_WORK_TREE: tree };
		execFileSync("git", ["init", "-q", "--bare", store], {
			env: isolatedEnv(),
		});
		const inTree = (...args: string[]) =>
			execFileSync("git", args, { cwd: tree, env: isolatedEnv(redirect) });
		return {
			tree,
			inTree,
			run: (cwd = tree) =>
				run(["K"], SECRET, cwd, { CLAUDE_PROJECT_DIR: "", ...redirect }),
		};
	};
	const bareBases: [string, () => string][] = [
		["no repository above", () => home],
		["a repository above", () => host],
	];

	it.each(bareBases)(
		"refuses a .env a bare repository tracks through an inherited GIT_DIR and GIT_WORK_TREE, from the work tree and from its parent, with %s (#3063)",
		(_l, base) => {
			const bare = buildBareEntered(base);
			const tracked = path.join(bare.tree, ".env");
			fs.writeFileSync(tracked, "A=1\n");
			bare.inTree("add", ".env");
			for (const cwd of [bare.tree, path.dirname(bare.tree)]) {
				const r = bare.run(cwd);
				expect(r.status).toBe(1);
				expect(r.stderr).toBe(
					`write-secret: refused, .env untouched — ${tracked} is tracked by git, so a secret written there would be committed. Untrack it (git rm --cached .env, then commit that) and ignore it first.\n`,
				);
			}
			expect(fs.readFileSync(tracked, "utf8")).toBe("A=1\n");
		},
	);

	it.each(bareBases)(
		"names and leaves an aside a bare repository tracks through an inherited GIT_DIR and GIT_WORK_TREE, with %s (#3063)",
		(_l, base) => {
			const bare = buildBareEntered(base);
			const stale = path.join(bare.tree, `.env.${DeadPid}.0a1b2c3d.tmp`);
			fs.writeFileSync(stale, StaleCopy);
			bare.inTree("add", path.basename(stale));
			const r = bare.run();
			expect(
				r.stderr.startsWith(
					`write-secret: warning — ${stale}, ${left}, is tracked by git, so its secrets are in history. Rotate them, then git rm --cached it.\n`,
				),
			).toBe(true);
			expect(fs.readFileSync(stale, "utf8")).toBe(StaleCopy);
		},
	);

	it.each(bareBases)(
		"writes, silently, a .env a bare repository entered through an inherited GIT_DIR and GIT_WORK_TREE ignores and does not track, with %s (#3063)",
		(_l, base) => {
			const bare = buildBareEntered(base);
			fs.writeFileSync(path.join(bare.tree, ".gitignore"), ".env*\n");
			const r = bare.run();
			expect(r.status).toBe(0);
			expect(r.stderr).toBe("");
			expect(fs.readFileSync(path.join(bare.tree, ".env"), "utf8")).toBe(
				`K=${SECRET}\n`,
			);
		},
	);

	it("refuses where git ignores .env but tracks .ENV, the file a write to .env lands in on a case-insensitive filesystem (#3063)", () => {
		// This filesystem is case-sensitive; the check matches case-blind on any.
		const upper = path.join(host, ".ENV");
		fs.writeFileSync(upper, "A=1\n");
		git("add", "-f", ".ENV");
		const r = run(["K"], SECRET);
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(
			`write-secret: refused, .env untouched — ${env()} is tracked by git, so a secret written there would be committed. Untrack it (git rm --cached .env, then commit that) and ignore it first.\n`,
		);
		expect(fs.existsSync(env())).toBe(false);
		expect(fs.readFileSync(upper, "utf8")).toBe("A=1\n");
	});

	it("refuses a tracked .env under an inherited GIT_LITERAL_PATHSPECS (#3063)", () => {
		fs.writeFileSync(env(), "A=1\n");
		git("add", "-f", ".env");
		const r = run(["K"], SECRET, host, { GIT_LITERAL_PATHSPECS: "1" });
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(
			`write-secret: refused, .env untouched — ${env()} is tracked by git, so a secret written there would be committed. Untrack it (git rm --cached .env, then commit that) and ignore it first.\n`,
		);
		expect(read()).toBe("A=1\n");
	});

	it("refuses a .env a non-bare repository tracks through an inherited GIT_DIR alone, run from a subdirectory of the project dir (#3063)", () => {
		const store = path.join(home, "store");
		const tree = path.join(home, "w");
		fs.mkdirSync(path.join(tree, "sub"), { recursive: true });
		gitInit(store);
		const tracked = path.join(tree, ".env");
		fs.writeFileSync(tracked, "A=1\n");
		const gitDir = path.join(store, ".git");
		execFileSync("git", ["add", ".env"], {
			cwd: tree,
			env: isolatedEnv({ GIT_DIR: gitDir, GIT_WORK_TREE: tree }),
		});
		const r = run(["K"], SECRET, path.join(tree, "sub"), {
			CLAUDE_PROJECT_DIR: tree,
			GIT_DIR: gitDir,
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(
			`write-secret: refused, .env untouched — ${tracked} is tracked by git, so a secret written there would be committed. Untrack it (git rm --cached .env, then commit that) and ignore it first.\n`,
		);
		expect(fs.readFileSync(tracked, "utf8")).toBe("A=1\n");
	});

	const couldNotSayRefusal = (file: string, dir: string) =>
		`write-secret: refused, .env untouched — git could not say whether ${file} is tracked, so the secret might be committed. Check git runs in ${dir}, then re-run.\n`;

	const trackedRefusal = (file: string) =>
		`write-secret: refused, .env untouched — ${file} is tracked by git, so a secret written there would be committed. Untrack it (git rm --cached .env, then commit that) and ignore it first.\n`;

	/**
	 * A bare store under `home` tracking `.env` in the work tree `home/w`,
	 * which holds no `.git`.
	 */
	const buildStoreForTree = () => {
		const store = path.join(home, "store.git");
		const tree = path.join(home, "w");
		fs.mkdirSync(tree);
		execFileSync("git", ["init", "-q", "--bare", store], {
			env: isolatedEnv(),
		});
		const tracked = path.join(tree, ".env");
		fs.writeFileSync(tracked, "A=1\n");
		execFileSync("git", ["add", ".env"], {
			cwd: tree,
			env: isolatedEnv({ GIT_DIR: store, GIT_WORK_TREE: tree }),
		});
		return { store, tree, tracked };
	};

	it.each<
		[
			string,
			(s: ReturnType<typeof buildStoreForTree>) => {
				cwd: string;
				extra: Record<string, string>;
			},
		]
	>([
		[
			"GIT_WORK_TREE alone, run from inside the store",
			(s) => ({ cwd: s.store, extra: { GIT_WORK_TREE: s.tree } }),
		],
		[
			"injected core.bare=false and core.worktree, with GIT_DIR",
			(s) => ({
				cwd: s.tree,
				extra: {
					GIT_DIR: s.store,
					GIT_CONFIG_COUNT: "2",
					GIT_CONFIG_KEY_0: "core.bare",
					GIT_CONFIG_VALUE_0: "false",
					GIT_CONFIG_KEY_1: "core.worktree",
					GIT_CONFIG_VALUE_1: s.tree,
				},
			}),
		],
		[
			"the store's own core.worktree, run from inside the store",
			(s) => {
				execFileSync("git", ["config", "core.bare", "false"], {
					cwd: s.store,
					env: isolatedEnv(),
				});
				execFileSync("git", ["config", "core.worktree", s.tree], {
					cwd: s.store,
					env: isolatedEnv(),
				});
				return { cwd: s.store, extra: {} };
			},
		],
	])(
		"refuses a .env the caller's shell would commit through %s, the project dir declared (#3063)",
		(_l, enter) => {
			const s = buildStoreForTree();
			const { cwd, extra } = enter(s);
			const r = run(["K"], SECRET, cwd, {
				CLAUDE_PROJECT_DIR: s.tree,
				...extra,
			});
			expect(r.status).toBe(1);
			expect(r.stderr).toBe(trackedRefusal(s.tracked));
			expect(fs.readFileSync(s.tracked, "utf8")).toBe("A=1\n");
		},
	);

	it("refuses a .env a non-bare repository tracks under its work tree's subdirectory through an inherited GIT_DIR alone, run from that work tree (#3063)", () => {
		const store = path.join(home, "store");
		gitInit(store);
		const gitDir = path.join(store, ".git");
		const tree = path.join(home, "w");
		fs.mkdirSync(tree);
		const tracked = path.join(tree, ".env");
		fs.writeFileSync(tracked, "A=1\n");
		execFileSync("git", ["add", "w/.env"], {
			cwd: home,
			env: isolatedEnv({ GIT_DIR: gitDir, GIT_WORK_TREE: home }),
		});
		const r = run(["K"], SECRET, home, {
			CLAUDE_PROJECT_DIR: tree,
			GIT_DIR: gitDir,
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(trackedRefusal(tracked));
	});

	it("refuses a .env tracked in a relative GIT_INDEX_FILE, run from a subdirectory (#3063)", () => {
		fs.writeFileSync(env(), "A=1\n");
		execFileSync("git", ["add", "-f", ".env"], {
			cwd: host,
			env: isolatedEnv({ GIT_INDEX_FILE: "idx" }),
		});
		const sub = path.join(host, "sub");
		fs.mkdirSync(sub);
		const r = run(["K"], SECRET, sub, { GIT_INDEX_FILE: "idx" });
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(trackedRefusal(env()));
	});

	const buildOtherTrackingRepo = () => {
		const other = path.join(home, "other");
		gitInit(other);
		fs.writeFileSync(path.join(other, ".env"), "A=1\n");
		execFileSync("git", ["add", ".env"], { cwd: other, env: isolatedEnv() });
		return other;
	};

	it.each<[string, Record<string, string>]>([
		["GIT_INDEX_FILE", { GIT_INDEX_FILE: ".git/index" }],
		["GIT_DIR", { GIT_DIR: ".git" }],
		[
			"GIT_DIR and GIT_INDEX_FILE",
			{ GIT_DIR: ".git", GIT_INDEX_FILE: ".git/index" },
		],
	])(
		"writes under a hook's relative %s, run from another repository that tracks its own .env (#3063)",
		(_l, extra) => {
			const r = run(["K"], SECRET, buildOtherTrackingRepo(), extra);
			expect(r.status).toBe(0);
			expect(read()).toBe(`K=${SECRET}\n`);
		},
	);

	it("refuses under an inherited absolute GIT_DIR naming another repository that tracks .env, which a commit -a from the project dir would take it into (#3063)", () => {
		const other = buildOtherTrackingRepo();
		const r = run(["K"], SECRET, other, { GIT_DIR: path.join(other, ".git") });
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(trackedRefusal(env()));
		expect(fs.existsSync(env())).toBe(false);
	});

	it("refuses a .env an outer repository tracks where the project dir is a repository nested in it, and names a tracked aside there (#3063)", () => {
		const outer = path.join(home, "outer");
		const nested = path.join(outer, "pkg");
		fs.mkdirSync(nested, { recursive: true });
		gitInit(outer);
		const tracked = path.join(nested, ".env");
		const stale = path.join(nested, `.env.${DeadPid}.0a1b2c3d.tmp`);
		fs.writeFileSync(tracked, "A=1\n");
		fs.writeFileSync(stale, StaleCopy);
		execFileSync("git", ["add", "pkg"], { cwd: outer, env: isolatedEnv() });
		gitInit(nested);
		fs.writeFileSync(path.join(nested, ".gitignore"), ".env*\n");
		const r = run(["K"], SECRET, nested, { CLAUDE_PROJECT_DIR: nested });
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(
			`write-secret: warning — ${stale}, ${left}, is tracked by git, so its secrets are in history. Rotate them, then git rm --cached it.\n${trackedRefusal(tracked)}`,
		);
		expect(fs.readFileSync(tracked, "utf8")).toBe("A=1\n");
		expect(fs.readFileSync(stale, "utf8")).toBe(StaleCopy);
	});

	const expectSilentWrite = (dir: string, cwd = dir) => {
		const r = run(["K"], SECRET, cwd, { CLAUDE_PROJECT_DIR: dir });
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
		expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toBe(
			`K=${SECRET}\n`,
		);
	};

	it("writes silently where the project dir's .git file names its git directory through a symlink and a .. after it (#3080)", () => {
		const deep = path.join(home, "deep", "x");
		fs.mkdirSync(deep, { recursive: true });
		fs.symlinkSync(deep, path.join(home, "xl"));
		const proj = path.join(home, "proj");
		execFileSync(
			"git",
			[
				"init",
				"-q",
				`--separate-git-dir=${path.join(home, "deep", "dd.git")}`,
				proj,
			],
			{ env: isolatedEnv() },
		);
		fs.writeFileSync(path.join(proj, ".git"), `gitdir: ${home}/xl/../dd.git\n`);
		fs.writeFileSync(path.join(proj, ".gitignore"), ".env*\n");
		expectSilentWrite(proj);
	});

	it("writes, warning, where the project dir's .git is a bare repository, which tracks nothing there but cannot say it ignores .env (#3088)", () => {
		const proj = path.join(home, "proj");
		fs.mkdirSync(proj);
		initBare(proj);
		const r = run(["K"], SECRET, proj, { CLAUDE_PROJECT_DIR: proj });
		expect(r.stderr).toBe(
			`write-secret: warning — git does not ignore .env in ${proj}, so it could be committed. Add .env and .env.*.tmp to .gitignore.\n`,
		);
		expect(r.status).toBe(0);
		expect(fs.readFileSync(path.join(proj, ".env"), "utf8")).toBe(
			`K=${SECRET}\n`,
		);
	});

	it("refuses a .env an outer repository tracks where the project dir's .git is a bare repository (#3088)", () => {
		const outer = path.join(home, "outer");
		const proj = path.join(outer, "proj");
		fs.mkdirSync(proj, { recursive: true });
		gitInit(outer);
		const tracked = path.join(proj, ".env");
		fs.writeFileSync(tracked, "A=1\n");
		execFileSync("git", ["add", "proj"], { cwd: outer, env: isolatedEnv() });
		initBare(proj);
		const r = run(["K"], SECRET, proj, { CLAUDE_PROJECT_DIR: proj });
		expect(r.stderr).toBe(trackedRefusal(tracked));
		expect(r.status).toBe(1);
		expect(fs.readFileSync(tracked, "utf8")).toBe("A=1\n");
	});

	it("refuses as git could not say where the project dir's .git has lost its HEAD inside a bare repository, which reports no work tree (#3088)", () => {
		const outer = path.join(home, "outer");
		const proj = path.join(outer, "proj");
		fs.mkdirSync(proj, { recursive: true });
		initBare(outer);
		gitInit(proj);
		fs.rmSync(path.join(proj, ".git", "HEAD"));
		const r = run(["K"], SECRET, proj, { CLAUDE_PROJECT_DIR: proj });
		expect(r.stderr).toBe(couldNotSayRefusal(path.join(proj, ".env"), proj));
		expect(r.status).toBe(1);
	});

	it("writes silently in a repository nested in an outer one that tracks other files under it (#3063)", () => {
		const outer = path.join(home, "outer");
		const nested = path.join(outer, "pkg");
		fs.mkdirSync(nested, { recursive: true });
		gitInit(outer);
		fs.writeFileSync(path.join(nested, "a"), "x\n");
		execFileSync("git", ["add", "pkg"], { cwd: outer, env: isolatedEnv() });
		gitInit(nested);
		fs.writeFileSync(path.join(nested, ".gitignore"), ".env*\n");
		expectSilentWrite(nested);
	});

	/** A repository at `dir` ignoring .env only through its own info/exclude. */
	const initExcluding = (dir: string) => {
		gitInit(dir);
		fs.appendFileSync(path.join(dir, ".git", "info", "exclude"), ".env*\n");
	};

	it.each<[string, (outer: string) => void]>([
		["", () => undefined],
		[
			", whose index is lost after a commit, which a git reset brings back",
			(outer) => {
				commitAll(outer);
				fs.rmSync(path.join(outer, ".git", "index"));
			},
		],
	])(
		"warns where the project dir is a repository ignoring .env only through info/exclude, nested in an outer one that tracks other files under it and would add .env%s (#3073)",
		(_l, damage) => {
			const outer = path.join(home, "outer");
			const nested = path.join(outer, "pkg");
			fs.mkdirSync(nested, { recursive: true });
			gitInit(outer);
			fs.writeFileSync(path.join(nested, "a"), "x\n");
			execFileSync("git", ["add", "pkg"], { cwd: outer, env: isolatedEnv() });
			damage(outer);
			initExcluding(nested);
			const r = run(["K"], SECRET, nested, { CLAUDE_PROJECT_DIR: nested });
			expect(r.status).toBe(0);
			expect(r.stderr).toBe(
				`write-secret: warning — git does not ignore .env in ${nested}, so it could be committed. Add .env and .env.*.tmp to .gitignore.\n`,
			);
		},
	);

	it("warns where the project dir is a repository ignoring .env only through info/exclude, nested in an outer one that tracks other files under it, where an inherited XDG_CONFIG_HOME reaches a global excludes file listing .env (#3393)", () => {
		const outer = path.join(home, "outer");
		const nested = path.join(outer, "pkg");
		fs.mkdirSync(nested, { recursive: true });
		gitInit(outer);
		fs.writeFileSync(path.join(nested, "a"), "x\n");
		execFileSync("git", ["add", "pkg"], { cwd: outer, env: isolatedEnv() });
		initExcluding(nested);
		const xdg = path.join(home, "xdg");
		fs.mkdirSync(path.join(xdg, "git"), { recursive: true });
		fs.writeFileSync(path.join(xdg, "git", "ignore"), ".env*\n");
		const r = run(["K"], SECRET, nested, {
			CLAUDE_PROJECT_DIR: nested,
			XDG_CONFIG_HOME: xdg,
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toBe(
			`write-secret: warning — git does not ignore .env in ${nested}, so it could be committed. Add .env and .env.*.tmp to .gitignore.\n`,
		);
	});

	it("writes silently where the project dir is a repository ignoring .env only through info/exclude, below a dotfiles repository that tracks nothing under it (#3073)", () => {
		const proj = path.join(home, "proj");
		fs.mkdirSync(proj);
		gitInit(home);
		fs.writeFileSync(path.join(home, ".bashrc"), "x\n");
		execFileSync("git", ["add", ".bashrc"], { cwd: home, env: isolatedEnv() });
		initExcluding(proj);
		expectSilentWrite(proj);
	});

	it.each<[string, (dir: string) => void]>([
		["an empty directory", (dir) => fs.mkdirSync(path.join(dir, ".git"))],
		["a bare repository", initBare],
	])(
		"writes silently in a repository below a .git that is %s (#3063)",
		(_l, plant) => {
			const above = path.join(home, "above");
			const proj = path.join(above, "proj");
			fs.mkdirSync(proj, { recursive: true });
			plant(above);
			gitInit(proj);
			fs.writeFileSync(path.join(proj, ".gitignore"), ".env*\n");
			expectSilentWrite(proj);
		},
	);

	const buildOuterTrackingEnv = () => {
		const outer = path.join(home, "outer");
		const proj = path.join(outer, "proj");
		fs.mkdirSync(proj, { recursive: true });
		gitInit(outer);
		const tracked = path.join(proj, ".env");
		fs.writeFileSync(tracked, "A=1\n");
		execFileSync("git", ["add", "proj/.env"], {
			cwd: outer,
			env: isolatedEnv(),
		});
		commitAll(outer);
		return { outer, proj, tracked };
	};

	it.each<[string, (outer: string) => void]>([
		[
			"has lost its HEAD",
			(outer) => fs.rmSync(path.join(outer, ".git", "HEAD")),
		],
		[
			"has lost its HEAD and index",
			(outer) => {
				fs.rmSync(path.join(outer, ".git", "HEAD"));
				fs.rmSync(path.join(outer, ".git", "index"));
			},
		],
		[
			"is a symlink whose target moved",
			(outer) => {
				fs.renameSync(path.join(outer, ".git"), path.join(home, "moved"));
				fs.symlinkSync(path.join(home, "gone"), path.join(outer, ".git"));
			},
		],
		[
			"is a linked worktree whose repository moved, the project dir a repository of its own",
			(outer) => {
				fs.renameSync(path.join(outer, ".git"), path.join(home, "moved"));
				fs.writeFileSync(path.join(outer, ".git"), `gitdir: ${home}/gone\n`);
				gitInit(path.join(outer, "proj"));
			},
		],
	])(
		"refuses as git could not say where a repository above that tracks the project dir's .env %s (#3063)",
		(_l, breakOuter) => {
			const { outer, proj, tracked } = buildOuterTrackingEnv();
			breakOuter(outer);
			const r = run(["K"], SECRET, proj, { CLAUDE_PROJECT_DIR: proj });
			expect(r.status).toBe(1);
			expect(r.stderr).toBe(couldNotSayRefusal(tracked, proj));
			expect(fs.readFileSync(tracked, "utf8")).toBe("A=1\n");
		},
	);

	it("refuses as git could not say, without crashing, where the project dir lies under a regular file (#3063)", () => {
		fs.writeFileSync(path.join(host, "afile"), "");
		const root = path.join(host, "afile", "sub");
		const r = run(["K"], SECRET, host, { CLAUDE_PROJECT_DIR: root });
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(
			`write-secret: warning — ${root} could not be listed (ENOTDIR), so ${left} may remain there. Look for .env.*.tmp by hand.\n${couldNotSayRefusal(path.join(root, ".env"), root)}`,
		);
	});

	it.skipIf(process.getuid?.() === 0)(
		"refuses as git could not say where a repository above that tracks the project dir's .env cannot be listed (#3063)",
		() => {
			const { outer, proj, tracked } = buildOuterTrackingEnv();
			const gitDir = path.join(outer, ".git");
			fs.chmodSync(gitDir, 0o000);
			try {
				const r = run(["K"], SECRET, proj, { CLAUDE_PROJECT_DIR: proj });
				expect(r.status).toBe(1);
				expect(r.stderr).toBe(couldNotSayRefusal(tracked, proj));
			} finally {
				fs.chmodSync(gitDir, 0o755);
			}
			expect(fs.readFileSync(tracked, "utf8")).toBe("A=1\n");
		},
	);

	/**
	 * The host committed and added as submodule `at`, named `name`, of a
	 * superproject under `under`, `.env` force-added to the host first where
	 * `trackEnv`, and committed there where `commit`.
	 */
	const buildSubmodule = (
		trackEnv: boolean,
		{
			at = "lib",
			name = at,
			commit = true,
			under = home,
		}: { at?: string; name?: string; commit?: boolean; under?: string } = {},
	) => {
		if (trackEnv) {
			fs.writeFileSync(env(), "A=1\n");
			git("add", "-f", ".env");
		}
		git("add", ".gitignore");
		commitAll();
		const sup = path.join(under, "sup");
		gitInit(sup);
		const supGit = (...args: string[]) =>
			execFileSync("git", args, { cwd: sup, env: isolatedEnv() });
		supGit(
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"-q",
			"add",
			"--name",
			name,
			host,
			at,
		);
		if (commit) commitAll(sup);
		return { sup, lib: path.join(sup, at), supGit };
	};

	it("writes silently where the project dir is a submodule ignoring .env, run from its superproject, whose HEAD is unborn (#3063)", () => {
		const { sup, lib } = buildSubmodule(false, { commit: false });
		const r = run(["K"], SECRET, sup, { CLAUDE_PROJECT_DIR: lib });
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
		expect(fs.readFileSync(path.join(lib, ".env"), "utf8")).toBe(
			`K=${SECRET}\n`,
		);
	});

	it("refuses where the project dir is a submodule tracking .env, run from its superproject, whose HEAD is unborn (#3063)", () => {
		const { sup, lib } = buildSubmodule(true, { commit: false });
		const tracked = path.join(lib, ".env");
		const r = run(["K"], SECRET, sup, { CLAUDE_PROJECT_DIR: lib });
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(trackedRefusal(tracked));
		expect(fs.readFileSync(tracked, "utf8")).toBe("A=1\n");
	});

	it("writes silently where the project dir is a submodule ignoring .env, run from it (#3087)", () => {
		expectSilentWrite(buildSubmodule(false).lib);
	});

	it.each([
		["the project dir", (lib: string) => lib, true],
		[
			"its superproject",
			(lib: string) => path.dirname(path.dirname(lib)),
			true,
		],
		[
			"its superproject, whose HEAD is unborn",
			(lib: string) => path.dirname(path.dirname(lib)),
			false,
		],
	])(
		"writes silently where the project dir is a submodule ignoring .env at a path of two segments, run from %s (#3087)",
		(_, cwdOf, commit) => {
			const { lib } = buildSubmodule(false, { at: "ext/lib", commit });
			expectSilentWrite(lib, cwdOf(lib));
		},
	);

	it("writes silently where the project dir is a healthy submodule's subdirectory (#3087)", () => {
		const sub = path.join(buildSubmodule(false).lib, "sub");
		fs.mkdirSync(sub);
		expectSilentWrite(sub);
	});

	it("writes silently where the project dir reuses the path of a submodule a committed git rm removed, whose git directory remains (#3087)", () => {
		const { sup, lib, supGit } = buildSubmodule(false);
		supGit("rm", "-q", "lib");
		fs.mkdirSync(lib);
		fs.writeFileSync(path.join(lib, "a"), "");
		fs.writeFileSync(path.join(sup, ".gitignore"), ".env*\n");
		supGit("add", ".gitignore", "lib/a");
		commitAll(sup);
		expectSilentWrite(lib);
	});

	/** The could-not-say refusal for the project dir `lib`, its `.env` left reading `A=1`. */
	const expectLostSubmoduleRefusal = (
		lib: string,
		cwd = lib,
		extra: Record<string, string> = {},
	) => {
		const tracked = path.join(lib, ".env");
		const r = run(["K"], SECRET, cwd, { CLAUDE_PROJECT_DIR: lib, ...extra });
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(couldNotSayRefusal(tracked, lib));
		expect(fs.readFileSync(tracked, "utf8")).toBe("A=1\n");
	};

	/** The could-not-say refusal for a new project dir `sub` inside `lib`, run from it. */
	const expectSubdirRefusal = (
		lib: string,
		extra: Record<string, string> = {},
	) => {
		const sub = path.join(lib, "sub");
		fs.mkdirSync(sub);
		const r = run(["K"], SECRET, sub, { CLAUDE_PROJECT_DIR: sub, ...extra });
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(couldNotSayRefusal(path.join(sub, ".env"), sub));
		expect(fs.existsSync(path.join(sub, ".env"))).toBe(false);
	};

	it("refuses as git could not say where the project dir is a submodule tracking .env, moved from its name's path, whose .git file is lost (#3087)", () => {
		const { sup, supGit } = buildSubmodule(true);
		const moved = path.join(sup, "vlib");
		supGit("mv", "lib", "vlib");
		fs.rmSync(path.join(moved, ".git"));
		expectLostSubmoduleRefusal(moved);
	});

	it("refuses as git could not say where the project dir is a submodule tracking .env, named other than its path, whose .git file and .gitmodules are lost (#3087)", () => {
		const { sup, lib } = buildSubmodule(true, { name: "foo" });
		fs.rmSync(path.join(lib, ".git"));
		fs.rmSync(path.join(sup, ".gitmodules"));
		expectLostSubmoduleRefusal(lib);
	});

	it("refuses as git could not say where the project dir is a submodule tracking .env at a path of two segments whose .git file is lost (#3087)", () => {
		const { lib } = buildSubmodule(true, { at: "ext/lib" });
		fs.rmSync(path.join(lib, ".git"));
		expectLostSubmoduleRefusal(lib);
	});

	it("refuses as git could not say where the project dir is a submodule tracking .env, named other than its path, that git submodule deinit emptied (#3087)", () => {
		const { lib, supGit } = buildSubmodule(true, { name: "foo" });
		supGit("submodule", "-q", "deinit", "-f", "lib");
		fs.writeFileSync(path.join(lib, ".env"), "A=1\n");
		expectLostSubmoduleRefusal(lib);
	});

	it("refuses as git could not say where the project dir is a submodule tracking .env whose .git file is lost and whose gitlink git rm --cached staged out, which a git reset brings back (#3087)", () => {
		const { lib, supGit } = buildSubmodule(true);
		supGit("rm", "-q", "--cached", "lib");
		fs.rmSync(path.join(lib, ".git"));
		expectLostSubmoduleRefusal(lib);
	});

	it("refuses as git could not say where the project dir is a submodule tracking .env whose .git file is lost, of a superproject reached through an inherited GIT_DIR (#3087)", () => {
		const { sup, lib } = buildSubmodule(true);
		const store = `${sup}.git`;
		fs.renameSync(path.join(sup, ".git"), store);
		fs.rmSync(path.join(lib, ".git"));
		expectLostSubmoduleRefusal(lib, lib, {
			GIT_DIR: store,
			GIT_WORK_TREE: sup,
		});
	});

	it("refuses as git could not say where the project dir lies inside a submodule whose .git file is lost and which only the index records, run from it under an inherited GIT_DIR (#3087)", () => {
		const { sup, supGit } = buildSubmodule(true);
		supGit("mv", "lib", "vlib");
		const store = `${sup}.git`;
		fs.renameSync(path.join(sup, ".git"), store);
		const moved = path.join(sup, "vlib");
		fs.rmSync(path.join(moved, ".git"));
		expectSubdirRefusal(moved, { GIT_DIR: store, GIT_WORK_TREE: sup });
	});

	/**
	 * A submodule tracking `.env` whose gitlink `git rm --cached` staged out,
	 * so only HEAD records it, and whose `.git` file is lost; `ref` is the
	 * branch HEAD names.
	 */
	const buildHeadOnlySubmodule = () => {
		const built = buildSubmodule(true);
		built.supGit("rm", "-q", "--cached", "lib");
		fs.rmSync(path.join(built.lib, ".git"));
		const ref = built.supGit("symbolic-ref", "HEAD").toString().trim();
		return { ...built, ref };
	};

	it("refuses as git could not say where the project dir lies inside a submodule whose .git file is lost and which only HEAD records, its branch ref lost and HEAD's reflog kept (#3087)", () => {
		const { sup, lib, ref } = buildHeadOnlySubmodule();
		fs.rmSync(path.join(sup, ".git", ref));
		expectSubdirRefusal(lib);
	});

	it("refuses as git could not say where the project dir lies inside a submodule whose .git file is lost and which only HEAD records, its branch ref and HEAD's reflog lost and the branch's reflog kept (#3087)", () => {
		const { sup, lib, ref } = buildHeadOnlySubmodule();
		fs.rmSync(path.join(sup, ".git", ref));
		fs.rmSync(path.join(sup, ".git", "logs", "HEAD"));
		expectSubdirRefusal(lib);
	});

	it("refuses as git could not say where the project dir lies inside a submodule whose .git file is lost and which only HEAD records, HEAD's tree object lost (#3087)", () => {
		const { sup, lib, supGit } = buildHeadOnlySubmodule();
		const tree = supGit("rev-parse", "HEAD^{tree}").toString().trim();
		fs.rmSync(
			path.join(sup, ".git", "objects", tree.slice(0, 2), tree.slice(2)),
		);
		expectSubdirRefusal(lib);
	});

	it.each([
		["", false],
		[" whose reflogs are expired", true],
	])(
		"writes silently where the project dir, no submodule's path, lies in a superproject on a new orphan branch%s (#3087)",
		(_, expire) => {
			const { sup, supGit } = buildSubmodule(false);
			if (expire) supGit("reflog", "expire", "--expire=now", "--all");
			supGit("checkout", "-q", "--orphan", "fresh");
			fs.writeFileSync(path.join(sup, ".gitignore"), ".env*\n");
			supGit("add", ".gitignore");
			const app = path.join(sup, "app");
			fs.mkdirSync(app);
			expectSilentWrite(app);
		},
	);

	it("refuses as git could not say where the project dir lies inside a submodule whose .git file is lost and which only HEAD records, its branch deleted (#3087)", () => {
		const { lib, supGit, ref } = buildHeadOnlySubmodule();
		supGit("update-ref", "-d", ref);
		expectSubdirRefusal(lib);
	});

	const [major = 0, minor = 0] = (
		execFileSync("git", ["version"])
			.toString()
			.match(/(\d+)\.(\d+)/) ?? []
	)
		.slice(1)
		.map(Number);
	// Reftable arrived in git 2.45.
	const hasReftable = major > 2 || (major === 2 && minor >= 45);

	// Git 2.45 on refuses to open a repository this config names reftable at format 0.
	it.skipIf(hasReftable)(
		"writes silently where the project dir lies in a repository whose HEAD is unborn and whose config, at a format that ignores it, names reftable (#3087)",
		() => {
			const repo = path.join(home, "plain");
			gitInit(repo);
			const repoGit = (...args: string[]) =>
				execFileSync("git", args, { cwd: repo, env: isolatedEnv() });
			repoGit("config", "extensions.refStorage", "reftable");
			fs.writeFileSync(path.join(repo, ".gitignore"), ".env*\n");
			repoGit("add", ".gitignore");
			const app = path.join(repo, "app");
			fs.mkdirSync(app);
			expectSilentWrite(app);
		},
	);

	it.skipIf(!hasReftable)(
		"refuses as git could not say where the project dir lies in a reftable repository whose HEAD is unborn (#3087)",
		() => {
			const repo = path.join(home, "rt");
			execFileSync("git", ["init", "-q", "--ref-format=reftable", repo], {
				env: isolatedEnv(),
			});
			expectSubdirRefusal(repo);
		},
	);

	// The pair's two halves need two filesystems, so each skips where its own
	// is missing: CI's ext4 runs only the case-sensitive half, as ext4 folds
	// case only on a casefold mount, which needs root to make.
	it.skipIf(!foldingDir)(
		"refuses as git could not say where the project dir is a submodule tracking .env whose .git file is lost, spelt in another case on a case-insensitive filesystem (#3100)",
		() => {
			// Under foldingDir, not beforeEach's temp dir, whose filesystem
			// may not fold.
			const under = fs.mkdtempSync(
				path.join(foldingDir ?? "", "write-secret-fold-"),
			);
			try {
				const { sup, lib } = buildSubmodule(true, { under });
				fs.rmSync(path.join(lib, ".git"));
				expectLostSubmoduleRefusal(path.join(sup, "LIB"));
			} finally {
				fs.rmSync(under, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(foldingDir === os.tmpdir())(
		"writes silently where the project dir is a plain directory spelt as a healthy submodule beside it in another case, on a case-sensitive filesystem (#3100)",
		() => {
			const { sup, supGit } = buildSubmodule(false, { at: "Lib" });
			const lib = path.join(sup, "lib");
			fs.mkdirSync(lib);
			fs.writeFileSync(path.join(lib, "a"), "");
			fs.writeFileSync(path.join(sup, ".gitignore"), ".env*\n");
			supGit("add", ".gitignore", "lib/a");
			commitAll(sup);
			expectSilentWrite(lib);
		},
	);

	it.each([
		["the project dir", (lib: string) => lib],
		["its superproject", (lib: string) => path.dirname(lib)],
	])(
		"refuses as git could not say where the project dir is a submodule tracking .env whose .git file is lost, run from %s (#3087)",
		(_, cwdOf) => {
			const { lib } = buildSubmodule(true);
			fs.rmSync(path.join(lib, ".git"));
			expectLostSubmoduleRefusal(lib, cwdOf(lib));
		},
	);

	it("refuses as git could not say where the project dir lies inside a submodule whose .git file is lost (#3087)", () => {
		const { lib } = buildSubmodule(true);
		fs.rmSync(path.join(lib, ".git"));
		expectSubdirRefusal(lib);
	});

	it("refuses as git could not say under a relative GIT_DIR naming no repository from the subdirectory of the project dir it is run from (#3063)", () => {
		const sub = path.join(host, "sub");
		fs.mkdirSync(sub);
		const r = run(["K"], SECRET, sub, { GIT_DIR: ".git" });
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(couldNotSayRefusal(env(), host));
		expect(fs.existsSync(env())).toBe(false);
	});

	it("writes silently under an inherited GIT_DIR naming a bare repository, which has no work tree to commit from (#3063)", () => {
		const store = path.join(home, "store.git");
		execFileSync("git", ["init", "-q", "--bare", store], {
			env: isolatedEnv(),
		});
		const r = run(["K"], SECRET, host, { GIT_DIR: store });
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
		expect(read()).toBe(`K=${SECRET}\n`);
	});

	it.each<[string, () => Record<string, string>]>([
		[
			"an inherited GIT_CONFIG_GLOBAL",
			() => ({ GIT_CONFIG_GLOBAL: "/dev/null" }),
		],
		["an inherited GIT_DIR", () => ({ GIT_DIR: path.join(home, ".git") })],
	])(
		"writes the project dir's .env from a directory in another repository under %s (#3063)",
		(_l, extra) => {
			gitInit(home);
			const r = run(["K"], SECRET, home, extra());
			expect(r.status).toBe(0);
			expect(read()).toBe(`K=${SECRET}\n`);
		},
	);

	it("writes .env outside any repository where an inherited GIT_CEILING_DIRECTORIES hides one above (#3063)", () => {
		gitInit(home);
		fs.writeFileSync(path.join(home, ".gitignore"), ".env*\n");
		const proj = path.join(home, "proj");
		fs.mkdirSync(proj);
		const r = run(["K"], SECRET, proj, {
			CLAUDE_PROJECT_DIR: "",
			GIT_CEILING_DIRECTORIES: home,
		});
		expect(r.status).toBe(0);
		expect(fs.readFileSync(path.join(proj, ".env"), "utf8")).toBe(
			`K=${SECRET}\n`,
		);
	});

	const buildExcludesFile = () => {
		const file = path.join(home, "excludes");
		fs.writeFileSync(file, ".env*\n");
		return file;
	};
	const configExcludes: [string, () => Record<string, string>][] = [
		[
			"GIT_CONFIG_COUNT",
			() => ({
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "core.excludesFile",
				GIT_CONFIG_VALUE_0: buildExcludesFile(),
			}),
		],
		[
			"GIT_CONFIG_PARAMETERS",
			() => ({
				GIT_CONFIG_PARAMETERS: `'core.excludesFile'='${buildExcludesFile()}'`,
			}),
		],
		[
			"GIT_CONFIG_GLOBAL",
			() => {
				const file = path.join(home, "gitconfig");
				fs.writeFileSync(
					file,
					`[core]\n\texcludesFile = ${buildExcludesFile()}\n`,
				);
				return { GIT_CONFIG_GLOBAL: file };
			},
		],
	];

	it.each(configExcludes)(
		"still warns that git does not ignore .env where an inherited %s excludes it (#3063)",
		(_l, extra) => {
			fs.writeFileSync(path.join(host, ".gitignore"), "");
			const r = run(["K"], SECRET, host, extra());
			expect(r.status).toBe(0);
			expect(r.stderr).toBe(
				`write-secret: warning — git does not ignore .env in ${host}, so it could be committed. Add .env and .env.*.tmp to .gitignore.\n`,
			);
		},
	);

	it.each(configExcludes)(
		"still warns that a bare repository entered through an inherited GIT_DIR and GIT_WORK_TREE does not ignore .env where an inherited %s excludes it (#3063)",
		(_l, extra) => {
			const bare = buildBareEntered(() => home);
			const r = run(["K"], SECRET, bare.tree, {
				CLAUDE_PROJECT_DIR: "",
				GIT_DIR: path.join(home, "store.git"),
				GIT_WORK_TREE: bare.tree,
				...extra(),
			});
			expect(r.status).toBe(0);
			expect(r.stderr).toBe(
				`write-secret: warning — git does not ignore .env in ${bare.tree}, so it could be committed. Add .env and .env.*.tmp to .gitignore.\n`,
			);
		},
	);

	it.each<[string, (dir: string) => string]>([
		["XDG_CONFIG_HOME", (dir) => path.join(dir, "git")],
		["HOME", (dir) => path.join(dir, ".config", "git")],
	])(
		"still warns that git does not ignore .env where an inherited %s reaches a global excludes file listing it (#3393)",
		(name, excludesDir) => {
			const dir = path.join(home, "other");
			fs.mkdirSync(excludesDir(dir), { recursive: true });
			fs.writeFileSync(path.join(excludesDir(dir), "ignore"), ".env*\n");
			fs.writeFileSync(path.join(host, ".gitignore"), "");
			const r = run(["K"], SECRET, host, { [name]: dir });
			expect(r.status).toBe(0);
			expect(r.stderr).toBe(
				`write-secret: warning — git does not ignore .env in ${host}, so it could be committed. Add .env and .env.*.tmp to .gitignore.\n`,
			);
		},
	);

	/** A `.env` committed under `host/r`, then the index lost. */
	const buildLostIndex = () => {
		const proj = path.join(host, "r");
		fs.mkdirSync(proj);
		const file = path.join(proj, ".env");
		fs.writeFileSync(file, "A=1\n");
		git("add", "-f", file);
		commitAll();
		fs.rmSync(path.join(host, ".git", "index"));
		return { proj, file };
	};

	it("refuses a .env HEAD tracks where the index is lost, which a git reset brings back, run from the project dir's repository's top (#3080)", () => {
		const { proj, file } = buildLostIndex();
		const r = run(["K"], SECRET, host, { CLAUDE_PROJECT_DIR: proj });
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(trackedRefusal(file));
		expect(fs.readFileSync(file, "utf8")).toBe("A=1\n");
	});

	it("refuses a .env tracked where the index is lost and the branch ref emptied, which HEAD's reflog restores (#3080)", () => {
		const { proj, file } = buildLostIndex();
		const ref = git("symbolic-ref", "HEAD").toString().trim();
		fs.writeFileSync(path.join(host, ".git", ref), "");
		const r = run(["K"], SECRET, host, { CLAUDE_PROJECT_DIR: proj });
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(trackedRefusal(file));
		expect(fs.readFileSync(file, "utf8")).toBe("A=1\n");
	});

	it("refuses a .env tracked where the index, the branch ref and HEAD's reflog are lost, which the branch's reflog restores (#3098)", () => {
		const { proj, file } = buildLostIndex();
		const ref = git("symbolic-ref", "HEAD").toString().trim();
		fs.rmSync(path.join(host, ".git", ref));
		fs.rmSync(path.join(host, ".git", "logs", "HEAD"));
		const r = run(["K"], SECRET, host, { CLAUDE_PROJECT_DIR: proj });
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(trackedRefusal(file));
		expect(fs.readFileSync(file, "utf8")).toBe("A=1\n");
	});

	it("writes silently where the index is lost and the branch is truly unborn (#3098)", () => {
		git("add", ".gitignore");
		fs.rmSync(path.join(host, ".git", "index"));
		expectSilentWrite(host);
	});

	/** `.gitignore` committed, then the index, the branch ref and HEAD's reflog lost. */
	const buildLostRefs = () => {
		git("add", ".gitignore");
		commitAll();
		const ref = git("symbolic-ref", "HEAD").toString().trim();
		fs.rmSync(path.join(host, ".git", "index"));
		fs.rmSync(path.join(host, ".git", ref));
		fs.rmSync(path.join(host, ".git", "logs", "HEAD"));
		return fs.readFileSync(path.join(host, ".git", "logs", ref), "utf8");
	};

	it("refuses as git could not say where the index, the branch ref and HEAD's reflog are lost and the branch's reflog tip leaves .env untracked (#3098)", () => {
		buildLostRefs();
		const r = run(["K"], SECRET);
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(couldNotSayRefusal(env(), host));
		expect(fs.existsSync(env())).toBe(false);
	});

	it("refuses as git could not say where the commit the branch's reflog would restore, the index, the branch ref and HEAD's reflog are lost (#3098)", () => {
		const tip = buildLostRefs().trimEnd().split("\n").pop()?.split(" ")[1];
		if (tip === undefined) throw new Error("no reflog tip");
		const objects = path.join(host, ".git", "objects");
		fs.rmSync(path.join(objects, tip.slice(0, 2), tip.slice(2)));
		const r = run(["K"], SECRET);
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(couldNotSayRefusal(env(), host));
		expect(fs.existsSync(env())).toBe(false);
	});

	it("refuses as git could not say where the project dir's repository, nested in a healthy one that ignores .env, tracks .env and has lost its HEAD (#3080)", () => {
		gitInit(home);
		fs.writeFileSync(path.join(home, ".gitignore"), "*\n");
		const nested = path.join(home, "pkg");
		gitInit(nested);
		const file = path.join(nested, ".env");
		fs.writeFileSync(file, "A=1\n");
		execFileSync("git", ["add", "-f", ".env"], {
			cwd: nested,
			env: isolatedEnv(),
		});
		fs.rmSync(path.join(nested, ".git", "HEAD"));
		const r = run(["K"], SECRET, nested, { CLAUDE_PROJECT_DIR: nested });
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(couldNotSayRefusal(file, nested));
		expect(fs.readFileSync(file, "utf8")).toBe("A=1\n");
	});

	/** A committed `.env` whose removal `git rm --cached` staged, and ignored. */
	const buildStagedUntrack = () => {
		fs.writeFileSync(env(), "A=1\n");
		git("add", "-f", ".env");
		commitAll();
		git("rm", "-q", "--cached", ".env");
		fs.writeFileSync(path.join(host, ".gitignore"), ".env\n.env.*.tmp\n");
	};

	it("refuses a .env HEAD tracks whose removal is staged but not committed, which a git reset or git stash brings back (#3393)", () => {
		buildStagedUntrack();
		const r = run(["K"], SECRET);
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(trackedRefusal(env()));
		expect(read()).toBe("A=1\n");
	});

	it.each<[string, (ref: string) => void]>([
		["emptied", (ref) => fs.writeFileSync(path.join(host, ".git", ref), "")],
		["deleted", (ref) => fs.rmSync(path.join(host, ".git", ref))],
		["deleted with git update-ref -d", (ref) => git("update-ref", "-d", ref)],
	])(
		"refuses a .env whose removal is staged where the branch ref is %s, which restoring it from a reflog brings back (#3393)",
		(_l, damage) => {
			buildStagedUntrack();
			damage(git("symbolic-ref", "HEAD").toString().trim());
			const r = run(["K"], SECRET);
			expect(r.status).toBe(1);
			expect(r.stderr).toBe(trackedRefusal(env()));
			expect(read()).toBe("A=1\n");
		},
	);

	it("refuses a .env whose removal is staged under an inherited GIT_REPLACE_REF_BASE swapping HEAD for a commit without it (#3393)", () => {
		buildStagedUntrack();
		const head = git("rev-parse", "HEAD").toString().trim();
		const tree = git("write-tree").toString().trim();
		const fake = execFileSync(
			"git",
			[
				"-c",
				"user.name=t",
				"-c",
				"user.email=t@t",
				"commit-tree",
				tree,
				"-m",
				"x",
			],
			{ cwd: host, env: isolatedEnv() },
		)
			.toString()
			.trim();
		git("update-ref", `refs/fake/${head}`, fake);
		const r = run(["K"], SECRET, host, { GIT_REPLACE_REF_BASE: "refs/fake/" });
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(trackedRefusal(env()));
		expect(read()).toBe("A=1\n");
	});

	it("writes a .env once its git rm --cached is committed, as the refusal says to (#3393)", () => {
		buildStagedUntrack();
		commitAll();
		const r = run(["K"], SECRET);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
		expect(read()).toBe(`A=1\nK=${SECRET}\n`);
	});

	it("refuses as git could not say where a repository that lost its HEAD lies under a path holding a colon, inside a healthy repository (#3080)", () => {
		gitInit(home);
		const repo = path.join(home, "a:b", "h");
		const proj = path.join(repo, "mid", "r");
		fs.mkdirSync(proj, { recursive: true });
		gitInit(repo);
		const file = path.join(proj, ".env");
		fs.writeFileSync(file, "A=1\n");
		execFileSync("git", ["add", "-f", file], { cwd: repo, env: isolatedEnv() });
		fs.rmSync(path.join(repo, ".git", "HEAD"));
		const r = run(["K"], SECRET, proj, { CLAUDE_PROJECT_DIR: proj });
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(couldNotSayRefusal(file, proj));
		expect(fs.readFileSync(file, "utf8")).toBe("A=1\n");
	});

	it("refuses as git could not say where the caller's directory is a repository git cannot open whose core.worktree is the project dir, inside a healthy repository (#3080)", () => {
		gitInit(home);
		const repo = path.join(home, "X");
		const tree = path.join(home, "ww");
		fs.mkdirSync(tree);
		const inRepo = (...args: string[]) =>
			execFileSync("git", args, { cwd: repo, env: isolatedEnv() });
		gitInit(repo);
		inRepo("config", "core.worktree", tree);
		fs.writeFileSync(path.join(tree, ".env"), "A=1\n");
		inRepo("add", "-f", path.join(tree, ".env"));
		fs.rmSync(path.join(repo, ".git", "HEAD"));
		const r = run(["K"], SECRET, repo, { CLAUDE_PROJECT_DIR: tree });
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(couldNotSayRefusal(path.join(tree, ".env"), tree));
		expect(fs.readFileSync(path.join(tree, ".env"), "utf8")).toBe("A=1\n");
	});

	const canUnshare =
		spawnSync("unshare", ["-rm", "true"], { stdio: "ignore" }).status === 0;

	/**
	 * Runs the script in a fresh mount namespace with a tmpfs over `h/work`
	 * under `home`, the project dir `h/work/r` created inside it. `h` is a
	 * repository ignoring `.env`; `damage` loses its HEAD, inside a healthy
	 * repository at `home`.
	 */
	const runBelowMount = (damage: boolean) => {
		const outer = path.join(home, "h");
		const work = path.join(outer, "work");
		fs.mkdirSync(work, { recursive: true });
		gitInit(outer);
		fs.writeFileSync(path.join(outer, ".gitignore"), ".env*\n");
		if (damage) {
			gitInit(home);
			fs.rmSync(path.join(outer, ".git", "HEAD"));
		}
		const proj = path.join(work, "r");
		const r = spawnSync(
			"unshare",
			[
				"-rm",
				"sh",
				"-c",
				'mount -t tmpfs t "$1" && mkdir "$2" && cd "$2" && exec "$3" "$4" K',
				"sh",
				work,
				proj,
				process.execPath,
				SCRIPT,
			],
			{
				encoding: "utf8",
				env: isolatedEnv({ CLAUDE_PROJECT_DIR: proj }),
				input: SECRET,
			},
		);
		return { ...r, proj };
	};

	it.skipIf(!canUnshare)(
		"writes silently below a mount point under a repository that ignores .env, where git's search stops at the mount (#3080)",
		() => {
			const r = runBelowMount(false);
			expect(r.stderr).toBe("");
			expect(r.stdout).toBe(
				`write-secret: added K in ${path.join(r.proj, ".env")}\n`,
			);
			expect(r.status).toBe(0);
		},
	);

	it.skipIf(!canUnshare)(
		"refuses as git could not say below a mount point under a repository that has lost its HEAD, inside a healthy one (#3080)",
		() => {
			const r = runBelowMount(true);
			expect(r.stderr).toBe(
				couldNotSayRefusal(path.join(r.proj, ".env"), r.proj),
			);
			expect(r.status).toBe(1);
		},
	);

	it("writes .env outside any repository, where nothing can commit it (#2777)", () => {
		removeRepo();
		const r = run(["K"], SECRET);
		expect(r.status).toBe(0);
		expect(read()).toBe(`K=${SECRET}\n`);
	});

	it.each([
		["plain", "a-b_c.d/e+f=", "a-b_c.d/e+f="],
		["with inner spaces", "two words", "two words"],
		["with a #", "pa#ss", "'pa#ss'"],
		["with a $", "pa$ss", "'pa$ss'"],
		["with a backtick", "pa`ss", "'pa`ss'"],
		["ending in a double quote", 'pass"', `'pass"'`],
		["with an inner single quote only", "it's", "it's"],
	])(
		"writes a value %s so the readers get it back: %j",
		(_l, value, written) => {
			expect(run(["K"], value).status).toBe(0);
			expect(read()).toBe(`K=${written}\n`);
		},
	);

	it("resolves the host root from a subdirectory when no project dir is declared", () => {
		const sub = path.join(host, "deep", "er");
		fs.mkdirSync(sub, { recursive: true });
		const r = runInProcess(SCRIPT, ["K"], {
			cwd: sub,
			env: isolatedEnv(),
			stdin: SECRET,
		});
		expect(r.status).toBe(0);
		expect(read()).toBe(`K=${SECRET}\n`);
	});

	it.each([[[]], [["A", "B"]]])(
		"rejects the arguments %j with the usage",
		(args) => {
			const r = run(args, SECRET);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain("usage: write-secret.js <NAME>");
			expect(fs.existsSync(env())).toBe(false);
		},
	);
});
