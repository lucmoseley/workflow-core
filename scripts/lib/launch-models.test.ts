// @vitest-environment node
/*
 * launch-models.test.ts — the two prose model tables, and retro-bundles.js's
 * copy of the triage row, against scripts/lib/launch-models.sh, the one source
 * both launch scripts read (#361, #1195). A model changed in one place and not
 * the others fails here.
 *
 * It reads the real docs, not fixtures, since drift between the real files is
 * the whole subject, and resolves each kind through `launch_model_for` in bash,
 * as launch.sh does. A loosened case lets the tables a session or /pick-next
 * routes by name one model while the launch scripts start another.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const MAP = path.join(__dirname, "launch-models.sh");
const { RETRO_BUNDLE_MODEL } = require("./retro-bundles.js");

/** Every mapped kind, resolved through launch_model_for as both launch scripts resolve it. */
const readMap = (): { models: Map<string, string>; fallback: string } => {
	const out = execFileSync(
		"bash",
		[
			"-c",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash expansions, not a JS template
			'source "$1"; echo "$LAUNCH_MODEL_FALLBACK"; for p in "${LAUNCH_MODELS[@]}"; do k="${p%%=*}"; echo "$k $(launch_model_for "$k")"; done',
			"_",
			MAP,
		],
		{ encoding: "utf8" },
	)
		.trim()
		.split("\n");
	const models = new Map(
		out.slice(1).map((line) => line.split(" ") as [string, string]),
	);
	return { models, fallback: out[0] };
};

/** The rows of the first table after `anchor`, as [first cell, second cell]. */
const readTableRows = (file: string, anchor: string): [string, string][] => {
	const text = fs.readFileSync(path.join(ROOT, file), "utf8");
	const start = text.indexOf(anchor);
	expect(start, `${anchor} not found in ${file}`).toBeGreaterThan(-1);
	const lines = text.slice(start).split("\n");
	const first = lines.findIndex((l) => l.startsWith("|"));
	const rows: [string, string][] = [];
	for (const line of lines.slice(first + 2)) {
		if (!line.startsWith("|")) break;
		const cells = line.split("|").map((c) => c.trim());
		rows.push([cells[1], cells[2]]);
	}
	return rows;
};

const kindOf = (cell: string): string =>
	cell.replace(/`/g, "").replace(/^\/|^takes:/, "");

/** `**plain Opus**`, `Sonnet`, `` `opus` `` or a host-model sentence → one alias. */
const modelOf = (cell: string): string => {
	const lower = cell.toLowerCase();
	const hits = ["sonnet", "opus", "fable", "haiku"].filter((m) =>
		lower.includes(m),
	);
	expect(hits, `ambiguous Model cell: ${cell}`).toHaveLength(1);
	return hits[0];
};

describe("launch-models.sh", () => {
	const { models, fallback } = readMap();

	it("agrees with docs/effort-guide.md's launch table", () => {
		const rows = readTableRows(
			"docs/effort-guide.md",
			"## Which model to launch each session on",
		);
		const seen = new Set<string>();
		for (const [kindCell, modelCell] of rows) {
			const kind = kindOf(kindCell);
			const want = kind === "ad-hoc / untyped" ? fallback : models.get(kind);
			expect(want, `${kind} is not in launch-models.sh`).toBeDefined();
			expect(modelOf(modelCell), kind).toBe(want);
			seen.add(kind);
		}
		expect([...models.keys()].filter((k) => !seen.has(k))).toEqual([]);
	});

	it("agrees with the retro triage bundles' copy of the triage row (#1195)", () => {
		expect(RETRO_BUNDLE_MODEL).toBe(models.get("triage"));
	});

	it("agrees with pick-next §6's takes: table", () => {
		const rows = readTableRows(
			".claude/skills/pick-next/SKILL.md",
			"| `takes:` | Model |",
		);
		expect(rows.length).toBeGreaterThan(0);
		for (const [kindCell, modelCell] of rows) {
			const kind = kindOf(kindCell);
			expect(models.get(kind), kind).toBe(modelOf(modelCell));
		}
	});
});
