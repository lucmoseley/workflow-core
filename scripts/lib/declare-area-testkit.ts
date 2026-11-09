/*
 * One sensitive area declared in a tree's working copy, for the suites that
 * read `sensitivePaths` through a real hook or adapter.
 */

import fs from "node:fs";
import path from "node:path";

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
