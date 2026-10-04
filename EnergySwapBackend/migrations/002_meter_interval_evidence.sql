ALTER TABLE meter_readings
    ADD COLUMN interval_start timestamptz,
    ADD COLUMN interval_end timestamptz,
    ADD COLUMN hcs_topic_id text,
    ADD COLUMN gateway_public_key text,
    ADD COLUMN gateway_key_fingerprint text,
    ADD COLUMN attested_at timestamptz,
    ADD COLUMN hcs_consensus_timestamp timestamptz;

ALTER TABLE meter_readings
    ADD CONSTRAINT meter_readings_interval_order_check
        CHECK (
            (interval_start IS NULL AND interval_end IS NULL)
            OR (interval_start IS NOT NULL AND interval_end > interval_start)
        );

CREATE UNIQUE INDEX meter_readings_meter_interval_unique
    ON meter_readings (meter_id, interval_start, interval_end)
    WHERE interval_start IS NOT NULL AND interval_end IS NOT NULL;
