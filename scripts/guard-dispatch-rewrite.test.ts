// @vitest-environment node
/*
 * The transforms are lib/dispatch-artefact.js's and lib/burn-mode.js's, tested
 * there; what is tested here is that the hook composes them into one envelope,
 * splices each tripped rule's fragment in whole once a session, denies a
 * subagent's own dispatch, stays silent on any other tool, and leaves the
 * dispatch as written — recorded — wherever it cannot decide (mantahostels#103
 * §6). A red here means a dispatch either lost a change it was owed — the line
 * or the remap — or was rewritten when it should have been left alone (#515).
 * It runs on every `Agent`/`Task` dispatch as a `PreToolUse` hook
 * (`self-plugin/hooks/hooks.json`, `hooks/hooks.json`), so a lost `Artefact:`
 * line leaves a stalled agent unseen.
 *
 * The burn marker is always WFC_BURN_MARKER here — the real one, at
 * ~/.claude/.burn-mode, is the machine's live switch.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeFailOpenLog, failOpenLogPath } from "./guard-log-fixture";
import { requiredLibs } from "./guard-parse-fixture";

const HOOK = path.resolve(__dirname, "guard-dispatch-rewrite.sh");
const NODE_LIBS = requiredLibs("dispatch-rewrite.js");
const LIBS = ["guard-parse.sh", "guard-log.sh", "guard-root.sh", ...NODE_LIBS];

let dir: string;
let config: string;
let project: string;
let marker: string;

const dispatch = (input: Record<string, unknown>) => ({
	tool_name: "Agent",
	session_id: "s1",
	tool_input: { prompt: "Do the work.", description: "do a thing", ...input },
});

const run = (
	hook: string,
	payload: Record<string, unknown>,
	env: NodeJS.ProcessEnv = process.env,
) => {
	const r = spawnSync(hook, [], {
		encoding: "utf8",
		input: JSON.stringify(payload),
		cwd: project,
		env: {
			...env,
			CLAUDE_CONFIG_DIR: config,
			CLAUDE_PROJECT_DIR: project,
			WFC_BURN_MARKER: marker,
		},
	});
	if (r.status === null) throw new Error(`hook did not run: ${r.error}`);
	return r;
};

const envelopeOf = (payload: Record<string, unknown>) => {
	const r = run(HOOK, payload);
	expect(r.status).toBe(0);
	return JSON.parse(r.stdout).hookSpecificOutput;
};

const expectSilent = (r: ReturnType<typeof run>) => {
	expect(r.status).toBe(0);
	expect(r.stdout ?? "").toBe("");
	expect(r.stderr ?? "").toBe("");
};

const burnOn = () => fs.writeFileSync(marker, "");

/** A copy of the hook whose lib/ can be tampered with. */
const detach = () => {
	const at = path.join(dir, "detached");
	fs.mkdirSync(path.join(at, "lib"), { recursive: true });
	const hook = path.join(at, path.basename(HOOK));
	fs.copyFileSync(HOOK, hook);
	fs.chmodSync(hook, 0o755);
	for (const lib of LIBS)
		fs.copyFileSync(
			path.resolve(__dirname, "lib", lib),
			path.join(at, "lib", lib),
		);
	return { at, hook };
};

