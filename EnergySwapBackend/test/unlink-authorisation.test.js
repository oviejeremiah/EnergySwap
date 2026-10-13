const test = require('node:test');
const assert = require('node:assert/strict');
const { Wallet } = require('ethers');

const {
    issueUnlinkChallenge,
    verifyUnlinkChallenge,
    _resetUnlinkChallenges,
} = require('../identity-binding');

// Unlinking cannot be checked against Hedera the way a bind can, so the only
// thing standing between an attacker and a platform-wide unlink grief is this
// signature check. These tests are the regression guard for it.

// Addresses are derived from the keys rather than asserted, so a rejection
// cannot pass merely because both sides happened to be wrong in the same way.
const alice = new Wallet(`0x${'11'.repeat(32)}`);
const mallory = new Wallet(`0x${'22'.repeat(32)}`);

const ALICE = alice.address.toLowerCase();
const MALLORY = mallory.address.toLowerCase();

test.beforeEach(() => _resetUnlinkChallenges());

test('the two test wallets are distinct addresses', () => {
    // Guards the tests below: if these ever collided, every "different wallet"
    // case would pass for the wrong reason.
    assert.notEqual(ALICE, MALLORY);
    assert.match(ALICE, /^0x[0-9a-f]{40}$/);
    assert.match(MALLORY, /^0x[0-9a-f]{40}$/);
});

test('issues a challenge that names the address and the intent', () => {
    const challenge = issueUnlinkChallenge({ evmAddress: ALICE });
    assert.match(challenge.message, /unlink/i);
    assert.match(challenge.message, new RegExp(ALICE));
    assert.ok(Date.parse(challenge.expiresAt) > Date.now());
});

test('rejects a malformed address', () => {
    assert.throws(() => issueUnlinkChallenge({ evmAddress: '0x123' }), /EVM address/);
    assert.throws(() => issueUnlinkChallenge({ evmAddress: '0.0.1234' }), /EVM address/);
});

test('accepts a valid signature from the wallet owner', () => {
    const { nonce, message } = issueUnlinkChallenge({ evmAddress: ALICE });
    const signature = alice.signMessageSync(message);

    const result = verifyUnlinkChallenge({ evmAddress: ALICE, nonce, signature });
    assert.equal(result.ok, true, result.reason);
});

test('REJECTS a nonce issued to a different wallet', () => {
    // Mallory issues a challenge for herself, signs it, then presents it to
    // unlink Alice. The nonce is scoped, so this is caught before the signature
    // is ever examined.
    const { nonce, message } = issueUnlinkChallenge({ evmAddress: MALLORY });
    const signature = mallory.signMessageSync(message);

    const result = verifyUnlinkChallenge({ evmAddress: ALICE, nonce, signature });
    assert.equal(result.ok, false);
    assert.match(result.reason, /different address/);
});

test('REJECTS a signature from a different wallet on the owner\'s own nonce', () => {
    // The sharper griefing case: Mallory takes Alice's nonce - which is not a
    // secret, she can trigger one for any address - and signs it with her own
    // key. The address matches the nonce, so only signature recovery stops her.
    const { nonce, message } = issueUnlinkChallenge({ evmAddress: ALICE });
    const signature = mallory.signMessageSync(message);

    const result = verifyUnlinkChallenge({ evmAddress: ALICE, nonce, signature });
    assert.equal(result.ok, false);
    assert.match(result.reason, /does not prove control/);
});

test('REJECTS an unsigned unlink attempt', () => {
    const { nonce } = issueUnlinkChallenge({ evmAddress: ALICE });

    for (const signature of [undefined, '', '0xdeadbeef', null]) {
        const result = verifyUnlinkChallenge({ evmAddress: ALICE, nonce, signature });
        assert.equal(result.ok, false, `signature ${String(signature)} must be refused`);
    }
});

test('REJECTS a replayed authorisation', () => {
    const { nonce, message } = issueUnlinkChallenge({ evmAddress: ALICE });
    const signature = alice.signMessageSync(message);

    assert.equal(verifyUnlinkChallenge({ evmAddress: ALICE, nonce, signature }).ok, true);

    const replay = verifyUnlinkChallenge({ evmAddress: ALICE, nonce, signature });
    assert.equal(replay.ok, false);
    assert.match(replay.reason, /unknown or already used/);
});

test('REJECTS a nonce issued for a different address', () => {
    const aliceChallenge = issueUnlinkChallenge({ evmAddress: ALICE });
    // Mallory signs Alice's nonce but asks to unlink herself.
    const signature = mallory.signMessageSync(aliceChallenge.message);

    const result = verifyUnlinkChallenge({
        evmAddress: MALLORY,
        nonce: aliceChallenge.nonce,
        signature,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /different address/);
});

test('REJECTS a signature over a different message', () => {
    const { nonce } = issueUnlinkChallenge({ evmAddress: ALICE });
    const signature = alice.signMessageSync('EnergySwap: unlink everyone');

    const result = verifyUnlinkChallenge({ evmAddress: ALICE, nonce, signature });
    assert.equal(result.ok, false);
    assert.match(result.reason, /does not prove control/);
});

test('rejects an unknown nonce without touching the signature', () => {
    const signature = alice.signMessageSync('anything');
    const result = verifyUnlinkChallenge({ evmAddress: ALICE, nonce: 'f'.repeat(48), signature });
    assert.equal(result.ok, false);
    assert.match(result.reason, /unknown or already used/);
});