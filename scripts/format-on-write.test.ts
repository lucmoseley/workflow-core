// @vitest-environment node

/*
 * Pins scripts/format-on-write.js, post-write.sh's shell and Python formatter
 * (#1332): it formats a shell file, as lib/formatters.js picks them (#1828),
 * and a .py, touches nothing else, and exits 0 on whatever it cannot format.
 *
 * Run in process from the host root, as post-write.sh runs it; the Python
 * case needs the machine's ruff and skips without it. Loosen a case and a
 * written file reaches the commit gate unformatted, or a tool write fails.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newRepo, registerTempCleanup } from "./lib/precommit-gate-harness";
import { ROOT } from "./lib/precommit-gate-testkit";
import { REAL_RUFF } from "./lib/ruff-testkit";
import { runInProcess } from "./lib/run-in-process.js";

const temps = registerTempCleanup();
const SCRIPT = path.join(ROOT, "scripts", "format-on-write.js");

const SH_BAD = "if true; then\n\techo x\nfi\n";
const SH_OK = "if true; then\n  echo x\nfi\n";

/** Writes `body` at `rel` in a fresh repo, runs the formatter on it, returns its exit code, what it printed and the bytes left. */
function formatted(
	rel: string,
	body: string,
): { code: number; out: string; printed: string } {
	const { root } = newRepo("format-on-write-", temps);
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), body);
	const run = runInProcess(SCRIPT, [rel], {
		cwd: root,
		env: { ...process.env, WFC_RUFF: REAL_RUFF || "/nonexistent/ruff" },
	});
	return {
		code: run.status,
		out: fs.readFileSync(path.join(root, rel), "utf8"),
		printed: run.stdout,
	};
}

describe("format-on-write.js", () => {
	it("formats a script in the shellcheck file set", () => {
		expect(formatted("scripts/a.sh", SH_BAD)).toMatchObject({
			code: 0,
			out: SH_OK,
		});
	});

	// post-write.sh answers exactly this with rule:shell-lint-blind (#2019).
	it("prints `shell` on a shell file and nothing on any other", () => {
		expect(formatted("scripts/a.sh", SH_BAD).printed).toBe("shell\n");
		expect(formatted(".husky/pre-push", SH_OK).printed).toBe("shell\n");
		expect(formatted("bin/notes", SH_BAD).printed).toBe("");
	});

	it("formats a husky hook, which has no .sh extension", () => {
		expect(formatted(".husky/pre-push", SH_BAD).out).toBe(SH_OK);
	});

	it("formats a .sh outside scripts/ and an extensionless file with a shell shebang (#1828)", () => {
		expect(formatted("tools/a.sh", SH_BAD).out).toBe(SH_OK);
		const run = `#!/usr/bin/env bash\n${SH_BAD}`;
		expect(formatted("bin/run", run).out).toBe(`#!/usr/bin/env bash\n${SH_OK}`);
	});

	it("leaves an extensionless file with no shell shebang as written", () => {
		expect(formatted("bin/notes", SH_BAD).out).toBe(SH_BAD);
	});

	it("leaves an unparseable script as written, exiting 0", () => {
		expect(formatted("scripts/a.sh", "if then fi (\n")).toMatchObject({
			code: 0,
			out: "if then fi (\n",
		});
	});

	it.skipIf(!REAL_RUFF)("formats a .py with ruff", () => {
		expect(formatted("pkg/a.py", "print( 'x' )\n").out).toBe('print("x")\n');
	});

	it("exits 0 where ruff is not installed", () => {
		const { root } = newRepo("format-on-write-", temps);
		fs.writeFileSync(path.join(root, "a.py"), "print( 'x' )\n");
		const run = runInProcess(SCRIPT, ["a.py"], {
			cwd: root,
			env: { ...process.env, WFC_RUFF: "/nonexistent/ruff" },
		});
		expect(run.status).toBe(0);
	});
});
