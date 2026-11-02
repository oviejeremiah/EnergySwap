/**
 * Reading a submitted transaction from the Hedera mirror node.
 *
 * The platform has to learn who actually paid for a transaction before it will
 * act on it: a prosumer's offer is only honoured if the transaction carrying the
 * challenge nonce was paid for by the account claiming to be the producer, and a
 * settled trade is only recorded if the buyer paid the seller.
 *
 * ## Why this is not TransactionRecordQuery
 *
 * The SDK query is the obvious choice and cannot work in this platform.
 * `@hashgraph/sdk` 2.81.0 has `Query._isPaymentRequired()` returning true, and
 * `TransactionRecordQuery` does not override it. The only ways to satisfy it are
 * `setQueryPayment` or `setPaymentTransactionId`, and both require an operator.
 * The SDK then refuses with:
 *
 *   `client` must have an `operator` or an explicit payment transaction must be provided
 *
 * EnergySwap deliberately holds no signing identity - prosumers and consumers
 * sign for themselves and this service only reads. Supplying an operator to
 * satisfy a query would break that central guarantee, so the SDK route is not
 * available.
 *
 * This is not a recent regression. `/api/record-trade` has used the same query
 * since it was written, so verification of a settled trade against the live
 * network could not have succeeded either. Any report that settlement was
 * confirmed by the SDK query was confirmed by a stub, not by the network.
 *
 * The mirror node's REST API answers the same question with no key, no payment
 * and no account. It is already how this service fetches account keys, so this
 * is the mechanism the codebase was using successfully all along.
 *
 * ## Why the payer is trustworthy
 *
 * The fee payer is part of the transaction ID, which the network assigns when
 * the transaction is consensus-reached. The mirror node reports the ID it
 * recorded, so the payer read from it is what the network saw. Nothing in the
 * request influences it, and a client cannot present a payer that did not pay.
 */

const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * How long to wait between attempts on "mirror node has not indexed it yet".
 *
 * Consensus confirms a transaction in a few seconds while the mirror node can
 * stay seconds behind it, so a first 404 (or a first topic window without the
 * asked timestamp) is not evidence of absence. Three bounded attempts total
 * ~3.5 s before absence is reported - short enough for a user waiting on a
 * route response, long enough to cover normal indexing slack.
 */
const NOT_INDEXED_RETRY_DELAYS_MS = [500, 1_000, 2_000];

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A Hedera account ID, e.g. 0.0.6243111. */
const ACCOUNT_ID = /^0\.0\.\d+$/;

/**
 * A transaction ID as the Hedera SDK and mirror node each write it:
 * `0.0.1234@1792006000.000000001` (SDK) or `0.0.1234-1792006000-000000001`
 * (REST). The payer is the first component either way.
 */
const TRANSACTION_ID = /^(\d+\.\d+\.\d+)[@.-]\d/;

/**
 * Extract the fee payer from a transaction ID.
 *
 * @param {unknown} transactionId
 * @returns {string|null} an account ID, or null when the ID is not well formed.
 */
function payerFromTransactionId(transactionId) {
    if (typeof transactionId !== 'string') return null;

    const match = TRANSACTION_ID.exec(transactionId.trim());
    if (!match) return null;

    const payer = match[1];
    return ACCOUNT_ID.test(payer) ? payer : null;
}

/**
 * Decode a mirror-node `memo_base64` into text.
 *
 * Hedera memos are arbitrary bytes, so a memo that is not valid UTF-8 must not
 * throw - the request checking it would fail for an unrelated reason.
 *
 * @param {unknown} base64
 * @returns {string} '' when there is no memo.
 */
function decodeMemo(base64) {
    if (typeof base64 !== 'string' || base64 === '') return '';
    try {
        return Buffer.from(base64, 'base64').toString('utf8');
    } catch {
        return '';
    }
}

/**
 * Convert a transaction ID into the form the mirror node's REST API accepts.
 *
 * The SDK and the REST API spell the same transaction differently: the SDK
 * writes `0.0.1234@1792006000.000000001` and REST wants
 * `0.0.1234-1792006000-000000001`. The REST endpoint answers HTTP 400 to the @
 * form - not 404, and not even for a transaction that genuinely exists.
 *
 * The wallet reports IDs in the @ form, so without this every proof would be
 * refused for a reason that has nothing to do with the proof.
 *
 * The seconds and nanosecond fields are carried through as written rather than
 * reformatted: rewriting a timestamp would point the lookup at a different
 * transaction.
 *
 * @param {string} transactionId
 * @returns {string}
 */
