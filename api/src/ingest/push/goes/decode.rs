//! Decode one GOES-19 ABI L2 NetCDF4 object (HDF5 on disk) into GOES-grid rows (T7), one
//! window per app region (PLAN.md C-A4).
//!
//! Only each region's bbox hyperslab of each variable is read; a region the file's sector does
//! not reach (CONUS vs the Colombian Caribbean) reads nothing and yields no rows. Product rules, from each file's
//! `flag_values`/`flag_meanings` (checked against the fixtures in `api/fixtures/goes`):
//!
//! - LSTC `LST` (u16, K). Domain: land. The LST `DQF` (0 high, 1 medium, 2 low quality, 3 no
//!   retrieval) cannot tell water from cloud, both are "no retrieval", so the domain comes from
//!   `PQI` bits 6-7 (`surface_type`: 0 land, 64 snow/ice, 128 inland water, 192 coastal). In the
//!   fixtures the open sea carries 192, so land = classes 0 and 64; inland water and 192 are skipped.
//!   Land pixels: DQF 0/1 -> value in C; DQF 2/3 with PQI cloud bits 2-3 >= probably cloudy -> cloud;
//!   other DQF 2/3 -> bad_dqf. A cell needs one land pixel to produce a row.
//! - SSTF `SST` (u16, K). Domain: water = DQF 0 good, 1 degraded, 2 severely degraded (cloudy water
//!   is 2 in the fixtures); DQF 3 "invalid due to unprocessed" is land and skipped. DQF 0 -> value;
//!   1/2 -> bad_dqf. A cell needs one water pixel to produce a row.
//! - FDCC `Power` (f32, MW): only pixels whose `Mask` is a fire class (10-15, 30-35) produce a row;
//!   the absence of fire is the absence of a row, so a 5-minute product does not write nulls.
//! - ACMC `BCM`: cloudy pixels (BCM 1, DQF good or degraded) produce `lst_c` rows flagged `cloud` with
//!   a null value at the ACMC scan time; clear pixels produce nothing.
//!
//! A cell inside a product's domain whose sampled pixels are all flagged is stored flagged
//! (see `GridMap::aggregate`); dropping applies only to pixels outside the domain.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use hdf5_metno as hdf5;
use ndarray::{s, Array2};

use crate::app::config::{App, Region};
use crate::ingest::push::goes_grid::{Cell, FixedGrid, GridMap, Pixel, Proj, Window};
use crate::model::{Origin, Param, ReadingRow, Row, StationKind, StationRef};

/// Unix ms of the J2000 epoch (2000-01-01T12:00:00Z), the origin of the files' `t` variable.
const J2000_UNIX_MS: i64 = 946_728_000_000;

/// LST `PQI` bit fields (flag_masks in the file).
const PQI_CLOUD_MASK: u32 = 12;
const PQI_PROBABLY_CLOUDY: u32 = 8;
const PQI_SURFACE_MASK: u32 = 192;
const PQI_SURFACE_INLAND_WATER: u32 = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Product {
    Lst,
    Sst,
    Fdc,
    Acm,
}

impl Product {
    pub const ALL: [Product; 4] = [Product::Lst, Product::Sst, Product::Fdc, Product::Acm];

    /// S3 key prefix, also the first path segment of every object key.
    pub fn prefix(self) -> &'static str {
        match self {
            Product::Lst => "ABI-L2-LSTC",
            Product::Sst => "ABI-L2-SSTF",
            Product::Fdc => "ABI-L2-FDCC",
            Product::Acm => "ABI-L2-ACMC",
        }
    }

    /// Product from an S3 key (`ABI-L2-LSTC/2026/272/15/OR_...nc`) or a bare file name (`OR_ABI-L2-LSTC-...`).
    pub fn from_key(key: &str) -> Option<Product> {
        let name = key.rsplit('/').next().unwrap_or(key);
        Product::ALL
            .into_iter()
            .find(|p| key.starts_with(&format!("{}/", p.prefix())) || name.starts_with(&format!("OR_{}-", p.prefix())))
    }

    pub fn param(self) -> Param {
        match self {
            Product::Lst | Product::Acm => Param::LstC,
            Product::Sst => Param::SstC,
            Product::Fdc => Param::FireFrp,
        }
    }
}

