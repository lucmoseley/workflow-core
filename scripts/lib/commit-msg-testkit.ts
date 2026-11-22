import fs from "node:fs";
import path from "node:path";
import { shellQuote } from "./sh-quote.js";

const ROOT = path.join(__dirname, "..", "..");

export function installCommitMsgHook(hooks: string): void {
	fs.writeFileSync(
		path.join(hooks, "commit-msg"),
		`#!/bin/sh\nexec sh ${shellQuote(path.join(ROOT, ".husky", "commit-msg"))} "$1"\n`,
		{ mode: 0o755 },
	);
}
