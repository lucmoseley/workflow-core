// @vitest-environment node
/*
 * Holds check-retry-watchdog.js's verdicts: a binary and settings carrying
 * both watchdog variables pass; a binary missing one, or holding only a longer
 * name it prefixes, or settings missing one or not parsing, fail, each naming
 * its way out; a missing binary or settings file leaves only its half
 * unchecked, and SKIPs where both are missing. Loosen it and a CLI update or
 * settings edit that turns the in-turn retry off (#4815) goes unsaid on
 * `npm run status`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-retry-watchdog.js");
const WATCHDOG = "CLAUDE_CODE_RETRY_WATCHDOG";
const CAP = "CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS";
const BOTH_ENV = { [WATCHDOG]: "1", [CAP]: "1" };

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "retry-watchdog-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs the checker over a binary holding `binaryText` (none where null) and
 * settings carrying `env` (no file where null). */
function run(binaryText: string | null, env: object | null) {
	const bin = path.join(dir, "claude");
	if (binaryText !== null) fs.writeFileSync(bin, binaryText);
	const settings = path.join(dir, "settings.json");
	if (env !== null) fs.writeFileSync(settings, JSON.stringify({ env }));
	const r = runInProcess(SCRIPT, [settings], {
		env: { ...process.env, WFC_CLAUDE_BIN: bin },
	});
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const binary = (...names: string[]) =>
	`\0junk${names.map((n) => `"${n}",`).join("x")}\0more`;

it("passes a binary and settings carrying both names", () => {
	const { status, out } = run(binary(WATCHDOG, CAP), BOTH_ENV);
	expect(status).toBe(0);
	expect(out).toMatch(/^OK:/m);
});

it("fails a binary missing the usage-limit cap's name", () => {
	const { status, out } = run(binary(WATCHDOG), BOTH_ENV);
	expect(status).toBe(1);
	expect(out).toContain(`no longer holds ${CAP}`);
	expect(out).toContain("then update WATCHDOG_ENV, the live settings");
});

it("fails a binary holding the watchdog name only as a prefix of another", () => {
	const { status, out } = run(binary(CAP, `${WATCHDOG}_SCOPE`), BOTH_ENV);
	expect(status).toBe(1);
	expect(out).toContain(`no longer holds ${WATCHDOG};`);
});

it("fails settings missing a variable", () => {
	const { status, out } = run(binary(WATCHDOG, CAP), { [WATCHDOG]: "1" });
	expect(status).toBe(1);
	expect(out).toContain(`${CAP}=null, not "1"`);
	expect(out).toContain(`set it to "1" there`);
});

it("still judges the settings where no binary is found", () => {
	const { status, out } = run(null, BOTH_ENV);
	expect(status).toBe(0);
	expect(out).toMatch(/no `.*claude` binary was found; that half is unchecked/);
});

it("still fails settings missing a variable where no binary is found", () => {
	const { status, out } = run(null, {});
	expect(status).toBe(1);
	expect(out).toContain(`${WATCHDOG}=null`);
	expect(out).toContain("binary was found; that half is unchecked");
});

it("still judges the binary where the settings file is missing", () => {
	const ok = run(binary(WATCHDOG, CAP), null);
	expect(ok.status).toBe(0);
	expect(ok.out).toContain("settings.json is missing; that half is unchecked");
	const dropped = run(binary(WATCHDOG), null);
	expect(dropped.status).toBe(1);
	expect(dropped.out).toContain(`no longer holds ${CAP}`);
});

it("skips where neither the settings file nor a binary is found", () => {
	const { status, out } = run(null, null);
	expect(status).toBe(0);
	expect(out).toMatch(
		/^SKIP:.*settings\.json is missing; no `.*claude` binary was found/m,
	);
});

it("fails a settings file that does not parse, naming the fix", () => {
	const settings = path.join(dir, "settings.json");
	fs.writeFileSync(settings, "{");
	fs.writeFileSync(path.join(dir, "claude"), binary(WATCHDOG, CAP));
	const r = runInProcess(SCRIPT, [settings], {
		env: { ...process.env, WFC_CLAUDE_BIN: path.join(dir, "claude") },
	});
	expect(r.status).not.toBe(0);
	expect(`${r.stdout}${r.stderr}`).toContain(`${settings} does not parse`);
	expect(`${r.stdout}${r.stderr}`).toContain("fix the file, then add");
});
