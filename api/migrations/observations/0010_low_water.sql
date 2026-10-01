-- NWPS low-water threshold (gauge `lowThreshold.value`, NWPS stage feet) next to the flood
-- categories (gates/leaf-E1.md G3). Null when the gauge defines none. Stage at or below it is
-- NWPS's `low_threshold` state, reported as `lowWater` on SiteStatus and SiteReview. Like the
-- flood categories, a changed value is a new row, so an as-of view uses the value known then.
alter table forecast_thresholds add column low_ft real;
