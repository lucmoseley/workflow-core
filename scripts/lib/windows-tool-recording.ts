import fs from "node:fs";
import { expect, it } from "vitest";

export interface ToolAnswer {
	argv?: string[];
	status: number | null;
	stdout: string;
	stderr: string;
}

export interface Recording<R> {
	recordedBy: string;
	responses: R;
}

export const readRecording = <R>(file: string): Recording<R> =>
	JSON.parse(fs.readFileSync(file, "utf8"));

export const itNamesItsRecorder = (r: Recording<unknown>, tool: string) =>
	it("names the command that re-records it", () => {
		expect(r.recordedBy).toBe(`node scripts/record-windows-tools.js ${tool}`);
	});
