/*
 * breadcrumb-testkit.ts — read back the Stop-guard breadcrumbs `hook-record.js`
 * wrote under a test's root: every `PREFIX` file in `recordsDir`, line by line,
 * sorted by each line's own guard and session rather than by the file name it
 * landed in (#1367). Unlike `check-stop-guard-outcomes.js` it matches the guard
 * name as written, never normalised.
 *
 * A `null` session reads hook-record.js's "unknown-session", restated here
 * because the module keeps it private: rename it there and those reads come
 * back empty.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { caught } from "./caught.js";

const require = createRequire(import.meta.url);
const { recordsDir, PREFIX } = require("./hook-record.js");

interface Breadcrumb {
	guard: string;
	session: string;
	outcome?: string;
	[field: string]: unknown;
}

/**
 * Every line one guard recorded for one session, oldest first; a `null`
 * session reads the lines kept for payloads naming none. A torn line is
 * skipped, as the real reader counts and skips it.
 */
export function breadcrumbs(
	root: string,
	guard: string,
	sessionId: string | null,
): Breadcrumb[] {
	const dir = recordsDir(root);
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch (e) {
		// Absent means no record was ever written; any other failure is one.
		if (caught(e).code === "ENOENT") return [];
		throw e;
	}
	const session = sessionId ?? "unknown-session";
	return names
		.filter((n) => n.startsWith(PREFIX))
		.sort()
		.flatMap((name) => fileBreadcrumbs(path.join(dir, name), guard, session));
}

/** One breadcrumb file's lines for `guard` and `session`, in file order. */
function fileBreadcrumbs(
	file: string,
	guard: string,
	session: string,
): Breadcrumb[] {
	const out: Breadcrumb[] = [];
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line);
			if (parsed?.guard === guard && parsed.session === session)
				out.push(parsed);
		} catch {
			// A torn line, which the real reader also skips.
		}
	}
	return out;
}
