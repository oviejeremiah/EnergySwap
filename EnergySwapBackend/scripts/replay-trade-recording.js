// Replay of the first live trade's recording step. The payment itself already
// settled on-chain (0.0.6242449-1793370585-796318635) and must NOT be repeated;
// only the bookkeeping that 500'd is being replayed, and the server re-verifies
// the payment from the mirror node as usual.
fetch('http://localhost:3000/api/record-trade', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
        offerId: 'offer-1793359475685-zdd2awgie',
        energyAmountKWh: 0.1,
        consumerAccountId: '0.0.6242449',
        transactionId: '0.0.6242449@1793370585.796318635',
    }),
})
    .then(async (res) => {
        console.log('HTTP', res.status);
        console.log(JSON.stringify(await res.json(), null, 2));
    })
    .catch((e) => console.log('FAILED:', e.message));
