import fs from "node:fs";
import path from "node:path";
import { shellQuote } from "./sh-quote.js";

export type AttachKind = "offTerminal" | "onTerminal";

export const recorded: {
	harness: string;
	responses: Record<AttachKind, { status: number }>;
} = JSON.parse(
	fs.readFileSync(
		path.join(__dirname, "..", "fixtures", "claude-attach.json"),
		"utf8",
	),
);

export function buildAttachBranch(log: string) {
	const to = shellQuote(log);
	return `if [ "$1" = "attach" ]; then
  [ -t 0 ] || exit ${recorded.responses.offTerminal.status}
  echo "$*" >> ${to}; printf '> '; IFS= read -r line
  line=\${line#$'\\e[200~'}; line=\${line%$'\\e[201~'}
  echo "typed $line" >> ${to}; exit 0
fi`;
}
