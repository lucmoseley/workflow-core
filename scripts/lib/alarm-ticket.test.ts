// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { alarmTicketTender } from "./alarm-ticket.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const ALARM = { name: "queue-wait", run: 1, at: 0, count: 1 };

let markers: string;
beforeEach(() => {
	markers = fs.mkdtempSync(path.join(os.tmpdir(), "alarm-ticket-"));
});
afterEach(() => fs.rmSync(markers, { recursive: true, force: true }));

it("ticks the criterion before closing the ticket once main moves", () => {
	let body = "";
	const calls: string[] = [];
	const tend = alarmTicketTender(
		{
			openIssue: () => (body === "" ? null : { number: 3, labels: [], body }),
			similar: () => [],
			fileIssue: (_args, input) => {
				body = input;
				return { status: 0, stdout: "Filed #3: https://x/3\n", stderr: "" };
			},
			refresh: (n, b) => {
				body = b;
				calls.push(`refresh #${n}`);
				return "refreshed";
			},
			addLabels: () => undefined,
			close: (n, comment) => {
				calls.push(`close #${n}: ${comment}`);
			},
		},
		markers,
	);

	tend({ main: A, alarms: [ALARM] });
	expect(tend({ main: B, alarms: [] })).toEqual(["alarm ticket: closed #3."]);

	expect(calls).toEqual([
		"refresh #3",
		`close #3: \`main\` moved from \`${A}\` to \`${B}\`.`,
	]);
	expect(body).toContain(
		"- [x] The cause is fixed, and `main` moves again or the alarm passes.",
	);
});
