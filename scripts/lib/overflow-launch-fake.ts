/*
 * A fixture checkout under `home` whose dispatch ledger marks sessions
 * overflow, written through the ledger's own writer (#3696), so a test of a
 * spend reading breaks where the row's shape moves rather than passing on a
 * shape no launch writes.
 */
import fs from "node:fs";
import path from "node:path";
import { record } from "./dispatch-ledger";

export function writeOverflowCheckout(
	home: string,
	name: string,
	sessionIds: string[],
) {
	const root = path.join(home, name);
	fs.mkdirSync(path.join(root, ".git"), { recursive: true });
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	fs.writeFileSync(path.join(root, ".claude", "workflow-core.json"), "{}\n");
	for (const sessionId of sessionIds)
		record({
			issues: [1],
			model: "opus",
			prompt: "/implement 1",
			root,
			jobId: sessionId.slice(0, 8),
			overflow: {
				keyVar: "WFC_OVERFLOW_API_KEY_FAKE",
				allowanceUsd: 100,
				sessionId,
			},
		});
}