const projectRoot = () => fs.realpathSync(project);

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-dispatch-rewrite-"));
	config = path.join(dir, "claude-config");
	project = path.join(dir, "project");
	fs.mkdirSync(project);
	marker = path.join(dir, "burn-mode");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("the artefact line", () => {
	it("is supplied where the prompt names none, and the session told the path and the check", () => {
		const v = envelopeOf(dispatch({}));
		expect(v.hookEventName).toBe("PreToolUse");
		expect(v.permissionDecision).toBe("allow");
		const m = /^Artefact: (\S+)$/m.exec(v.updatedInput.prompt);
		expect(m).not.toBeNull();
		const file = m?.[1] as string;
		expect(
			file.startsWith(`${projectRoot()}/.claude/tmp/agents/do-a-thing-`),
		).toBe(true);
		expect(v.updatedInput.prompt).toContain("as each one lands");
		expect(v.additionalContext).toContain(file);
		expect(v.additionalContext).toContain("watch-artefact.js");
		expect(v.additionalContext).toContain(` ${file} 120\``);
		expect(fs.existsSync(path.dirname(file))).toBe(true);
	});

	it("is left alone where the prompt names a usable one, the session told to watch it (#2013)", () => {
		const v = envelopeOf(
			dispatch({ prompt: "Do it.\nArtefact: .claude/tmp/x.md" }),
		);
		expect(v).not.toHaveProperty("updatedInput");
		expect(v).not.toHaveProperty("permissionDecision");
		expect(v.additionalContext).toContain(
			"This dispatch names its artefact: .claude/tmp/x.md.",
		);
		expect(v.additionalContext).toContain(" .claude/tmp/x.md 120`");
		expect(v.additionalContext).toContain(
			"When the agent's completion notification arrives, `TaskStop` the watcher first.",
		);
	});

	it("replaces a placeholder in place", () => {
		const v = envelopeOf(
			dispatch({ prompt: "Do it.\nArtefact: <path>\nThen report." }),
		);
		const lines = v.updatedInput.prompt.split("\n");
		expect(lines[0]).toBe("Do it.");
		expect(lines[1]).toMatch(/^Artefact: \/.+\.md$/);
		expect(lines.at(-1)).toBe("Then report.");
		expect(v.updatedInput.prompt).not.toContain("<path>");
	});

	it("is not supplied to an agent type with no file-writing tool, told only to end the turn", () => {
		const v = envelopeOf(dispatch({ subagent_type: "statusline-setup" }));
		expect(v).not.toHaveProperty("updatedInput");
		expect(v.additionalContext).toBe(
			"While this agent runs, end the turn: its completion notification wakes this session, so a poll learns nothing.",
		);
	});

	it("is supplied to a fork", () => {
		const v = envelopeOf(dispatch({ subagent_type: "fork" }));
		expect(v.updatedInput.prompt).toMatch(/^Artefact: \//m);
	});

	it("gets a different absolute path on each call", () => {
		const a = envelopeOf(dispatch({})).updatedInput.prompt;
		const b = envelopeOf(dispatch({})).updatedInput.prompt;
		const pathOf = (p: string) => /^Artefact: (\S+)$/m.exec(p)?.[1] as string;
		expect(path.isAbsolute(pathOf(a))).toBe(true);
		expect(path.isAbsolute(pathOf(b))).toBe(true);
		expect(pathOf(a)).not.toBe(pathOf(b));
	});
});

describe("burn mode, in the same envelope", () => {
	// Two hooks each rewriting the call raced, the last winning
	// (anthropics/claude-code#83353); one envelope is what #515 built to stop it.
	it("moves the model and supplies the line in one rewrite", () => {
		burnOn();
		const v = envelopeOf(dispatch({ model: "sonnet" }));
		expect(v.updatedInput.model).toBe("opus");
		expect(v.updatedInput.prompt).toMatch(/^Artefact: \//m);
		expect(v.updatedInput.description).toBe("do a thing");
		expect(v.additionalContext).toContain("from `sonnet` to `opus`");
		expect(v.additionalContext).toContain("watch-artefact.js");
	});

	it("changes only the model where the prompt already names an artefact", () => {
		burnOn();
		const prompt = "Do it.\nArtefact: .claude/tmp/x.md";
		const v = envelopeOf(dispatch({ model: "sonnet", prompt }));
		expect(v.updatedInput).toEqual({
			prompt,
			description: "do a thing",
			model: "opus",
		});
		expect(v.additionalContext).toContain("names its artefact");
	});

	it.each([
		["opus", "opus"],
		["fable", "fable"],
		["no model", undefined],
	])("changes nothing on %s with a usable line", (_n, model) => {
		burnOn();
		const v = envelopeOf(
			dispatch({ model, prompt: "Artefact: .claude/tmp/x.md" }),
		);
		expect(v).not.toHaveProperty("updatedInput");
	});

	it("leaves the model alone while the marker is absent", () => {
		const v = envelopeOf(dispatch({ model: "sonnet" }));
		expect(v.updatedInput.model).toBe("sonnet");
	});

	it("judges a Task payload, the other spelling of a dispatch", () => {
		burnOn();
		const r = run(HOOK, {
			tool_name: "Task",
			tool_input: { model: "sonnet", prompt: "Artefact: a/b.md" },
		});
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout).hookSpecificOutput.updatedInput.model).toBe(
			"opus",
		);
	});
});

const fragment = (file: string) => fs.readFileSync(file, "utf8").trimEnd();
const TIER = path.resolve(__dirname, "../docs/agents/rules/dispatch-tier.txt");
const SEARCH = path.resolve(
	__dirname,
	"../docs/agents/rules/dispatch-search-tracker.txt",
);
const GRANDCHILD = path.resolve(
	__dirname,
	"../docs/agents/rules/dispatch-grandchild.txt",
);

describe("the dispatch rules, printed at the call (#2013)", () => {
	it("hands over the effort guide rule whole on a tier it routes away from, once a session", () => {
		const first = envelopeOf(dispatch({ model: "haiku" }));
		expect(first.additionalContext).toContain("This dispatch names `haiku`");
		expect(first.additionalContext).toContain(fragment(TIER));
		const again = envelopeOf(dispatch({ model: "haiku" }));
		expect(again.additionalContext).toContain("This dispatch names `haiku`");
		expect(again.additionalContext).not.toContain(fragment(TIER));
	});

	it("hands over the tracker rule whole on a search of the repo that names none", () => {
		const v = envelopeOf(
			dispatch({ prompt: "Search the repo for the figure." }),
		);
		expect(v.additionalContext).toContain(
			"This prompt asks for a search of the repo and names no tracker.",
		);
		expect(v.additionalContext).toContain(fragment(SEARCH));
	});

	it("prints neither off its trigger", () => {
		const v = envelopeOf(
			dispatch({
				model: "sonnet",
				prompt: "Search the repo and the tracker for the figure.",
			}),
		);
		expect(v.additionalContext).not.toContain(fragment(TIER));
		expect(v.additionalContext).not.toContain(fragment(SEARCH));
	});

	it("denies a dispatch from inside a subagent, with the rule whole", () => {
		const r = run(HOOK, { ...dispatch({}), agent_id: "a1" });
		expect(r.status).toBe(0);
		const v = JSON.parse(r.stdout).hookSpecificOutput;
		expect(v.permissionDecision).toBe("deny");
		expect(v.permissionDecisionReason).toBe(fragment(GRANDCHILD));
	});

	it("lets the parent's own dispatch through", () => {
		expect(envelopeOf(dispatch({})).permissionDecision).toBe("allow");
	});
});

