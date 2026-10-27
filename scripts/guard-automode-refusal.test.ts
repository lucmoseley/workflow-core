// @vitest-environment node
/*
 * Pins that a turn ending after an auto-mode refusal is sent back once per
 * refused call, with the founder's hand-over paragraph and #1023's re-run
 * clause, and that a quoted denial, an earlier turn or a spent cap passes.
 *
 * #860's guard is run black-box: a Stop payload on stdin, the repo root pointed
 * at a throwaway directory so the counter, the seen set and the breadcrumbs
 * land there and never spend the shared tree's real allowance.
 *
 * It is a `Stop` hook in `self-plugin/hooks/hooks.json` and the shipped
 * plugin's `hooks/hooks.json`: loosen a case and a session ends silently on a
 * refusal, stalling its ticket, or is sent back over a transcript that merely
 * quotes the denial.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStopGuardBlock, type StopRun } from "./lib/stop-guard-testkit";
import { buildBashCall } from "./lib/transcript-testkit";

const hookRecord = createRequire(__filename)("./lib/hook-record.js");
const { markersDir } = createRequire(__filename)("./lib/marker-root.js");

const GUARD = path.join(__dirname, "guard-automode-refusal.js");

const DENIAL =
	"Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Auto-Mode Bypass]. If you have other tasks that don't depend on this action, continue working on those.";

let dir: string;
let sid: string;

const prompt = (text = "do the thing") => ({
	type: "user",
	message: { role: "user", content: text },
});

const result = (id: string, content: unknown, over: object = {}) => ({
	type: "user",
	message: {
		role: "user",
		content: [{ type: "tool_result", tool_use_id: id, content, ...over }],
	},
});

/** A classifier refusal, shaped as the harness records one. */
const refused = (id: string) => ({
	...result(id, DENIAL, { is_error: true }),
	toolDenialKind: "automode-blocked",
});

