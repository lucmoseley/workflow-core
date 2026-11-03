/*
 * require-closure.ts — a script's relative-require closure, and a copy of it
 * into a fixture.
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
 * Every file `rels` reaches by a relative `require`, `rels` included, as paths
 * relative to `source`, in the order the walk meets them.
 */
export function requireClosure(source: string, rels: string[]): string[] {
	const seen = new Set<string>();
	const queue = [...rels];
	for (let rel = queue.shift(); rel !== undefined; rel = queue.shift()) {
		if (seen.has(rel)) continue;
		seen.add(rel);
		const text = fs.readFileSync(path.join(source, rel), "utf8");
		for (const m of text.matchAll(LOCAL_REQUIRE)) {
			const dep = path.join(
				path.dirname(rel),
				requiredGroup(m, 1, LOCAL_REQUIRE),
			);
			queue.push(fs.existsSync(path.join(source, dep)) ? dep : `${dep}.js`);
		}
	}
	return [...seen];
}

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
	for (const rel of requireClosure(source, rels)) {
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.copyFileSync(path.join(source, rel), path.join(root, rel));
	}
}
