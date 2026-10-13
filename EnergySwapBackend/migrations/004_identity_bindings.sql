-- Identity bindings: prove an EVM wallet and a Hedera account belong to the
-- same person, on-chain, without trusting this platform.
--
-- EnergySwap lets someone sign in with any wallet while settling in HBAR from a
-- Hedera account. Those wallets are deliberately different — the sign-in wallet
-- should hold nothing, so compromising it yields no funds. This table records
-- the link between them.
--
-- The link is evidenced by a Hedera Consensus Service message whose *payer* is
-- the Hedera account being bound. The mirror node exposes that payer publicly,
-- so any third party can re-verify a row here without trusting this database.
-- The columns below are therefore a cache of an on-chain fact, not the proof
-- itself.
--
-- addresses are stored lowercase: EIP-55 checksum casing is presentation only,
-- and treating 0xAbC and 0xabc as different accounts would let one binding be
-- written and read under two spellings.

CREATE TABLE IF NOT EXISTS identity_bindings (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    evm_address         text        NOT NULL,
    evm_chain_id        integer     NOT NULL DEFAULT 1,
    hedera_account_id   text        NOT NULL,
    topic_id            text        NOT NULL,
    sequence_number     bigint,
    consensus_timestamp text,
    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT identity_bindings_evm_address_check CHECK (evm_address ~ '^0x[0-9a-f]{40}$'),
    CONSTRAINT identity_bindings_hedera_check CHECK (hedera_account_id ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
    CONSTRAINT identity_bindings_topic_check CHECK (topic_id ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),

    -- One Hedera account may be linked to exactly one EVM identity at a time.
    -- Without this, a compromised wallet could add a second identity and split
    -- the energy balance to dodge per-account limits.
    CONSTRAINT identity_bindings_hedera_unique UNIQUE (hedera_account_id)
);

-- Lookups run in both directions: "what may this EVM wallet trade?" on every
-- authenticated request, and "is this Hedera account already bound?" when
-- issuing a nonce.
--
-- A plain index, not UNIQUE. Enforcing one-to-one is added in migration 005,
-- which is where the dedupe step lives - CREATE UNIQUE INDEX fails outright if
-- duplicates already exist, so it cannot simply be retrofitted here.
CREATE INDEX IF NOT EXISTS identity_bindings_evm_idx ON identity_bindings (evm_address);

-- Evidence columns are kept for audit. They are deliberately NOT used to
-- re-validate: verification always re-reads the mirror node, so a tampered
-- row cannot make a binding appear valid.
COMMENT ON TABLE identity_bindings IS
    'On-chain proof that an EVM sign-in wallet and a Hedera settlement account share an owner. Verify against the Hedera mirror node before trusting a row; payer_account_id of the attestation must equal hedera_account_id.';

COMMENT ON COLUMN identity_bindings.sequence_number IS
    'Consensus sequence number of the attestation, for auditing. Not used for authorisation.';