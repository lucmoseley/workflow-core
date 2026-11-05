// @vitest-environment node
/*
 * The held-queue issue closed once `main` holds its batch (#3636), and naming
 * each fix ticket still owed (#3777).
 *
 * Loosen it and the issue closes while its batch is still held, or never, or
 * says nothing of a ticket only the heartbeat then records.
 */
import { expect, it } from "vitest";
import { heldQueueFiler } from "./held-queue.js";
import type { FixTicket } from "./lander.js";

const B = "b".repeat(40);
const C = "c".repeat(40);

const filer = (
	deps: Partial<Parameters<typeof heldQueueFiler>[0]>,
): ReturnType<typeof heldQueueFiler> =>
	heldQueueFiler({
		openIssue: () => null,
		similar: () => [],
		fileIssue: () => ({ status: 0, stdout: "", stderr: "" }),
		refresh: () => "",
		addLabels: () => undefined,
		close: () => undefined,
		...deps,
	});

const release = (body: string, held: string[]) => {
	const closed: string[] = [];
	const line = filer({
		openIssue: () => ({ number: 9, labels: [], body }),
		close: (_, comment) => {
			closed.push(comment);
		},
	}).releaseQueue(C, (batch) => held.includes(batch));
	return { line, closed };
};

it("closes the issue once main holds its batch, naming the sha main moved to", () => {
	const r = release(`- Batch: \`${B}\`\n`, [B]);

	expect(r.line).toBe("held-queue issue: closed #9.");
	expect(r.closed).toEqual([
		`The lander moved \`main\` to \`${C}\`, past the held batch \`bbbbbbbbb\`.`,
	]);
});

it("leaves the issue open while main does not hold its batch", () => {
	const r = release(`- Batch: \`${B}\`\n`, []);

	expect(r.line).toBeNull();
	expect(r.closed).toEqual([]);
});

it("closes a body naming no batch on any move of main", () => {
	const r = release("- Batch: (none read)\n", []);

	expect(r.closed).toEqual([`The lander moved \`main\` to \`${C}\`.`]);
});

it("names on the issue each fix ticket still owed, and none where none is", () => {
	const filed = (owed: FixTicket[]) => {
		const bodies: string[] = [];
		filer({
			fileIssue: (_, body) => {
				bodies.push(body);
				return { status: 0, stdout: "Filed #9: https://x/9", stderr: "" };
			},
		}).holdQueue({ batch: B, reason: "r", failing: null, owed });
		return bodies[0];
	};
	const ticket = {
		culprit: B,
		parent: null,
		revert: C,
		files: [],
		jobs: [],
		stale: null,
	};

	expect(filed([ticket])).toContain("- `bbbbbbbbb`, reverted in `ccccccccc`");
	expect(filed([ticket])).toContain(
		"- [ ] Each fix ticket named above is filed.",
	);
	expect(filed([])).not.toMatch(/fix ticket/i);
});
