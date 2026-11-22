import fs from "node:fs";
import path from "node:path";
import { type CostTable, SESSION_COST_TABLE } from "./session-spend.js";

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
