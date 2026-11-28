// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isUntrusted } from "./workspace-trust.js";

describe("a seat's trust in a launch dir (#5918)", () => {
	let seat: string;
	beforeEach(() => {
		seat = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-trust-"));
	});
	afterEach(() => fs.rmSync(seat, { recursive: true, force: true }));
	const seed = (projects: unknown) =>
		fs.writeFileSync(
			path.join(seat, ".claude.json"),
			JSON.stringify({ projects }),
		);

	it("takes trust in the repo root as trust in its worktrees", () => {
		seed({ "/home/u/repo": { hasTrustDialogAccepted: true } });
		expect(isUntrusted(seat, "/home/u/repo")).toBe(false);
		expect(isUntrusted(seat, "/home/u/repo/.claude/worktrees/w-1")).toBe(false);
	});

	it("calls a dir untrusted where no ancestor is, a declined one included", () => {
		seed({
			"/home/u/other": { hasTrustDialogAccepted: true },
			"/home/u/repo": { hasTrustDialogAccepted: false },
		});
		expect(isUntrusted(seat, "/home/u/repo")).toBe(true);
		expect(isUntrusted(seat, "/home/u/repository")).toBe(true);
	});

	it("holds nothing where the seat's file is absent, torn or keeps no project map", () => {
		expect(isUntrusted(seat, "/home/u/repo")).toBe(false);
		fs.writeFileSync(path.join(seat, ".claude.json"), "{");
		expect(isUntrusted(seat, "/home/u/repo")).toBe(false);
		fs.writeFileSync(path.join(seat, ".claude.json"), "{}");
		expect(isUntrusted(seat, "/home/u/repo")).toBe(false);
	});

	it("takes trust stored under a symlinked dir's real path", () => {
		const real = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-trust-real-"));
		const link = path.join(seat, "link");
		fs.symlinkSync(real, link);
		seed({ [fs.realpathSync(real)]: { hasTrustDialogAccepted: true } });
		try {
			expect(isUntrusted(seat, link)).toBe(false);
		} finally {
			fs.rmSync(real, { recursive: true, force: true });
		}
	});
});
