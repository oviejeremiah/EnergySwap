const test = require('node:test');
const assert = require('node:assert/strict');

const {
    issueProofChallenge,
    verifyTransactionProof,
    proofMemoFor,
    _resetChallenges,
} = require('../wallet-auth');

// Proof of account control by a signed TRANSACTION rather than a signed message.
//
// The fee payer of a transaction is authoritative: the network assigns it when
// the transaction reaches consensus, and nobody can attach someone else's payer
// to their own transaction. That is the whole basis of this check, and it needs
// no wallet cryptography and no assumptions about signature encoding.
//
// The record shape consumed here is the normalised one produced by
// mirror-node.js: { status, payerAccountId, memo }. Keeping it explicit means
// the checks below read the same way the network reports them.

const ACCOUNT = '0.0.9990003';

test.beforeEach(() => _resetChallenges());

test('issues a proof challenge carrying a memo and the target network', () => {
    const challenge = issueProofChallenge(ACCOUNT, 'testnet');

    assert.equal(typeof challenge.nonce, 'string');
    assert.ok(challenge.nonce.length >= 32, 'the nonce is unpredictable');
    assert.equal(challenge.network, 'testnet', 'the caller is told which network to build a client for');
    assert.equal(
        challenge.memo,
        proofMemoFor(challenge.nonce),
        'the memo is derived from the nonce so the two cannot drift apart',
    );
});

test('the memo fits the Hedera transaction memo limit', () => {
    const challenge = issueProofChallenge(ACCOUNT, 'testnet');
    // Hedera rejects a memo longer than 100 bytes; a truncated one would fail at
    // submission with an error that looks nothing like an auth problem.
    assert.ok(Buffer.byteLength(challenge.memo, 'utf8') <= 100, `memo is ${challenge.memo.length} chars`);
});

test('a different account gets a different memo', () => {
    const a = issueProofChallenge(ACCOUNT, 'testnet');
    const b = issueProofChallenge('0.0.9990004', 'testnet');
    assert.notEqual(a.memo, b.memo, 'nonces must not repeat across accounts');
});

test('rejects a transaction nobody paid for', async () => {
    const { nonce } = issueProofChallenge(ACCOUNT, 'testnet');

    const result = await verifyTransactionProof({
        accountId: ACCOUNT,
        nonce,
        transactionId: '0.0.999999@1.000000001',
        queryRecord: async () => ({ status: 'SUCCESS', payerAccountId: '0.0.111111', memo: '' }),
    });

    assert.equal(result.ok, false, 'a transaction paid by another account proves nothing');
});

test('rejects a transaction whose memo does not carry the nonce', async () => {
    const { nonce } = issueProofChallenge(ACCOUNT, 'testnet');

    const result = await verifyTransactionProof({
        accountId: ACCOUNT,
        nonce,
        transactionId: '0.0.999999@1.000000002',
        queryRecord: async () => ({ status: 'SUCCESS', payerAccountId: ACCOUNT, memo: 'some other memo' }),
    });

    assert.equal(result.ok, false, 'a paid transaction without the nonce is not proof of this challenge');
});

test('rejects a transaction that failed', async () => {
    const { nonce, memo } = issueProofChallenge(ACCOUNT, 'testnet');

    const result = await verifyTransactionProof({
        accountId: ACCOUNT,
        nonce,
        transactionId: '0.0.999999@1.000000003',
        queryRecord: async () => ({ status: 'REVERT', payerAccountId: ACCOUNT, memo }),
    });

    assert.equal(result.ok, false);
});

test('rejects a record that reports no status at all', async () => {
    // Absence of a status must not read as success.
    const { nonce, memo } = issueProofChallenge(ACCOUNT, 'testnet');

    const result = await verifyTransactionProof({
        accountId: ACCOUNT,
        nonce,
        transactionId: '0.0.999999@1.000000004',
        queryRecord: async () => ({ payerAccountId: ACCOUNT, memo }),
    });

    assert.equal(result.ok, false);
});

test('rejects a record with no payer', async () => {
    const { nonce, memo } = issueProofChallenge(ACCOUNT, 'testnet');

    const result = await verifyTransactionProof({
        accountId: ACCOUNT,
        nonce,
        transactionId: '0.0.999999@1.000000005',
        queryRecord: async () => ({ status: 'SUCCESS', payerAccountId: null, memo }),
    });

    assert.equal(result.ok, false, 'a record with no payer proves nothing about who paid');
});

test('accepts a transaction the account paid for carrying the nonce', async () => {
    const { nonce, memo } = issueProofChallenge(ACCOUNT, 'testnet');

    const result = await verifyTransactionProof({
        accountId: ACCOUNT,
        nonce,
        transactionId: '0.0.999999@1.000000006',
        queryRecord: async () => ({ status: 'SUCCESS', payerAccountId: ACCOUNT, memo }),
    });

    assert.equal(result.ok, true, result.reason);
});

