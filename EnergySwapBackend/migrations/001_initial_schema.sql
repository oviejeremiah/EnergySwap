CREATE TABLE offers (
    id text PRIMARY KEY,
    prosumer_id text NOT NULL,
    energy_amount_kwh numeric(20, 8) NOT NULL CHECK (energy_amount_kwh > 0),
    hbar_per_kwh numeric(20, 8) NOT NULL CHECK (hbar_per_kwh > 0),
    total_hbar numeric(20, 8) NOT NULL CHECK (total_hbar >= 0),
    created_at timestamptz NOT NULL,
    status text NOT NULL CHECK (status IN ('available', 'completed'))
);

CREATE INDEX offers_status_created_at_idx ON offers (status, created_at DESC);
CREATE INDEX offers_prosumer_created_at_idx ON offers (prosumer_id, created_at DESC);

CREATE TABLE trades (
    id text PRIMARY KEY,
    offer_id text NOT NULL REFERENCES offers(id),
    buyer_id text NOT NULL,
    seller_id text NOT NULL,
    transaction_id text NOT NULL UNIQUE,
    energy_amount_kwh numeric(20, 8) NOT NULL CHECK (energy_amount_kwh > 0),
    hbar_amount numeric(20, 8) NOT NULL CHECK (hbar_amount > 0),
    hbar_per_kwh numeric(20, 8) NOT NULL CHECK (hbar_per_kwh > 0),
    gas_fee_hbar numeric(20, 8) NOT NULL CHECK (gas_fee_hbar >= 0),
    total_hbar_paid numeric(20, 8) NOT NULL CHECK (total_hbar_paid > 0),
    hbar_price_usd numeric(20, 8) NOT NULL CHECK (hbar_price_usd >= 0),
    gas_fee_usd numeric(20, 8) NOT NULL CHECK (gas_fee_usd >= 0),
    created_at timestamptz NOT NULL,
    status text NOT NULL CHECK (status IN ('completed', 'reconciliation_required'))
);

CREATE INDEX trades_created_at_idx ON trades (created_at DESC);
CREATE INDEX trades_offer_created_at_idx ON trades (offer_id, created_at DESC);

CREATE TABLE meter_readings (
    reading_id text PRIMARY KEY,
    meter_id text NOT NULL,
    prosumer_id text NOT NULL,
    kwh_generated numeric(20, 2) NOT NULL CHECK (kwh_generated > 0),
    reading_timestamp timestamptz NOT NULL,
    canonical_reading text NOT NULL,
    signature text NOT NULL,
    token_units bigint NOT NULL CHECK (token_units > 0),
    status text NOT NULL CHECK (
        status IN (
            'hcs_pending',
            'attested_pending_credit',
            'credit_pending',
            'credited',
            'rejected',
            'reconciliation_required'
        )
    ),
    received_at timestamptz NOT NULL,
    credited_at timestamptz,
    hcs_transaction_id text,
    hts_transaction_id text,
    error text
);

CREATE INDEX meter_readings_status_received_at_idx ON meter_readings (status, received_at);
