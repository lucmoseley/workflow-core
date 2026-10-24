// @vitest-environment node
/*
 * write-secret.js writes one secret into the host's `.env` (#640).
 *
 * Every CLI case drives the script in-process against a throwaway git repo,
 * the value on piped stdin, and reads back only what the founder sees: the
 * exit, the printed lines, the file's bytes and mode. The repo shuts out the
 * developer's global git excludes, which would silence the git-ignore warning
 * whatever the script did. Every run is checked for the value leaking into
 * stdout or stderr.
 *
 * It is the route the founder hands a secret over by: loosen a case and a key
 * leaks into a terminal a session reads, lands in a git-tracked `.env`, or
 * mangles the file's other entries.
 */

import { execFileSync } from "node:child_process";
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

const run = (args: string[], stdin: string, cwd = host) => {
	const r = runInProcess(SCRIPT, args, {
		cwd,
		env: isolatedEnv({ CLAUDE_PROJECT_DIR: host }),
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

const read = () => fs.readFileSync(env(), "utf8");
const mode = () => fs.statSync(env()).mode & 0o777;

describe("write-secret", () => {
	it("creates .env owner-only holding exactly the one line", () => {
		const r = run(["API_KEY"], `${SECRET}\n`);
		expect(r.status).toBe(0);
		expect(read()).toBe(`API_KEY=${SECRET}\n`);
		expect(mode()).toBe(0o600);
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
		expect(mode()).toBe(0o640);
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
			`write-secret: refused, .env untouched — ${env()} is tracked by git, so a secret written there would be committed. Untrack it (git rm --cached .env) and ignore it first.\n`,
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
		const r = runInProcess(SCRIPT, ["K"], {
			cwd: host,
			env: { ...isolatedEnv({ CLAUDE_PROJECT_DIR: host }), PATH: "" },
			stdin: SECRET,
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/git could not say whether .+ is tracked/);
		expect(fs.existsSync(env())).toBe(false);
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
