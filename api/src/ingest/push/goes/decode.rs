//! Decode one GOES-19 ABI L2 NetCDF4 object (HDF5 on disk) into app-grid rows (T7).
//!
//! Only the bbox hyperslab of each variable is read. Product rules, from each file's
//! `flag_values`/`flag_meanings` (checked against the fixtures in `api/fixtures/goes`):
//!
//! - LSTC `LST` (u16, K): DQF 0 high / 1 medium quality -> value in C; 2 low / 3 no retrieval -> bad_dqf.
//! - SSTF `SST` (u16, K): DQF 0 good -> value; 1 degraded / 2 severely degraded / 3 unprocessed -> bad_dqf.
//! - FDCC `Power` (f32, MW): only pixels whose `Mask` is a fire class (10-15, 30-35) produce a row;
//!   the absence of fire is the absence of a row, so a 5-minute product does not write 108,800 nulls.
//! - ACMC `BCM`: cloudy pixels (BCM 1, DQF good or degraded) produce `lst_c` rows flagged `cloud` with
//!   a null value at the ACMC scan time; clear pixels produce nothing. LSTC itself cannot tell cloud
//!   from water (both are "no retrieval"), so this is what marks a land cell as cloud-covered.
//!
//! A cell whose sampled pixels are all flagged is stored flagged (see `GridMap::aggregate`).

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use hdf5_metno as hdf5;
use ndarray::{s, Array2};

use crate::ingest::push::goes_grid::{cell_center, cell_id, Cell, FixedGrid, GridMap, Pixel, Proj, Window};
use crate::model::{Origin, Param, ReadingRow, Row, StationKind, StationRef};

/// Unix ms of the J2000 epoch (2000-01-01T12:00:00Z), the origin of the files' `t` variable.
const J2000_UNIX_MS: i64 = 946_728_000_000;

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
    pub window: Window,
    pub cells: Vec<Cell>,
}

