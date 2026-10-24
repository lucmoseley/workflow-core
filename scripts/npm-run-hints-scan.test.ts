// @vitest-environment node
/*
 * No shipped script or rule fragment tells an adopter to `npm run` a script it
 * does not have (#1289, #1291). A message names the core script through
 * scriptPath() instead (#439), and a gate the husky hooks run through
 * `${WFC_PLUGIN_ROOT:+$WFC_PLUGIN_ROOT/}` (#441).
 *
 * The scan is lexical and skips a script's comment lines, so a hint printed
 * from a docstring is unseen. It reads this repo's real shipped tree, as
 * `plugin-tree.js` defines it, since what ships is the thing under test.
 * It sits apart from `npm-run-hints.test.ts` so that file's unit cases do not
 * read the whole tree (#1900). The names it lets through, declared and
 * exempt, are `lib/npm-run-hints-testkit.ts`'s.
 *
 * It runs in CI's Vitest step: loosen it and an adopter's guard refusal or
 * warning can end in npm's `Missing script` error instead of a runnable fix.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hintsIn } from "./lib/npm-run-hints-testkit";

const require_ = createRequire(__filename);
const { isShipped } = require_("./lib/plugin-tree.js");

const ROOT = path.resolve(__dirname, "..");

const SCANNED = /\.(c?js|sh|py)$/;

/** @returns the hints in each shipped file under `pathspec` that `keep` passes */
function shippedHints(
	pathspec: string,
	keep: (rel: string) => boolean,
	floor: number,
): string[] {
	const shipped = execFileSync("git", ["ls-files", "-z", pathspec], {
		cwd: ROOT,
		encoding: "utf8",
	})
		.split("\0")
		.filter((f) => f && keep(f) && isShipped(ROOT, f));
	expect(shipped.length).toBeGreaterThan(floor);
	return shipped.flatMap((rel) =>
		hintsIn(rel, fs.readFileSync(path.join(ROOT, rel), "utf8")),
	);
}

describe("the npm scripts a shipped script names (#1289)", () => {
	it("names none an adopter cannot run", () => {
		expect(shippedHints("scripts", (f) => SCANNED.test(f), 100)).toEqual([]);
	});

	it("names none an adopter cannot run in a shipped rule fragment (#1291)", () => {
		expect(shippedHints("docs/agents/rules/*.txt", () => true, 50)).toEqual([]);
	});
});
