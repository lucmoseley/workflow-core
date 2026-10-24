// @vitest-environment node
/*
 * Every flag a runCheck script reads is one it declares (#938).
 *
 * runCheck refuses any flag outside the library's own (plus `--root` on a
 * direction-gating spec), the spec's `valueFlags` and its `flags`. A read the spec forgot to declare is
 * therefore a flag nobody can pass: the checker answers it with BROKEN.
 *
 * LEXICAL, per file: a read is a `.has("--x")` or `.value("--x"` literal, or
 * one off `ctx.argv`/`process.argv` by `includes`/`indexOf`, outside a
 * comment. A flag held in a variable is unseen. A file's declared set is
 * every `valueFlags: [...]` and `flags: [...]` literal in it.
 *
 * It reads every real runCheck script on disk rather than a fixture, so a
 * checker added later is held without being listed here. Many of those
 * checkers run in .husky/pre-commit and CI: loosen this and a gate passing a
 * flag its spec forgot answers BROKEN, exit 2, refusing every commit it meets.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runInProcess } from "./run-in-process";

const require = createRequire(import.meta.url);
const { stripComments } = require("./strip-comments.js");

const SCRIPTS = path.resolve(__dirname, "..");

/* A checker declaring no flag of its own, asked about one flag at a time, so
 * the library's own acceptance — not a copy of its list — is what a read is
 * judged against. CLAUDE_CONFIG_DIR keeps a probed `--notify` off the real
 * report store. */
const PROBES = fs.mkdtempSync(path.join(os.tmpdir(), "declared-flags-"));
afterAll(() => fs.rmSync(PROBES, { recursive: true, force: true }));

const probe = (against: boolean) => {
	const file = path.join(PROBES, `probe-${against}.js`);
	if (!fs.existsSync(file))
		fs.writeFileSync(
			file,
			`require(${JSON.stringify(path.join(__dirname, "check.js"))}).runCheck({
  name: "declared-flags-probe",
  usage: "node probe.js",
  ${against ? 'against: { profile: "none", materialise: "tree" },' : ""}
  run() { return { okLine: "probed." }; },
});
`,
		);
	return file;
};

const taken = new Map<string, boolean>();
/** Whether runCheck accepts `flag` on a checker that declares none, direction-gating where `against`. */
const libraryTakes = (flag: string, against: boolean) => {
	const key = `${against} ${flag}`;
	if (!taken.has(key)) {
		const r = runInProcess(probe(against), [flag], {
			cwd: PROBES,
			env: { ...process.env, CLAUDE_CONFIG_DIR: PROBES, GITHUB_ACTIONS: "" },
		});
		taken.set(key, !`${r.stdout}${r.stderr}`.includes(`unknown flag: ${flag}`));
	}
	return taken.get(key) as boolean;
};

const READS = [
	/\.(?:has|value)\(\s*"(--[\w-]+)"/g,
	/(?:ctx|process)\.argv\.(?:includes|indexOf)\(\s*"(--[\w-]+)"/g,
];
const DECLARED = /\b(?:valueFlags|flags)\s*:\s*\[([^\]]*)\]/g;
const DECLARED_KEY = /\b(?:valueFlags|flags)\s*:\s*[^\s[]/;

const captures = (re: RegExp, text: string) =>
	[...text.matchAll(re)].map((m) => m[1]);

const checkers = fs
	.readdirSync(SCRIPTS)
	.filter((f) => f.endsWith(".js"))
	.map((f) => ({
		file: f,
		body: stripComments(fs.readFileSync(path.join(SCRIPTS, f), "utf8")),
	}))
	.filter(({ body }) => /\brunCheck\(/.test(body));

describe("runCheck scripts declare every flag they read", () => {
	it("asks runCheck, which takes its own flags and refuses an unknown one", () => {
		expect(libraryTakes("--json", false)).toBe(true);
		expect(libraryTakes("--root", true)).toBe(true);
		expect(libraryTakes("--root", false)).toBe(false);
		expect(libraryTakes("--no-such-flag", false)).toBe(false);
		expect(libraryTakes("--no-such-flag", true)).toBe(false);
	});

	/* A floor well under the family's size, so a broken glob or stripper that
	 * finds a handful cannot pass as a clean sweep. */
	it("finds the family", () => {
		expect(checkers.length).toBeGreaterThan(60);
	});

	it.each(checkers)("$file declares every flag it reads", ({ body }) => {
		expect(DECLARED_KEY.test(body), "declare flags as an inline array").toBe(
			false,
		);
		const declared = new Set<string>(
			captures(DECLARED, body).flatMap((list) =>
				captures(/"(--[\w-]+)"/g, list),
			),
		);
		const against = /\bagainst\s*:/.test(body);
		const read = new Set(READS.flatMap((re) => captures(re, body)));
		expect(
			[...read]
				.filter((f) => !declared.has(f) && !libraryTakes(f, against))
				.sort(),
		).toEqual([]);
	});
});
