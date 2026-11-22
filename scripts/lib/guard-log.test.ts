// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { shellQuote } from "./sh-quote.js";

const { projectSlug, UNRESOLVED_ROOT_SLUG } = require("./project-slug.js");
const { mainCheckout } = require("./main-checkout.js");

const GUARD_LOG = path.resolve(__dirname, "guard-log.sh");

const readSlugViaGuardLog = (
	root: string,
	extraEnv: Record<string, string> = {},
): string => {
	const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-log-slug-"));
	try {
		execFileSync(
			"bash",
			["-c", `source ${shellQuote(GUARD_LOG)} && gl_log "slug probe"`],
			{
				encoding: "utf8",
				env: {
					...process.env,
					CLAUDE_PROJECT_DIR: root,
					CLAUDE_CONFIG_DIR: configDir,
					...extraEnv,
				},
			},
		);
		const entries = fs.readdirSync(path.join(configDir, "projects"));
		expect(entries).toHaveLength(1);
		return entries[0];
	} finally {
		fs.rmSync(configDir, { recursive: true, force: true });
	}
};

describe("guard-log.sh's slug restatement agrees with projectSlug() (mantahostels#2051)", () => {
	it("agrees on this repo's own root", () => {
		const root = path.resolve(__dirname, "..", "..");
		expect(readSlugViaGuardLog(root)).toBe(
			projectSlug(mainCheckout(root) ?? root),
		);
	});

	it("agrees on a dot, not only on the slashes", () => {
		const root = "/home/lucmo/.claude3/jobs/12fb6c3a/tmp";
		expect(readSlugViaGuardLog(root)).toBe(projectSlug(root));
	});

	it("agrees on case, neither side folding it", () => {
		const root = "/tmp/armA";
		expect(readSlugViaGuardLog(root)).toBe(projectSlug(root));
	});

	it("agrees on a run of dots, neither side collapsing it to one hyphen", () => {
		const root = "/a..b";
		expect(readSlugViaGuardLog(root)).toBe(projectSlug(root));
	});

	it("agrees on a space", () => {
		const root = "/a b/c";
		expect(readSlugViaGuardLog(root)).toBe(projectSlug(root));
	});

	it("agrees on an underscore", () => {
		const root = "/a_b/c";
		expect(readSlugViaGuardLog(root)).toBe(projectSlug(root));
	});

	it("agrees on a non-ASCII BMP character even when the caller is under LC_ALL=C (mantahostels#2096)", () => {
		const root = "/tmp/a\u00e9b";
		expect(readSlugViaGuardLog(root, { LC_ALL: "C" })).toBe(projectSlug(root));
	});
});

const readRootlessLogDirs = (): string[] => {
	const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-log-root-"));
	const libDir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-log-lib-"));
	try {
		const lone = path.join(libDir, "guard-log.sh");
		fs.copyFileSync(GUARD_LOG, lone);
		execFileSync(
			"bash",
			["-c", `source ${shellQuote(lone)} && gl_log "rootless probe"`],
			{
				encoding: "utf8",
				env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
			},
		);
		const projects = path.join(configDir, "projects");
		return fs
			.readdirSync(projects, { withFileTypes: true })
			.map(
				(e) =>
					`${e.isDirectory() ? "dir" : "file"}:${e.name}:${
						e.isDirectory() ? fs.readdirSync(path.join(projects, e.name)) : ""
					}`,
			);
	} finally {
		fs.rmSync(configDir, { recursive: true, force: true });
		fs.rmSync(libDir, { recursive: true, force: true });
	}
};

describe("gl_log with no repo root to slug (mantahostels#2438)", () => {
	it("files under a NAMED directory, not projects/ itself", () => {
		expect(readRootlessLogDirs()).toEqual([
			`dir:${UNRESOLVED_ROOT_SLUG}:guard-errors.log`,
		]);
	});
});

