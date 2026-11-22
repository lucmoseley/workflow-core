// @vitest-environment node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const realGh = (process.env.PATH ?? "")
	.split(path.delimiter)
	.map((d) => path.join(d, "gh"))
	.find((f) => fs.existsSync(f));

describe.skipIf(!realGh)(
	"gh api, a field given twice (the real gh, skipped where none is on PATH)",
	() => {
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
	},
);
