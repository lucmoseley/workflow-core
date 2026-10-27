// @vitest-environment node
/*
 * Pins that gl_log files a guard's fail-open record where errorLog() reads it:
 * the same project slug as projectSlug(), the same store on every seat (#383),
 * and a clean optional fourth field (#320).
 *
 * guard-log.sh's slug restatement (`${slug//[^a-zA-Z0-9]/-}`) is
 * exempted from project-slug-scan.test.ts's needle scan (mantahostels#2020) because it
 * computes the same value as projectSlug() (project-slug.js) by a different
 * route — bash parameter expansion rather than `String.replace` — on the
 * fail-open path, where forking to `node -e` is the failure mode guard-log.sh
 * exists to survive. The needle scan pins the SPELLING of the two
 * restatements; it says nothing about whether they still agree on OUTPUT for
 * a given input (mantahostels#2051).
 *
 * SUBPROCESS, NOT STATIC REASONING: bash's `${var//pattern/replacement}` and
 * JS's `String.replace(/regex/g, ...)` are two different engines, and the two
 * are known to diverge (RESIDUAL below) — re-deriving the bash transform in
 * JS and asserting it equals itself would have missed that.
 *
 * RESIDUAL, both scoped rather than pinned:
 * - a root already carrying a trailing slash is out of scope here. gr_root()
 *   (guard-root.sh) strips it before guard-log.sh slugs, so the harness's
 *   own input to the transform is always pre-normalised; the normalisation
 *   itself is arbiter-core.test.ts's "repoRoot normalises the trailing
 *   slash" suite, not this file's.
 * - the two engines diverge on an ASTRAL character (bash counts one character
 *   where JS's UTF-16 `String.replace` counts a surrogate pair and emits two
 *   hyphens). Accepted as residual at mantahostels#2096 rather than fixed — matching it
 *   needs a code-point walk in bash on the path forbidden to fork node — so it
 *   is deliberately unpinned here.
 *
 * THE LOCALE LIMB IS FIXED, not residual: mantahostels#2096 pinned gl_log to a UTF-8
 * locale (`local LC_ALL=C.UTF-8`), and the last case below runs the whole
 * probe under `LC_ALL=C` to hold that.
 *
 * Every shell guard logs its fail-open through gl_log and check-guard-errors.js
 * reports the store under `npm run status`, so a loosened case lets records land
 * where nothing reads them and a guard failing open goes unreported.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const { projectSlug, UNRESOLVED_ROOT_SLUG } = require("./project-slug.js");

const GUARD_LOG = path.resolve(__dirname, "guard-log.sh");

/**
 * Run gl_log for real with CLAUDE_PROJECT_DIR set to `root`, and return the
 * one project directory name it wrote under — guard-log.sh's own answer for
 * how `root` slugs.
 *
 * `extraEnv` is spread last, so it overrides the two set above: the locale
 * case below needs the caller's own LC_ALL, which is otherwise inherited.
 */
const readSlugViaGuardLog = (
	root: string,
	extraEnv: Record<string, string> = {},
): string => {
	const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-log-slug-"));
	try {
		execFileSync(
			"bash",
			["-c", `source "${GUARD_LOG}" && gl_log "slug probe"`],
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
		expect(readSlugViaGuardLog(root)).toBe(projectSlug(root));
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
		// Bash's `[^a-zA-Z0-9]` matches per BYTE in the C locale, so before gl_log
		// pinned its own locale this two-byte `é` slugged to TWO hyphens against
		// projectSlug()'s one — and a hook inherits the harness's locale, so C is
		// not a contrived input. Break `local LC_ALL=C.UTF-8` in guard-log.sh and
		// this is the case that fails.
		//
		// PRECONDITION: the host has a C.UTF-8 locale. Without one bash keeps the
		// caller's — here C — and this goes red on the pre-fix values, which is
		// the divergence and not a flake.
		const root = "/tmp/a\u00e9b";
		expect(readSlugViaGuardLog(root, { LC_ALL: "C" })).toBe(projectSlug(root));
	});
});

/*
 * THE FAULT IS INDUCED BY MOVING THE FILE, not by editing it: guard-log.sh
 * resolves guard-root.sh as its own directory's sibling, so a copy on its own
 * in a temp directory takes the `gr_root() { :; }` stub, and the fault is
 * reached without touching the checkout every other session is running from.
 */
const readRootlessLogDirs = (): string[] => {
	const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-log-root-"));
	const libDir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-log-lib-"));
	try {
		const lone = path.join(libDir, "guard-log.sh");
		fs.copyFileSync(GUARD_LOG, lone);
		execFileSync(
			"bash",
			["-c", `source "${lone}" && gl_log "rootless probe"`],
			{
				encoding: "utf8",
				// No CLAUDE_PROJECT_DIR override: an empty one falls straight through
				// gr_root's `:-` to git and then $PWD, so it induces nothing.
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
		// An empty slug made `projects/$slug` resolve to `projects/`, so the
		// record was a FILE beside the project directories and
		// check-guard-errors.js never opened it.
		//
		// BEHAVIOURAL, and the only thing holding the bash literal equal to
		// project-slug.js's constant — guard-log.sh cannot require that file on the
		// path it runs.
		expect(readRootlessLogDirs()).toEqual([
			`dir:${UNRESOLVED_ROOT_SLUG}:guard-errors.log`,
		]);
	});
});

describe("gl_log's optional fourth field (#320)", () => {
	/** Run gl_log with `args` (bash words) and return the one line it wrote. */
	const readLoggedRecord = (args: string): string => {
		const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-log-f4-"));
		try {
			execFileSync("bash", ["-c", `source "${GUARD_LOG}" && gl_log ${args}`], {
				env: {
					...process.env,
					CLAUDE_PROJECT_DIR: "/repo",
					CLAUDE_CONFIG_DIR: configDir,
				},
			});
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
		// A reason routinely carries a path straight off the tool payload. A file
		// named with a newline would append a forged record, and one with a tab
		// shift every field, so check-guard-errors.js read the message as the guard.
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
	/**
	 * The log path each side gives under CLAUDE_CONFIG_DIR=`configDir`: bash by
	 * writing it, node by naming it. WFC_CLAUDE_CONFIG_* are dropped, so the
	 * seats are the sandbox's own siblings.
	 */
	const bothSides = (configDir: string) => {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			CLAUDE_PROJECT_DIR: "/repo",
			CLAUDE_CONFIG_DIR: configDir,
		};
		delete env.WFC_CLAUDE_CONFIG_A;
		delete env.WFC_CLAUDE_CONFIG_B;
		delete env.WFC_CLAUDE_CONFIG_C;
		execFileSync("bash", ["-c", `source "${GUARD_LOG}" && gl_log probe`], {
			env,
		});
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
