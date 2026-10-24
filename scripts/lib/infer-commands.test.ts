// @vitest-environment node
/*
 * lib/infer-commands.js's `runsLintStaged` (#2587): a command runs lint-staged
 * itself, or through the `package.json` scripts it runs, however the call is
 * spelled.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runsLintStaged } from "./infer-commands.js";

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "infer-commands-"));
	fs.writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({
			scripts: {
				pre: "lint-staged",
				"lint-staged": "tsc",
				loop: "npm run loop",
			},
		}),
	);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("runsLintStaged", () => {
	it.each([
		"lint-staged",
		"npx lint-staged && tsc",
		"npx lint-staged@17",
		"./node_modules/.bin/lint-staged",
		'sh -c "lint-staged"',
		"npm run pre",
		'npm run "pre"',
		'concurrently "npm run pre"',
		"npm run -s pre",
		"npm --prefix . run pre",
		"pnpm run --silent pre",
		"biome check . && yarn run pre",
	])("counts %j", (command) => {
		expect(runsLintStaged(dir, command)).toBe(true);
	});

	it.each([
		"eslint --rule lint-staged-x .",
		"npm run lint-staged",
		"npm run missing",
		"npm run loop",
	])("does not count %j", (command) => {
		expect(runsLintStaged(dir, command)).toBe(false);
	});
});
