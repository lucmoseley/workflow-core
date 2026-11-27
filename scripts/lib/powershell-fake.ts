import path from "node:path";
import { writeFakeBin } from "./fake-bin";
import { shellQuote } from "./sh-quote.js";

export function writePowershell(dir: string) {
	const calls = path.join(dir, "powershell-calls");
	return {
		bin: writeFakeBin(
			dir,
			"powershell.exe",
			`printf '%s\\n' "$*" >>${shellQuote(calls)}
case "$*" in *" -Check") echo ok; exit 0;; esac
[ "$2" = -Command ] && eval "\${3#& }"`,
		),
		calls,
	};
}
