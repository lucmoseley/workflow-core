/*
 * A fixture checkout under `home` whose dispatch ledger marks sessions
 * overflow, written through the ledger's own writer (#3696), so a test of a
 * spend reading breaks where the row's shape moves rather than passing on a
 * shape no launch writes. It declares the overflow seat in `home`'s seat file
 * too, as a reader consults the ledger only where one is declared (#4393).
 */
import fs from "node:fs";
import path from "node:path";
import { ledgerPath, record } from "./dispatch-ledger";

const KEY_VAR = "WFC_OVERFLOW_API_KEY_FAKE";

/** `home`'s seat file: a plan seat and an overflow seat on its dir. */
export function declareOverflowSeat(home: string) {
	fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(home, ".claude", "refill-seats"),
		`~/.claude\n~/.claude api key=${KEY_VAR} grant=100 cycle-day=1\n`,
	);
}

function writeCheckout(home: string, name: string) {
	const root = path.join(home, name);
	fs.mkdirSync(path.join(root, ".git"), { recursive: true });
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	fs.writeFileSync(path.join(root, ".claude", "workflow-core.json"), "{}\n");
	return root;
}

/** A checkout under `home` whose dispatch ledger will not read. */
export function writeUnreadableLedgerCheckout(home: string, name: string) {
	fs.mkdirSync(ledgerPath(writeCheckout(home, name)), { recursive: true });
}

export function writeOverflowCheckout(
	home: string,
	name: string,
	sessionIds: string[],
) {
	declareOverflowSeat(home);
	const root = writeCheckout(home, name);
	for (const sessionId of sessionIds)
		record({
			issues: [1],
			model: "opus",
			prompt: "/implement 1",
			root,
			jobId: sessionId.slice(0, 8),
			overflow: {
				keyVar: KEY_VAR,
				allowanceUsd: 100,
				sessionId,
			},
		});
}
