// @vitest-environment node
/*
 * lib/deny-capable.js decides which guards the lost-deny reporter speaks for
 * when one is killed at its timeout, and which the census counts. A route it
 * misses is a refusal that fails open in silence; a route it invents blocks a
 * turn over a guard that could never have refused.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardDirs, guardPath, isDenyCapableIn } from "./deny-capable";

let a: string;
let b: string;
beforeEach(() => {
	a = fs.mkdtempSync(path.join(os.tmpdir(), "deny-capable-a-"));
	b = fs.mkdtempSync(path.join(os.tmpdir(), "deny-capable-b-"));
});
afterEach(() => {
	fs.rmSync(a, { recursive: true, force: true });
	fs.rmSync(b, { recursive: true, force: true });
});

const judged = (text: string) => {
	fs.writeFileSync(path.join(a, "g.sh"), text);
	return isDenyCapableIn([a])("g.sh");
};

describe("the routes to a refusal", () => {
	it.each([
		["gp_deny", '#!/usr/bin/env bash\ngp_deny "no"\n'],
		["a JS verdict", 'out({ permissionDecision: "deny" });\n'],
		["a JSON verdict", '{"permissionDecision": "deny"}'],
		["an escaped JSON verdict", 'echo "{\\"permissionDecision\\":\\"deny\\"}"'],
	])("admits %s", (_, text) => {
		expect(judged(text)).toBe(true);
	});

	it.each([
		[
			"additionalContext alone",
			'{"hookSpecificOutput":{"additionalContext":"note"}}',
		],
		["an allow", '{"permissionDecision":"allow"}'],
		["a lookalike call", "gp_denyish\n"],
	])("refuses %s", (_, text) => {
		expect(judged(text)).toBe(false);
	});
});

describe("a DENIES-THROUGH: header line", () => {
	const delegate = (text: string) =>
		fs.writeFileSync(path.join(a, "arbiter.js"), text);

	it.each([
		[
			"a shell header",
			"#!/usr/bin/env bash\n# DENIES-THROUGH: arbiter.js check\n\nrun\n",
		],
		["a JS header", "/*\n * DENIES-THROUGH: arbiter.js check\n */\nrun();\n"],
	])("admits a guard declaring one in %s", (_, text) => {
		delegate('out({ permissionDecision: "deny" });\n');

		expect(judged(text)).toBe(true);
	});

	it("declares nothing below the header", () => {
		delegate('out({ permissionDecision: "deny" });\n');

		expect(
			judged("#!/usr/bin/env bash\nrun\n# DENIES-THROUGH: arbiter.js\n"),
		).toBe(false);
	});

	it("declares nothing where the script it names writes no verdict", () => {
		delegate('out({ additionalContext: "note" });\n');

		expect(judged("# DENIES-THROUGH: arbiter.js check\n")).toBe(false);
	});

	it("declares nothing where the script it names is not beside it", () => {
		fs.writeFileSync(path.join(b, "arbiter.js"), 'permissionDecision: "deny"');
		fs.writeFileSync(path.join(a, "g.sh"), "# DENIES-THROUGH: arbiter.js\n");

		expect(isDenyCapableIn([a, b])("g.sh")).toBe(false);
	});

	it("follows one hop only, never a marker on the delegate", () => {
		delegate("# DENIES-THROUGH: g.sh\n");

		expect(judged("# DENIES-THROUGH: arbiter.js\n")).toBe(false);
	});
});

describe("a DENIES-BY: exit 2 header line (#2473)", () => {
	it("admits a guard declaring it that exits 2", () => {
		expect(
			judged(
				"#!/usr/bin/env bash\n# DENIES-BY: exit 2\n\necho no >&2\nexit 2\n",
			),
		).toBe(true);
	});

	it("declares nothing where the script never exits 2", () => {
		expect(judged("#!/usr/bin/env bash\n# DENIES-BY: exit 2\n\nexit 1\n")).toBe(
			false,
		);
	});

	it("declares nothing below the header", () => {
		expect(
			judged("#!/usr/bin/env bash\nrun\n# DENIES-BY: exit 2\nexit 2\n"),
		).toBe(false);
	});

	it("admits the real self-plugin canary", () => {
		expect(
			isDenyCapableIn([path.resolve(__dirname, "..")])("self-plugin-canary.sh"),
		).toBe(true);
	});

	it("leaves a bare exit 2 undeclared, a usage error's spelling", () => {
		expect(judged("#!/usr/bin/env bash\nexit 2\n")).toBe(false);
	});
});

describe("finding the guard", () => {
	it("takes the first directory that holds it, and only that one", () => {
		fs.writeFileSync(path.join(a, "g.sh"), "echo fine\n");
		fs.writeFileSync(path.join(b, "g.sh"), "gp_deny\n");

		expect(guardPath("g.sh", [a, b])).toBe(path.join(a, "g.sh"));
		expect(isDenyCapableIn([a, b])("g.sh")).toBe(false);
	});

	it("falls through to the next directory", () => {
		fs.writeFileSync(path.join(b, "g.sh"), "gp_deny\n");

		expect(isDenyCapableIn([a, b])("g.sh")).toBe(true);
	});

	it("resolves nothing but a bare filename", () => {
		fs.writeFileSync(path.join(a, "g.sh"), "gp_deny\n");

		expect(guardPath(`../${path.basename(a)}/g.sh`, [b])).toBeNull();
		expect(guardPath("..", [a])).toBeNull();
		expect(isDenyCapableIn([a])("missing.sh")).toBe(false);
	});

	it("searches the core's scripts/ before the session repo's, once where they are one", () => {
		expect(guardDirs(a, b)).toEqual([
			path.join(a, "scripts"),
			path.join(b, "scripts"),
		]);
		expect(guardDirs(a, a)).toEqual([path.join(a, "scripts")]);
	});
});
