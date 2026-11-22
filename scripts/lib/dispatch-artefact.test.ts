// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	artefactFile,
	buildWatchNote,
	injectArtefact,
} from "./dispatch-artefact";

const FILE = "/repo/.claude/tmp/agents/do-a-thing-0badf00d.md";
const watch = (f: string, job = false) => `watch ${f}${job ? " --job" : ""}`;
const READ_LINE =
	"Save a long fetched or local source to disk and search it, rather than reading it whole into your context.";
const ARTEFACT_INSTRUCTIONS = `Append your findings to that file as each one lands; never hold them back for the final report.\n${READ_LINE}`;

const given = (prompt: string) =>
	(injectArtefact({ prompt }, FILE, watch)?.input.prompt as
		| string
		| undefined) ?? null;

const kept = (prompt: string) => given(prompt) === null;

describe("a usable marker — the shapes that comply", () => {
	it("accepts the plain form", () => {
		expect(kept("Artefact: docs/research/x.md")).toBe(true);
	});

	it("accepts it anywhere in a multi-line prompt", () => {
		const prompt = [
			"Search the tracker for prior art on rate limits.",
			"",
			"Artefact: .claude/tmp/findings.md",
			"",
			"Append each finding as it lands.",
		].join("\n");
		expect(kept(prompt)).toBe(true);
	});

	it("accepts markdown bold, which is how the repo's own prompts read", () => {
		expect(kept("**Artefact:** /tmp/a.md")).toBe(true);
		expect(kept("**Artefact**: /tmp/a.md")).toBe(true);
	});

	it("accepts a list bullet", () => {
		expect(kept("- Artefact: /tmp/a.md")).toBe(true);
		expect(kept("* Artefact: /tmp/a.md")).toBe(true);
	});

	it("accepts a backticked path", () => {
		expect(kept("Artefact: `docs/notes/a.md`")).toBe(true);
	});

	it("accepts indentation", () => {
		expect(kept("    Artefact: docs/a.md")).toBe(true);
	});

	it("accepts the US spelling and any case", () => {
		expect(kept("Artifact: docs/a.md")).toBe(true);
		expect(kept("artefact: docs/a.md")).toBe(true);
		expect(kept("ARTEFACT: docs/a.md")).toBe(true);
	});

	it("accepts a CRLF transcript", () => {
		expect(kept("do the thing\r\nArtefact: docs/a.md\r\n")).toBe(true);
	});

	it("accepts a bare filename carrying an extension", () => {
		expect(kept("Artefact: findings.md")).toBe(true);
	});
});

describe("a usable marker — the shapes that do not", () => {
	it("refuses a prompt with no marker at all", () => {
		expect(kept("Review the diff at docs/a.md and report back.")).toBe(false);
	});

	it("refuses the word mid-sentence", () => {
		expect(kept("Write the Artefact: docs/a.md when done")).toBe(false);
	});

	it("refuses an empty value", () => {
		expect(kept("Artefact:")).toBe(false);
		expect(kept("Artefact:   ")).toBe(false);
	});

	it("refuses an unfilled placeholder", () => {
		expect(kept("Artefact: <path>")).toBe(false);
		expect(kept("Artefact: <artefact>")).toBe(false);
		expect(kept("Artefact: TBD")).toBe(false);
		expect(kept("Artefact: none")).toBe(false);
		expect(kept("Artefact: N/A")).toBe(false);
	});

	it("refuses a value that is not path-like", () => {
		expect(kept("Artefact: a report of the findings")).toBe(false);
	});
});

describe("the marker's value", () => {
	it("may be backticked, quoted or bold", () => {
		expect(kept("Artefact: `docs/a.md`")).toBe(true);
		expect(kept('Artefact: "docs/a.md"')).toBe(true);
		expect(kept("**Artefact:** docs/a.md")).toBe(true);
	});

	it("is the path up to a trailing clause", () => {
		expect(kept("Artefact: /tmp/a.md, appended as you go")).toBe(true);
	});
});

describe("the prompt given a line", () => {
	it("leaves a usable marker exactly as written", () => {
		expect(given("Do it.\nArtefact: .claude/tmp/x.md")).toBeNull();
	});

	it("appends the line and the instruction where there is no marker", () => {
		expect(given("Do it.\n\n")).toBe(
			`Do it.\n\nArtefact: ${FILE}\n${ARTEFACT_INSTRUCTIONS}\n`,
		);
	});

	it.each([
		["TBD", "Artefact: TBD"],
		["an angle-bracket template", "Artefact: <path>"],
		["none", "Artefact: none"],
		["a multi-word template", "Artefact: <path to file>"],
	])("replaces %s in place rather than adding a second line", (_n, line) => {
		const out = given(`Do it.\n${line}\nThen report.`);
		expect(out).toBe(
			`Do it.\nArtefact: ${FILE}\n${ARTEFACT_INSTRUCTIONS}\nThen report.`,
		);
		expect(kept(out as string)).toBe(true);
	});

	it("keeps the bullet, the bold and the trailing clause of a replaced line", () => {
		expect(given("- **Artefact:** <path>, appended as you go")).toBe(
			`- **Artefact:** ${FILE}, appended as you go\n${ARTEFACT_INSTRUCTIONS}`,
		);
	});

	it("appends rather than fill an empty marker", () => {
		const out = given("Artefacts:\n- a.md\n- b.md");
		expect(out?.startsWith("Artefacts:\n- a.md\n- b.md\n")).toBe(true);
		expect(out).toContain(`\nArtefact: ${FILE}\n${ARTEFACT_INSTRUCTIONS}\n`);
	});

	it("appends rather than overwrite a marker whose value is prose", () => {
		const out = given("Artifacts: the three files below\n- a");
		expect(out?.startsWith("Artifacts: the three files below\n- a\n")).toBe(
			true,
		);
		expect(out).toContain(`\nArtefact: ${FILE}\n${ARTEFACT_INSTRUCTIONS}\n`);
	});
});

