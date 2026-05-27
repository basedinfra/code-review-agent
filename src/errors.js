// Shared HTTP-status-bearing error. Lives outside the domain modules so both the
// HTTP layer (server.js) and the review orchestration (reviews.js) can throw a
// status without a cross-layer import.

export class HttpStatusError extends Error {
	/**
	 * @param {number} status
	 * @param {string} message
	 */
	constructor(status, message) {
		super(message);
		this.name = 'HttpStatusError';
		this.status = status;
	}
}
