/*
 * The load-contract tests for scripts/lib/guard-parse.sh, shared by the two
 * guards' test files (mantahostels#123). The library is one thing, so a change to how it is
 * sourced must not mean editing the same six tests in two places.
 *
 * These tests only ask whether the guard denied or stayed silent, so the two
 * guards' differing verdict vocabularies stay in their own files.
 *
 * Also the lib/ collectors (`sourcedLibs`, `requiredLibs`, `programLibs`) and
 * their copier `copyLibs`, which any test copying a script into a detached
 * fixture uses (#2256, #2272).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const { requiredGroup }: typeof import("./lib/regex-group.js") = createRequire(
	import.meta.url,
)("./lib/regex-group.js");

export interface GuardParseFixture {
	/** The real guard under test. */
	guard: string;
	/** A command that guard denies outright, used to prove it is still armed. */
	denyCommand: string;
	/**
	 * Files under scripts/lib/ the guard runs rather than sources, which
	 * `sourcedLibs` cannot see. guard-issue-close.sh denies through
	 * `node lib/outstanding-line.js`, and lets a close through where that
	 * parser cannot load (#1255).
	 */
	extraLibs?: string[];
	/*
	 * Read at test time, not at describe time: the temp repos are built in
	 * beforeEach, so these paths do not exist when the fixture is called.
	 */
	ctx: () => {
		/** The temp root the detached copy is written into. */
		dir: string;
		/** The stand-in for the shared working tree. */
		shared: string;
		/** An unrelated repo, for the cwd-resolution case. */
		elsewhere: string;
		/** Guard-specific environment on top of CLAUDE_PROJECT_DIR. */
		env?: Record<string, string>;
	};
}

const SOURCE_LINE = /^\s*source\s+\S*?([\w.-]+\.sh)/gm;

/**
 * The lib/ files a guard sources, as bare filenames. Read off the guard's own
 * `source` lines so a detached copy carries whatever it actually needs —
 * scripts/check-guard-registry.js follows the same spelling to build a guard's
 * staleness digest.
 *
 * TRANSITIVE (mantahostels#1905), because a library may source one of its own: lib/
 * guard-log.sh and lib/guard-parse.sh both take lib/guard-root.sh, which no
 * guard names. Read one level deep only, a detached copy silently loses it, and
 * every fail-open case reports the missing library as the tampering it exists
 * to detect.
 *
 * MATCHED ON THE BASENAME, not on a literal `lib/` in the source line: a
 * library sourcing its neighbour spells the directory `${BASH_SOURCE[0]%/*}`,
 * which carries no `lib/` at all. A name that does not resolve under lib/ is
 * dropped rather than returned — the callers copy every name they are given,
 * and a `source ~/.bashrc` is not something they can copy.
 */
export const sourcedLibs = (guard: string): string[] =>
	libClosure(fs.readFileSync(guard, "utf8"), (text) =>
		[...text.matchAll(SOURCE_LINE)]
			.map((m) => requiredGroup(m, 1, SOURCE_LINE))
			.filter((lib) => fs.existsSync(path.resolve(__dirname, "lib", lib))),
	);

const SIBLING_REQUIRE = /require\("\.\/([^"]+)"\)/g;
const PROGRAM_LIB_REQUIRE = /require\("\.\/lib\/([^"]+)"\)/g;

/** The files `text` requires through `pattern`, as .js filenames. */
const requiresOf = (pattern: RegExp) => (text: string) =>
	[...text.matchAll(pattern)].map((m) => {
		const name = requiredGroup(m, 1, pattern);
		return name.endsWith(".js") ? name : `${name}.js`;
	});

/**
 * `entry` and every lib/ file it requires, transitively, as bare filenames:
 * the node counterpart of `sourcedLibs`, for a lib/ script a guard runs.
 */
export const requiredLibs = (entry: string): string[] => [
	entry,
	...libClosure(
		fs.readFileSync(path.resolve(__dirname, "lib", entry), "utf8"),
		requiresOf(SIBLING_REQUIRE),
	).filter((lib) => lib !== entry),
];

/**
 * Every lib/ file a scripts/ program requires, transitively, as bare
 * filenames: what a plugin-install fixture copies beside `program`, which is
 * left out (#2256). Reads only the double-quoted `require("./lib/…")` form
 * Biome writes; a miss fails the fixture's run as MODULE_NOT_FOUND.
 */
export const programLibs = (program: string): string[] => [
	...new Set(
		requiresOf(PROGRAM_LIB_REQUIRE)(
			fs.readFileSync(path.resolve(__dirname, program), "utf8"),
		).flatMap(requiredLibs),
	),
];

export const copyLibs = (
	dest: string,
	libs: string[],
	omit: string[] = [],
): void => {
	fs.mkdirSync(dest, { recursive: true });
	for (const lib of libs.filter((l) => !omit.includes(l)))
		fs.copyFileSync(path.resolve(__dirname, "lib", lib), path.join(dest, lib));
};

/** Every lib/ file reachable from `text` through `named`, read from lib/. */
const libClosure = (text: string, named: (text: string) => string[]) => {
	const out = new Set<string>();
	const queue = named(text);
	for (let lib = queue.shift(); lib !== undefined; lib = queue.shift()) {
		if (out.has(lib)) continue;
		out.add(lib);
		queue.push(
			...named(fs.readFileSync(path.resolve(__dirname, "lib", lib), "utf8")),
		);
	}
	return [...out];
};

