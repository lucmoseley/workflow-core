/*
 * The network probe's stand-in, which a suite names at WFC_NET_PROBE in place
 * of lib/net-probe.js's child (#4815). Offline it prints the line the real
 * child prints when api.anthropic.com does not resolve, which
 * lib/net-probe.contract.test.ts holds to the real one (#4826).
 */

import fs from "node:fs";
import { shellQuote } from "./sh-quote.js";

export const NET_PROBE_OFFLINE_LINE =
	"api.anthropic.com did not resolve: EAI_AGAIN";

/**
 * Writes the stand-in at `file`: reachable, unless `offlineMarker` exists,
 * when it prints NET_PROBE_OFFLINE_LINE and exits 1.
 */
export function writeNetProbeFake(file: string, offlineMarker: string): void {
	fs.writeFileSync(
		file,
		`#!/bin/bash\n[ -e ${shellQuote(offlineMarker)} ] && { echo ${shellQuote(NET_PROBE_OFFLINE_LINE)} >&2; exit 1; }\nexit 0\n`,
		{ mode: 0o755 },
	);
}
