import path from "node:path";
import { writeFakeBin } from "./fake-bin";
import { shellQuote } from "./sh-quote.js";

export function writeSchtasks(
	dir: string,
	diag: string,
	tasks: Record<string, { log: string; line: string }>,
): string {
	const arms = Object.entries(tasks)
		.map(
			([task, { log, line }]) =>
				`  ${shellQuote(task)}) printf '%s\\r\\n' ${shellQuote(`2026-11-28T07:00:00 ${line}`)} >>${shellQuote(path.join(diag, log))};;`,
		)
		.join("\n");
	return writeFakeBin(
		dir,
		"schtasks.exe",
		`case "$3" in
${arms}
  *) echo "ERROR: The system cannot find the file specified." >&2; exit 1;;
esac
echo 'SUCCESS: Attempted to run the scheduled task.'`,
	);
}