function toRestTransactionId(transactionId) {
    const at = transactionId.indexOf('@');
    if (at === -1) return transactionId;

    const account = transactionId.slice(0, at);
    const when = transactionId.slice(at + 1);

    // A second @ means this is not a transaction ID; return it unchanged so the
    // well-formedness check can refuse it rather than this quietly reshaping it.
    if (when.includes('@')) return transactionId;

    const dot = when.indexOf('.');
    if (dot === -1) return transactionId;

    return `${account}-${when.slice(0, dot)}-${when.slice(dot + 1)}`;
}

/**
 * Reduce a mirror-node transaction record to the facts verification needs.
 *
 * Field names were taken from live testnet records, not from the mirror node's
 * published schema, because the two disagree: a live CRYPTOTRANSFER reports a
 * transfer leg as `{"account": ..., "amount": ...}`, while the schema names the
 * field `account_id`. Both spellings are accepted here, because supporting only
 * the one that happens to be untested fails silently in whichever direction is
 * untested - finding no legs, and refusing every honest payment.
 *
 * Amounts are carried as decimal strings and compared as integers, so that no
 * arithmetic on them passes through a double. Note the limit of that: the mirror
 * node returns small amounts as JSON numbers, and JSON parsing has already
 * rounded a number literal before any code here sees it, so exactness is
 * preserved for amounts that arrive as strings and cannot be recovered for
 * amounts that arrive as oversized numbers. What this code does guarantee is
 * that it never rounds further, and never does fractional arithmetic on a value
 * that is supposed to be a whole number of tinybars.
 *
 * @param {object|null} record
 * @returns {{status: string, payerAccountId: string|null, memo: string,
 *            name: string|null, consensusTimestamp: string|null,
 *            consensusTimestampRaw: string|null,
 *            transactionFeeTinybars: string|null,
 *            transfers: Array<{accountId: string, amountTinybars: string}>,
 *            tokenTransfers: Array<{accountId: string, tokenId: string, amount: string}>}}
 */
function normaliseTransactionRecord(record) {
    // Absence of a status is never a success. A record that does not say the
    // transaction succeeded cannot have its payer relied upon.
    const status = typeof record?.result === 'string' ? record.result : 'UNKNOWN';

    return {
        status,
        payerAccountId: payerFromTransactionId(record?.transaction_id),
        memo: decodeMemo(record?.memo_base64),
        name: typeof record?.name === 'string' ? record.name : null,
        consensusTimestamp: toIsoInstant(record?.consensus_timestamp),
        // The mirror node's own "seconds.nanoseconds" text, kept alongside the
        // ISO form. Reading a consensus message back requires an exact match
        // against it, and converting to ISO and back would risk matching a
        // neighbouring message instead of this one.
        consensusTimestampRaw:
            typeof record?.consensus_timestamp === 'string' && /^\d+\.\d+$/.test(record.consensus_timestamp.trim())
                ? record.consensus_timestamp.trim()
                : null,
        transactionFeeTinybars: toAmountString(record?.charged_tx_fee),
        transfers: (record?.transfers || [])
            .map((leg) => ({ accountId: legAccount(leg), amountTinybars: toAmountString(leg?.amount) }))
            .filter((leg) => leg.accountId !== null && leg.amountTinybars !== null),
        tokenTransfers: (record?.token_transfers || [])
            .map((leg) => ({
                accountId: legAccount(leg),
                tokenId: leg?.token_id == null ? null : String(leg.token_id),
                amount: toAmountString(leg?.amount),
            }))
            // A leg naming no token is not a token leg. Presenting it as one
            // would let an HBAR payment pass as a token credit - the forgery
            // that was fixed once already and would return through this path.
            .filter((leg) => leg.accountId !== null && leg.tokenId !== null && leg.amount !== null),
    };
}

/**
 * Read the account from a transfer leg, tolerating either field spelling.
 *
 * @param {object} leg
 * @returns {string|null}
 */
function legAccount(leg) {
    const account = leg?.account ?? leg?.account_id;
    if (account == null) return null;
    const id = String(account);
    return ACCOUNT_ID.test(id) ? id : null;
}