export const describeSharedParserLibrary = ({
	guard: guardPath,
	denyCommand,
	extraLibs = [],
	ctx,
}: GuardParseFixture) => {
	describe("the shared parser library", () => {
		/** A copy of the guard whose lib/ can be tampered with, run by absolute path. */
		const detach = () => {
			const at = path.join(ctx().dir, "detached");
			const guard = path.join(at, path.basename(guardPath));
			// Listed here, a guard that gained a second library would disarm itself
			// in the copy, and these tests would report the missing library as the
			// tampering they exist to detect.
			copyLibs(path.join(at, "lib"), [...sourcedLibs(guardPath), ...extraLibs]);
			fs.copyFileSync(guardPath, guard);
			fs.chmodSync(guard, 0o755);
			return { at, guard };
		};

		const configDir = () =>
			ctx().env?.CLAUDE_CONFIG_DIR ?? path.join(ctx().dir, "config");

		const runOf = (guard: string, command: string, cwd = ctx().shared) => {
			const r = spawnSync(guard, [], {
				cwd,
				encoding: "utf8",
				input: JSON.stringify({
					session_id: "test",
					tool_name: "Bash",
					tool_input: { command },
				}),
				env: {
					...process.env,
					CLAUDE_PROJECT_DIR: ctx().shared,
					// The fail-open cases below log under CLAUDE_CONFIG_DIR; inherited, each
					// run leaves a project folder in the live one (#832).
					CLAUDE_CONFIG_DIR: configDir(),
					...(ctx().env ?? {}),
				},
			});
			if (r.status === null) throw new Error(`guard did not run: ${r.error}`);
			return r;
		};

		const denies = (guard: string, command: string, cwd = ctx().shared) =>
			/"permissionDecision"\s*:\s*"deny"/.test(
				runOf(guard, command, cwd).stdout ?? "",
			);

		/*
		 * A guard that CRASHES also emits no verdict, so an allow alone would pass
		 * whether the source line fails open or the script dies on the first
		 * missing function. Fail-open means a clean exit 0 and silence: a non-zero
		 * exit is a hook error Claude Code surfaces and check-guard-errors.js
		 * counts.
		 */
		const expectSilentAllow = (guard: string, command: string) => {
			const r = runOf(guard, command);
			expect(r.status).toBe(0);
			expect(r.stdout ?? "").toBe("");
			expect(r.stderr ?? "").toBe("");
		};

		it("the detached copy still denies — the control for the cases below", () => {
			const { guard } = detach();
			expect(denies(guard, denyCommand)).toBe(true);
		});

		it("allows everything through when the library is missing", () => {
			const { at, guard } = detach();
			fs.rmSync(path.join(at, "lib"), { recursive: true, force: true });
			// Fail open (mantahostels#103 §6): a guard that cannot load its parser must not wedge
			// every Bash call in the session.
			expectSilentAllow(guard, denyCommand);
		});

		it("allows everything through when the library is unreadable", () => {
			const { at, guard } = detach();
			fs.chmodSync(path.join(at, "lib", "guard-parse.sh"), 0o000);
			expectSilentAllow(guard, denyCommand);
		});

		it("logs that fail-open to the test's config dir, never the live one (#832)", () => {
			// Unreadable, not missing: lib/guard-log.sh must still load to log at all.
			const { at, guard } = detach();
			fs.chmodSync(path.join(at, "lib", "guard-parse.sh"), 0o000);
			runOf(guard, denyCommand);
			const projects = path.join(configDir(), "projects");
			const logs = fs.existsSync(projects)
				? fs
						.readdirSync(projects, { recursive: true })
						.map(String)
						.filter((f) => path.basename(f) === "guard-errors.log")
				: [];
			expect(logs).not.toEqual([]);
		});

		it("stays armed when the library's last statement returns non-zero", () => {
			// `source` reports the status of the library's LAST STATEMENT, so gating on
			// it would disarm the guard over a top-level probe that merely answered no
			// — with the whole parser correctly loaded. The gate is `declare -F`.
			const { at, guard } = detach();
			fs.appendFileSync(path.join(at, "lib", "guard-parse.sh"), "\nfalse\n");
			expect(denies(guard, denyCommand)).toBe(true);
		});

		it.each(["gp_deny()", "_gp_split_segments()", "gp_walk_commands()"])(
			"disarms when the library is truncated at %s",
			(marker) => {
				// A half-parsed library defines some functions and not others, which
				// would otherwise crash the guard mid-run rather than failing open.
				// The single-name gate (mantahostels#157) holds only because gp_begin is the LAST
				// function defined, so a break anywhere above it is never reached —
				// these three cut before, between and after the parser internals.
				const { at, guard } = detach();
				const lib = path.join(at, "lib", "guard-parse.sh");
				const text = fs.readFileSync(lib, "utf8");
				const cut = text.indexOf(marker);
				expect(cut).not.toBe(-1); // the marker exists
				fs.writeFileSync(lib, text.slice(0, cut));
				expectSilentAllow(guard, denyCommand);
			},
		);

		it("resolves the library from the guard's own path, not the cwd", () => {
			// A hook runs with whatever cwd the session is in. `elsewhere` is a
			// different repo entirely and has no lib/ of its own, so a cwd-relative
			// source would fail to load and the guard would fall silent.
			const { guard } = detach();
			const { shared, elsewhere } = ctx();
			expect(denies(guard, `cd ${shared} && ${denyCommand}`, elsewhere)).toBe(
				true,
			);
		});
	});
};
