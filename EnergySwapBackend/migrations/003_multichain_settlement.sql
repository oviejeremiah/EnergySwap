ALTER TABLE offers
    ADD COLUMN settlement_network text NOT NULL DEFAULT 'hedera-testnet',
    ADD COLUMN settlement_asset text NOT NULL DEFAULT 'HBAR',
    ADD COLUMN seller_address text,
    ADD COLUMN price_per_kwh numeric(38, 18);

UPDATE offers
SET seller_address = prosumer_id,
    price_per_kwh = hbar_per_kwh;

ALTER TABLE offers
    ALTER COLUMN hbar_per_kwh DROP NOT NULL,
    ALTER COLUMN total_hbar DROP NOT NULL,
    ALTER COLUMN seller_address SET NOT NULL,
    ALTER COLUMN price_per_kwh SET NOT NULL,
    ADD CONSTRAINT offers_settlement_network_asset_check CHECK (
        (settlement_network = 'hedera-testnet' AND settlement_asset = 'HBAR')
        OR (settlement_network = 'ethereum-sepolia' AND settlement_asset = 'ETH')
        OR (settlement_network = 'bitcoin-testnet' AND settlement_asset = 'BTC')
    );

ALTER TABLE trades
    ADD COLUMN settlement_network text NOT NULL DEFAULT 'hedera-testnet',
    ADD COLUMN settlement_asset text NOT NULL DEFAULT 'HBAR',
    ADD COLUMN buyer_address text,
    ADD COLUMN seller_address text,
    ADD COLUMN payment_amount numeric(38, 18),
    ADD COLUMN payment_fee numeric(38, 18);

UPDATE trades
SET buyer_address = buyer_id,
    seller_address = seller_id,
    payment_amount = hbar_amount,
    payment_fee = gas_fee_hbar;

ALTER TABLE trades
    ALTER COLUMN hbar_amount DROP NOT NULL,
    ALTER COLUMN hbar_per_kwh DROP NOT NULL,
    ALTER COLUMN gas_fee_hbar DROP NOT NULL,
    ALTER COLUMN total_hbar_paid DROP NOT NULL,
    ALTER COLUMN hbar_price_usd DROP NOT NULL,
    ALTER COLUMN gas_fee_usd DROP NOT NULL,
    ALTER COLUMN buyer_address SET NOT NULL,
    ALTER COLUMN seller_address SET NOT NULL,
    ALTER COLUMN payment_amount SET NOT NULL,
    ALTER COLUMN payment_fee SET NOT NULL,
    DROP CONSTRAINT IF EXISTS trades_transaction_id_key,
    ADD CONSTRAINT trades_settlement_network_asset_check CHECK (
        (settlement_network = 'hedera-testnet' AND settlement_asset = 'HBAR')
        OR (settlement_network = 'ethereum-sepolia' AND settlement_asset = 'ETH')
        OR (settlement_network = 'bitcoin-testnet' AND settlement_asset = 'BTC')
    ),
    ADD CONSTRAINT trades_settlement_network_transaction_id_key UNIQUE (settlement_network, transaction_id);
