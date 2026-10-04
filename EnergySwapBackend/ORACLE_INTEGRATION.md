# Meter gateway attestations (Hedera Testnet)

## Trust model

EnergySwap deliberately trusts the configured meter gateway to attest the
relationship between a physical meter and a Hedera prosumer account, and to
report the kWh produced in a stated measurement interval. The gateway is a
first-class participant in the P2P protocol, not an incidental data provider.
EnergySwap verifies what the gateway signed, protects against replay, and
publishes the attestation for both trading parties to inspect. It cannot
independently calibrate a meter or prove that the gateway reported physical
reality correctly.

The current deployment supports one configured Ed25519 gateway key. The
operator is responsible for the gateway's identity, key custody, meter
enrollment, meter-to-prosumer assignment, calibration, and key rotation. Each
attestation contains the gateway public key and its SHA-256 SPKI fingerprint
so historical HCS evidence remains verifiable after a key rotation. Key
rotation and multiple independently enrolled gateways still need operational
support before production.

## Signed reading schema (version 2)

The gateway signs the UTF-8 bytes of this JSON with Ed25519. Property order is
fixed and unknown properties are ignored. The half-open interval
`[intervalStart, intervalEnd)` includes its start and excludes its end; that
convention prevents adjacent readings from claiming the same boundary
instant. Both times must be canonical UTC ISO-8601 strings. Intervals must be
positive and no longer than 24 hours. The interval end must be within five
minutes behind or one minute ahead of API server time when first submitted.

```json
{"schemaVersion":2,"readingId":"reading-unique-id","meterId":"meter-001","prosumerId":"0.0.12345","intervalStart":"2026-10-04T12:00:00.000Z","intervalEnd":"2026-10-04T12:15:00.000Z","intervalConvention":"[start,end)","kwhGenerated":15.75}
```

Submit the reading and detached Base64 signature:

```json
{
  "reading": {
    "schemaVersion": 2,
    "readingId": "reading-unique-id",
    "meterId": "meter-001",
    "prosumerId": "0.0.12345",
    "intervalStart": "2026-10-04T12:00:00.000Z",
    "intervalEnd": "2026-10-04T12:15:00.000Z",
    "intervalConvention": "[start,end)",
    "kwhGenerated": 15.75
  },
  "signature": "BASE64_ED25519_SIGNATURE"
}
```

`kwhGenerated` must use 0.01 kWh increments to match the configured HTS
token precision. The account ID and meter ID are assertions made by the
trusted gateway; production enrollment must ensure that the gateway is only
authorized to make the assigned meter/account attestations.

## API and public evidence

- `GET /api/oracle/gateway` returns the active public key, algorithm, schema
  version, and key fingerprint. It never returns a private key.
- `POST /api/oracle/readings` verifies the gateway signature, checks interval
  bounds/freshness, and reserves both the reading ID and meter interval in
  PostgreSQL before chain operations. Reuse of either ID or interval is
  rejected, including concurrent requests on different API instances.
- After HCS confirms, the immutable message includes the signed reading,
  detached signature, gateway public key/fingerprint, Testnet network, and
  energy token ID. Its topic sequence and consensus time are Hedera's ordered
  inclusion evidence.
- `GET /api/oracle/readings/{readingId}` returns the original signed payload,
  key fingerprint, attestation/credit status, HCS topic and transaction IDs,
  consensus timestamp when available, and public HashScan links. Anyone with
  the reading ID can inspect and independently verify the signature.

Do not put names, home addresses, or other personal information into a meter
ID, gateway payload, HCS message, or public evidence. HCS messages are public
and permanent. A valid signature means the configured key signed those exact
bytes; it is not an independent certification of meter calibration or
physical delivery.

## P2P agreement and dispute handling

Before a P2P trade, the buyer and seller should agree in writing on:

1. The registered meter and account attribution, and what the measured kWh
   represents (generated, exported, delivered, or another defined quantity).
2. The measurement interval convention, units, rounding, allowed tolerance,
   corrections, and how duplicate or missing readings are handled.
3. Which gateway keys and calibration/maintenance process they trust.
4. A dispute deadline, the evidence each party must provide, response times,
   who decides unresolved disputes, and the available remedies.
5. That HBAR payments are direct and irreversible at the protocol level:
   EnergySwap does not custody funds, guarantee grid delivery, or automatically
   reverse a confirmed payment.

For a dispute, both parties can use the public evidence endpoint and HCS
transaction to identify the exact meter, account, interval, quantity, gateway
key, and consensus-ordered attestation. They should preserve the payment
transaction ID, compare it with the agreed meter interval/tolerance, exchange
their written positions under the agreed process, and record the jointly
accepted outcome with the relevant transaction/evidence references.

The API currently publishes and retrieves evidence; it does not authenticate
trade-party statements, open or adjudicate disputes, enforce an agreement,
or record a jointly signed resolution. Those functions require participant
wallet authorization and a mutually accepted dispute-policy version in the
trade flow before they can be treated as platform capabilities.

## Chain-operation recovery

Reading IDs and `(meterId, intervalStart, intervalEnd)` are unique in
PostgreSQL. A pending or uncertain HCS/HTS operation is not automatically
replayed: this prevents a timeout from resulting in a duplicate token credit.
The operator must inspect the HCS/HTS transaction IDs and current database
status, verify what the network accepted, and document reconciliation before
taking any further action. HCS submission and HTS credit are separate chain
transactions, not atomic.

The API and HCS topic are configured for Hedera Testnet only. Mainnet
attestations, production gateway enrollment, multi-key rotation, participant
wallet authentication, and an in-product dispute lifecycle are not enabled.
