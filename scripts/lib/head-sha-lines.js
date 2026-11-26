const RED_RUN_HEADING = "## The red run";

const BASE_RED_MAIN = "- Main:";

// #5777
/**
 * @param {string} body
 * @returns {string}
 */
function withoutHeadShaLines(body) {
	const kept = [];
	let inRun = false;
	for (const line of body.split("\n")) {
		if (line === RED_RUN_HEADING) inRun = true;
		else if (inRun && line.startsWith("## ")) inRun = false;
		if (!inRun && !line.startsWith(`${BASE_RED_MAIN} \``)) kept.push(line);
	}
	return kept.join("\n");
}

module.exports = { BASE_RED_MAIN, RED_RUN_HEADING, withoutHeadShaLines };
