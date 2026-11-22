// @vitest-environment node

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("gh api, a field given twice", () => {
	it.each([
		["-f", "-f"],
		["-F", "-F"],
		["-f", "-F"],
		["-F", "-f"],
	])("%s then %s exits before any request", (first, second) => {
		const out = spawnSync(
			"gh",
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
		expect(out.error, "gh is not on PATH").toBeUndefined();
		expect(out.status).not.toBe(0);
		expect(out.stderr).toContain(
			'unexpected override existing field under "body"',
		);
	});
});
