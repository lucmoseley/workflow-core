// @vitest-environment node
/*
 * lib/dispatch-rewrite.js, a PreToolUse dispatcher core (#2791), composes the
 * dispatch transforms into one rewrite (#515). Two rewrites on one call race,
 * the last to finish winning (anthropics/claude-code#83353), so a composition
 * that dropped either change would bring the race back by another route,
 * unseen. A red here means a dispatch either lost a change it was owed — the
 * line or the remap — or was rewritten when it should have been left alone,
 * or a subagent spawned a subagent. It runs on every `Agent`/`Task` dispatch,
 * so a lost `Artefact:` line leaves a stalled agent unseen.
 *
 * The composition's cases call `decide` in process over a fake context — a
 * fixed artefact path, burn mode as given, a recorded `makeDir` — since what
 * it rewrites is a function of the input alone. The core's cases run in
 * process through
 * lib/guard-core-testkit.ts over the production ports
 * (lib/dispatch-rewrite-host.js), the real rule store and a temp project. The
 * burn marker is always WFC_BURN_MARKER here — the real one, at
 * ~/.claude/.burn-mode, is the machine's live switch.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCore } from "./guard-core-testkit";
import { kitContextFake } from "./kit-context-fake";

/* CommonJS, hence the require. */
const core = require("./dispatch-rewrite.js") as {
	decide: (
		prompt: string,
		ctx: Record<string, unknown>,
	) => {
		injectRules: string[];
		skip: string[];
		prelude: string;
		updatedInput?: Record<string, unknown>;
	} | null;
};

const FILE = "/repo/.claude/tmp/agents/d-0badf00d.md";

/**
 * One parent dispatch through `decide`: the fresh artefact path is FILE, burn
 * mode's marker present as `burn` says, and every directory the core makes
 * recorded in `made` — the artefact's, where one was supplied — and every
 * line it logs in `logged`.
 */
function rewrite(input: unknown, { file = FILE, burn = false } = {}) {
	const made: string[] = [];
	const logged: string[] = [];
	const out = core.decide(
		"",
		kitContextFake({
			/* Unchecked: a case may hand the core a malformed input. */
			input: input as Record<string, unknown>,
			env: { WFC_BURN_MARKER: "/burn-marker" },
			artefactFile: () => file,
			makeDir: (at: string) => made.push(at) > 0,
			isFile: () => burn,
			log: (what: string) => logged.push(what),
			ruleText: () => "",
		}),
	);
	return out
		? {
				...out,
				made,
				logged,
				tripped: out.injectRules.filter((id) => !out.skip.includes(id)),
			}
		: null;
}

describe("the composed rewrite", () => {
	it("carries both changes in one updatedInput", () => {
		const out = rewrite(
			{ prompt: "Do it.", description: "d", model: "sonnet" },
			{ file: FILE, burn: true },
		);
		expect(out?.updatedInput).toMatchObject({
			model: "opus",
			description: "d",
			prompt: expect.stringContaining(`Artefact: ${FILE}`),
		});
		expect(out?.prelude).toContain("watch-artefact.js");
		expect(out?.prelude).toContain("from `sonnet` to `opus`");
		expect(out?.made).toEqual([path.dirname(FILE)]);
	});

	it("names no artefact where only the model moved", () => {
		const out = rewrite(
			{ prompt: "Artefact: a/b.md", model: "sonnet" },
			{ file: FILE, burn: true },
		);
		expect(out?.made).toEqual([]);
	});

	it("leaves the model alone while burn mode is off", () => {
		const out = rewrite(
			{ prompt: "x", model: "sonnet" },
			{ file: FILE, burn: false },
		);
		expect(out?.updatedInput).toMatchObject({ model: "sonnet" });
	});

	it("tells the watch on a prompt's own artefact, changing nothing (#2013)", () => {
		const out = rewrite(
			{ prompt: "Artefact: a/b.md", model: "opus" },
			{ file: FILE, burn: true },
		);
		expect(out).not.toHaveProperty("updatedInput");
		expect(out?.prelude).toContain("This dispatch names its artefact: a/b.md.");
		expect(out?.prelude).toContain("watch-artefact.js a/b.md 120");
	});

	it("tells an agent with no artefact to watch to end the turn", () => {
		const out = rewrite(
			{ prompt: "Find it.", subagent_type: "Explore" },
			{ file: FILE, burn: false },
		);
		expect(out?.prelude).toMatch(/^While this agent runs, end the turn/);
	});

	it.each([
		[
			"a tier the guide routes away from",
			{ model: "haiku" },
			["dispatch-tier"],
		],
		[
			"a tracker-less search of the repo",
			{ prompt: "Search the repo for it." },
			["dispatch-search-tracker"],
		],
		["neither", { model: "sonnet" }, []],
	])("names the rules %s trips", (_n, call, rules) => {
		const out = rewrite(
			{ prompt: "Do it.", ...call },
			{ file: FILE, burn: false },
		);
		expect(out?.tripped).toEqual(rules);
	});

	it("judges the tier as asked, before burn mode's remap", () => {
		const out = rewrite(
			{ prompt: "Do it.", model: "sonnet" },
			{ file: FILE, burn: true },
		);
		expect(out?.tripped).toEqual([]);
	});

	it.each([
		["a non-object", "x"],
		["null", null],
	])("is null for %s", (_n, input) => {
		expect(rewrite(input, { file: FILE, burn: true })).toBeNull();
	});
});

