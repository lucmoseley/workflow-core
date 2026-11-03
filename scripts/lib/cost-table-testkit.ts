/*
 * cost-table-testkit.ts — a fixture checkout's session cost table, at the path
 * lib/session-spend.js reads it from (#3697). Import it directly: vitest's
 * graph then selects the caller when session-spend.js moves the table.
 */

import fs from "node:fs";
import path from "node:path";
import { type CostTable, SESSION_COST_TABLE } from "./session-spend.js";

/** Writes the table into the checkout `root` and returns its path. The default
 *  only reads as a table: a case asserting on a figure passes that figure. */
export function writeCostTable(
	root: string,
	figures: Partial<CostTable> & { n?: number } = {},
): string {
	const file = path.join(root, SESSION_COST_TABLE);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		JSON.stringify({
			n: 2,
			meanUsd: 4,
			quantilesUsd: [1, 10],
			tailRemainderUsd: 9,
			landedByHours: [[1, 1]],
			...figures,
		}),
	);
	return file;
}
