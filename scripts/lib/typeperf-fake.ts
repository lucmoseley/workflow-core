import fs from "node:fs";
import path from "node:path";

export interface Sample {
	cpuPct: number;
	availableMb: number;
	vmmemBytes: number;
}

export function writeTypeperf(dir: string, sample: Sample | "failing"): string {
	fs.mkdirSync(dir, { recursive: true });
	const bin = path.join(dir, "typeperf.exe");
	const values =
		sample === "failing"
			? null
			: [sample.cpuPct, sample.availableMb, sample.vmmemBytes];
	fs.writeFileSync(
		bin,
		`#!/usr/bin/env node
const values = ${JSON.stringify(values)};
if (!values) process.exit(1);
const counters = process.argv.slice(2, 5);
const q = (v) => '"' + v + '"';
process.stdout.write(
	"\\r\\n" +
		[q("(PDH-CSV 4.0)"), ...counters.map((c) => q("\\\\\\\\HOST" + c))].join(",") +
		"\\r\\n" +
		[q("10/29/2026 12:02:17.667"), ...values.map((v) => q(v.toFixed(6)))].join(",") +
		"\\r\\nExiting, please wait...\\r\\nThe command completed successfully.\\r\\n",
);
`,
		{ mode: 0o755 },
	);
	return bin;
}