/** The watch the context hands the session for an artefact supplied at `file`. */
const watchCommand = (file: string) =>
	/backgrounded `([^`]+)`/.exec(
		String(rewrite({ prompt: "Do it." }, { file })?.prelude),
	)?.[1] ?? expect.fail("the context names no backgrounded watch");

describe("the watch command", () => {
	it("names the watcher that ships beside this file", () => {
		const watcher = String(
			/^node '?(.*?)'? \S+ 120$/.exec(watchCommand(FILE))?.[1],
		);
		expect(path.basename(watcher)).toBe("watch-artefact.js");
		expect(fs.existsSync(watcher)).toBe(true);
	});

	// The watcher's own path is the checkout's, quoted or not, so only the
	// artefact's half is pinned.
	it("leaves a plain path bare", () => {
		expect(watchCommand(FILE).endsWith(` ${FILE} 120`)).toBe(true);
	});

	it("quotes a path a shell would split, apostrophe included", () => {
		expect(
			watchCommand("/my repo/it's.md").endsWith(` '/my repo/it'\\''s.md' 120`),
		).toBe(true);
	});
});

/* ---- the core, through the dispatcher ---- */

let dir: string;
let project: string;
let marker: string;
let logs: string[];

beforeEach(() => {
	dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-rewrite-")),
	);
	project = path.join(dir, "project");
	fs.mkdirSync(project);
	marker = path.join(dir, "burn-mode");
	logs = [];
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const dispatch = (input: Record<string, unknown>) => ({
	tool_name: "Agent",
	session_id: "s1",
	tool_input: { prompt: "Do the work.", description: "do a thing", ...input },
});

const run = (
	payload: Record<string, unknown>,
	env: Record<string, string> = { WFC_BURN_MARKER: marker },
) => {
	const r = runCore("guard-dispatch-rewrite", payload, { root: project, env });
	logs.push(...r.logs);
	return r.output;
};

interface HookOut {
	permissionDecision?: string;
	permissionDecisionReason?: string;
	additionalContext?: string;
	updatedInput: Record<string, string>;
}

/** The hook output a dispatch gets; it must say something. */
const envelopeOf = (payload: Record<string, unknown>) => {
	const out = run(payload);
	expect(out).not.toBeNull();
	return out as unknown as HookOut;
};

const burnOn = () => fs.writeFileSync(marker, "");

const FRAGMENTS: Record<string, string> = {
	"dispatch-tier": path.resolve(
		__dirname,
		"../../docs/agents/rules/dispatch-tier.txt",
	),
	"dispatch-search-tracker": path.resolve(
		__dirname,
		"../../docs/agents/rules/dispatch-search-tracker.txt",
	),
	"dispatch-grandchild": path.resolve(
		__dirname,
		"../../docs/agents/rules/dispatch-grandchild.txt",
	),
};
const readFragment = (id: string) =>
	fs.readFileSync(FRAGMENTS[id] as string, "utf8").trimEnd();

describe("the artefact line", () => {
	it("is supplied where the prompt names none, and the session told the path and the check", () => {
		const v = envelopeOf(dispatch({}));
		expect(v.permissionDecision).toBe("allow");
		const m = /^Artefact: (\S+)$/m.exec(v.updatedInput.prompt);
		expect(m).not.toBeNull();
		const file = m?.[1] as string;
		expect(file.startsWith(`${project}/.claude/tmp/agents/do-a-thing-`)).toBe(
			true,
		);
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

describe("burn mode, in the same rewrite", () => {
	// Two hooks each rewriting the call raced, the last winning
	// (anthropics/claude-code#83353); one rewrite is what #515 built to stop it.
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
		const v = envelopeOf({
			tool_name: "Task",
			tool_input: { model: "sonnet", prompt: "Artefact: a/b.md" },
		});
		expect(v.updatedInput.model).toBe("opus");
	});
});

describe("the dispatch rules, printed at the call (#2013)", () => {
	it("hands over the effort guide rule whole on a tier it routes away from, once a session", () => {
		const first = envelopeOf(dispatch({ model: "haiku" }));
		expect(first.additionalContext).toContain("This dispatch names `haiku`");
		expect(first.additionalContext).toContain(readFragment("dispatch-tier"));
		const again = envelopeOf(dispatch({ model: "haiku" }));
		expect(again.additionalContext).toContain("This dispatch names `haiku`");
		expect(again.additionalContext).not.toContain(
			readFragment("dispatch-tier"),
		);
	});

	it("hands over the tracker rule whole on a search of the repo that names none", () => {
		const v = envelopeOf(
			dispatch({ prompt: "Search the repo for the figure." }),
		);
		expect(v.additionalContext).toContain(
			"This prompt asks for a search of the repo and names no tracker.",
		);
		expect(v.additionalContext).toContain(
			readFragment("dispatch-search-tracker"),
		);
	});

	it("prints neither off its trigger", () => {
		const v = envelopeOf(
			dispatch({
				model: "sonnet",
				prompt: "Search the repo and the tracker for the figure.",
			}),
		);
		expect(v.additionalContext).not.toContain(readFragment("dispatch-tier"));
		expect(v.additionalContext).not.toContain(
			readFragment("dispatch-search-tracker"),
		);
	});

	it("puts the notes first, then each tripped rule in turn", () => {
		const v = envelopeOf(
			dispatch({ model: "haiku", prompt: "Search the repo for the figure." }),
		);
		const notes = rewrite(
			{
				prompt: v.updatedInput.prompt.split("\nArtefact:")[0],
				description: "do a thing",
				model: "haiku",
			},
			{
				file: /^Artefact: (\S+)$/m.exec(v.updatedInput.prompt)?.[1] ?? "",
				burn: false,
			},
		)?.prelude;
		expect(v.additionalContext).toBe(
			`${notes}\n\n${readFragment("dispatch-tier")}\n\n${readFragment("dispatch-search-tracker")}`,
		);
	});

	it("denies a dispatch from inside a subagent, with the rule whole", () => {
		const v = envelopeOf({ ...dispatch({}), agent_id: "a1" });
		expect(v.permissionDecision).toBe("deny");
		expect(v.permissionDecisionReason).toBe(
			readFragment("dispatch-grandchild"),
		);
	});

	it("lets the parent's own dispatch through", () => {
		expect(envelopeOf(dispatch({})).permissionDecision).toBe("allow");
	});
});

// A widened matcher must not rewrite some other tool's input (mantahostels#258).
it("stays out of another tool's input", () => {
	burnOn();
	expect(
		run({ tool_name: "SomeOtherTool", tool_input: { model: "sonnet" } }),
	).toBeNull();
});

/** Swap lib/burn-mode.js in the module cache for one whose table throws `e`. */
function breakBurnMode(e: Error & { code?: string }) {
	const req = createRequire(__filename);
	const id = req.resolve("./burn-mode.js");
	const saved = req.cache[id];
	req.cache[id] = {
		id,
		filename: id,
		loaded: true,
		exports: new Proxy(
			{},
			{
				get() {
					throw e;
				},
			},
		),
	} as unknown as NodeJS.Module;
	return () => {
		if (saved) req.cache[id] = saved;
		else delete req.cache[id];
	};
}

describe("failing open", () => {
	it("leaves the dispatch as written, recorded, when a transform throws", () => {
		const input: Record<string, unknown> = { prompt: "Do it." };
		Object.defineProperty(input, "model", {
			enumerable: true,
			get() {
				throw new Error("broken");
			},
		});
		expect(
			run({ tool_name: "Agent", session_id: "s1", tool_input: input }),
		).toBeNull();
		expect(logs).toContain(
			"dispatch rewrite threw — dispatch left as written: broken",
		);
	});

	it("still supplies the line, and records the lost remap, when the burn-mode table is broken", () => {
		burnOn();
		const restore = breakBurnMode(new Error("broken"));
		let v: HookOut;
		try {
			v = envelopeOf(dispatch({ model: "sonnet" }));
		} finally {
			restore();
		}
		expect(v.updatedInput.model).toBe("sonnet");
		expect(v.updatedInput.prompt).toMatch(/^Artefact: \//m);
		expect(logs).toContain(
			"burn-mode marker path unresolved — burn mode left this dispatch unmapped",
		);
	});

	it("records an unreadable burn-mode table as such", () => {
		burnOn();
		const restore = breakBurnMode(
			Object.assign(new Error("gone"), { code: "MODULE_NOT_FOUND" }),
		);
		let v: HookOut;
		try {
			v = envelopeOf(dispatch({ model: "sonnet" }));
		} finally {
			restore();
		}
		expect(v.updatedInput.model).toBe("sonnet");
		expect(logs).toContain(
			"lib/burn-mode.js unreadable — burn mode left this dispatch unmapped",
		);
	});

	it("still supplies the line, and records it, when the artefact directory cannot be made", () => {
		fs.mkdirSync(path.join(project, ".claude", "tmp"), { recursive: true });
		fs.writeFileSync(path.join(project, ".claude", "tmp", "agents"), "");
		const v = envelopeOf(dispatch({}));
		expect(v.updatedInput.prompt).toMatch(/^Artefact: \//m);
		expect(logs).toContain(
			"artefact directory not made — the agent's first shell append will fail",
		);
	});

	it("still supplies the line, and records the loss, when the burn marker cannot be placed", () => {
		const out = run(dispatch({ model: "sonnet" }), {}) as unknown as HookOut;
		expect(out.updatedInput.model).toBe("sonnet");
		expect(out.updatedInput.prompt).toMatch(/^Artefact: \//m);
		expect(logs).toContain(
			"burn-mode marker path unresolved — burn mode left this dispatch unmapped",
		);
	});

	it("leaves a payload with no prompt alone, recorded", () => {
		expect(run({ tool_name: "Agent", session_id: "s1" })).toBeNull();
		expect(logs).toContain(
			"no prompt in payload — agent dispatch allowed unchecked",
		);
	});
});

describe("the cases a mutant must not survive (#2791)", () => {
	it("denies a subagent's Task dispatch that names its own artefact", () => {
		const v = envelopeOf({
			tool_name: "Task",
			session_id: "s1",
			agent_id: "abc",
			tool_input: { prompt: "Artefact: a/b.md" },
		});
		expect(v.permissionDecision).toBe("deny");
	});

	it("reads an empty agent_id as the parent's", () => {
		const v = envelopeOf({ ...dispatch({}), agent_id: "" });
		expect(v.permissionDecision).toBe("allow");
	});

	it("reads the marker as present only where it is a file", () => {
		fs.mkdirSync(marker);
		const v = envelopeOf(dispatch({ model: "sonnet" }));
		expect(v.updatedInput.model).toBe("sonnet");
	});

	it("latches a rule only once it is said, so the other is still owed", () => {
		envelopeOf(dispatch({ model: "haiku" }));
		const v = envelopeOf(
			dispatch({ model: "haiku", prompt: "Search the repo for the figure." }),
		);
		expect(v.additionalContext).not.toContain(readFragment("dispatch-tier"));
		expect(v.additionalContext).toContain(
			readFragment("dispatch-search-tracker"),
		);
	});
});
