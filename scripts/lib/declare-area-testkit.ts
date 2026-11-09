/*
 * One sensitive area declared in a tree's working copy, for the suites that
 * read `sensitivePaths` through a real hook or adapter.
 */

import fs from "node:fs";
import path from "node:path";

/** Write `tree`'s `.claude/workflow-core.json` declaring `name` over `globs`. */
export function declareArea(tree: string, name: string, globs: string[]) {
	fs.mkdirSync(path.join(tree, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(tree, ".claude", "workflow-core.json"),
		JSON.stringify({
			sensitivePaths: [
				{ name, description: "who may read or write what", globs },
			],
		}),
	);
}
