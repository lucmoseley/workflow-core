// @vitest-environment node
/*
 * write-secret.js writes one secret into the secrets file, outside every
 * working tree (#640, #3202).
 *
 * Every CLI case drives the script in-process from a throwaway git repo, the
 * value on piped stdin and XDG_CONFIG_HOME on a throwaway directory, and reads
 * back only what the founder sees: the exit, the printed lines, the file's
 * bytes and mode. Every run is checked for the value leaking into stdout or
 * stderr.
 *
 * It is the route the founder hands a secret over by: loosen a case and a key
 * leaks into a terminal a session reads, lands where a commit or a stray
 * `.env` write reaches it, or mangles the file's other entries.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gateway } from "./guard-jev-advisory.js";
import { readEnvFileValue, secretsFile } from "./lib/env-file.js";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "write-secret.js");

const SECRET = "plain-test-value";

let host: string;
let config: string;
const store = () => path.join(config, "workflow-core", "secrets.env");

const isolatedEnv = (extra: Record<string, string> = {}) => ({
	PATH: process.env.PATH ?? "",
	HOME: config,
	XDG_CONFIG_HOME: config,
	GIT_CONFIG_NOSYSTEM: "1",
	...extra,
});
const gitIn =
	(cwd: string) =>
	(...args: string[]) =>
		execFileSync("git", args, { cwd, env: isolatedEnv() });

beforeEach(() => {
	host = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "write-secret-")),
	);
	config = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "write-secret-config-")),
	);
	gitIn(host)("init", "-q");
});
afterEach(() => {
	fs.rmSync(host, { recursive: true, force: true });
	fs.rmSync(config, { recursive: true, force: true });
});

const run = (
	args: string[],
	stdin: string,
	extra: Record<string, string> = {},
) => {
	const r = runInProcess(SCRIPT, args, {
		cwd: host,
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

const seed = (text: string) => {
	fs.mkdirSync(path.dirname(store()), { recursive: true });
	fs.writeFileSync(store(), text);
};
const read = () => fs.readFileSync(store(), "utf8");
const modeOf = (p: string) => fs.statSync(p).mode & 0o777;
const refused = (why: string) =>
	`write-secret: refused, ${store()} untouched — ${why}\n`;

describe("write-secret", () => {
	it("creates the secrets file owner-only in an owner-only directory, holding exactly the one line, and nothing in the host root", () => {
		const r = run(["API_KEY"], `${SECRET}\n`);
		expect(r.status).toBe(0);
		expect(read()).toBe(`API_KEY=${SECRET}\n`);
		expect(modeOf(store())).toBe(0o600);
		expect(modeOf(path.dirname(store()))).toBe(0o700);
		expect(r.stdout).toBe(`write-secret: added API_KEY in ${store()}\n`);
		expect(r.stderr).toBe("");
		expect(fs.readdirSync(host)).toEqual([".git"]);
	});

	it("leaves every stored secret readable to its readers after a stray `echo X > .env` in the host root (#3161)", () => {
		expect(run(["AI_GATEWAY_API_KEY"], SECRET).status).toBe(0);
		expect(run(["SEAT_KEY"], "seat-value").status).toBe(0);
		execFileSync("sh", ["-c", "echo X=1 > .env"], { cwd: host });
		expect(fs.readFileSync(path.join(host, ".env"), "utf8")).toBe("X=1\n");
		const saved = { ...process.env };
		process.env.XDG_CONFIG_HOME = config;
		delete process.env.WFC_SECRETS_FILE;
		delete process.env.AI_GATEWAY_API_KEY;
		try {
			expect(gateway.readKey()).toBe(SECRET);
			expect(readEnvFileValue(secretsFile(), "SEAT_KEY")).toBe("seat-value");
		} finally {
			for (const k of [
				"XDG_CONFIG_HOME",
				"WFC_SECRETS_FILE",
				"AI_GATEWAY_API_KEY",
			]) {
				if (saved[k] === undefined) delete process.env[k];
				else process.env[k] = saved[k];
			}
		}
	});

	it("uses ~/.config where XDG_CONFIG_HOME is unset or relative", () => {
		const home = path.join(config, "home");
		for (const xdg of [undefined, "", "relative/dir"]) {
			const env: Record<string, string> = isolatedEnv({
				CLAUDE_PROJECT_DIR: host,
				HOME: home,
			});
			if (xdg === undefined) delete env.XDG_CONFIG_HOME;
			else env.XDG_CONFIG_HOME = xdg;
			const r = runInProcess(SCRIPT, ["K"], { cwd: host, env, stdin: SECRET });
			expect(r.status).toBe(0);
			expect(r.stdout).not.toContain(SECRET);
			expect(r.stderr).not.toContain(SECRET);
		}
		expect(
			fs.readFileSync(
				path.join(home, ".config", "workflow-core", "secrets.env"),
				"utf8",
			),
		).toBe(`K=${SECRET}\n`);
	});

	it("replaces only that name's value, keeping every other byte, the order and the missing final newline, and tightens the mode to owner-only", () => {
		seed("# keys\nA=1\r\nexport API_KEY = old\r\n\nB='two words'");
		fs.chmodSync(store(), 0o640);
		const r = run(["API_KEY"], SECRET);
		expect(r.status).toBe(0);
		expect(read()).toBe(
			`# keys\nA=1\r\nexport API_KEY = ${SECRET}\r\n\nB='two words'`,
		);
		expect(modeOf(store())).toBe(0o600);
		expect(r.stdout).toBe(`write-secret: replaced API_KEY in ${store()}\n`);
	});

	it("a second run for the same name replaces the first value", () => {
		run(["API_KEY"], "first-value");
		fs.appendFileSync(store(), "OTHER=x\n");
		run(["API_KEY"], SECRET);
		expect(read()).toBe(`API_KEY=${SECRET}\nOTHER=x\n`);
	});

	it("does not match a name that only shares a prefix", () => {
		seed("API_KEY_OLD=x\nXAPI_KEY=y\n");
		expect(run(["API_KEY"], SECRET).status).toBe(0);
		expect(read()).toBe(`API_KEY_OLD=x\nXAPI_KEY=y\nAPI_KEY=${SECRET}\n`);
	});

	it.each([
		["with a final newline", "A=1\n", `A=1\nK=${SECRET}\n`],
		["without one", "A=1", `A=1\nK=${SECRET}`],
	])(
		"appends a new name to a file %s, keeping that ending",
		(_l, before, after) => {
			seed(before);
			expect(run(["K"], SECRET).status).toBe(0);
			expect(read()).toBe(after);
		},
	);

	it("trims the value, as the readers do", () => {
		run(["K"], `  ${SECRET} \n`);
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
			expect(readEnvFileValue(store(), "K")).toBe(value);
		},
	);

	it.each(["1KEY", "API-KEY", "API KEY", "", SECRET])(
		"refuses the name %j with exit 2, without echoing it",
		(name) => {
			seed("A=1\n");
			const r = run([name], "unused-value");
			expect(r.status).toBe(2);
			expect(
				r.stderr.startsWith(
					`write-secret: refused, ${store()} untouched — the argument is not a shell variable name`,
				),
			).toBe(true);
			if (name) expect(r.stderr).not.toContain(name);
			expect(read()).toBe("A=1\n");
		},
	);

	it.each([
		[
			"a value holding a line break",
			"one\ntwo\n",
			"the value holds a line break, which one line cannot carry. Re-run and give it on one line.",
		],
		[
			"a value needing quotes that holds a single quote",
			"it's#mine",
			"the value holds a single quote as well as #, $, a backtick or a quote at an end, which no .env quoting reads back intact. Store it elsewhere, or rotate to a value without them.",
		],
	])("refuses %s with exit 2, the file untouched", (_l, stdin, why) => {
		seed("A=1\n");
		const r = run(["K"], stdin);
		expect(r.status).toBe(2);
		expect(r.stderr).toBe(refused(why));
		expect(r.stdout).toBe("");
		expect(read()).toBe("A=1\n");
	});

	it.each([
		["an empty", ""],
		["a whitespace-only", "  \n"],
	])(
		"refuses %s value on a stdin that is no terminal, naming that cause and the own-terminal line, the file untouched (#2554)",
		(_l, stdin) => {
			seed("A=1\n");
			const r = run(["K"], stdin);
			expect(r.status).toBe(2);
			expect(r.stderr).toBe(
				refused(
					"the value for K is empty: stdin is not a terminal, as under Claude Code's `!` prefix, so no hidden prompt could ask for it. " +
						`Run this in your own terminal instead:\ncd ${host} && node ${SCRIPT} K`,
				),
			);
			expect(r.stdout).toBe("");
			expect(read()).toBe("A=1\n");
		},
	);

	it("refuses an empty value without creating the file", () => {
		const r = run(["K"], "");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(
			`refused, ${store()} untouched — the value for K is empty`,
		);
		expect(fs.existsSync(store())).toBe(false);
	});

	it("refuses with exit 1 where the file would lie in a git working tree, writing nothing", () => {
		const r = run(["K"], SECRET, { XDG_CONFIG_HOME: path.join(host, "cfg") });
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(
			`write-secret: refused, ${path.join(host, "cfg", "workflow-core", "secrets.env")} untouched — it lies in the git working tree at ${host}, so a commit there could take it. Point XDG_CONFIG_HOME at a directory in no working tree, then re-run.\n`,
		);
		expect(fs.existsSync(path.join(host, "cfg"))).toBe(false);
	});

	it("refuses with exit 1 where the config directory is a symlink into a git working tree", () => {
		const dots = path.join(config, "dots");
		fs.mkdirSync(path.join(dots, "config"), { recursive: true });
		gitIn(dots)("init", "-q");
		const link = path.join(config, "linked");
		fs.symlinkSync(path.join(dots, "config"), link);
		const r = run(["K"], SECRET, { XDG_CONFIG_HOME: link });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`it lies in the git working tree at ${dots},`);
		expect(fs.existsSync(path.join(dots, "config", "workflow-core"))).toBe(
			false,
		);
	});

	it("refuses with exit 1, writing nothing, where the config path runs through a regular file", () => {
		const blocker = path.join(config, "blocker");
		fs.writeFileSync(blocker, "");
		const r = run(["K"], SECRET, { XDG_CONFIG_HOME: blocker });
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/could not be written \(ENOTDIR\)/);
		expect(fs.readFileSync(blocker, "utf8")).toBe("");
	});

	it("refuses a symlinked file with exit 1, leaving its target untouched", () => {
		const target = path.join(config, "real.env");
		fs.writeFileSync(target, "A=1\n");
		fs.mkdirSync(path.dirname(store()), { recursive: true });
		fs.symlinkSync(target, store());
		const r = run(["K"], SECRET);
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(
			refused(
				"it is a symlink, whose target may lie in a working tree. Replace it with a regular file, then re-run.",
			),
		);
		expect(fs.readFileSync(target, "utf8")).toBe("A=1\n");
	});

	it("refuses with exit 1 when the file cannot be written, leaving no temp file", () => {
		fs.mkdirSync(store(), { recursive: true });
		const r = run(["K"], SECRET);
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(
			/could not be written \(E[A-Z]+\)\. Check it is a regular file you can write, then re-run\.\n$/,
		);
		expect(fs.readdirSync(path.dirname(store()))).toEqual(["secrets.env"]);
	});

	const StaleCopy = "OLD_KEY=stale-copy-value\n";
	/** Above Linux's 2^22 pid ceiling, so no process ever holds it. */
	const DeadPid = 4_194_305;

	const aside = (pid: number, tag = "0a1b2c3d") =>
		path.join(config, "workflow-core", `secrets.env.${pid}.${tag}.tmp`);
	const left = "a copy of the secrets file an earlier interrupted write left";
	const plant = (p: string) => {
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, StaleCopy);
	};

	it("removes an aside an earlier run left, naming it (#2320)", () => {
		const stale = aside(DeadPid);
		plant(stale);
		const r = run(["K"], SECRET);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe(`write-secret: removed ${stale}, ${left}.\n`);
		expect(fs.existsSync(stale)).toBe(false);
		expect(read()).toBe(`K=${SECRET}\n`);
	});

	it("removes a stale aside on a run that then refuses a symlinked file (#2320)", () => {
		const stale = aside(DeadPid);
		plant(stale);
		fs.symlinkSync(path.join(config, "elsewhere"), store());
		const r = run(["K"], SECRET);
		expect(r.status).toBe(1);
		expect(
			r.stderr.startsWith(`write-secret: removed ${stale}, ${left}.\n`),
		).toBe(true);
		expect(fs.existsSync(stale)).toBe(false);
	});

	it("names and leaves an aside whose pid is running (#2320)", () => {
		const live = aside(process.pid);
		plant(live);
		const r = run(["K"], SECRET);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe(
			`write-secret: left ${live}, a copy of the secrets file: its pid ${process.pid} is running, so it may be a run still writing. Delete it once no write-secret runs.\n`,
		);
		expect(fs.readFileSync(live, "utf8")).toBe(StaleCopy);
	});

	it("leaves a near-shaped name, a symlink and a directory under an aside's name (#2320)", () => {
		const near = aside(DeadPid, "notahex1");
		const link = aside(DeadPid);
		const dir = aside(DeadPid, "ffffffff");
		const target = path.join(config, "outside");
		plant(near);
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
		plant(stale);
		fs.chmodSync(path.dirname(stale), 0o555);
		try {
			const r = run(["K"], SECRET);
			expect(
				r.stderr.startsWith(
					`write-secret: warning — ${stale}, ${left}, could not be removed (EACCES). Delete it by hand.\n`,
				),
			).toBe(true);
		} finally {
			fs.chmodSync(path.dirname(stale), 0o700);
		}
		expect(fs.readFileSync(stale, "utf8")).toBe(StaleCopy);
	});

	it.each([[[]], [["A", "B"]]])(
		"rejects the arguments %j with the usage",
		(args) => {
			const r = run(args, SECRET);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain("usage: write-secret.js <NAME>");
			expect(fs.existsSync(store())).toBe(false);
		},
	);
});
