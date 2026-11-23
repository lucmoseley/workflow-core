// @vitest-environment node
import { describe, expect, it } from "vitest";

const { judgeCut } = require("./release-due.js");

const file = (version: string, body: string) => ({
	note: `migrations/${version}.md`,
	version,
	text: `# ${version}\n\n## Manual steps\n\n${body}`,
});

describe("judgeCut", () => {
	it("is due where a note newer than the tag owes steps, naming each note and its act and choice count", () => {
		const v = judgeCut({
			tag: "v1.0.0",
			notes: [
				file("v1.1.0", "- [act] One.\n- [choice] Two.\n- [notice] Three.\n"),
				file("v1.2.0", "- [act] One.\n"),
			],
		});
		expect(v.due).toBe(true);
		expect(v.why).toContain(
			"migrations/v1.1.0.md (2), migrations/v1.2.0.md (1)",
		);
	});

	it("passes over the tag's own note and older ones, however many steps they owe", () => {
		const v = judgeCut({
			tag: "v1.0.0",
			notes: [
				file("v0.9.0", "- [act] Old.\n"),
				file("v1.0.0", "- [act] Cut.\n"),
			],
		});
		expect(v.due).toBe(false);
	});

	it("is not due where a newer note carries only notices", () => {
		const v = judgeCut({
			tag: "v1.0.0",
			notes: [file("v1.1.0", "- [notice] Only.\n")],
		});
		expect(v.due).toBe(false);
		expect(v.why).toContain("no migration note newer than v1.0.0");
	});

	it("is due on a trigger a session names, whatever the notes say", () => {
		const v = judgeCut({ tag: "v1.0.0", notes: [] }, "v1.0.0 breaks start");
		expect(v).toEqual({ due: true, why: "v1.0.0 breaks start" });
	});
});
