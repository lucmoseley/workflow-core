/*
 * require-closure.ts — copy a script into a fixture with what it requires.
 *
 * A fixture copying a fixed list of the config reader's files broke two
 * suites when the reader gained a sibling require (#1657); walking the
 * requires copies the next one too. Its own module, not
 * precommit-gate-testkit.ts: the read-edges pass credits a helper's path
 * literals to each test that imports it, and this file names none.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { requiredGroup } = require("./regex-group.js");

const LOCAL_REQUIRE = /\brequire\(\s*["'](\.\.?\/[^"']+)["']\s*\)/g;

/**
 * Copy each `rels` file from `source` into `root` at the same path, with every
 * file it reaches by a relative `require`. Pass the repo root through an
 * anchor the test read-edges extractor knows, and list in full each file
 * whose edit should select the suite: the walk copies the rest but gives the
 * suite no read edge to it.
 */
export function copyRequireClosure(
	root: string,
	source: string,
	rels: string[],
): void {
	const seen = new Set<string>();
	const queue = [...rels];
	for (let rel = queue.shift(); rel !== undefined; rel = queue.shift()) {
		if (seen.has(rel)) continue;
		seen.add(rel);
		const from = path.join(source, rel);
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.copyFileSync(from, path.join(root, rel));
		for (const m of fs.readFileSync(from, "utf8").matchAll(LOCAL_REQUIRE)) {
			const dep = path.join(
				path.dirname(rel),
				requiredGroup(m, 1, LOCAL_REQUIRE),
			);
			queue.push(fs.existsSync(path.join(source, dep)) ? dep : `${dep}.js`);
		}
	}
}
