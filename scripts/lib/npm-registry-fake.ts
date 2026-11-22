import fs from "node:fs";
import path from "node:path";
import type { Call } from "./npm-install.js";
import { shellQuote } from "./sh-quote.js";

export type { Call } from "./npm-install.js";

export interface Registry {
	created: string;
	downloads: number | "FAIL" | "MISSING";
	viewOut?: string;
	viewStatus?: number | null;
	dlOut?: string;
	dlStatus?: number | null;
}

export const buildPassingRegistry = (now: number): Registry => ({
	created: new Date(now - 4000 * 86_400_000).toISOString(),
	downloads: 9_000_000,
});

const buildNpmError = (code: string, summary: string, detail: string) =>
	`${JSON.stringify({ error: { code, summary, detail } }, null, 2)}\n`;

function npmViewMode(created: string): Call {
	if (created === "MISSING") return { missing: true };
	if (created === "E404")
		return {
			status: 1,
			stdout: buildNpmError(
				"E404",
				"Not Found - GET https://registry.example/the-package - Not found",
				"The requested resource 'the-package@*' could not be found.",
			),
		};
	if (created === "FAIL")
		return {
			status: 1,
			stdout: buildNpmError(
				"ECONNREFUSED",
				"FetchError: request to https://registry.example/the-package failed",
				"If you are behind a proxy, please make sure that the 'proxy' config is set properly.",
			),
		};
	return { status: 0, stdout: `"${created}"\n` };
}

function downloadsMode(downloads: Registry["downloads"]): Call {
	if (downloads === "MISSING") return { missing: true };
	if (downloads === "FAIL") return { status: 7, stdout: "" };
	return {
		status: 0,
		stdout: JSON.stringify({
			downloads,
			start: "2026-01-01",
			end: "2026-01-30",
			package: "the-package",
		}),
	};
}

const overridden = (
	call: Call,
	status: number | null | undefined,
	stdout: string | undefined,
): Call =>
	"missing" in call
		? call
		: {
				status: status === undefined ? call.status : status,
				stdout: stdout ?? call.stdout,
			};

export const npmViewAnswer = (reg: Registry): Call =>
	overridden(npmViewMode(reg.created), reg.viewStatus, reg.viewOut);

export const downloadsAnswer = (reg: Registry): Call =>
	overridden(downloadsMode(reg.downloads), reg.dlStatus, reg.dlOut);

export function writeRegistryStubs(dir: string) {
	fs.mkdirSync(dir, { recursive: true });
	const buildStubScript = (name: string, tool: string, extra = "") =>
		`#!/usr/bin/env bash
echo ${shellQuote(`${tool} `)}"$*" >> "$STUB_CALLS"
${extra}printf '%s' "$STUB_${name}_OUT"
exit "$STUB_${name}_STATUS"
`;
	for (const [name, tool, extra] of [
		["NPM", "npm", `echo "noise on stderr" >&2\n`],
		["CURL", "curl", ""],
	] as const) {
		const file = path.join(dir, tool);
		fs.writeFileSync(file, buildStubScript(name, tool, extra));
		fs.chmodSync(file, 0o755);
	}
	const buildServedEnv = (
		name: string,
		tool: string,
		call: Call,
	): NodeJS.ProcessEnv =>
		"missing" in call
			? { [`WFC_${name}`]: path.join(dir, `no-such-${tool}`) }
			: {
					[`WFC_${name}`]: path.join(dir, tool),
					[`STUB_${name}_OUT`]: call.stdout,
					[`STUB_${name}_STATUS`]: String(call.status),
				};
	return (reg: Registry): NodeJS.ProcessEnv => ({
		...buildServedEnv("NPM", "npm", npmViewAnswer(reg)),
		...buildServedEnv("CURL", "curl", downloadsAnswer(reg)),
	});
}