/**
 * Render an HBAR amount as an exact decimal string.
 *
 * A missing amount is reported as absent rather than zero: a zero-value leg is
 * a claim about the transfer, and inventing one would make the buyer-side
 * arithmetic balance by accident.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function toAmountString(value) {
    if (value == null) return null;
    if (typeof value === 'number') {
        return Number.isFinite(value) ? BigInt(Math.trunc(value)).toString() : null;
    }
    const text = String(value).trim();
    return /^-?\d+$/.test(text) ? BigInt(text).toString() : null;
}

/**
 * Convert the mirror node's "seconds.nanoseconds" consensus timestamp to an
 * ISO instant.
 *
 * @param {unknown} value
 * @returns {string|null} null when the value is absent or unparseable. The
 *          epoch is never returned as a substitute, because it would look like a
 *          real instant to anything comparing it against wall-clock time.
 */
function toIsoInstant(value) {
    if (typeof value !== 'string') return null;
    const match = /^(\d+)\.(\d+)$/.exec(value.trim());
    if (!match) return null;

    const nanos = BigInt(match[2]);
    try {
        const millis = Number(BigInt(match[1]) * 1000n + nanos / 1_000_000n);
        const date = new Date(millis);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    } catch {
        return null;
    }
}

/**
 * Fetch and normalise a transaction record from the mirror node.
 *
 * Absence and failure are kept distinct, because they call for different
 * responses: a transaction the node has not indexed yet may be worth retrying,
 * while a node that cannot be reached is a fault to report rather than a fact
 * about the transaction.
 *
 * @param {{mirrorNodeUrl: string, transactionId: string,
 *          fetchImpl?: typeof fetch, timeoutMs?: number}} params
 * @returns {Promise<{status: string, payerAccountId: string|null, memo: string}|null>}
 *          null when the mirror node holds no such transaction. Throws when the
 *          mirror node is unconfigured, unreachable, or slow.
 */
