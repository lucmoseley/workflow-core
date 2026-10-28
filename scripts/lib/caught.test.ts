// @vitest-environment node
/*
 * lib/caught.js's contract (#1329): each field narrowed from whatever was
 * thrown, so a handler reading one never throws itself, a thrown `null`
 * included. The fs and child-process cases throw for real rather than build
 * the error by hand, so a Node change to either shape fails here.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildErrorText, caught, parseErrorText } from "./caught.js";

/** What `fn` threw. */
function thrownBy(fn: () => unknown): unknown {
	try {
		fn();
	} catch (e) {
		return e;
	}
	throw new Error("fixture did not throw");
}

describe("caught", () => {
	it("reads a filesystem error's code and message", () => {
		const e = thrownBy(() => readFileSync("/nonexistent/caught-test"));

		const c = caught(e);
		expect(c.code).toBe("ENOENT");
		expect(c.message).toContain("no such file");
		expect(c.status).toBeUndefined();
	});

	it("decodes a failed child's stderr and stdout, Buffer or string", () => {
		const script =
			"process.stdout.write('out'); process.stderr.write('err'); process.exit(3)";
		const buffered = caught(
			thrownBy(() =>
				execFileSync(process.execPath, ["-e", script], { stdio: "pipe" }),
			),
		);
		const decoded = caught(
			thrownBy(() =>
				execFileSync(process.execPath, ["-e", script], {
					encoding: "utf8",
					stdio: "pipe",
				}),
			),
		);

		for (const c of [buffered, decoded]) {
			expect(c.status).toBe(3);
			expect(c.stderr).toBe("err");
			expect(c.stdout).toBe("out");
		}
	});

	it.each([
		["null", null, "null"],
		["undefined", undefined, "undefined"],
		["a string", "boom", "boom"],
		["a number", 42, "42"],
	])(
		"reads %s without throwing, its message the value printed",
		(_, v, msg) => {
			expect(caught(v)).toEqual({
				code: undefined,
				message: msg,
				status: undefined,
				stderr: undefined,
				stdout: undefined,
			});
		},
	);

	it("drops a field of the wrong type rather than passing it on", () => {
		const c = caught({ code: 1, message: ["x"], status: "1", stderr: 5 });

		expect(c.code).toBeUndefined();
		expect(c.status).toBeUndefined();
		expect(c.stderr).toBeUndefined();
		expect(c.message).toBe("[object Object]");
	});

	it("prints an object whose toString is unusable", () => {
		expect(caught(Object.create(null)).message).toBe("[object Object]");
	});
});

describe("parseErrorText (#2673)", () => {
	it("is the child's stderr where it printed any", () => {
		const e = thrownBy(() =>
			execFileSync("sh", ["-c", "echo refused >&2; exit 1"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}),
		);

		expect(parseErrorText(e)).toBe("refused\n");
	});

	it("is the message where the child's stderr is empty, as a timed-out one's is", () => {
		const e = thrownBy(() =>
			execFileSync("sleep", ["5"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 50,
			}),
		);

		expect(caught(e).stderr).toBe("");
		expect(parseErrorText(e)).toBe("spawnSync sleep ETIMEDOUT");
	});
});

describe("buildErrorText", () => {
	it("is an Error's stack, its message on the first line", () => {
		const text = buildErrorText(new Error("boom"));

		expect(text.split("\n")[0]).toBe("Error: boom");
		expect(text).toContain("caught.test.ts");
	});

	it("is a thrown non-Error as a string", () => {
		expect(buildErrorText("refused")).toBe("refused");
		expect(buildErrorText(null)).toBe("null");
	});
});
