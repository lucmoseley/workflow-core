import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInProcess } from "./run-in-process.js";

const SCRIPT = path.resolve(__dirname, "..", "check-context-budget.js");

export function liveCaps(): { pool: number; injection: number } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctxbudget-caps-"));
	try {
		const r = runInProcess(SCRIPT, ["--root", root, "--json"]);
		const j = JSON.parse(r.stdout);
		const caps = { pool: j.cap, injection: j.injection?.cap };
		if (typeof caps.pool !== "number" || typeof caps.injection !== "number")
			throw new Error(
				`check-context-budget.js --json gave no caps (outcome ${j.outcome}, exit ${r.status})`,
			);
		return caps;
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}
