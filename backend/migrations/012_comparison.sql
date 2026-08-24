-- ═══════════════════════════════════════════════════════════════
-- 012 · Comparison views
--
-- Ranking lives in the database so the comparison sheet, the exports and bid
-- analysis cannot drift apart. SQLite supports window functions (3.25+), so
-- the same ROW_NUMBER() logic as the Postgres version applies.
--
-- Only vendors that actually quoted (rate > 0) are ranked, matching the
-- existing itemRank() / vendorRank() behaviour. Ties break on vendor name so
-- the ordering is stable between reloads.
-- ═══════════════════════════════════════════════════════════════

create view if not exists vendor_comparison_view as
select
  e.id                as enquiry_id,
  ei.id               as enquiry_item_id,
  ei.item_no,
  ei.short_name,
  ei.description,
  ei.unit,
  ei.quantity,
  ev.id               as enquiry_vendor_id,
  ev.vendor_id,
  coalesce(v.name, ev.vendor_name) as vendor_name,
  vql.rate,
  vql.amount,
  vql.gst_percent,
  vql.gst_amount,
  vql.total_amount,
  row_number() over (
    partition by ei.id
    order by vql.amount asc, coalesce(v.name, ev.vendor_name) asc
  ) as rank
from enquiry_items ei
join enquiries e            on e.id = ei.enquiry_id and e.deleted_at is null
join vendor_quote_lines vql on vql.enquiry_item_id = ei.id
join enquiry_vendors ev     on ev.id = vql.enquiry_vendor_id and ev.deleted_at is null
left join vendors v         on v.id = ev.vendor_id
where vql.rate > 0 and ei.item_type = 'item';

create view if not exists vendor_total_ranking_view as
select
  ev.enquiry_id,
  ev.id as enquiry_vendor_id,
  ev.vendor_id,
  coalesce(v.name, ev.vendor_name) as vendor_name,
  ev.invitation_status,
  ev.revision,
  ev.base_amount,
  ev.gst_amount,
  ev.total_amount,
  (select count(*) from vendor_quote_lines l where l.enquiry_vendor_id = ev.id and l.rate > 0) as items_quoted,
  row_number() over (
    partition by ev.enquiry_id
    order by ev.base_amount asc, coalesce(v.name, ev.vendor_name) asc
  ) as rank
from enquiry_vendors ev
left join vendors v on v.id = ev.vendor_id
where ev.deleted_at is null and ev.base_amount > 0;
