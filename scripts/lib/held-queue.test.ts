// @vitest-environment node
/*
 * The held-queue issue closed once `main` holds its batch (#3636).
 *
 * Loosen it and the issue closes while its batch is still held, or never.
 */
import { expect, it } from "vitest";
import { heldQueueFiler } from "./held-queue.js";

const B = "b".repeat(40);
const C = "c".repeat(40);

const release = (body: string, held: string[]) => {
	const closed: string[] = [];
	const line = heldQueueFiler({
		openIssue: () => ({ number: 9, labels: [], body }),
		similar: () => [],
		fileIssue: () => ({ status: 0, stdout: "", stderr: "" }),
		refresh: () => "",
		addLabels: () => undefined,
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
