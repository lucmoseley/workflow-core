// @vitest-environment node
/*
 * The real gh's refusal of a repeated field, which issue-create-label.js's
 * REST judge passes unjudged on the strength of (#3614). A dummy token and a
 * dead proxy: a gh that stopped refusing reaches nothing.
 *
 * Red after a gh upgrade: that judge now owes a verdict on the value gh sends.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const realGh = (process.env.PATH ?? "")
	.split(path.delimiter)
	.map((d) => path.join(d, "gh"))
	.find((f) => fs.existsSync(f));

// Residual: where no gh is installed this skips, and the refusal goes unchecked.
describe.skipIf(!realGh)("gh api, a field given twice", () => {
	it.each([
		["-f", "-f"],
		["-F", "-F"],
		["-f", "-F"],
		["-F", "-f"],
	])("%s then %s exits before any request", (first, second) => {
		const out = spawnSync(
			realGh ?? "gh",
			[
				"api",
				"--method",
				"POST",
				"repos/o/r/dry",
				first,
				"body=x",
				second,
				"body=",
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					GH_TOKEN: "dummy",
					HTTPS_PROXY: "http://127.0.0.1:1",
				},
			},
		);
		expect(out.status).not.toBe(0);
		expect(out.stderr).toContain(
			'unexpected override existing field under "body"',
		);
	});
});
