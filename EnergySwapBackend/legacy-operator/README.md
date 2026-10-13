# Legacy operator scripts — archived, not for use

These eight scripts predate the platform's decentralisation. They are kept for
history only and **must not be run**.

## Why they were archived

They all read `OPERATOR_KEY` from `.env` and call `client.setOperator(...)`,
which means the *platform* signs and submits chain transactions. That contradicts
the architecture EnergySwap now runs on:

- HBAR moves **directly** between buyer and seller
- Prosumers set their own price; nothing operator-controlled
- The API opens zero Hedera clients when accepting a meter reading
  (asserted by `test/gateway.test.js`)
- Meter attestations and energy-token credits are signed by the **grid gateway**
  (`EnergySwapBackend/gateway/`), which owns those keys and pays the fees

Two of these are specifically incompatible with that model:

| Script | Why it is wrong now |
|---|---|
| `execute-trade.js` | Settles a trade **as a middleman**, moving energy tokens between buyer and seller. This is the operator-controlled path that was deliberately removed from `server.js`. |
| `credit-energy-tokens.js` | Transfers energy tokens under the operator identity. Credit issuance belongs to the gateway. |

The remaining five (`associate-consumer.js`, `associate-token.js`,
`create-hcs-topic.js`, `create-token.js`, `log-energy-data.js`) are Hedera
provisioning utilities — token/topic creation and HCS submission. They were
one-time setup helpers and have no place in a service architecture.

`index.js` is a standalone "hello world" that configured a Hedera client and
printed the operator account ID. Nothing imports it.

## How they were reachable

They were **not** exposed. None are imported by `server.js`, and `package.json`
exposes only `test`, `start`, `dev`, `migrate` and `import-json`. Running one
required invoking it by hand. They were moved anyway to remove the
operator-signing pattern from the working tree before the operator identity is
reintroduced for IoT metering.

## Where the operator key belongs next

Per the platform design, `OPERATOR_KEY` is reserved for **grid metering** after
mainnet: charging consumers and paying prosumer incentives from IoT meter
readings. That is a grid-entity function, and it is deliberately separate from
the P2P trade path.

When that service is built:

- Give it its own credential store — do **not** reuse this key
- It must never be loaded into the marketplace API process
- Keep it out of `EnergySwapBackend/.env`; use a secret manager
- It should attest to meter readings, not move energy between buyer and seller

Until then the key has no consumer in this codebase, which is the correct state.