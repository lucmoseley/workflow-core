// @vitest-environment node
/*
 * Pins gl_arm_exit's record (#1818): a guard that dies before its verdict — the
 * case being `set -u`'s abort on an unbound variable, which code-standards-base
 * §S5 demands of every gate — leaves a guard-log line check-guard-errors.js
 * reports, and a guard reaching a verdict leaves none of its own.
 *
 * Each case runs a fixture guard for real, sourcing guard-parse.sh as a guard
 * does and reading its payload through gp_begin, which arms the trap.
 *
 * Nothing else tests gl_arm_exit: loosen a case and an abort goes back to
 * stderr alone, or every verdict starts filing a false one.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox } from "./arbiter-testkit";
import { runInProcess } from "./run-in-process.js";

const GUARD_PARSE = path.resolve(__dirname, "guard-parse.sh");
const CHECKER = path.resolve(__dirname, "..", "check-guard-errors.js");
const ABORT = "exited non-zero before a verdict — the act went unjudged";

const sb = freshSandbox();

/** A guard's own cleanup trap, quoted as guard-commit-form.sh's is, writing the `$?` it sees. */
const CLEANUP = `out="\${0%/*}/cleaned"\ntrap 'printf %s "$?" >"$out" 2>/dev/null' EXIT`;

/** Run a fixture guard: `before` ahead of gp_begin, `body` after it. */
function runGuard(body: string, before = "") {
	const guard = path.join(sb.dir, "guard-fixture.sh");
	fs.writeFileSync(
		guard,
		`set -uo pipefail\n${before}\nsource "${GUARD_PARSE}"\ngp_begin '.tool_input.command' command\n${body}\n`,
	);
	return spawnSync("bash", [guard], {
		encoding: "utf8",
		input: JSON.stringify({
			session_id: "s1818",
			tool_input: { command: "ls" },
		}),
		env: process.env,
	});
}

const records = () =>
	fs.existsSync(sb.errorLog())
		? fs
				.readFileSync(sb.errorLog(), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => l.split("\t"))
		: [];

describe("a guard aborting before its verdict (#1818)", () => {
	it("leaves a record naming the guard, its status and the command it died on", () => {
		const r = runGuard('echo "$never_set"');
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("never_set: unbound variable");
		const [rec] = records();
		expect(records()).toHaveLength(1);
		expect(rec[1]).toBe("guard-fixture.sh");
		expect(rec[2]).toBe(ABORT);
		expect(rec[3]).toBe('exit 1 at: echo "$never_set"');
	});

	it("is reported by check-guard-errors.js", () => {
		runGuard('echo "$never_set"');
		const r = runInProcess(CHECKER, [], {
			env: { ...process.env, GITHUB_ACTIONS: "" },
			cwd: sb.repo,
		});
		expect(r.stderr).toContain("guard-fixture.sh");
		expect(r.stderr).toContain(ABORT);
		expect(r.status).toBe(1);
	});

	it("keeps the guard's exit status and the EXIT trap it set before gp_begin, which sees that status", () => {
		const r = runGuard('echo "$never_set"', CLEANUP);
		expect(r.status).toBe(1);
		expect(fs.readFileSync(path.join(sb.dir, "cleaned"), "utf8")).toBe("1");
		expect(records()).toHaveLength(1);
	});
});

describe("a guard reaching its verdict leaves no record of its own (#1818)", () => {
	it.each([
		["allows", "gp_allow"],
		["warns", 'gp_warn "careful"'],
		["denies", 'gp_deny "no"'],
		["falls off the end", "true"],
	])("when it %s", (_, verdict) => {
		const r = runGuard(verdict);
		expect(r.status).toBe(0);
		expect(records()).toEqual([]);
	});

	it("when gp_rule refuses on a store fault, which logs once and exits 2", () => {
		const r = runGuard("gp_rule no-such-rule-1818");
		expect(r.status).toBe(2);
		expect(records()).toHaveLength(1);
		expect(records()[0][2]).not.toBe(ABORT);
	});

	it("runs the EXIT trap it set before gp_begin on a verdict too", () => {
		runGuard("gp_allow", CLEANUP);
		expect(fs.readFileSync(path.join(sb.dir, "cleaned"), "utf8")).toBe("0");
	});
});
