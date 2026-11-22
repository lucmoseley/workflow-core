import fs from "node:fs";
import path from "node:path";
import { shellQuote } from "./sh-quote.js";

const PS_FAILING_SCRIPT =
	'#!/bin/sh\necho "ps: cannot read /proc" >&2\nexit 1\n';

const END = "PS_STUB_END";

export function writePsStub(
	dir: string,
	lines: string[],
	{
		name = "ps",
		fails = false,
		marker,
	}: { name?: string; fails?: boolean; marker?: string } = {},
): string {
	if (lines.includes(END))
		throw new Error(`ps-stub: a line may not be the heredoc's ${END}`);
	const file = path.join(dir, name);
	const body = fails
		? PS_FAILING_SCRIPT
		: [
				"#!/bin/sh",
				...(marker ? [`touch ${shellQuote(marker)}`] : []),
				`cat <<'${END}'`,
				...lines,
				END,
				"",
			].join("\n");
	fs.writeFileSync(file, body, { mode: 0o755 });
	return file;
}
