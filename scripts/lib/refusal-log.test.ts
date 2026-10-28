// @vitest-environment node
/*
 * refusal-log.test.ts — the refusal limbs' log writer (#1101, #1753). A plain temp directory stands in for a repo root,
 * named `mantahostels` so the line's repo field is checkable; the writer
 * needs no git.
 *
 * The `Stop` hook guard-priced-options.js writes these logs and the
 * close-check and round-check reporters count them, so a loosened case lets a
 * lost or misnamed line skew either reading.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsonl } from "./jsonl";
import { CLOSE_CHECK_LOG } from "./priced-options-limbs";
import { appendEvents, logPath } from "./refusal-log";

let root: string;

beforeEach(() => {
	root = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "refusal-log-")),
		"mantahostels",
	);
});

afterEach(() => {
	fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

const read = () => readJsonl(logPath(root, CLOSE_CHECK_LOG))?.rows;

describe("appendEvents", () => {
	it("appends one line per event, naming the repo by its root and keeping a given time", () => {
		appendEvents(
			root,
			[
				{
					at: "2026-10-01T00:00:00.000Z",
					session: "s1",
					round: "1",
					kind: "refused",
					pair: null,
					slot: 1,
				},
			],
			CLOSE_CHECK_LOG,
		);
		appendEvents(
			root,
			[{ session: "s1", round: "1", kind: "passed-unreadable", pair: null }],
			CLOSE_CHECK_LOG,
		);
		expect(read()).toEqual([
			{
				at: "2026-10-01T00:00:00.000Z",
				session: "s1",
				repo: "mantahostels",
				round: "1",
				kind: "refused",
				pair: null,
				slot: 1,
			},
			{
				at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
				session: "s1",
				repo: "mantahostels",
				round: "1",
				kind: "passed-unreadable",
				pair: null,
			},
		]);
	});

	it("writes nothing for no events", () => {
		appendEvents(root, [], CLOSE_CHECK_LOG);
		expect(fs.existsSync(logPath(root, CLOSE_CHECK_LOG))).toBe(false);
	});

	it("writes each store apart, leaving the close-check log alone (#1710)", () => {
		appendEvents(
			root,
			[{ session: "s1", round: "1", kind: "passed-unrefused" }],
			".other-log.jsonl",
		);
		expect(readJsonl(logPath(root, ".other-log.jsonl"))?.rows).toEqual([
			expect.objectContaining({ kind: "passed-unrefused" }),
		]);
		expect(fs.existsSync(logPath(root, CLOSE_CHECK_LOG))).toBe(false);
	});

	it("lives in the markers directory", () => {
		expect(logPath(root, CLOSE_CHECK_LOG)).toBe(
			path.join(root, ".claude", "tmp", "markers", ".close-check-log.jsonl"),
		);
	});
});
