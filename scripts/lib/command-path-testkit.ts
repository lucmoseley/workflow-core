import { execFileSync } from "node:child_process";
import { shellQuote } from "./sh-quote.js";

export function commandPath(cmd: string): string {
	try {
		return execFileSync("sh", ["-c", `command -v ${shellQuote(cmd)}`], {
			encoding: "utf8",
		}).trim();
	} catch (cause) {
		throw new Error(`${cmd} is not on PATH`, { cause });
	}
}