#[derive(Debug)]
pub struct Decoded {
    pub product: Product,
    /// Scan mid-point, unix ms.
    pub observed_at: i64,
    /// The pixel window read for each region, in region order (empty when the sector misses it).
    pub windows: Vec<Window>,
    /// Every region's cells, tagged with `Cell::region`.
    pub cells: Vec<Cell>,
}

#[cfg(test)]
impl Decoded {
    /// Region 0's window (the pre-pivot single-region view).
    pub fn window(&self) -> Window {
        self.windows[0]
    }
}

/// Decode from bytes in memory. HDF5 needs a path, so the bytes go through a temp file that is
/// removed afterwards; the function stays deterministic for a given payload.
pub fn decode_bytes(bytes: &[u8], product: Product, app: &App) -> Result<Decoded> {
    struct Temp(PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let tmp = Temp(std::env::temp_dir().join(format!("goes-{}.nc", uuid::Uuid::now_v7())));
    std::fs::write(&tmp.0, bytes).with_context(|| format!("write {}", tmp.0.display()))?;
    decode_file(&tmp.0, product, app)
}

pub fn decode_file(path: &Path, product: Product, app: &App) -> Result<Decoded> {
    let file = hdf5::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let grid = fixed_grid(&file)?;
    let t: f64 = file.dataset("t")?.read_scalar().context("t")?;
    let observed_at = J2000_UNIX_MS + (t * 1000.0).round() as i64;
    let mut windows = Vec::with_capacity(app.regions.len());
    let mut cells = Vec::new();
    for region in &app.regions {
        let map = GridMap::for_grid(&grid, &region.layout.env);
        windows.push(map.window);
        if !map.covers() {
            continue;
        }
        let mut region_cells = decode_region(&file, product, &map)?;
        for c in &mut region_cells {
            c.region = region.idx;
        }
        cells.extend(region_cells);
    }
    Ok(Decoded { product, observed_at, windows, cells })
}

/// One region's window of the product, aggregated to its GOES cells.
fn decode_region(file: &hdf5::File, product: Product, map: &GridMap) -> Result<Vec<Cell>> {
    let w = map.window;
    Ok(match product {
        Product::Lst => {
            let ds = file.dataset("LST")?;
            let (scale, offset) = (attr_f64(&ds, "scale_factor")?, attr_f64(&ds, "add_offset")?);
            let fill = attr_f64(&ds, "_FillValue")?;
            let valid = attr_vec(&ds, "valid_range")?;
            let dqf = file.dataset("DQF")?;
            let dqf_fill = attr_f64(&dqf, "_FillValue")?;
            let raw = window(&ds, &w)?;
            let q = window(&dqf, &w)?;
            let pqi = window(&file.dataset("PQI")?, &w)?;
            map.aggregate(|i| {
                let (v, q, p) = (raw[i], q[i], pqi[i] as u32);
                if q == dqf_fill || p & PQI_SURFACE_MASK >= PQI_SURFACE_INLAND_WATER {
                    Pixel::Skip
                } else if q > 1.0 {
                    if p & PQI_CLOUD_MASK >= PQI_PROBABLY_CLOUDY {
                        Pixel::Cloud
                    } else {
                        Pixel::Bad
                    }
                } else if v == fill || v < valid[0] || v > valid[1] {
                    Pixel::Missing
                } else {
                    Pixel::Good(v * scale + offset - 273.15)
                }
            })
        }
        Product::Sst => {
            let ds = file.dataset("SST")?;
            let (scale, offset) = (attr_f64(&ds, "scale_factor")?, attr_f64(&ds, "add_offset")?);
            let fill = attr_f64(&ds, "_FillValue")?;
            let valid = attr_vec(&ds, "valid_range")?;
            let dqf = file.dataset("DQF")?;
            let dqf_fill = attr_f64(&dqf, "_FillValue")?;
            let raw = window(&ds, &w)?;
            let q = window(&dqf, &w)?;
            map.aggregate(|i| {
                let (v, q) = (raw[i], q[i]);
                if q == dqf_fill || q >= 3.0 {
                    Pixel::Skip
                } else if q > 0.0 {
                    Pixel::Bad
                } else if v == fill || v < valid[0] || v > valid[1] {
                    Pixel::Missing
                } else {
                    Pixel::Good(v * scale + offset - 273.15)
                }
            })
        }
        Product::Fdc => {
            let power = file.dataset("Power")?;
            let fill = attr_f64(&power, "_FillValue")?;
            let p = window(&power, &w)?;
            let m = window(&file.dataset("Mask")?, &w)?;
            map.aggregate(|i| {
                let mask = m[i] as i32;
                let fire = (10..=15).contains(&mask) || (30..=35).contains(&mask);
                if fire && p[i] != fill && p[i] >= 0.0 {
                    Pixel::Good(p[i])
                } else {
                    Pixel::Skip
                }
            })
        }
        Product::Acm => {
            let bcm = window(&file.dataset("BCM")?, &w)?;
            let q = window(&file.dataset("DQF")?, &w)?;
            // DQF 0 good_quality_qf, 6 degraded_quality_qf; 1 bad, 2 space, 255 fill are skipped.
            map.aggregate(|i| if bcm[i] == 1.0 && (q[i] == 0.0 || q[i] == 6.0) { Pixel::Cloud } else { Pixel::Skip })
        }
    })
}

/// Station ext id of a GOES cell: `g5:<col>:<row>` in a single-region app (unchanged from before
/// the pivot), `g5:<region>:<col>:<row>` when the app has several regions, so two regions'
/// cells never share an id.
pub fn cell_ext_id(app: &App, region: &Region, idx: usize) -> String {
    let cell = region.layout.env.cell_id(idx);
    if app.single_region() {
        format!("g5:{cell}")
    } else {
        format!("g5:{}:{cell}", region.id())
    }
}

/// Rows for the ingest pipeline: one satellite reading per aggregated cell, station = the cell.
pub fn rows(d: &Decoded, app: &App) -> Vec<Row> {
    d.cells
        .iter()
        .map(|c| {
            let region = &app.regions[c.region as usize];
            let id = cell_ext_id(app, region, c.idx);
            let (lon, lat) = region.layout.env.center(c.idx);
            Row::Reading(ReadingRow {
                station: StationRef { name: format!("GOES cell {id}"), ext_id: id, lat, lon, kind: StationKind::GoesCell },
                param: d.product.param(),
                value: c.value,
                flag: c.flag,
                observed_at: d.observed_at,
                origin: Origin::Satellite,
            })
        })
        .collect()
}

fn fixed_grid(file: &hdf5::File) -> Result<FixedGrid> {
    let gp = file.dataset("goes_imager_projection").context("goes_imager_projection")?;
    let proj = Proj::new(
        attr_f64(&gp, "perspective_point_height")?,
        attr_f64(&gp, "semi_major_axis")?,
        attr_f64(&gp, "semi_minor_axis")?,
        attr_f64(&gp, "longitude_of_projection_origin")?,
    );
    let x = file.dataset("x").context("x")?;
    let y = file.dataset("y").context("y")?;
    Ok(FixedGrid {
        proj,
        x0: attr_f64(&x, "add_offset")?,
        dx: attr_f64(&x, "scale_factor")?,
        nx: x.shape()[0],
        y0: attr_f64(&y, "add_offset")?,
        dy: attr_f64(&y, "scale_factor")?,
        ny: y.shape()[0],
    })
}

/// Numeric attribute (any integer or float type; HDF5 converts) as f64.
fn attr_f64(ds: &hdf5::Dataset, name: &str) -> Result<f64> {
    attr_vec(ds, name)?.first().copied().with_context(|| format!("attribute {name} is empty"))
}

fn attr_vec(ds: &hdf5::Dataset, name: &str) -> Result<Vec<f64>> {
    ds.attr(name).and_then(|a| a.read_raw::<f64>()).with_context(|| format!("attribute {name}"))
}

/// The bbox hyperslab of a 2-D (y, x) variable as f64 in row-major window order.
fn window(ds: &hdf5::Dataset, w: &Window) -> Result<Vec<f64>> {
    let arr: Array2<f64> = ds.read_slice_2d(s![w.y0..w.y1, w.x0..w.x1]).with_context(|| format!("read {}", ds.name()))?;
    Ok(arr.iter().copied().collect())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::model::Flag;

    fn python() -> App {
        crate::hotspot::score::testkit::python_app()
    }

    /// Cells of the python region's GOES grid (68 x 64).
    fn cells_n() -> usize {
        python().regions[0].layout.env.cells()
    }

    /// First fixture whose name starts with `OR_<product prefix>`; `None` when absent.
    pub fn fixture(product: Product) -> Option<PathBuf> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/goes");
        let want = format!("OR_{}-", product.prefix());
        std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).find(|p| {
            p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(&want) && n.ends_with(".nc"))
        })
    }

    fn count(d: &Decoded, flag: Flag) -> usize {
        d.cells.iter().filter(|c| c.flag == flag).count()
    }

    /// CONUS scan s20262691801167 to e20262691803541 (day 269 = 2026-09-26): mid-point 18:02:35.4Z.
    fn conus_scan_ms() -> i64 {
        chrono::DateTime::parse_from_rfc3339("2026-09-26T18:02:35.4Z").unwrap().timestamp_millis()
    }

    fn check_station(r: &Row, param: Param) {
        let env = python().regions[0].layout.env;
        match r {
            Row::Reading(r) => {
                assert!(r.station.ext_id.starts_with("g5:"), "{}", r.station.ext_id);
                assert_eq!(r.station.ext_id.matches(':').count(), 2, "single-region id g5:<col>:<row>: {}", r.station.ext_id);
                assert_eq!(r.station.name, format!("GOES cell {}", r.station.ext_id));
                assert_eq!(r.station.kind, StationKind::GoesCell);
                assert_eq!(r.param, param);
                assert_eq!(r.origin, Origin::Satellite);
                assert!((env.south..env.north()).contains(&r.station.lat) && (env.west..env.east()).contains(&r.station.lon));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn goes_fixture_lst_land_cells_have_values_and_flags() {
        let path = fixture(Product::Lst).expect("LSTC fixture present (api/fixtures/goes/fetch.sh)");
        let app = python();
        let d = decode_file(&path, Product::Lst, &app).unwrap();
        let (ok, cloud, bad, missing) =
            (count(&d, Flag::Ok), count(&d, Flag::Cloud), count(&d, Flag::BadDqf), count(&d, Flag::Missing));
        eprintln!("LSTC window {:?} land cells {} ok {ok} cloud {cloud} bad_dqf {bad} missing {missing}", d.window(), d.cells.len());
        assert!((d.observed_at - conus_scan_ms()).abs() < 2_000, "observed_at {}", d.observed_at);
        let cells_n = cells_n();
        assert!(d.cells.len() > cells_n / 5 && d.cells.len() < cells_n * 3 / 4, "land cells only, not the sea");
        assert!(ok > 0, "some clear land cells");
        assert!(cloud > 0, "cloudy land cells are flagged, not dropped");
        assert!(d.cells.iter().filter(|c| c.flag == Flag::Ok).all(|c| (0.0..60.0).contains(&c.value.unwrap())));
        let rows = rows(&d, &app);
        assert_eq!(rows.len(), d.cells.len());
        rows.iter().for_each(|r| check_station(r, Param::LstC));
        // The south-west corner cell (Gulf of Mexico) is outside the land domain.
        assert!(rows.iter().all(|r| !matches!(r, Row::Reading(r) if r.station.ext_id == "g5:0:0")));

        // Lionfish Watch on the same CONUS file: the Keys region decodes with its own window and
        // region-qualified ids; Colombia is outside the sector and yields nothing.
        let lf = crate::ingest::poll::bio::testing::lionfish();
        let d2 = decode_file(&path, Product::Lst, &lf).unwrap();
        assert_eq!(d2.windows.len(), 4);
        assert_eq!(d2.windows[0], d.window(), "fl-keys shares the python bbox and window");
        let co = lf.region("co-caribbean").unwrap();
        assert_eq!(d2.windows[co.idx as usize].width(), 0, "no CONUS pixels over Colombia");
        assert!(d2.cells.iter().all(|c| c.region != co.idx));
        let fl: Vec<&Cell> = d2.cells.iter().filter(|c| c.region == 0).collect();
        assert_eq!(fl.len(), d.cells.len(), "same land cells as the python decode");
        let rows2 = super::rows(&d2, &lf);
        assert!(rows2.iter().all(|r| matches!(r, Row::Reading(r) if r.station.ext_id.starts_with("g5:") && r.station.ext_id.matches(':').count() == 3)), "g5:<region>:<col>:<row>");
        assert!(rows2.iter().any(|r| matches!(r, Row::Reading(r) if r.station.ext_id.starts_with("g5:fl-keys:"))));
    }

    #[test]
    fn goes_fixture_acm_has_cloud_cells() {
        let path = fixture(Product::Acm).expect("ACMC fixture present (api/fixtures/goes/fetch.sh)");
        let app = python();
        let d = decode_file(&path, Product::Acm, &app).unwrap();
        eprintln!("ACMC window {:?} cloud cells {}", d.window(), d.cells.len());
        assert!((d.observed_at - conus_scan_ms()).abs() < 2_000);
        assert!(!d.cells.is_empty() && d.cells.len() < cells_n(), "cloudy cells only");
        assert!(d.cells.iter().all(|c| c.flag == Flag::Cloud && c.value.is_none()));
        let rows = rows(&d, &app);
        rows.iter().for_each(|r| check_station(r, Param::LstC));
        assert!(rows.iter().all(|r| matches!(r, Row::Reading(r) if r.flag == Flag::Cloud && r.value.is_none())));
    }

    #[test]
    fn goes_fixture_fdc_rows_are_fires_only() {
        let path = fixture(Product::Fdc).expect("FDCC fixture present (api/fixtures/goes/fetch.sh)");
        let app = python();
        let d = decode_file(&path, Product::Fdc, &app).unwrap();
        eprintln!("FDCC window {:?} fire cells {}", d.window(), d.cells.len());
        assert!(d.cells.len() < cells_n() / 10, "fires are sparse");
        assert!(d.cells.iter().all(|c| c.flag == Flag::Ok && c.value.unwrap() > 0.0));
        rows(&d, &app).iter().for_each(|r| check_station(r, Param::FireFrp));
    }

    #[test]
    fn goes_fixture_sst_water_cells_full_disk_window() {
        let Some(path) = fixture(Product::Sst) else {
            eprintln!("SSTF fixture absent (run api/fixtures/goes/fetch.sh); skipping");
            return;
        };
        let app = python();
        let d = decode_file(&path, Product::Sst, &app).unwrap();
        let (ok, bad) = (count(&d, Flag::Ok), count(&d, Flag::BadDqf));
        eprintln!("SSTF window {:?} water cells {} ok {ok} bad_dqf {bad}", d.window(), d.cells.len());
        assert!(d.cells.len() > cells_n() / 3 && d.cells.len() < cells_n(), "water cells only, not the land");
        assert!(ok > 0 && bad > 0);
        assert!(d.cells.iter().filter(|c| c.flag == Flag::Ok).all(|c| (15.0..40.0).contains(&c.value.unwrap())));
        let rows = rows(&d, &app);
        rows.iter().for_each(|r| check_station(r, Param::SstC));
        assert!(rows.iter().any(|r| matches!(r, Row::Reading(r) if r.station.ext_id == "g5:0:0")), "Gulf corner is water");
    }

    /// Driver target: under 250k GOES rows a day. Every consumed product is hourly (ACMC only the
    /// top-of-hour scan), so rows/day = rows per hourly scan set x 24.
    #[test]
    fn goes_fixture_rows_per_scan_under_daily_budget() {
        let app = python();
        let mut per_scan = 0;
        for p in Product::ALL {
            let Some(path) = fixture(p) else {
                assert_eq!(p, Product::Sst, "{p:?} fixture is committed");
                // SSTF is fetched on demand; without it count every water cell, the worst case.
                per_scan += cells_n();
                continue;
            };
            let n = rows(&decode_file(&path, p, &app).unwrap(), &app).len();
            eprintln!("GOES rows/scan {:?} {n}", p);
            per_scan += n;
        }
        eprintln!("GOES rows/scan {per_scan} (rows/day {})", per_scan * 24);
        assert!(per_scan * 24 < 250_000, "{per_scan} rows per scan hour");
    }

    #[test]
    fn goes_fixture_decode_bytes_matches_file() {
        let path = fixture(Product::Fdc).unwrap();
        let app = python();
        let bytes = std::fs::read(&path).unwrap();
        let a = decode_bytes(&bytes, Product::Fdc, &app).unwrap();
        let b = decode_file(&path, Product::Fdc, &app).unwrap();
        assert_eq!(a.observed_at, b.observed_at);
        assert_eq!(a.cells, b.cells);
        assert!(Product::from_key("ABI-L2-LSTC/2026/272/15/OR_ABI-L2-LSTC-M6_G19_s1_e2_c3.nc") == Some(Product::Lst));
        assert!(Product::from_key("OR_ABI-L2-SSTF-M6_G19_s1_e2_c3.nc") == Some(Product::Sst));
        assert!(Product::from_key("ABI-L1b-RadC/2026/272/15/OR_ABI-L1b-RadC-M6C02_G19_s1_e2_c3.nc").is_none());
    }
}