describe("the reading instruction (#1789)", () => {
	const count = (s: string | null) => (s ?? "").split(READ_LINE).length - 1;

	it.each([
		["an appended line", "Do it."],
		["a replaced placeholder", "Do it.\nArtefact: TBD\nThen report."],
	])("rides %s exactly once", (_n, prompt) => {
		expect(count(given(prompt))).toBe(1);
	});

	it("adds nothing to a prompt whose marker is already usable", () => {
		expect(given("Read the chapters.\nArtefact: .claude/tmp/x.md")).toBeNull();
	});
});

describe("injectArtefact — the transform over one Agent call", () => {
	it("carries every other field through and tells the path and the check", () => {
		const out = injectArtefact(
			{ prompt: "Do it.", description: "d", model: "sonnet" },
			FILE,
			watch,
		);
		expect(out?.input).toMatchObject({ description: "d", model: "sonnet" });
		expect(out?.input.prompt).toBe(
			`Do it.\n\nArtefact: ${FILE}\n${ARTEFACT_INSTRUCTIONS}\n`,
		);
		expect(out?.note).toContain(FILE);
		expect(out?.note).toContain(`\`watch ${FILE}\``);
	});

	it("gives a fork the line too", () => {
		expect(
			injectArtefact({ prompt: "Do it.", subagent_type: "fork" }, FILE, watch),
		).not.toBeNull();
	});

	it("gives a remote dispatch the line (#5521)", () => {
		expect(
			injectArtefact({ prompt: "Do it.", isolation: "remote" }, FILE, watch),
		).not.toBeNull();
	});

	it.each([
		["a usable marker", { prompt: "Artefact: .claude/tmp/x.md" }],
		[
			"an agent type with no file-writing tool",
			{ prompt: "Do it.", subagent_type: "statusline-setup" },
		],
		[
			"web-fetch, which has no tool that can create a file (#5496)",
			{ prompt: "Do it.", subagent_type: "web-fetch" },
		],
		[
			"Explore, read-only by its own instructions (#565)",
			{ prompt: "Do it.", subagent_type: "Explore" },
		],
		[
			"Plan, read-only by its own instructions (#565)",
			{ prompt: "Do it.", subagent_type: "Plan" },
		],
		["no prompt", { description: "d" }],
		["a blank prompt", { prompt: "  " }],
		["a non-string prompt", { prompt: 42 }],
	])("is null for %s", (_n, call) => {
		expect(injectArtefact(call, FILE, watch)).toBeNull();
	});
});

describe("buildWatchNote — a prompt that names its own artefact (#2013)", () => {
	it("names that file and the watch on it", () => {
		const note = buildWatchNote(
			{ prompt: "Do it.\nArtefact: .claude/tmp/x.md" },
			watch,
		);
		expect(note).toContain(
			"This dispatch names its artefact: .claude/tmp/x.md.",
		);
		expect(note).toContain("`watch .claude/tmp/x.md`");
		expect(note).toContain("then end the turn");
		expect(note).toContain("A `DONE` means the agent has stopped");
	});

	it("holds a background job's turn on the watch, backgrounded while work remains and foreground once idle (#5496, #5554)", () => {
		const note = buildWatchNote(
			{ prompt: "Artefact: .claude/tmp/x.md" },
			watch,
			undefined,
			true,
		);
		expect(note).toContain("hold the turn on `watch .claude/tmp/x.md --job`");
		expect(note).toContain(
			"Run it with `run_in_background` while other work remains, in the foreground once idle, as `rule:job-holds-turn` says (#5554).",
		);
		expect(note).not.toContain("end the turn");
	});

	it("watches a remote dispatch's named artefact (#5521)", () => {
		expect(
			buildWatchNote(
				{ prompt: "Artefact: .claude/tmp/x.md", isolation: "remote" },
				watch,
			),
		).toContain("This dispatch names its artefact: .claude/tmp/x.md.");
	});

	it.each([
		["a prompt naming none", { prompt: "Do it." }],
		["Explore", { prompt: "Artefact: a/b.md", subagent_type: "Explore" }],
	])("is null for %s", (_n, call) => {
		expect(buildWatchNote(call, watch)).toBeNull();
	});
});

describe("artefactFile — where a supplied artefact lives", () => {
	it("is absolute, under .claude/tmp/agents/, named from the description", () => {
		expect(artefactFile("/repo", "Review the PR #12!", "0badf00d")).toBe(
			"/repo/.claude/tmp/agents/review-the-pr-12-0badf00d.md",
		);
	});

	it("falls back to `agent` where the description gives no slug", () => {
		expect(artefactFile("/repo", undefined, "0badf00d")).toBe(
			"/repo/.claude/tmp/agents/agent-0badf00d.md",
		);
	});

	it("draws a different id each call", () => {
		expect(artefactFile("/repo", "d")).not.toBe(artefactFile("/repo", "d"));
	});
});
