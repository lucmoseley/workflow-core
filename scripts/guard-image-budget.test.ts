// @vitest-environment node
/*
 * guard-image-budget.test.ts — the PostToolUse Read hook telling an agent
 * which images no longer reach it (#1784).
 *
 * Spawns the real script with TMPDIR pointed at a scratch directory, the
 * store's only seam, and budgets small enough to cross in a few Reads. The
 * payload is the stored Read result #1784's probes captured. Loosen the naming
 * cases and an agent is told an image it still sees is gone, or never told of
 * one it lost; loosen the silent ones and every Read carries the notice.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath } from "./guard-log-fixture";

const GUARD = path.resolve(__dirname, "guard-image-budget.sh");

let tmp: string;
let config: string;
let project: string;

const read = (
	file: string,
	response: Record<string, unknown>,
	payload: Record<string, unknown> = {},
) => ({
	hook_event_name: "PostToolUse",
	tool_name: "Read",
	session_id: "sess-1784",
	tool_input: { file_path: file },
	tool_response: response,
	...payload,
});

const imageRead = (
	file: string,
	chars: number,
	payload: Record<string, unknown> = {},
) =>
	read(
		file,
		{
			type: "image",
			file: {
				base64: "A".repeat(chars),
				type: "image/jpeg",
				originalSize: Math.floor((chars * 3) / 4),
				dimensions: { originalWidth: 660, originalHeight: 871 },
			},
		},
		payload,
	);

const spawn = (input: string, env: Record<string, string> = {}) => {
	const r = spawnSync(GUARD, [], {
		encoding: "utf8",
		input,
		env: {
			...process.env,
			TMPDIR: tmp,
			CLAUDE_CONFIG_DIR: config,
			CLAUDE_PROJECT_DIR: project,
			WFC_IMAGE_BUDGET_CHARS: "1000",
			WFC_IMAGE_WARN_CHARS: "750",
			...env,
		},
	});
	if (r.status === null) throw new Error(`guard did not run: ${r.error}`);
	expect(r.status).toBe(0);
	return r.stdout;
};

const run = (input: unknown, env: Record<string, string> = {}) =>
	spawn(JSON.stringify(input), env);

const said = (stdout: string) => {
	const out = JSON.parse(stdout).hookSpecificOutput;
	expect(out.hookEventName).toBe("PostToolUse");
	return out.additionalContext as string;
};

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imgbudget-")));
	config = path.join(tmp, "config");
	project = path.join(tmp, "project");
	fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("an agent's images nearing and passing the request budget", () => {
	it("says nothing under the warning line", () => {
		expect(run(imageRead("/p/a.jpg", 300))).toBe("");
		expect(run(imageRead("/p/b.jpg", 300))).toBe("");
	});

	it("warns once as the total crosses the warning line", () => {
		run(imageRead("/p/a.jpg", 400));
		const text = said(run(imageRead("/p/b.jpg", 400)));
		expect(text).toContain("read 2 images");
		expect(text).toContain("`[media removed: request limit]`");
		expect(text).toContain("stop and report which images never reached you");
		expect(run(imageRead("/p/c.jpg", 100))).toBe("");
	});

	it("names each image the budget pushes out, once, oldest first", () => {
		run(imageRead("/p/a.jpg", 400));
		run(imageRead("/p/b.jpg", 400));
		const first = said(run(imageRead("/p/c.jpg", 400)));
		expect(first).toContain("- /p/a.jpg (image 1 of this context)");
		expect(first).not.toContain("/p/b.jpg");
		expect(first).toContain("Do not judge, compare against or describe");
		const second = said(run(imageRead("/p/d.jpg", 400)));
		expect(second).toContain("- /p/b.jpg (image 2 of this context)");
		expect(second).not.toContain("/p/a.jpg");
	});

	it("keeps a subagent's count apart from its parent's", () => {
		run(imageRead("/p/a.jpg", 400));
		run(imageRead("/p/b.jpg", 400, { agent_id: "a1" }));
		expect(run(imageRead("/p/c.jpg", 300, { agent_id: "a2" }))).toBe("");
		expect(said(run(imageRead("/p/d.jpg", 400)))).toContain("read 2 images");
	});

	it("caps the list it names and counts the rest", () => {
		for (let i = 1; i <= 12; i++) run(imageRead(`/p/${i}.jpg`, 10));
		const text = said(run(imageRead("/p/big.jpg", 1000)));
		expect(text).toContain("- /p/10.jpg (image 10 of this context)");
		expect(text).not.toContain("/p/11.jpg");
		expect(text).toContain("and 2 more");
	});

	it("names a path holding a tab whole", () => {
		run(imageRead("/p/a\tb.jpg", 600));
		expect(said(run(imageRead("/p/c.jpg", 600)))).toContain("- /p/a b.jpg");
	});

	it("counts a PDF's document block against the same budget", () => {
		run(
			read("/p/doc.pdf", {
				type: "pdf",
				file: { filePath: "/p/doc.pdf", base64: "A".repeat(800) },
			}),
		);
		expect(said(run(imageRead("/p/a.jpg", 300)))).toContain("- /p/doc.pdf");
	});
});

describe("silent Reads", () => {
	it("stays silent on a text Read, however full the budget already is", () => {
		run(imageRead("/p/a.jpg", 900));
		const out = run(
			read("/p/notes.md", {
				type: "text",
				file: { filePath: "/p/notes.md", content: "x".repeat(5000) },
			}),
		);
		expect(out).toBe("");
	});

	it("stays silent on an image Read with the hook defeated", () => {
		run(imageRead("/p/a.jpg", 900));
		expect(run(imageRead("/p/b.jpg", 900), { WFC_NO_IMAGE_BUDGET: "1" })).toBe(
			"",
		);
	});

	it("stays silent on an unparseable payload, and records the fail-open", () => {
		expect(spawn("{not json")).toBe("");
		const log = fs.readFileSync(failOpenLogPath(config, project), "utf8");
		expect(log).toContain("payload did not parse as JSON — Read allowed");
	});
});