async function fetchTransactionRecord({
    mirrorNodeUrl,
    transactionId,
    fetchImpl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
    // A missing mirror node is a configuration fault, not an absent
    // transaction. Returning null here would refuse every honest offer for a
    // reason that has nothing to do with the offer.
    if (typeof mirrorNodeUrl !== 'string' || !mirrorNodeUrl.trim()) {
        throw new Error('No Hedera mirror node is configured, so no transaction can be verified.');
    }

    const id = typeof transactionId === 'string' ? transactionId.trim() : '';
    // Refuse a malformed ID before spending a request: there is no such
    // transaction to look up, and sending it on would only invite a confusing
    // response.
    if (!TRANSACTION_ID.test(id)) {
        return { status: 'UNKNOWN', payerAccountId: null, memo: '' };
    }

    const doFetch = fetchImpl || globalThis.fetch;

    // The REST endpoint rejects the SDK's @ form outright, so the ID has to be
    // respelled before it is sent. Encoding is still required: an unencoded '@'
    // is not legal in a path segment.
    const restId = toRestTransactionId(id);
    const url = `${mirrorNodeUrl.replace(/\/+$/, '')}/api/v1/transactions/${encodeURIComponent(restId)}`;

    // The mirror node reports an unknown transaction as 404. For a transaction
    // submitted seconds ago that is usually "not indexed YET" rather than "no
    // such transaction": consensus confirms it while the mirror is seconds
    // behind. A single 404 therefore must not be final evidence - retry on a
    // short bounded schedule before reporting absence. The normalised result of
    // this function is unchanged afterwards: absent stays null, so "no long-lived
    // transaction" is still a definitive answer, never acceptance.
    for (let attempt = 0; ; attempt++) {
        // Without a bound, a mirror node that accepts the connection and never
        // answers holds this request open - and it sits in front of a user
        // waiting to post an offer.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        let response;
        try {
            response = await doFetch(url, {
                headers: { accept: 'application/json' },
                signal: controller.signal,
            });
        } catch (error) {
            if (controller.signal.aborted) {
                throw new Error(`The Hedera mirror node did not answer within ${timeoutMs}ms.`);
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }

        if (response.status === 404) {
            const delayMs = NOT_INDEXED_RETRY_DELAYS_MS[attempt];
            if (delayMs !== undefined) {
                await sleepMs(delayMs);
                continue;
            }
            return null;
        }
        if (!response.ok) {
            throw new Error(`The Hedera mirror node answered HTTP ${response.status} for ${id}.`);
        }

        const body = await response.json();
        return normaliseTransactionRecord(Array.isArray(body?.transactions) ? body.transactions[0] : null);
    }
}

/**
 * Read back the consensus message a transaction carried.
 *
 * Needed because a successful transaction is not evidence of anything: the meter
 * topic has no submit key, so any account can submit to it, and "did the
 * transaction succeed" says nothing about what it said. Reading the message back
 * is what binds the recorded transaction id to this reading's attestation.
 *
 * Matching is by exact consensus timestamp. A nearest-neighbour or
 * most-recent match would be the hole itself - an attacker's own message would
 * land inside any such window.
 *
 * A message split across HCS chunks is refused rather than reassembled, because
 * reassembling wrongly would mean verifying a payload the submitter never
 * signed as one piece. Real attestations are single chunks: the API refuses to
 * issue settlement instructions for a message over 1024 bytes.
 *
 * @param {{mirrorNodeUrl: string, topicId: string, consensusTimestamp: string,
 *          fetchImpl?: typeof fetch, timeoutMs?: number, limit?: number}} params
 * @returns {Promise<{message: string, consensusTimestamp: string,
 *                    payerAccountId: string|null, sequenceNumber: number|null}|null>}
 *          null when no single-chunk message sits at exactly that timestamp.
 *          Throws when the mirror node is unreachable or slow, so "cannot ask"
 *          is never confused with "there is nothing there".
 */
async function fetchTopicMessage({
    mirrorNodeUrl,
    topicId,
    consensusTimestamp,
    fetchImpl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    limit = 25,
}) {
    if (typeof mirrorNodeUrl !== 'string' || !mirrorNodeUrl.trim()) {
        throw new Error('No Hedera mirror node is configured, so no consensus message can be read.');
    }
    // No topic or no timestamp means there is nothing to look up. Returning null
    // is a refusal to guess, not a fallback to the most recent message.
    if (typeof topicId !== 'string' || !topicId.trim()) return null;
    if (typeof consensusTimestamp !== 'string' || !/^\d+\.\d+$/.test(consensusTimestamp.trim())) return null;

    const doFetch = fetchImpl || globalThis.fetch;
    const url =
        `${mirrorNodeUrl.replace(/\/+$/, '')}` +
        `/api/v1/consensus/topics/${encodeURIComponent(topicId.trim())}/messages` +
        `?limit=${limit}&order=desc`;

    // The mirror node answers 404 for a topic that has no messages at all. For a
    // topic whose first-ever message was just submitted, though, that is also
    // what "not indexed yet" looks like, so the absence window is retried - the
    // same reasoning as fetchTransactionRecord's transaction window.
    // "Nothing there after the bound" still returns null, and null is never
    // acceptance: an attestation check treats absence as refusal.
    for (let attempt = 0; ; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        let response;
        try {
            response = await doFetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
        } catch (error) {
            if (controller.signal.aborted) {
                throw new Error(`The Hedera mirror node did not answer within ${timeoutMs}ms.`);
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }

        if (response.status === 404) {
            const delayMs = NOT_INDEXED_RETRY_DELAYS_MS[attempt];
            if (delayMs !== undefined) {
                await sleepMs(delayMs);
                continue;
            }
            return null;
        }
        if (!response.ok) {
            throw new Error(`The Hedera mirror node answered HTTP ${response.status} for topic ${topicId}.`);
        }

        const body = await response.json();
        const messages = Array.isArray(body?.messages) ? body.messages : [];

        const match = messages.find((entry) => entry?.consensus_timestamp === consensusTimestamp.trim());
        if (!match) {
            // The topic exists and has messages, but the exact timestamp is not
            // in the first window: for a just-submitted attestation that is the
            // not-indexed-yet case. Retry within the bound, then report absence.
            const delayMs = NOT_INDEXED_RETRY_DELAYS_MS[attempt];
            if (delayMs !== undefined) {
                await sleepMs(delayMs);
                continue;
            }
            return null;
        }

        // Refuse a chunked message. One chunk is guaranteed for a real attestation,
        // so a chunked entry here means the assumption no longer holds and guessing
        // would mean verifying something other than what was submitted.
        const total = match.chunk_info?.total;
        if (total !== undefined && total !== null && Number(total) !== 1) return null;

        const payer = match.payer_account_id == null ? null : String(match.payer_account_id);

        return {
            message: decodeMemo(match.chunk),
            consensusTimestamp: match.consensus_timestamp,
            payerAccountId: payer !== null && ACCOUNT_ID.test(payer) ? payer : null,
            sequenceNumber: match.sequence_number == null ? null : Number(match.sequence_number),
        };
    }
}

module.exports = {
    fetchTopicMessage,
    fetchTransactionRecord,
    normaliseTransactionRecord,
    payerFromTransactionId,
    decodeMemo,
    DEFAULT_TIMEOUT_MS,
};