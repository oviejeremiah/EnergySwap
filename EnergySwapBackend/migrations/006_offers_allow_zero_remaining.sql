-- A trade may legitimately consume an offer entirely. The recording path then
-- sets the offer's remaining energy to exactly 0 - which this column's CHECK
-- constraint (energy_amount_kwh > 0) refused, so the trade that cleared an
-- offer could never be recorded: the buyer paid on-chain, the bookkeeping
-- failed with SQLSTATE 23514, and the endpoint answered HTTP 500. That is
-- recorded in the stderr log of the first-ever live trade
-- (requestId 3bdec464-61a5-41d9-b30f-f78114ea92cc).
--
-- Zero remaining is a real and expected state for a completed offer. Change the
-- bound to >= 0. Negative remains a hard error: crediting takes must never be
-- expressible.

ALTER TABLE offers DROP CONSTRAINT offers_energy_amount_kwh_check;

ALTER TABLE offers
    ADD CONSTRAINT offers_energy_amount_kwh_check
    CHECK (energy_amount_kwh >= 0);
