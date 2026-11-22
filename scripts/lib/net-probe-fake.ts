import fs from "node:fs";
import { shellQuote } from "./sh-quote.js";

export const NET_PROBE_OFFLINE_LINE =
	"api.anthropic.com did not resolve: EAI_AGAIN";

export function writeNetProbeFake(file: string, offlineMarker: string): void {
	fs.writeFileSync(
		file,
		`#!/bin/bash\n[ -e ${shellQuote(offlineMarker)} ] && { echo ${shellQuote(NET_PROBE_OFFLINE_LINE)} >&2; exit 1; }\nexit 0\n`,
		{ mode: 0o755 },
	);
}