const transcript = (records: object[]) =>
	fs.writeFileSync(
		path.join(dir, `${sid}.jsonl`),
		`${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
	);

/**
 * The guard's verdict on this session's transcript, run as an interactive
 * session unless `over.job` says otherwise; with no `over.message`, the guard
 * reads the turn's text from the transcript.
 */
const run = (over: Partial<StopRun> = {}) => {
	const block = readStopGuardBlock(GUARD, {
		dir,
		sid,
		config: dir,
		transcript: path.join(dir, `${sid}.jsonl`),
		...over,
	});
	return { blocked: block !== null, reason: block?.reason ?? "" };
};

const readCrumb = () => {
	const lines = fs
		.readFileSync(
			path.join(
				hookRecord.recordsDir(dir),
				`.hook-ran-guard-automode-refusal-${sid}`,
			),
			"utf8",
		)
		.split("\n")
		.filter((l) => l.trim());
	return JSON.parse(lines.at(-1) ?? "");
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "automode-refusal-"));
	sid = "s-automode-refusal";
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("a turn carrying a refusal", () => {
	it("blocks with the founder's refusal paragraph, the call and its reason", () => {
		transcript([
			prompt(),
			buildBashCall("git push", "toolu_A"),
			refused("toolu_A"),
		]);

		const r = run();

		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("THE AUTO-MODE CLASSIFIER REFUSED A CALL");
		expect(r.reason).toContain("Bash: git push");
		expect(r.reason).toContain("Reason: [Auto-Mode Bypass]");
		expect(r.reason).toContain("AN AUTO-MODE REFUSAL");
		expect(r.reason).not.toContain("A SECRET he must supply");
		expect(readCrumb()).toMatchObject({ outcome: "message" });
	});

	it("carries #1023's bare re-run clause, with its three limits and its pointer", () => {
		transcript([
			prompt(),
			buildBashCall("git push", "toolu_A"),
			refused("toolu_A"),
		]);

		const r = run();

		expect(r.reason).toContain("matches a `permissions.allow` rule");
		expect(r.reason).toContain("re-run that command once, on its own");
		expect(r.reason).toContain("Never re-chain it");
		expect(r.reason).toContain("§Auto mode's permission classifier");
	});

	it("knows the refusal by its sentence alone, untagged and as text blocks", () => {
		transcript([
			prompt(),
			buildBashCall("ls", "toolu_A"),
			result("toolu_A", [{ type: "text", text: `Error: ${DENIAL}` }], {
				is_error: true,
			}),
		]);

		expect(run().blocked).toBe(true);
	});

	it("knows it by the harness's tag alone, whatever the wording", () => {
		transcript([
			prompt(),
			buildBashCall("ls", "toolu_A"),
			{
				...result("toolu_A", "Blocked.", { is_error: true }),
				toolDenialKind: "automode-unavailable",
			},
		]);

		expect(run().reason).toContain("Reason: none given");
	});

	it("still blocks while another Stop hook has sent the turn back", () => {
		transcript([prompt(), buildBashCall("ls", "toolu_A"), refused("toolu_A")]);

		expect(run({ payload: { stop_hook_active: true } }).blocked).toBe(true);
	});
});

describe("a turn it passes", () => {
	it("passes a turn with no refusal", () => {
		transcript([
			prompt(),
			buildBashCall("ls", "toolu_A"),
			result("toolu_A", "a b c"),
		]);

		expect(run().blocked).toBe(false);
		expect(readCrumb()).toMatchObject({ outcome: "no-finding" });
	});

	it("passes a refusal from before the last human prompt", () => {
		transcript([
			prompt(),
			buildBashCall("ls", "toolu_A"),
			refused("toolu_A"),
			prompt("next"),
		]);

		expect(run().blocked).toBe(false);
	});

	it("counts a Stop hook's own feedback as the same turn", () => {
		transcript([
			prompt(),
			buildBashCall("ls", "toolu_A"),
			refused("toolu_A"),
			{
				type: "user",
				isMeta: true,
				message: { content: "Stop hook feedback:\nx" },
			},
		]);

		expect(run().blocked).toBe(true);
	});

	it("passes a result that merely quotes the denial sentence", () => {
		transcript([
			prompt(),
			buildBashCall("grep -r classifier ~/.claude3/projects", "toolu_A"),
			result("toolu_A", `Exit code 1\nx.jsonl: "${DENIAL}"`, {
				is_error: true,
			}),
		]);

		expect(run().blocked).toBe(false);
	});
});

describe("the latch", () => {
	it("shows each refused call once and never again", () => {
		transcript([prompt(), buildBashCall("ls", "toolu_A"), refused("toolu_A")]);

		expect(run().blocked).toBe(true);
		expect(run().blocked).toBe(false);
	});

	it("shows a later refusal in the same turn, and only that one", () => {
		const records = [
			prompt(),
			buildBashCall("ls", "toolu_A"),
			refused("toolu_A"),
		];
		transcript(records);
		run();

		transcript([
			...records,
			buildBashCall("git push", "toolu_B"),
			refused("toolu_B"),
		]);
		const r = run();

		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("git push");
		expect(r.reason).not.toContain("Bash: ls");
	});
});

describe("the cap", () => {
	it("stops blocking once the session has had its turns, and marks nothing shown", () => {
		transcript([prompt(), buildBashCall("ls", "toolu_A"), refused("toolu_A")]);
		fs.mkdirSync(markersDir(dir), { recursive: true });
		fs.writeFileSync(
			path.join(markersDir(dir), `.automode-refusal-nagged-${sid}`),
			"3\n",
		);

		expect(run().blocked).toBe(false);
		expect(
			fs.existsSync(
				path.join(markersDir(dir), `.automode-refusal-seen-${sid}`),
			),
		).toBe(false);
	});
});

describe("failing open", () => {
	it("passes and crumbs where the transcript is not there", () => {
		expect(run().blocked).toBe(false);
		expect(readCrumb()).toMatchObject({ outcome: "no-transcript" });
	});

	it("passes where the transcript is not a file it can read", () => {
		fs.mkdirSync(path.join(dir, `${sid}.jsonl`));

		expect(run().blocked).toBe(false);
		expect(readCrumb()).toMatchObject({ outcome: "unreadable-transcript" });
	});

	it("points at the rule, never paraphrases it, where the fragment cannot be read", () => {
		transcript([prompt(), buildBashCall("ls", "toolu_A"), refused("toolu_A")]);

		const r = run({
			env: { WFC_RULES_DIR: dir, WFC_RULES_FALLBACK_DIR: undefined },
		});

		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("rule-text.sh founder-handover");
		expect(r.reason).not.toContain("never the end of the work");
	});
});
