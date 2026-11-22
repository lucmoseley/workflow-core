/**
 * @param {unknown} payload
 * @returns {boolean}
 */
function isSubagentPayload(payload) {
	const id = /** @type {{agent_id?: unknown} | null} */ (payload)?.agent_id;
	return id !== undefined && id !== null && id !== false && id !== "";
}

module.exports = { isSubagentPayload };
