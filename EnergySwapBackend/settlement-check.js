/**
 * Deciding whether a reported HBAR payment settles a trade.
 *
 * This is the only place EnergySwap checks that money actually moved. Everything
 * downstream - the trade row, the prosumer's earnings, the kWh balance - rests
 * on the answer, so each check here exists because something worse than a bug
 * follows from skipping it.
 *
 * The facts come from the mirror node rather than the SDK, for the reason
 * recorded in mirror-node.js: `TransactionRecordQuery` demands an operator this
 * platform deliberately does not have, so it could never have run against the
 * live network.
 *
 * Amounts are compared as BigInt tinybars because the alternative is comparing
 * floats that round to the same value while differing by a tinybar - and a
 * tinybar is the entire difference between "paid the posted amount" and "did
 * not".
 */

/**
 * The exact transfer the buyer must have made: the posted amount to the
 * prosumer, plus the network fee taken from the buyer.
 *
 * @param {{status: string, payerAccountId: string|null, memo: string,
 *          transactionFeeTinybars: string|null,
 *          transfers: Array<{accountId: string, amountTinybars: string}>}} record
 * @param {{consumerAccountId: string, prosumerId: string, expectedTinybars: bigint,
 *          expectedMemo: string}} expected
 * @returns {string|null} why it does not settle, or null when it settles.
 */
function settlementError(record, { consumerAccountId, prosumerId, expectedTinybars, expectedMemo }) {
    if (!record) {
        return 'The Hedera transaction could not be found on the network.';
    }

    // Absence of a status is not success.
    if (record.status !== 'SUCCESS') {
        return 'Hedera transaction did not succeed.';
    }

    // The consumer must have paid. Anyone can quote a transaction ID; only the
    // fee payer actually spent the money, and the network - not the caller -
    // decides who that is.
    if (record.payerAccountId !== consumerAccountId) {
        return 'The consumer must be the transaction fee payer.';
    }

    // Ties the payment to this offer, so a buyer cannot settle one offer with a
    // payment made for another and claim both.
    if (record.memo !== expectedMemo) {
        return 'Transaction memo does not match the selected offer.';
    }

    if (record.transactionFeeTinybars === null) {
        // Without the fee the buyer-side leg cannot be checked, and accepting
        // without it would let any payment of the right gross amount settle.
        return 'The Hedera transaction does not report a network fee.';
    }

    let feeTinybars;
    try {
        feeTinybars = BigInt(record.transactionFeeTinybars);
    } catch {
        return 'The Hedera transaction reports a network fee that is not a number.';
    }

    const legFor = (accountId) => record.transfers.find((leg) => leg.accountId === accountId);

    // The prosumer must have received exactly the posted amount.
    const sellerLeg = legFor(prosumerId);
    if (!sellerLeg) {
        return 'Confirmed transaction does not pay the prosumer.';
    }
    if (BigInt(sellerLeg.amountTinybars) !== expectedTinybars) {
        return 'Confirmed transaction does not pay the posted offer amount to the prosumer.';
    }

    // And the buyer must have been charged exactly that amount plus the fee.
    // Checking only the seller's leg would accept a payment short of the price,
    // because the seller would still have been made whole by someone else.
    const buyerLeg = legFor(consumerAccountId);
    if (!buyerLeg) {
        return 'Confirmed transaction does not charge the consumer.';
    }
    if (-BigInt(buyerLeg.amountTinybars) !== expectedTinybars + feeTinybars) {
        return 'Confirmed transaction does not charge the consumer for the offer and network fee.';
    }

    return null;
}

module.exports = { settlementError };