/// Decode from bytes in memory. HDF5 needs a path, so the bytes go through a temp file that is
/// removed afterwards; the function stays deterministic for a given payload.
pub fn decode_bytes(bytes: &[u8], product: Product) -> Result<Decoded> {
    struct Temp(PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let tmp = Temp(std::env::temp_dir().join(format!("goes-{}.nc", uuid::Uuid::now_v7())));
    std::fs::write(&tmp.0, bytes).with_context(|| format!("write {}", tmp.0.display()))?;
    decode_file(&tmp.0, product)
}

pub fn decode_file(path: &Path, product: Product) -> Result<Decoded> {
    let file = hdf5::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let grid = fixed_grid(&file)?;
    let map = GridMap::for_grid(&grid);
    let w = map.window;
    let t: f64 = file.dataset("t")?.read_scalar().context("t")?;
    let observed_at = J2000_UNIX_MS + (t * 1000.0).round() as i64;

    let cells = match product {
        Product::Lst | Product::Sst => {
            let name = if product == Product::Lst { "LST" } else { "SST" };
            let ds = file.dataset(name)?;
            let (scale, offset) = (attr_f64(&ds, "scale_factor")?, attr_f64(&ds, "add_offset")?);
            let fill = attr_f64(&ds, "_FillValue")?;
            let valid = attr_vec(&ds, "valid_range")?;
            let dqf = file.dataset("DQF")?;
            let dqf_fill = attr_f64(&dqf, "_FillValue")?;
            let good_max = if product == Product::Lst { 1.0 } else { 0.0 };
            let raw = window(&ds, &w)?;
            let q = window(&dqf, &w)?;
            map.aggregate(|i| {
                let (v, q) = (raw[i], q[i]);
                if q == dqf_fill {
                    Pixel::Skip
                } else if q > good_max {
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
    };
    Ok(Decoded { product, observed_at, window: w, cells })
}

/// Rows for the ingest pipeline: one satellite reading per aggregated cell, station = the cell.
pub fn rows(d: &Decoded) -> Vec<Row> {
    d.cells
        .iter()
        .map(|c| {
            let id = cell_id(c.idx);
            let (lat, lon) = cell_center(c.idx);
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
    use crate::ingest::push::goes_grid::CELLS;
    use crate::model::Flag;

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

    #[test]
    fn goes_fixture_lst_has_values_and_flags_in_bbox() {
        let path = fixture(Product::Lst).expect("LSTC fixture present (api/fixtures/goes/fetch.sh)");
        let d = decode_file(&path, Product::Lst).unwrap();
        let (ok, bad, missing) = (count(&d, Flag::Ok), count(&d, Flag::BadDqf), count(&d, Flag::Missing));
        eprintln!("LSTC window {:?} cells {} ok {ok} bad_dqf {bad} missing {missing}", d.window, d.cells.len());
        assert!((d.observed_at - conus_scan_ms()).abs() < 2_000, "observed_at {}", d.observed_at);
        assert_eq!(d.cells.len(), CELLS, "every bbox cell is sampled by the CONUS grid");
        assert!(ok > 0, "some clear land cells");
        assert!(bad > 0, "water and cloud cells are flagged, not dropped");
        assert!(d.cells.iter().filter(|c| c.flag == Flag::Ok).all(|c| (0.0..60.0).contains(&c.value.unwrap())));
        let rows = rows(&d);
        assert_eq!(rows.len(), d.cells.len());
        match &rows[0] {
            Row::Reading(r) => {
                assert_eq!(r.station.ext_id, "0:0");
                assert_eq!(r.station.name, "GOES cell 0:0");
                assert_eq!(r.station.kind, StationKind::GoesCell);
                assert_eq!(r.param, Param::LstC);
                assert_eq!(r.origin, Origin::Satellite);
                assert!((r.station.lat - 24.305).abs() < 1e-9 && (r.station.lon + 83.195).abs() < 1e-9);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn goes_fixture_acm_has_cloud_cells() {
        let path = fixture(Product::Acm).expect("ACMC fixture present (api/fixtures/goes/fetch.sh)");
        let d = decode_file(&path, Product::Acm).unwrap();
        eprintln!("ACMC window {:?} cloud cells {}", d.window, d.cells.len());
        assert!((d.observed_at - conus_scan_ms()).abs() < 2_000);
        assert!(!d.cells.is_empty() && d.cells.len() < CELLS, "cloudy cells only");
        assert!(d.cells.iter().all(|c| c.flag == Flag::Cloud && c.value.is_none()));
        let rows = rows(&d);
        assert!(matches!(&rows[0], Row::Reading(r) if r.param == Param::LstC && r.flag == Flag::Cloud && r.value.is_none()));
    }

    #[test]
    fn goes_fixture_fdc_rows_are_fires_only() {
        let path = fixture(Product::Fdc).expect("FDCC fixture present (api/fixtures/goes/fetch.sh)");
        let d = decode_file(&path, Product::Fdc).unwrap();
        eprintln!("FDCC window {:?} fire cells {}", d.window, d.cells.len());
        assert!(d.cells.len() < CELLS / 10, "fires are sparse");
        assert!(d.cells.iter().all(|c| c.flag == Flag::Ok && c.value.unwrap() > 0.0));
        assert!(rows(&d).iter().all(|r| matches!(r, Row::Reading(r) if r.param == Param::FireFrp)));
    }

    #[test]
    fn goes_fixture_sst_full_disk_window() {
        let Some(path) = fixture(Product::Sst) else {
            eprintln!("SSTF fixture absent (run api/fixtures/goes/fetch.sh); skipping");
            return;
        };
        let d = decode_file(&path, Product::Sst).unwrap();
        let (ok, bad) = (count(&d, Flag::Ok), count(&d, Flag::BadDqf));
        eprintln!("SSTF window {:?} cells {} ok {ok} bad_dqf {bad}", d.window, d.cells.len());
        assert_eq!(d.cells.len(), CELLS);
        assert!(ok > 0 && bad > 0);
        assert!(d.cells.iter().filter(|c| c.flag == Flag::Ok).all(|c| (15.0..40.0).contains(&c.value.unwrap())));
        assert!(rows(&d).iter().all(|r| matches!(r, Row::Reading(r) if r.param == Param::SstC)));
    }

    #[test]
    fn goes_fixture_decode_bytes_matches_file() {
        let path = fixture(Product::Fdc).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let a = decode_bytes(&bytes, Product::Fdc).unwrap();
        let b = decode_file(&path, Product::Fdc).unwrap();
        assert_eq!(a.observed_at, b.observed_at);
        assert_eq!(a.cells, b.cells);
        assert!(Product::from_key("ABI-L2-LSTC/2026/272/15/OR_ABI-L2-LSTC-M6_G19_s1_e2_c3.nc") == Some(Product::Lst));
        assert!(Product::from_key("OR_ABI-L2-SSTF-M6_G19_s1_e2_c3.nc") == Some(Product::Sst));
        assert!(Product::from_key("ABI-L1b-RadC/2026/272/15/OR_ABI-L1b-RadC-M6C02_G19_s1_e2_c3.nc").is_none());
    }
}
