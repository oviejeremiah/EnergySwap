import { describe, it, expect, vi } from 'vitest';
import { proveAccountControl, encodeSignature } from '../src/wallet-signature.js';

// Offer posting proves control of the Hedera account by asking the wallet to
// sign and submit a transaction carrying a server-issued nonce.
//
// This replaced wallet message signing, which could not be made to verify: the
// wallet produced structurally valid ECDSA signatures that matched no encoding,
// digest or wrapper of the challenge message, while a verification harness
// using the same code correctly accepted a signature it had made itself.
//
// A transaction needs none of that. The account signs it and pays the fee, and
// the server reads the result from the network - where the fee payer is
// authoritative and cannot be spoofed.
//
// It is network-agnostic: the challenge names the network and the client is
// built for whatever it says, so the same flow works with testnet HBAR now and
// mainnet HBAR after migration.

const ACCOUNT = '0.0.6243111';

function jsonResponse(body, ok = true, status = 200) {
    return { ok, status, json: async () => body };
}

function challenge(overrides = {}) {
    return jsonResponse({
        success: true,
        nonce: 'n0nce',
        memo: 'EnergySwap proof: n0nce',
        network: 'testnet',
        ...overrides,
    });
}

describe('proveAccountControl', () => {
    it('submits a transaction carrying the nonce and returns its id', async () => {
        const submitProof = vi.fn(async () => '0.0.999@1.000001');
        const signer = {
            getAccountId: () => ({ toString: () => ACCOUNT }),
            signTransaction: vi.fn(),
        };
        const fetchImpl = vi.fn(async () => challenge());

        const result = await proveAccountControl({
            accountId: ACCOUNT,
            signer,
            fetchImpl,
            clientFor: () => ({ close: vi.fn() }),
            submitProof,
        });

        expect(result).toEqual({ proofNonce: 'n0nce', proofTransactionId: '0.0.999@1.000001' });
        // The memo handed to the transaction must be the one the server issued,
        // or the proof is for a different challenge.
        expect(submitProof).toHaveBeenCalledWith(
            expect.objectContaining({ memo: 'EnergySwap proof: n0nce', account: ACCOUNT }),
        );
    });

    it('builds the client for the network the server names', async () => {
        // The requirement: the same flow must work with mainnet tokens after
        // migration. The network comes from the server, never hardcoded here.
        const signer = { getAccountId: () => ({ toString: () => ACCOUNT }), signTransaction: vi.fn() };
        const fetchImpl = vi.fn(async () => challenge({ network: 'mainnet' }));

        const requested = [];
        const clientFor = (network) => {
            requested.push(network);
            return { close: vi.fn() };
        };

        await proveAccountControl({
            accountId: ACCOUNT,
            signer,
            fetchImpl,
            clientFor,
            submitProof: async () => '0.0.999@1.000002',
        });

        expect(requested).toEqual(['mainnet']);
    });

    it('falls back to testnet when the server says nothing', async () => {
        const signer = { getAccountId: () => ({ toString: () => ACCOUNT }), signTransaction: vi.fn() };
        const fetchImpl = vi.fn(async () => challenge({ network: undefined }));

        const requested = [];
        await proveAccountControl({
            accountId: ACCOUNT,
            signer,
            fetchImpl,
            clientFor: (n) => {
                requested.push(n);
                return { close: vi.fn() };
            },
            submitProof: async () => '0.0.999@1.000003',
        });

        expect(requested).toEqual(['testnet']);
    });

    it('refuses when the signer belongs to a different account', async () => {
        const signer = { getAccountId: () => ({ toString: () => '0.0.99999' }), signTransaction: vi.fn() };
        const fetchImpl = vi.fn(async () => challenge());
        const submitProof = vi.fn();

        await expect(
            proveAccountControl({
                accountId: ACCOUNT,
                signer,
                fetchImpl,
                clientFor: () => ({ close: vi.fn() }),
                submitProof,
            }),
        ).rejects.toThrow(/not/i);

        expect(submitProof).not.toHaveBeenCalled();
    });

    it('surfaces a server refusal to issue a challenge', async () => {
        const signer = { getAccountId: () => ({ toString: () => ACCOUNT }), signTransaction: vi.fn() };
        const fetchImpl = vi.fn(async () =>
            jsonResponse({ success: false, message: 'Wallet authentication is not enabled.' }, false, 404),
        );

        await expect(
            proveAccountControl({
                accountId: ACCOUNT,
                signer,
                fetchImpl,
                clientFor: () => ({ close: vi.fn() }),
                submitProof: vi.fn(),
            }),
        ).rejects.toThrow(/Wallet authentication is not enabled/);
    });

    it('reports a wallet that rejects the transaction', async () => {
        const signer = { getAccountId: () => ({ toString: () => ACCOUNT }), signTransaction: vi.fn() };
        const fetchImpl = vi.fn(async () => challenge());

        await expect(
            proveAccountControl({
                accountId: ACCOUNT,
                signer,
                fetchImpl,
                clientFor: () => ({ close: vi.fn() }),
                submitProof: async () => {
                    throw new Error('User rejected the request');
                },
            }),
        ).rejects.toThrow(/User rejected/);
    });

    it('refuses when the challenge carries no nonce', async () => {
        const signer = { getAccountId: () => ({ toString: () => ACCOUNT }), signTransaction: vi.fn() };
        const fetchImpl = vi.fn(async () => challenge({ nonce: undefined }));

        await expect(
            proveAccountControl({
                accountId: ACCOUNT,
                signer,
                fetchImpl,
                clientFor: () => ({ close: vi.fn() }),
                submitProof: vi.fn(),
            }),
        ).rejects.toThrow(/usable proof challenge/);
    });
});

describe('submitProofTransaction', () => {
    it('signs through the wallet signer, the way the trade path does', async () => {
        // Regression guard. The first version used `transaction.sign(signer)`
        // and then `transaction.execute(client)`, which fails at runtime with
        // "transaction.execute is not a function" - the signed value is not the
        // transaction. The trade path signs with `signer.signTransaction(tx)`
        // and executes the result, and it works against a real wallet, so this
        // must match it exactly rather than differ by one method name.
        const { submitProofTransaction } = await import('../src/wallet-signature.js');
        const sdk = await import('@hashgraph/sdk');

        const signed = {
            execute: vi.fn(async () => ({
                transactionId: { toString: () => '0.0.999@1.000009' },
                getReceipt: vi.fn(async () => ({ status: { toString: () => 'SUCCESS' } })),
            })),
        };
        const signer = { signTransaction: vi.fn(async () => signed) };
        const client = { close: vi.fn() };

        const result = await submitProofTransaction({
            account: ACCOUNT,
            memo: 'EnergySwap proof: abc',
            signer,
            client,
        });

        expect(result).toBe('0.0.999@1.000009');
        expect(signer.signTransaction).toHaveBeenCalledTimes(1);
        // The memo has to reach the transaction: the server looks for the nonce
        // there, and nothing else carries it.
        const [built] = signer.signTransaction.mock.calls[0];
        expect(built.transactionMemo).toBe('EnergySwap proof: abc');
        expect(signed.execute).toHaveBeenCalledWith(client);
        expect(sdk.TransferTransaction).toBeTruthy();
    });
});

describe('encodeSignature', () => {
    it('encodes a Uint8Array signature as base64', () => {
        const bytes = Uint8Array.from([1, 2, 3]);
        expect(encodeSignature(bytes)).toBe(btoa(String.fromCharCode(...bytes)));
    });

    it('passes a string through unchanged', () => {
        expect(encodeSignature('ALREADY')).toBe('ALREADY');
    });
});