// A widened matcher must not rewrite some other tool's input (mantahostels#258).
it("stays out of another tool's input", () => {
	burnOn();
	expectSilent(
		run(HOOK, { tool_name: "SomeOtherTool", tool_input: { model: "sonnet" } }),
	);
});

describe("failing open", () => {
	it("the detached copy still rewrites — the control for the cases below", () => {
		const { hook } = detach();
		expect(JSON.parse(run(hook, dispatch({})).stdout)).toHaveProperty(
			"hookSpecificOutput.updatedInput",
		);
	});

	it.each([
		["the composer", "dispatch-rewrite.js"],
		["the artefact transform", "dispatch-artefact.js"],
	])(
		"leaves the dispatch as written, recorded, when %s is broken",
		(_n, lib) => {
			burnOn();
			const { at, hook } = detach();
			fs.writeFileSync(
				path.join(at, "lib", lib),
				"throw new Error('broken');\n",
			);
			const r = run(hook, dispatch({ model: "sonnet" }));
			expect(r.status).toBe(0);
			expect(r.stdout ?? "").toBe("");
			expect(r.stderr ?? "").toBe("");
			const log = failOpenLogPath(config, project);
			expect(fs.readFileSync(log, "utf8")).toMatch(
				/guard-dispatch-rewrite\.sh\tdispatch-rewrite\.js exited \d+ — dispatch left as written/,
			);
		},
	);

	it("still supplies the line, and records the lost remap, when the burn-mode table is broken", () => {
		burnOn();
		const { at, hook } = detach();
		fs.writeFileSync(
			path.join(at, "lib", "burn-mode.js"),
			"throw new Error('broken');\n",
		);
		const r = run(hook, dispatch({ model: "sonnet" }));
		expect(r.status).toBe(0);
		expect(r.stderr ?? "").toBe("");
		const v = JSON.parse(r.stdout).hookSpecificOutput;
		expect(v.updatedInput.model).toBe("sonnet");
		expect(v.updatedInput.prompt).toMatch(/^Artefact: \//m);
		expect(fs.readFileSync(failOpenLogPath(config, project), "utf8")).toContain(
			"marker path unresolved",
		);
	});

	it("records an unreadable burn-mode table as such", () => {
		burnOn();
		const { at, hook } = detach();
		fs.rmSync(path.join(at, "lib", "burn-mode.js"));
		const r = run(hook, dispatch({ model: "sonnet" }));
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout).hookSpecificOutput.updatedInput.model).toBe(
			"sonnet",
		);
		expect(fs.readFileSync(failOpenLogPath(config, project), "utf8")).toContain(
			"lib/burn-mode.js unreadable",
		);
	});

	it("still supplies the line, and records it, when the artefact directory cannot be made", () => {
		fs.mkdirSync(path.join(project, ".claude", "tmp"), { recursive: true });
		fs.writeFileSync(path.join(project, ".claude", "tmp", "agents"), "");
		const r = run(HOOK, dispatch({}));
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout).hookSpecificOutput.updatedInput.prompt).toMatch(
			/^Artefact: \//m,
		);
		expect(fs.readFileSync(failOpenLogPath(config, project), "utf8")).toContain(
			"artefact directory not made",
		);
	});

	it("still supplies the line, and records the loss, when the burn marker cannot be placed", () => {
		const { HOME: _drop, ...env } = process.env;
		const r = spawnSync(HOOK, [], {
			cwd: project,
			encoding: "utf8",
			input: JSON.stringify(dispatch({ model: "sonnet" })),
			env: {
				...env,
				CLAUDE_CONFIG_DIR: config,
				CLAUDE_PROJECT_DIR: project,
				WFC_BURN_MARKER: "",
			},
		});
		expect(r.status).toBe(0);
		const v = JSON.parse(r.stdout).hookSpecificOutput;
		expect(v.updatedInput.model).toBe("sonnet");
		expect(v.updatedInput.prompt).toMatch(/^Artefact: \//m);
		expect(fs.readFileSync(failOpenLogPath(config, project), "utf8")).toContain(
			"marker path unresolved",
		);
	});
});

describeFailOpenLog({
	guard: HOOK,
	denied: dispatch({}),
	armed: /"updatedInput"/,
	fieldless: { tool_name: "Agent" },
	fieldlessMatch: /no tool_input in payload/,
	benign: dispatch({ prompt: "Artefact: .claude/tmp/x.md" }),
	extraLibs: NODE_LIBS,
	ctx: () => ({ dir, config, project, env: { WFC_BURN_MARKER: marker } }),
});
