import path from "node:path";
import { coreRoot } from "./script-path.js";
import { shellQuote } from "./sh-quote.js";

// #5584
export function seenFrom<T>(cwd: string, read: () => T): T {
	const prev = process.cwd();
	process.chdir(cwd);
	try {
		return read();
	} finally {
		process.chdir(prev);
	}
}

export const coreFile = (rel: string): string =>
	shellQuote(path.join(coreRoot(), rel));