test('the nonce is single use', async () => {
    const { nonce, memo } = issueProofChallenge(ACCOUNT, 'testnet');
    const queryRecord = async () => ({ status: 'SUCCESS', payerAccountId: ACCOUNT, memo });

    const first = await verifyTransactionProof({
        accountId: ACCOUNT,
        nonce,
        transactionId: '0.0.999999@1.000000007',
        queryRecord,
    });
    assert.equal(first.ok, true, first.reason);

    const replay = await verifyTransactionProof({
        accountId: ACCOUNT,
        nonce,
        transactionId: '0.0.999999@1.000000007',
        queryRecord,
    });
    assert.equal(replay.ok, false, 'the same proof must not be reusable');
});

test('rejects an unknown nonce without querying the network', async () => {
    let queried = false;
    const result = await verifyTransactionProof({
        accountId: ACCOUNT,
        nonce: 'not-a-real-nonce',
        transactionId: '0.0.999999@1.000000008',
        queryRecord: async () => {
            queried = true;
            return null;
        },
    });

    assert.equal(result.ok, false);
    assert.equal(queried, false, 'an unknown nonce is rejected locally, before spending a network query');
});

test('a nonce issued for one account cannot prove another', async () => {
    const { nonce, memo } = issueProofChallenge(ACCOUNT, 'testnet');

    const result = await verifyTransactionProof({
        accountId: '0.0.9990005',
        nonce,
        transactionId: '0.0.999999@1.000000009',
        queryRecord: async () => ({ status: 'SUCCESS', payerAccountId: '0.0.9990005', memo }),
    });

    assert.equal(result.ok, false, 'a nonce is scoped to the account it was issued for');
});

test('an expired challenge is refused even with a genuine transaction', async () => {
    const { nonce, memo } = issueProofChallenge(ACCOUNT, 'testnet');

    const result = await verifyTransactionProof({
        accountId: ACCOUNT,
        nonce,
        transactionId: '0.0.999999@1.000000010',
        queryRecord: async () => ({ status: 'SUCCESS', payerAccountId: ACCOUNT, memo }),
        now: Date.now() + 6 * 60 * 1000,
    });

    assert.equal(result.ok, false);
});

test('survives a network failure without throwing', async () => {
    const { nonce } = issueProofChallenge(ACCOUNT, 'testnet');

    const result = await verifyTransactionProof({
        accountId: ACCOUNT,
        nonce,
        transactionId: '0.0.999999@1.000000011',
        queryRecord: async () => {
            throw new Error('mirror node unreachable');
        },
    });

    assert.equal(result.ok, false, 'a failure to check is a refusal, never an acceptance');
});

test('a transaction the mirror node does not hold is refused, not assumed', async () => {
    // null is the reader's way of saying "positively no such transaction",
    // which for a proof submitted moments ago usually means not yet indexed.
    const { nonce } = issueProofChallenge(ACCOUNT, 'testnet');

    const result = await verifyTransactionProof({
        accountId: ACCOUNT,
        nonce,
        transactionId: '0.0.999999@1.000000012',
        queryRecord: async () => null,
    });

    assert.equal(result.ok, false);
});

test('the reason distinguishes the three ways a proof fails', async () => {
    // A user staring at "verification failed" learns nothing. Each refusal says
    // which of the three network facts failed.
    const others = { wrongPayer: null, wrongMemo: null, failedTx: null };

    {
        const { nonce } = issueProofChallenge(ACCOUNT, 'testnet');
        others.wrongPayer = await verifyTransactionProof({
            accountId: ACCOUNT, nonce, transactionId: '0.0.999999@1.000000013',
            queryRecord: async () => ({ status: 'SUCCESS', payerAccountId: '0.0.111111', memo: nonce }),
        });
    }
    {
        const { nonce } = issueProofChallenge(ACCOUNT, 'testnet');
        others.wrongMemo = await verifyTransactionProof({
            accountId: ACCOUNT, nonce, transactionId: '0.0.999999@1.000000014',
            queryRecord: async () => ({ status: 'SUCCESS', payerAccountId: ACCOUNT, memo: 'nope' }),
        });
    }
    {
        const { nonce, memo } = issueProofChallenge(ACCOUNT, 'testnet');
        others.failedTx = await verifyTransactionProof({
            accountId: ACCOUNT, nonce, transactionId: '0.0.999999@1.000000015',
            queryRecord: async () => ({ status: 'REVERT', payerAccountId: ACCOUNT, memo }),
        });
    }

    assert.match(others.wrongPayer.reason, /paid for by 0\.0\.111111/);
    assert.match(others.wrongMemo.reason, /does not carry this challenge nonce/);
    assert.match(others.failedTx.reason, /did not succeed \(REVERT\)/);
});