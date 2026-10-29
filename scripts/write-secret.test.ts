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

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	fs.rmSync(host, { recursive: true, force: true });
	fs.rmSync(config, { recursive: true, force: true });
});

const run = (
	args: string[],
	stdin: string | Buffer,
	extra: Record<string, string> = {},
) => {
	const r = runInProcess(SCRIPT, args, {
		cwd: host,
		env: isolatedEnv({ CLAUDE_PROJECT_DIR: host, ...extra }),
		stdin,
	});
	expect(r.stderr).not.toContain("stale-copy-value");
	const value = String(stdin).trim();
	if (value) {
		expect(r.stdout).not.toContain(value);
		expect(r.stderr).not.toContain(value);
	}
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

/** The store's directory, owner-only as the script requires (#3539). */
const makeStoreDir = () => {
	fs.mkdirSync(path.dirname(store()), { recursive: true, mode: 0o700 });
	return path.dirname(store());
};
const seed = (text: string) => {
	makeStoreDir();
	fs.writeFileSync(store(), text);
};
const read = () => fs.readFileSync(store(), "utf8");
const UTF16_WHY = `it opens with a UTF-16 mark or holds a NUL byte, so it looks saved as UTF-16 (Notepad's "Unicode"), which a rewrite would mangle. Re-save it as UTF-8, then re-run.`;
const readFromStore = () => {
	vi.stubEnv("XDG_CONFIG_HOME", config);
	vi.stubEnv("WFC_SECRETS_FILE", undefined);
	vi.stubEnv("AI_GATEWAY_API_KEY", undefined);
};
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
		readFromStore();
		expect(gateway.readKey()).toBe(SECRET);
		expect(readEnvFileValue(secretsFile(), "SEAT_KEY")).toBe("seat-value");
	});

	it.each([
		[
			"a missing",
			() => {
				/* seed writes none */
			},
		],
		[
			"a symlinked",
			() =>
				fs.symlinkSync(
					path.join(config, "elsewhere"),
					path.join(path.dirname(store()), ".gitignore"),
				),
		],
	])(
		"the Stop guard's key read writes %s .gitignore beside a store from before #3539, keeping the value (#3663)",
		(_l, plantIgnore) => {
			seed(`AI_GATEWAY_API_KEY=${SECRET}\n`);
			plantIgnore();
			readFromStore();
			expect(gateway.readKey()).toBe(SECRET);
			const ignore = path.join(path.dirname(store()), ".gitignore");
			expect(fs.lstatSync(ignore).isFile()).toBe(true);
			expect(fs.readFileSync(ignore, "utf8")).toBe("*\n");
			expect(read()).toBe(`AI_GATEWAY_API_KEY=${SECRET}\n`);
		},
	);

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

	it("writes a CRLF line its reader reads back (#3542)", () => {
		seed("A=1\r\nK=old\r\n");
		expect(run(["K"], SECRET).status).toBe(0);
		expect(read()).toBe(`A=1\r\nK=${SECRET}\r\n`);
		expect(readEnvFileValue(store(), "K")).toBe(SECRET);
		expect(readEnvFileValue(store(), "A")).toBe("1");
	});

	it("replaces a BOM-led line rather than appending a second, keeping the BOM (#3542)", () => {
		seed("\uFEFFK=old\nA=1\n");
		const r = run(["K"], SECRET);
		expect(r.stdout).toBe(`write-secret: replaced K in ${store()}\n`);
		expect(read()).toBe(`\uFEFFK=${SECRET}\nA=1\n`);
		expect(readEnvFileValue(store(), "K")).toBe(SECRET);
	});

	it.each([
		[
			"a BOM mid-file, as `cat` of two files leaves",
			"A=1\n\uFEFFK=old\n",
			"A=1\n\uFEFFK=",
		],
		["a no-break space before the =", "K\u00A0=old\n", "K\u00A0="],
	])("replaces a line led or spaced by %s (#3542)", (_l, before, prefix) => {
		seed(before);
		const r = run(["K"], SECRET);
		expect(r.stdout).toBe(`write-secret: replaced K in ${store()}\n`);
		expect(read()).toBe(`${prefix}${SECRET}\n`);
		expect(readEnvFileValue(store(), "K")).toBe(SECRET);
	});

	it.each([
		["a CR-only file", "A=1\rK=old\r", 1],
		["a U+2028 inside the line", "A=1\nK=old\u2028tail\n", 2],
	])(
		"refuses with exit 1 a line assigning the name across %s (#3542)",
		(_l, before, line) => {
			seed(before);
			const r = run(["K"], SECRET);
			expect(r.status).toBe(1);
			expect(r.stderr).toBe(
				refused(
					`line ${line} assigns K across a line break (CR, U+2028 or U+2029) that no reader reads past, so its old value would stay in the file. Fix that line by hand, then re-run.`,
				),
			);
			expect(read()).toBe(before);
		},
	);

	it.each([
		[
			'a UTF-16 LE file, as Notepad saves "Unicode"',
			Buffer.from("\uFEFFA=1\r\nK=old\r\n", "utf16le"),
			UTF16_WHY,
		],
		[
			"a UTF-16 LE file without its mark, which decodes as UTF-8",
			Buffer.from("A=1\nK=old\n", "utf16le"),
			UTF16_WHY,
		],
		[
			"a file holding an invalid UTF-8 byte",
			Buffer.concat([
				Buffer.from("A=caf"),
				Buffer.from([0xe9]),
				Buffer.from("\nK=old\n"),
			]),
			"it holds bytes that are not valid UTF-8, which a rewrite would replace with U+FFFD. Re-save it as UTF-8, then re-run.",
		],
	])(
		"refuses with exit 1 %s, its bytes unchanged (#3550)",
		(_l, before, why) => {
			makeStoreDir();
			fs.writeFileSync(store(), before);
			const r = run(["K"], SECRET);
			expect(r.status).toBe(1);
			expect(r.stderr).toBe(refused(why));
			expect(fs.readFileSync(store())).toEqual(before);
		},
	);

	it("writes the first line after a lone BOM (#3542)", () => {
		seed("\uFEFF");
		expect(run(["K"], SECRET).status).toBe(0);
		expect(read()).toBe(`\uFEFFK=${SECRET}\n`);
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

	it.each([
		["1KEY"],
		["API-KEY"],
		["API KEY"],
		[""],
		[SECRET],
		[],
		["K", SECRET],
		[`-${SECRET}`],
		[`--${SECRET}`],
		["K", `--${SECRET}=x`],
		["ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"],
	])(
		"refuses the arguments %j with exit 2 and the usage, naming none of them (#3663)",
		(...argv) => {
			seed("A=1\n");
			const r = run(argv, "unused-value");
			expect(r.status).toBe(2);
			expect(r.stderr).toBe(
				refused(
					"it takes one argument, a shell variable name (letters, digits and underscores, not starting with a digit), and shows none it is given, as one may be the secret. The value is asked for afterwards, never given on the command line.",
				) +
					"usage: write-secret.js <NAME>\n  <NAME>  a shell variable name; the value is then asked for with typing hidden\n",
			);
			expect(r.stdout).toBe("");
			expect(read()).toBe("A=1\n");
		},
	);

	it("prints the usage on --help, writing nothing", () => {
		const r = run(["--help"], "");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("usage: write-secret.js <NAME>");
		expect(fs.existsSync(store())).toBe(false);
	});

	it.each([
		...[
			["a line break", "one\ntwo\n"],
			["a U+2028 (#3542)", "one\u2028two"],
			["a U+2029 (#3542)", "one\u2029two"],
		].map(([what, stdin]) => [
			`a value holding ${what}`,
			stdin,
			"the value holds a line break (CR, LF, U+2028 or U+2029), which one line cannot carry. Re-run and give it on one line.",
		]),
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
		["a NUL byte", Buffer.from("a\0b\n")],
		["bytes that are not UTF-8", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])],
		["a U+FFFD a lossy decode left", Buffer.from("caf\uFFFD\n")],
	])(
		"refuses a piped value holding %s with exit 2, the file untouched and readable to the next run (#3663)",
		(_l, stdin) => {
			seed("A=1\n");
			const r = run(["K"], stdin);
			expect(r.status).toBe(2);
			expect(r.stderr).toBe(
				refused(
					"the value is not valid UTF-8, or holds a NUL byte or U+FFFD, which the file could not carry intact. Re-run and give it as UTF-8 text.",
				),
			);
			expect(read()).toBe("A=1\n");
			expect(run(["K"], SECRET).status).toBe(0);
		},
	);

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
		makeStoreDir();
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

	it("refuses with exit 1 when the file cannot be written, leaving no temp file or lock", () => {
		fs.mkdirSync(store(), { recursive: true, mode: 0o700 });
		const r = run(["K"], SECRET);
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(
			/could not be written \(E[A-Z]+\)\. Check it is a regular file you can write, then re-run\.\n$/,
		);
		expect(fs.readdirSync(path.dirname(store())).sort()).toEqual([
			".gitignore",
			"secrets.env",
		]);
	});

	/** One real `node` run per name, all started together. */
	const runConcurrently = (names: string[]) =>
		Promise.all(
			names.map(
				(name) =>
					new Promise<number | null>((resolve) => {
						// spawn-kept: two processes at once, the lock's race (§X3)
						const child = spawn(process.execPath, [SCRIPT, name], {
							cwd: host,
							env: isolatedEnv({ CLAUDE_PROJECT_DIR: host }),
							stdio: ["pipe", "ignore", "ignore"],
						});
						child.on("close", resolve);
						child.stdin.end(`${name.toLowerCase()}-value\n`);
					}),
			),
		);

	/* 8 rounds of 4 runs lost a key before the lock (#3539's close), a count
	 * chosen there, not a measured minimum. The case measured 0.6-1.6 s
	 * across 16 runs beside ~10 sessions; 60 s is a margin chosen for a loaded
	 * machine, not measured (#3666). */
	it("keeps every key when runs write at once (#3539)", async () => {
		const names = ["K1", "K2", "K3", "K4"];
		for (let round = 0; round < 8; round++) {
			fs.rmSync(store(), { force: true });
			expect(await runConcurrently(names)).toEqual([0, 0, 0, 0]);
			for (const name of names)
				expect(readEnvFileValue(store(), name)).toBe(
					`${name.toLowerCase()}-value`,
				);
		}
		expect(fs.readdirSync(path.dirname(store())).sort()).toEqual([
			".gitignore",
			"secrets.env",
		]);
	}, 60_000);

	it("takes over a lock a dead run left (#3539)", () => {
		makeStoreDir();
		fs.writeFileSync(`${store()}.lock`, String(DeadPid));
		expect(run(["K"], SECRET).status).toBe(0);
		expect(read()).toBe(`K=${SECRET}\n`);
		expect(fs.existsSync(`${store()}.lock`)).toBe(false);
	});

	it("refuses with exit 1 where the lock's path is a directory, moving nothing (#3663)", () => {
		seed("A=1\n");
		fs.mkdirSync(`${store()}.lock`);
		const r = run(["K"], SECRET);
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(
			refused(
				`${store()}.lock is not a regular file, so it is no lock any run can take. Remove it by hand, then re-run.`,
			),
		);
		expect(read()).toBe("A=1\n");
		expect(fs.readdirSync(path.dirname(store())).sort()).toEqual([
			"secrets.env",
			"secrets.env.lock",
		]);
	});

	/* A value past any pipe buffer (64 KiB on Linux), sent as a first part and,
	 * after a pause no reader waits out, the rest: the pipe runs dry between, so
	 * a non-blocking read meets EAGAIN. */
	const PipedBytes = 4 << 20;
	const FirstPart = 1 << 20;
	const DryMs = 200;

	it("reads a piped value to its end where the non-blocking pipe runs dry mid-way (#3663)", async () => {
		const big = "v".repeat(PipedBytes);
		const status = await new Promise<number | null>((resolve) => {
			// spawn-kept: a real non-blocking pipe, which run-in-process cannot give (§X3); the real clock makes it run dry (§X9)
			const child = spawn(process.execPath, [SCRIPT, "BIG"], {
				cwd: host,
				env: isolatedEnv({ CLAUDE_PROJECT_DIR: host }),
				stdio: ["pipe", "ignore", "ignore"],
			});
			child.on("close", resolve);
			child.stdin.on("error", () => {
				/* the run refused early; its status says so */
			});
			child.stdin.write(big.slice(0, FirstPart));
			setTimeout(() => child.stdin.end(`${big.slice(FirstPart)}\n`), DryMs);
		});
		expect(status).toBe(0);
		expect(readEnvFileValue(store(), "BIG")).toBe(big);
	}, 30_000);

	const whyAbove = (dir: string, why: string) =>
		`${dir}, above its directory, ${why}, so another user could swap the directory for one of theirs. Point XDG_CONFIG_HOME at a directory whose every parent is yours or root's and writable by no one else, then re-run.`;

	it("refuses with exit 1, writing nothing, where a directory above the file's is writable by others (#3663)", () => {
		const shared = path.join(config, "shared");
		fs.mkdirSync(shared);
		fs.chmodSync(shared, 0o777);
		const xdg = path.join(shared, "cfg");
		const r = run(["K"], SECRET, { XDG_CONFIG_HOME: xdg });
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(
			`write-secret: refused, ${path.join(xdg, "workflow-core", "secrets.env")} untouched — ${whyAbove(shared, "is writable by others and not sticky")}\n`,
		);
		expect(fs.readdirSync(shared)).toEqual([]);
	});

	it("refuses with exit 1 where the config directory is a symlink into a directory others can write (#3663)", () => {
		const shared = path.join(config, "shared");
		fs.mkdirSync(path.join(shared, "cfg"), { recursive: true });
		fs.chmodSync(shared, 0o777);
		const link = path.join(config, "linked");
		fs.symlinkSync(path.join(shared, "cfg"), link);
		const r = run(["K"], SECRET, { XDG_CONFIG_HOME: link });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			whyAbove(shared, "is writable by others and not sticky"),
		);
		expect(fs.readdirSync(path.join(shared, "cfg"))).toEqual([]);
	});

	it("refuses with exit 1 where a symlink the config path passes through mid-way lies in a directory others can write (#3715)", () => {
		const shared = path.join(config, "shared");
		const data = path.join(config, "data", "cfg");
		const home = path.join(config, "home");
		fs.mkdirSync(shared);
		fs.chmodSync(shared, 0o777);
		fs.mkdirSync(data, { recursive: true, mode: 0o700 });
		fs.mkdirSync(home);
		fs.symlinkSync(data, path.join(shared, "link2"));
		fs.symlinkSync(path.join(shared, "link2"), path.join(home, ".config"));
		const r = run(["K"], SECRET, {
			XDG_CONFIG_HOME: path.join(home, ".config"),
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			whyAbove(shared, "is writable by others and not sticky"),
		);
		expect(fs.readdirSync(data)).toEqual([]);
	});

	it("refuses with exit 1 where a directory above the file's cannot be checked (#3663)", () => {
		const locked = path.join(config, "locked");
		fs.mkdirSync(path.join(locked, "cfg"), { recursive: true });
		fs.chmodSync(locked, 0o000);
		try {
			const xdg = path.join(locked, "cfg");
			const r = run(["K"], SECRET, { XDG_CONFIG_HOME: xdg });
			expect(r.status).toBe(1);
			expect(r.stderr).toContain(
				whyAbove(xdg, "could not be checked (EACCES)"),
			);
		} finally {
			fs.chmodSync(locked, 0o700);
		}
	});

	it("writes under a sticky directory others can write, as /tmp is (#3663)", () => {
		const sticky = path.join(config, "sticky");
		fs.mkdirSync(sticky);
		fs.chmodSync(sticky, 0o1777);
		const xdg = path.join(sticky, "cfg");
		expect(run(["K"], SECRET, { XDG_CONFIG_HOME: xdg }).status).toBe(0);
		expect(
			readEnvFileValue(path.join(xdg, "workflow-core", "secrets.env"), "K"),
		).toBe(SECRET);
	});

	/*
	 * The user databases are faked by spy, not by a seam the script reads:
	 * any path or variable pointing it elsewhere would let the environment
	 * vouch for a group (#3676).
	 */
	const me = os.userInfo();
	const myPasswd = `${me.username}:x:${me.uid}:${me.gid}::/home/me:/bin/sh\n`;
	const myGroup = `${me.username}:x:${me.gid}:\n`;
	const FilesOnly = "passwd: files\ngroup: files\n";
	const Systemd = "passwd: files systemd\ngroup: files systemd\n";
	interface UserDb {
		group?: string | null;
		passwd?: string;
		nsswitch?: string;
		dirs?: Record<string, string[]>;
	}
	/** Serves the user databases as given (null: unreadable), every other read as is. */
	const fakeUserDb = ({
		group = myGroup,
		passwd = myPasswd,
		nsswitch = FilesOnly,
		dirs = {},
	}: UserDb) => {
		const files = new Map<unknown, string | null>([
			["/etc/group", group],
			["/etc/passwd", passwd],
			["/etc/nsswitch.conf", nsswitch],
		]);
		const realRead = fs.readFileSync;
		vi.spyOn(fs, "readFileSync").mockImplementation(((
			p: fs.PathOrFileDescriptor,
			...rest: [never]
		) => {
			if (!files.has(p)) return realRead(p, ...rest);
			const text = files.get(p);
			if (text === null)
				throw Object.assign(new Error("EACCES"), { code: "EACCES" });
			return text;
		}) as typeof fs.readFileSync);
		const realDir = fs.readdirSync;
		vi.spyOn(fs, "readdirSync").mockImplementation(((
			p: fs.PathLike,
			...rest: [never]
		) => {
			if (typeof p !== "string" || !p.includes("userdb"))
				return realDir(p, ...rest);
			const entries = dirs[p];
			if (entries === undefined)
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return entries;
		}) as typeof fs.readdirSync);
	};
	const groupShared = () => {
		const shared = path.join(config, "shared");
		fs.mkdirSync(shared);
		fs.chmodSync(shared, 0o775);
		return shared;
	};

	it.each<[string, UserDb]>([
		["with lookups reading only the files", {}],
		[
			"with systemd serving only dynamic users",
			{
				nsswitch: Systemd,
				dirs: { "/run/systemd/userdb": ["io.systemd.DynamicUser"] },
			},
		],
	])(
		"writes under a directory writable only by the user's private group, as `pam_umask usergroups` leaves ~/.config, %s (#3676)",
		(_label, db) => {
			fakeUserDb(db);
			const xdg = path.join(groupShared(), "cfg");
			expect(run(["K"], SECRET, { XDG_CONFIG_HOME: xdg }).status).toBe(0);
			expect(
				readEnvFileValue(path.join(xdg, "workflow-core", "secrets.env"), "K"),
			).toBe(SECRET);
		},
	);

	it.each<[string, UserDb]>([
		[
			"lists another member",
			{ group: `${me.username}:x:${me.gid}:${me.username},other\n` },
		],
		[
			"is another user's primary group",
			{
				passwd: `${myPasswd}other:x:${me.uid + 1}:${me.gid}::/home/o:/bin/sh\n`,
			},
		],
		[
			"is not the user's primary group",
			{
				passwd: `${me.username}:x:${me.uid}:${me.gid + 1}::/home/me:/bin/sh\n`,
			},
		],
		["is in no /etc/group row", { group: "" }],
		["has a row with no member field", { group: `g:x:${me.gid}\n` }],
		["sits in an unreadable /etc/group", { group: null }],
		["may hold NIS members", { group: `${myGroup}+:::\n` }],
		["has a password", { group: `${me.username}:$6$salt$hash:${me.gid}:\n` }],
		[
			"lists another member behind a `#`",
			{ group: `${myGroup}a#b:x:${me.gid}:other\n` },
		],
		[
			"is another user's primary group by a wrapping id",
			{
				passwd: `${myPasswd}other:x:${me.uid + 1}:-${2 ** 32 - me.gid}::/home/o:/bin/sh\n`,
			},
		],
		[
			"may hold members by a looser nsswitch line",
			{ nsswitch: `group : sss\n${FilesOnly}` },
		],
		[
			"may hold directory-service members",
			{ nsswitch: "passwd: files sss\ngroup: files sss\n" },
		],
		[
			"is named for a user a second, blank-led passwd row also names",
			{
				passwd: `${myPasswd} ${me.username}:x:${me.uid + 1}:${me.uid + 1}::/home/o:/bin/sh\n`,
			},
		],
		[
			"may take members from an `initgroups` source",
			{ nsswitch: `${FilesOnly}initgroups: sss\n` },
		],
		[
			"is named for a user a second passwd row also names",
			{
				passwd: `${myPasswd}${me.username}:x:${me.uid + 1}:${me.uid + 1}::/home/o:/bin/sh\n`,
			},
		],
		[
			"may hold a systemd userdb record",
			{ nsswitch: Systemd, dirs: { "/etc/userdb": ["other.user"] } },
		],
		[
			"may hold a systemd-homed member",
			{
				nsswitch: Systemd,
				dirs: { "/run/systemd/userdb": ["io.systemd.Home"] },
			},
		],
	])(
		"refuses with exit 1, writing nothing, where the group that can write a directory above the file's %s (#3676)",
		(_label, db) => {
			fakeUserDb(db);
			const shared = groupShared();
			const xdg = path.join(shared, "cfg");
			const r = run(["K"], SECRET, { XDG_CONFIG_HOME: xdg });
			expect(r.status).toBe(1);
			expect(r.stderr).toContain(
				whyAbove(shared, "is writable by others and not sticky"),
			);
			expect(fs.readdirSync(shared)).toEqual([]);
		},
	);

	/* An access ACL granting a named user write, set as its raw xattr: no
	 * `setfacl` is on every host. Its group bits then show the ACL's mask. */
	const grantByAcl = (dir: string, uid: number) => {
		execFileSync("python3", [
			"-c",
			[
				"import os, struct, sys",
				"U = 0xFFFFFFFF",
				"rows = [(1, 7, U), (2, 7, int(sys.argv[2])), (4, 7, U), (16, 7, U), (32, 5, U)]",
				"acl = struct.pack('<I', 2) + b''.join(struct.pack('<HHI', *r) for r in rows)",
				"os.setxattr(sys.argv[1], 'system.posix_acl_access', acl)",
			].join("\n"),
			dir,
			String(uid),
		]);
	};

	/* An `ls` first on PATH that claims to be GNU's and marks no ACL. */
	const fakeLsFirst = () => {
		const bin = path.join(config, "bin");
		fs.mkdirSync(bin);
		fs.writeFileSync(
			path.join(bin, "ls"),
			`#!/bin/sh\ncase "$1" in --version) echo 'ls (GNU coreutils) 9.4';; *) echo 'drwxrwxr-x 2 u u 4096 Jan 1 00:00 x';; esac\n`,
			{ mode: 0o755 },
		);
		return { PATH: `${bin}:${process.env.PATH ?? ""}` };
	};

	it.each<[string, () => Record<string, string>]>([
		["", () => ({})],
		[", an `ls` first on PATH hiding it", fakeLsFirst],
	])(
		"refuses with exit 1, writing nothing, where an ACL lets another user write a directory above the file's, whatever its owning group%s (#3715)",
		(_l, env) => {
			fakeUserDb({});
			const shared = groupShared();
			grantByAcl(shared, me.uid + 1);
			const xdg = path.join(shared, "cfg");
			const r = run(["K"], SECRET, { XDG_CONFIG_HOME: xdg, ...env() });
			expect(r.status).toBe(1);
			expect(r.stderr).toContain(
				whyAbove(shared, "is writable by others and not sticky"),
			);
			expect(fs.readdirSync(shared)).toEqual([]);
		},
	);

	it("leaves the directory's own .gitignore alone under WFC_SECRETS_FILE, as the reader does (#3715)", () => {
		const dir = makeStoreDir();
		const ignore = path.join(dir, ".gitignore");
		fs.writeFileSync(ignore, "node_modules\n");
		const r = run(["K"], SECRET, { WFC_SECRETS_FILE: store() });
		expect(r.status).toBe(0);
		expect(fs.readFileSync(ignore, "utf8")).toBe("node_modules\n");
		expect(read()).toBe(`K=${SECRET}\n`);
	});

	it("checks and writes WFC_SECRETS_FILE as one resolved path where `..` follows a symlink in it (#3715)", () => {
		const shared = path.join(config, "shared");
		const sub = path.join(shared, "x", "sub");
		fs.mkdirSync(sub, { recursive: true, mode: 0o700 });
		fs.chmodSync(shared, 0o777);
		const home = path.join(config, "home");
		fs.mkdirSync(home, { mode: 0o700 });
		fs.symlinkSync(sub, path.join(home, "lnk"));
		const r = run(["K"], SECRET, {
			WFC_SECRETS_FILE: `${home}/lnk/../secrets.env`,
		});
		expect(r.status).toBe(0);
		expect(readEnvFileValue(path.join(home, "secrets.env"), "K")).toBe(SECRET);
		expect(fs.readdirSync(path.join(shared, "x"))).toEqual(["sub"]);
	});

	it("replaces a symlinked .gitignore, which git does not follow, keeping the file out of a bare dotfiles repository's `add -A` (#3663)", () => {
		const dots = path.join(host, "dots.git");
		execFileSync("git", ["init", "-q", "--bare", dots], { env: isolatedEnv() });
		const target = path.join(config, "ignore-target");
		fs.writeFileSync(target, "*\n");
		const ignore = path.join(makeStoreDir(), ".gitignore");
		fs.symlinkSync(target, ignore);
		expect(run(["K"], SECRET).status).toBe(0);
		expect(fs.lstatSync(ignore).isFile()).toBe(true);
		expect(fs.readFileSync(ignore, "utf8")).toBe("*\n");
		const staged = execFileSync(
			"git",
			[`--git-dir=${dots}`, `--work-tree=${config}`, "add", "-A", "--dry-run"],
			{ cwd: config, env: isolatedEnv(), encoding: "utf8" },
		);
		expect(staged).not.toContain("secrets.env");
	});

	it("keeps the file out of a bare dotfiles repository's `add -A` (#3539)", () => {
		const dots = path.join(host, "dots.git");
		execFileSync("git", ["init", "-q", "--bare", dots], { env: isolatedEnv() });
		const cfg = (...args: string[]) =>
			execFileSync(
				"git",
				[`--git-dir=${dots}`, `--work-tree=${config}`, ...args],
				{
					cwd: config,
					env: isolatedEnv(),
					encoding: "utf8",
				},
			);
		expect(run(["K"], SECRET).status).toBe(0);
		fs.writeFileSync(path.join(config, "tracked.txt"), "x");
		cfg("add", "-A");
		cfg("add", ".");
		expect(cfg("ls-files").split("\n").filter(Boolean)).toEqual([
			"tracked.txt",
		]);
		expect(
			fs.readFileSync(path.join(path.dirname(store()), ".gitignore"), "utf8"),
		).toBe("*\n");
	});

	it("refuses with exit 1 where the mount ignores modes, so the written file would be loose, the file untouched (#3539)", () => {
		seed("A=1\n");
		/* A mount without `metadata`: chmod is a no-op and a new file is 0644.
		 * Spied, as a test cannot mount one: mounting needs root. */
		const writeFileSync = fs.writeFileSync;
		vi.spyOn(fs, "chmodSync").mockImplementation(() => {
			/* the mount drops it */
		});
		vi.spyOn(fs, "writeFileSync").mockImplementation((p, data, options) =>
			writeFileSync(
				p,
				data,
				String(p).endsWith(".tmp") ? { flag: "wx", mode: 0o644 } : options,
			),
		);
		try {
			const r = run(["K"], SECRET);
			expect(r.status).toBe(1);
			expect(r.stderr).toBe(
				refused(
					`the file as written gives access to others, so another user could read or swap the file. Make ${path.dirname(store())} yours with no access for anyone else (\`chmod 700\`), on a filesystem that keeps modes (not a Windows drive under WSL), then re-run.`,
				),
			);
		} finally {
			vi.restoreAllMocks();
		}
		expect(read()).toBe("A=1\n");
		expect(fs.readdirSync(path.dirname(store())).sort()).toEqual([
			".gitignore",
			"secrets.env",
		]);
	});

	it.each([
		["group-readable", 0o750],
		["world-writable", 0o777],
	])(
		"refuses with exit 1 where the existing directory is %s, the file untouched (#3539)",
		(_l, mode) => {
			seed("A=1\n");
			fs.chmodSync(path.dirname(store()), mode);
			const r = run(["K"], SECRET);
			expect(r.status).toBe(1);
			expect(r.stderr).toBe(
				refused(
					`its directory ${path.dirname(store())} gives access to others, so another user could read or swap the file. Make ${path.dirname(store())} yours with no access for anyone else (\`chmod 700\`), on a filesystem that keeps modes (not a Windows drive under WSL), then re-run.`,
				),
			);
			expect(read()).toBe("A=1\n");
			expect(fs.readdirSync(path.dirname(store()))).toEqual(["secrets.env"]);
		},
	);

	const StaleCopy = "OLD_KEY=stale-copy-value\n";
	/** Above Linux's 2^22 pid ceiling, so no process ever holds it. */
	const DeadPid = 4_194_305;

	const aside = (pid: number, tag = "0a1b2c3d") =>
		path.join(config, "workflow-core", `secrets.env.${pid}.${tag}.tmp`);
	const left = "a copy of the secrets file an earlier interrupted write left";
	const plant = (p: string) => {
		makeStoreDir();
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
});
