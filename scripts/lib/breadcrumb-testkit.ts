import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { caught, orFallback } from "./caught.js";

const require = createRequire(import.meta.url);
const { recordsDir, PREFIX } = require("./hook-record.js");

interface Breadcrumb {
	guard: string;
	session: string;
	outcome?: string;
	[field: string]: unknown;
}

export function readBreadcrumbs(
	root: string,
	guard: string,
	sessionId: string | null,
): Breadcrumb[] {
	const dir = recordsDir(root);
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch (e) {
		if (caught(e).code === "ENOENT") return [];
		throw e;
	}
	const session = sessionId ?? "unknown-session";
	return names
		.filter((n) => n.startsWith(PREFIX))
		.sort()
		.flatMap((name) =>
			readFileBreadcrumbs(path.join(dir, name), guard, session),
		);
}

function readFileBreadcrumbs(
	file: string,
	guard: string,
	session: string,
): Breadcrumb[] {
	const out: Breadcrumb[] = [];
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		const parsed = orFallback(() => JSON.parse(line), undefined);
		if (parsed?.guard === guard && parsed.session === session) out.push(parsed);
	}
	return out;
}