describe("gl_log's optional fourth field (#320)", () => {
	const readLoggedRecord = (args: string): string => {
		const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-log-f4-"));
		try {
			execFileSync(
				"bash",
				["-c", `source ${shellQuote(GUARD_LOG)} && gl_log ${args}`],
				{
					env: {
						...process.env,
						CLAUDE_PROJECT_DIR: "/repo",
						CLAUDE_CONFIG_DIR: configDir,
					},
				},
			);
			return fs.readFileSync(
				path.join(configDir, "projects", "-repo", "guard-errors.log"),
				"utf8",
			);
		} finally {
			fs.rmSync(configDir, { recursive: true, force: true });
		}
	};

	it("writes the three-field line unchanged when no caller passes one", () => {
		const fields = readLoggedRecord("'what broke'").trimEnd().split("\t");
		expect(fields.slice(1)).toEqual(["guard", "what broke"]);
	});

	it("writes no field 4 for an empty detail, not a trailing tab", () => {
		expect(
			readLoggedRecord("'what broke' ''").trimEnd().split("\t"),
		).toHaveLength(3);
	});

	it("writes a passed detail as field 4, leaving field 3 alone", () => {
		const fields = readLoggedRecord("'what broke' 'target=$W pwd=/a'")
			.trimEnd()
			.split("\t");
		expect(fields.slice(2)).toEqual(["what broke", "target=$W pwd=/a"]);
	});

	it("collapses a tab, CR or newline in it, so it can neither shift a field nor forge a line", () => {
		const line = readLoggedRecord(`'what broke' $'a\\tb\\rc\\nd'`);
		expect(line.split("\n").filter(Boolean)).toHaveLength(1);
		expect(line.trimEnd().split("\t")[3]).toBe("a b c d");
	});

	it("collapses a tab or newline in field 3 the same way, so one fault is one line", () => {
		const line = readLoggedRecord(
			`"$(printf 'timed out on a\\tb\\nc — write allowed unchecked')"`,
		);
		expect(line.split("\n").filter(Boolean)).toHaveLength(1);
		expect(line.trimEnd().split("\t").slice(2)).toEqual([
			"timed out on a b c — write allowed unchecked",
		]);
	});
});

describe("gl_log files where errorLog() reads, on every seat (#383)", () => {
	const bothSides = (configDir: string) => {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			CLAUDE_PROJECT_DIR: "/repo",
			CLAUDE_CONFIG_DIR: configDir,
		};
		delete env.WFC_CLAUDE_CONFIG_A;
		delete env.WFC_CLAUDE_CONFIG_B;
		delete env.WFC_CLAUDE_CONFIG_C;
		execFileSync(
			"bash",
			["-c", `source ${shellQuote(GUARD_LOG)} && gl_log probe`],
			{
				env,
			},
		);
		const core = JSON.stringify(path.resolve(__dirname, "arbiter-core.js"));
		return execFileSync(
			process.execPath,
			["-e", `process.stdout.write(require(${core}).errorLog())`],
			{ env, encoding: "utf8" },
		);
	};

	const withSeats = (fn: (parent: string) => void) => {
		const parent = fs.mkdtempSync(path.join(os.tmpdir(), "guard-log-seat-"));
		try {
			for (const s of [".claude", ".claude2"])
				fs.mkdirSync(path.join(parent, s));
			fn(parent);
		} finally {
			fs.rmSync(parent, { recursive: true, force: true });
		}
	};

	it("agrees under a non-first seat, both in the first seat's store", () => {
		withSeats((parent) => {
			const log = bothSides(path.join(parent, ".claude2"));
			expect(log).toBe(
				path.join(parent, ".claude", "projects", "-repo", "guard-errors.log"),
			);
			expect(fs.readFileSync(log, "utf8")).toContain("probe");
		});
	});

	it("agrees under a scratch config dir, both in its own store", () => {
		withSeats((parent) => {
			const scratch = path.join(parent, "scratch");
			const log = bothSides(scratch);
			expect(log).toBe(
				path.join(scratch, "projects", "-repo", "guard-errors.log"),
			);
			expect(fs.readFileSync(log, "utf8")).toContain("probe");
		});
	});
});
