-- 040_investment_event_amount.sql — record the money figure behind each Action-History
-- row (invested capital on create/delete, realized P&L on sell) so the owner sees HOW MUCH
-- was declared / closed / removed, not just that it happened. Native VND (like investments);
-- the console formats it with the ₫/$ toggle. Nullable — an 'update' event may carry none.
ALTER TABLE company.investment_events ADD COLUMN IF NOT EXISTS amount numeric(18,4);
