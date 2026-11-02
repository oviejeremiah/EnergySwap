/**
 * Turn a failed API response into a message worth reading.
 *
 * The API explains every rejection - which nonce was wrong, which key did not
 * match, whether the signature was the wrong size. Discarding that and showing
 * only `response.statusText` collapses every distinct failure into the single
 * word "Unauthorized", which is exactly the information needed to tell a
 * stale-nonce problem from a wrong-key one.
 *
 * Kept separate from the caller so it can be tested without a browser or a
 * running server.
 */

/**
 * @param {{ok: boolean, status: number, statusText?: string,
 *          json?: () => Promise<any>}} response
 * @param {string} prefix what the caller was doing, e.g. "Failed to post offer"
 * @returns {Promise<string>} a message naming the cause, never "[object Object]"
 */
export async function describeApiError(response, prefix) {
    let detail = '';
    try {
        const body = await response.json();
        const candidate = body?.message || body?.error;
        if (typeof candidate === 'string' && candidate.trim()) {
            detail = candidate.trim();
        }
    } catch {
        // Body was not JSON - an HTML error page, or empty. Fall through to the
        // status line rather than reporting a parse failure the user cannot act on.
    }

    const status = response?.status;
    const fallback = `${prefix}: ${response?.statusText || 'request failed'} (HTTP ${status ?? 'unknown'})`;
    return detail ? `${prefix}: ${detail}` : fallback;
}