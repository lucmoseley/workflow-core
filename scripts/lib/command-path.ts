/*
 * command-path.ts — where `sh` finds a command on the inherited PATH, the one
 * `command -v` lookup a test or testkit makes (#3977).
 */

import { execFileSync } from "node:child_process";
import { shellQuote } from "./sh-quote.js";

/** The absolute path `command -v <cmd>` prints. Throws where `cmd` is not on
 *  PATH, so a missing tool fails at the lookup rather than as an empty path. */
export function commandPath(cmd: string): string {
	try {
		return execFileSync("sh", ["-c", `command -v ${shellQuote(cmd)}`], {
			encoding: "utf8",
		}).trim();
	} catch (cause) {
		throw new Error(`${cmd} is not on PATH`, { cause });
	}
}
