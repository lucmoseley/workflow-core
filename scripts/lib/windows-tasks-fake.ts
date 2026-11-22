/* #5497 */
import fs from "node:fs";
import path from "node:path";

const IMAGE = "Testlimit64.exe";

const NO_TASKS =
	"INFO: No tasks are running which match the specified criteria.";

export function writeWindowsTasks(dir: string, { denied = false } = {}) {
	fs.mkdirSync(dir, { recursive: true });
	const files = {
		args: path.join(dir, "testlimit.args"),
		pids: path.join(dir, "holder.pids"),
		strays: path.join(dir, "strays"),
		calls: path.join(dir, "calls"),
	};
	const write = (file: string, body: string) => {
		const bin = path.join(dir, file);
		fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
		return bin;
	};
	const live = `live() { for p in $(cat "${files.pids}" 2>/dev/null); do kill -0 "$p" 2>/dev/null && echo "$p"; done; }
strays() { cat "${files.strays}" 2>/dev/null || echo 0; }`;
	const row = `printf '"${IMAGE}","%s","Console","1","65,600 K"\\r\\n'`;
	return {
		...files,
		testlimit: write(
			IMAGE,
			`echo "$*" >> "${files.args}"; echo $$ >> "${files.pids}"; exec sleep 600`,
		),
		tasklist: write(
			"tasklist",
			`${live}
case "$*" in *"IMAGENAME eq ${IMAGE}"*) ;; *) echo "${NO_TASKS}"; exit 0 ;; esac
n=0
for p in $(live); do ${row} "$p"; n=1; done
i=0; while [ "$i" -lt "$(strays)" ]; do ${row} "9$i"; n=1; i=$((i + 1)); done
[ "$n" = 0 ] && echo "${NO_TASKS}"
exit 0`,
		),
		taskkill: write(
			"taskkill",
			`${live}
echo "taskkill $*" >> "${files.calls}"
${denied ? "echo 'ERROR: Access is denied.' >&2; exit 1" : ""}
n=0
if [ "$*" = "/IM ${IMAGE} /F" ]; then
	for p in $(live); do kill -9 "$p"; printf 'SUCCESS: The process "${IMAGE}" with PID %s has been terminated.\\r\\n' "$p"; n=1; done
	[ "$(strays)" -gt 0 ] && { echo 0 > "${files.strays}"; n=1; }
fi
[ "$n" = 0 ] && { printf 'ERROR: The process "%s" not found.\\r\\n' "$2" >&2; exit 128; }
exit 0`,
		),
		setStrays: (n: number) => fs.writeFileSync(files.strays, `${n}\n`),
	};
}
