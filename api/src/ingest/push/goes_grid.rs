//! GOES-R fixed-grid projection and the map from ABI pixels to the 0.05 deg GOES grid (T7).
//!
//! Formulas are the GOES-R Product Definition and Users' Guide (PUG) vol. 3, section 5.1.2.8:
//! scan angles (x, y) in radians to geodetic lat/lon on the GRS80 ellipsoid, and back.
//! A [`GridMap`] is computed once per distinct ABI grid (CONUS and full disk differ) and cached:
//! it holds the x/y index window covering the bbox and, for every GOES cell, the window pixels
//! sampled at a 4x4 sub-grid of the cell. ABI pixels are ~2 km, GOES cells ~5.5 km, so each cell
//! averages about eight pixels.
//!
//! The GOES grid is the PLAN C15 bbox at 0.05 deg (driver decision on row volume): 68 x 64 cells,
//! id `g5:<col>:<row>` from the south-west corner, five times coarser than the 0.01 deg app grid.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use crate::model::Flag;

pub const WEST: f64 = -83.2;
pub const SOUTH: f64 = 24.3;
pub const CELL_DEG: f64 = 0.05;
pub const COLS: usize = 68;
pub const ROWS: usize = 64;
pub const CELLS: usize = COLS * ROWS;

/// Sub-samples per cell side. 4 gives sixteen samples about 1.4 km apart in a 5.5 km cell.
const SUB: usize = 4;
const NONE: u32 = u32::MAX;

/// Cell id `g5:<col>:<row>` from the south-west corner.
pub fn cell_id(idx: usize) -> String {
    format!("g5:{}:{}", idx % COLS, idx / COLS)
}

/// Cell centre as (lat, lon).
pub fn cell_center(idx: usize) -> (f64, f64) {
    let col = (idx % COLS) as f64;
    let row = (idx / COLS) as f64;
    (SOUTH + (row + 0.5) * CELL_DEG, WEST + (col + 0.5) * CELL_DEG)
}

/// GOES-R geostationary projection parameters, from the file's `goes_imager_projection` variable.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Proj {
    /// Satellite distance from the Earth's centre: perspective_point_height + semi_major_axis.
    pub h: f64,
    pub r_eq: f64,
    pub r_pol: f64,
    pub lon0_deg: f64,
}

impl Proj {
    pub fn new(perspective_point_height: f64, semi_major_axis: f64, semi_minor_axis: f64, lon0_deg: f64) -> Self {
        Proj { h: perspective_point_height + semi_major_axis, r_eq: semi_major_axis, r_pol: semi_minor_axis, lon0_deg }
    }

    /// (lat, lon) degrees to scan angles (radians). `None` when the point is behind the limb.
    pub fn to_scan(self, lat_deg: f64, lon_deg: f64) -> Option<(f64, f64)> {
        let e2 = (self.r_eq * self.r_eq - self.r_pol * self.r_pol) / (self.r_eq * self.r_eq);
        let phi_c = ((self.r_pol * self.r_pol) / (self.r_eq * self.r_eq) * lat_deg.to_radians().tan()).atan();
        let r_c = self.r_pol / (1.0 - e2 * phi_c.cos().powi(2)).sqrt();
        let dlon = (lon_deg - self.lon0_deg).to_radians();
        let s_x = self.h - r_c * phi_c.cos() * dlon.cos();
        let s_y = -r_c * phi_c.cos() * dlon.sin();
        let s_z = r_c * phi_c.sin();
        let ratio = self.r_eq * self.r_eq / (self.r_pol * self.r_pol);
        if self.h * (self.h - s_x) < s_y * s_y + ratio * s_z * s_z {
            return None;
        }
        let y = (s_z / s_x).atan();
        let x = (-s_y / (s_x * s_x + s_y * s_y + s_z * s_z).sqrt()).asin();
        Some((x, y))
    }
}

/// One ABI product grid: `x[i] = x0 + i * dx`, `y[j] = y0 + j * dy` (dy is negative, north first).
#[derive(Debug, Clone, PartialEq)]
pub struct FixedGrid {
    pub proj: Proj,
    pub x0: f64,
    pub dx: f64,
    pub nx: usize,
    pub y0: f64,
    pub dy: f64,
    pub ny: usize,
}

impl FixedGrid {
    /// Nearest pixel (column, row) for a scan angle, or `None` outside the grid.
    pub fn index(&self, x: f64, y: f64) -> Option<(usize, usize)> {
        let i = ((x - self.x0) / self.dx).round();
        let j = ((y - self.y0) / self.dy).round();
        if i < 0.0 || j < 0.0 || i >= self.nx as f64 || j >= self.ny as f64 {
            return None;
        }
        Some((i as usize, j as usize))
    }

    fn key(&self) -> GridKey {
        GridKey {
            bits: [self.proj.h, self.proj.r_eq, self.proj.r_pol, self.proj.lon0_deg, self.x0, self.dx, self.y0, self.dy]
                .map(f64::to_bits),
            nx: self.nx,
            ny: self.ny,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct GridKey {
    bits: [u64; 8],
    nx: usize,
    ny: usize,
}

/// Half-open pixel index ranges to read from the file: `[x0, x1)` columns, `[y0, y1)` rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub x0: usize,
    pub x1: usize,
    pub y0: usize,
    pub y1: usize,
}

impl Window {
    pub fn width(&self) -> usize {
        self.x1 - self.x0
    }
}

/// Bbox window plus, per app cell, the window-relative flat pixel index of each sub-sample.
#[derive(Debug)]
pub struct GridMap {
    pub window: Window,
    samples: Vec<[u32; SUB * SUB]>,
}

/// One pixel as seen by a product's classifier.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Pixel {
    Good(f64),
    Cloud,
    Bad,
    /// Fill value with a good quality flag.
    Missing,
    /// Contributes nothing (off-grid, no-fire, clear sky for a cloud product).
    Skip,
}

/// Aggregated app cell. `value` is the mean of the good pixels when `flag` is `Ok`, else `None`.
#[derive(Debug, Clone, PartialEq)]
pub struct Cell {
    pub idx: usize,
    pub value: Option<f64>,
    pub flag: Flag,
}

impl GridMap {
    /// Cached map for a grid; built on first use (about 70k forward projections, a few ms).
    pub fn for_grid(grid: &FixedGrid) -> Arc<GridMap> {
        static MAPS: OnceLock<Mutex<HashMap<GridKey, Arc<GridMap>>>> = OnceLock::new();
        let maps = MAPS.get_or_init(|| Mutex::new(HashMap::new()));
        let key = grid.key();
        if let Some(m) = maps.lock().unwrap().get(&key) {
            return m.clone();
        }
        let built = Arc::new(GridMap::build(grid));
        maps.lock().unwrap().entry(key).or_insert(built).clone()
    }

    pub fn build(grid: &FixedGrid) -> GridMap {
        // Absolute pixel indices first, then shrink to the window and make them relative.
        let mut abs: Vec<[Option<(usize, usize)>; SUB * SUB]> = Vec::with_capacity(CELLS);
        let (mut x0, mut x1, mut y0, mut y1) = (usize::MAX, 0usize, usize::MAX, 0usize);
        for idx in 0..CELLS {
            let col = (idx % COLS) as f64;
            let row = (idx / COLS) as f64;
            let mut s = [None; SUB * SUB];
            for (k, slot) in s.iter_mut().enumerate() {
                let fx = (k % SUB) as f64 + 0.5;
                let fy = (k / SUB) as f64 + 0.5;
                let lon = WEST + (col + fx / SUB as f64) * CELL_DEG;
                let lat = SOUTH + (row + fy / SUB as f64) * CELL_DEG;
                *slot = grid.proj.to_scan(lat, lon).and_then(|(x, y)| grid.index(x, y));
                if let Some((i, j)) = *slot {
                    x0 = x0.min(i);
                    x1 = x1.max(i + 1);
                    y0 = y0.min(j);
                    y1 = y1.max(j + 1);
                }
            }
            abs.push(s);
        }
        if x0 == usize::MAX {
            // Grid does not cover the bbox at all: empty window, no samples.
            return GridMap { window: Window { x0: 0, x1: 0, y0: 0, y1: 0 }, samples: vec![[NONE; SUB * SUB]; CELLS] };
        }
        let window = Window { x0, x1, y0, y1 };
        let w = window.width();
        let samples = abs
            .iter()
            .map(|s| s.map(|p| p.map_or(NONE, |(i, j)| ((j - y0) * w + (i - x0)) as u32)))
            .collect();
        GridMap { window, samples }
    }

    /// Aggregate every cell. `classify` receives a window-relative flat index (`row * width + col`).
    /// Rules: any good pixel gives the mean and `Ok`; else cloud beats bad beats missing; cells with
    /// only `Skip` pixels produce nothing.
    pub fn aggregate(&self, classify: impl Fn(usize) -> Pixel) -> Vec<Cell> {
        let mut out = Vec::new();
        for (idx, samples) in self.samples.iter().enumerate() {
            let (mut sum, mut good, mut cloud, mut bad, mut missing) = (0.0, 0usize, 0usize, 0usize, 0usize);
            for &s in samples {
                if s == NONE {
                    continue;
                }
                match classify(s as usize) {
                    Pixel::Good(v) => {
                        sum += v;
                        good += 1;
                    }
                    Pixel::Cloud => cloud += 1,
                    Pixel::Bad => bad += 1,
                    Pixel::Missing => missing += 1,
                    Pixel::Skip => {}
                }
            }
            let (value, flag) = if good > 0 {
                (Some(sum / good as f64), Flag::Ok)
            } else if cloud > 0 {
                (None, Flag::Cloud)
            } else if bad > 0 {
                (None, Flag::BadDqf)
            } else if missing > 0 {
                (None, Flag::Missing)
            } else {
                continue;
            };
            out.push(Cell { idx, value, flag });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Test-only inverse projection and window height: the decoder only projects lat/lon to scan angles.
    impl Proj {
        /// GOES-East nominal parameters (PUG table 5.1.2.8). Files carry the same values; tests use this.
        pub fn goes_east() -> Self {
            Proj::new(35_786_023.0, 6_378_137.0, 6_356_752.314_14, -75.0)
        }

        /// Scan angles (radians) to (lat, lon) degrees. `None` when the ray misses the Earth.
        pub fn to_lat_lon(self, x: f64, y: f64) -> Option<(f64, f64)> {
            let (sx, cx) = x.sin_cos();
            let (sy, cy) = y.sin_cos();
            let ratio = self.r_eq * self.r_eq / (self.r_pol * self.r_pol);
            let a = sx * sx + cx * cx * (cy * cy + ratio * sy * sy);
            let b = -2.0 * self.h * cx * cy;
            let c = self.h * self.h - self.r_eq * self.r_eq;
            let disc = b * b - 4.0 * a * c;
            if disc < 0.0 {
                return None;
            }
            let r_s = (-b - disc.sqrt()) / (2.0 * a);
            let s_x = r_s * cx * cy;
            let s_y = -r_s * sx;
            let s_z = r_s * cx * sy;
            let lat = (ratio * s_z / ((self.h - s_x).powi(2) + s_y * s_y).sqrt()).atan();
            let lon = self.lon0_deg.to_radians() - (s_y / (self.h - s_x)).atan();
            Some((lat.to_degrees(), lon.to_degrees()))
        }
    }

    impl Window {
        fn height(&self) -> usize {
            self.y1 - self.y0
        }
    }

    /// ABI CONUS 2 km grid as written in every GOES-19 CONUS file (x/y scale_factor and add_offset).
    pub fn conus_2km() -> FixedGrid {
        FixedGrid { proj: Proj::goes_east(), x0: -0.101332, dx: 5.6e-05, nx: 2500, y0: 0.128212, dy: -5.6e-05, ny: 1500 }
    }

    #[test]
    fn goes_grid_pug_example_scan_angle_to_lat_lon() {
        // PUG vol. 3 section 5.1.2.8.1 worked example (GOES-East, lon0 = -75).
        let (lat, lon) = Proj::goes_east().to_lat_lon(-0.024052, 0.095340).unwrap();
        assert!((lat - 33.846162).abs() < 0.01, "lat {lat}");
        assert!((lon + 84.690932).abs() < 0.01, "lon {lon}");
    }

    #[test]
    fn goes_grid_image_center_matches_file_geospatial_extent() {
        // CONUS files: x_image = -0.03136, y_image = 0.08624; geospatial_lat_lon_extent centre 30.083, -87.097.
        let (lat, lon) = Proj::goes_east().to_lat_lon(-0.03136, 0.08624).unwrap();
        assert!((lat - 30.083).abs() < 0.01, "lat {lat}");
        assert!((lon + 87.097).abs() < 0.01, "lon {lon}");
    }

    #[test]
    fn goes_grid_forward_inverse_round_trip() {
        let p = Proj::goes_east();
        for (lat, lon) in [(24.3, -83.2), (27.5, -79.8), (25.7617, -80.1918), (0.0, -75.0)] {
            let (x, y) = p.to_scan(lat, lon).unwrap();
            let (lat2, lon2) = p.to_lat_lon(x, y).unwrap();
            assert!((lat - lat2).abs() < 1e-6 && (lon - lon2).abs() < 1e-6, "{lat},{lon} -> {lat2},{lon2}");
        }
        assert!(p.to_lat_lon(0.2, 0.2).is_none(), "off-earth ray");
        assert!(p.to_scan(0.0, 120.0).is_none(), "far side of the Earth");
    }

    #[test]
    fn goes_grid_window_and_samples_cover_bbox() {
        let map = GridMap::build(&conus_2km());
        let w = map.window;
        assert!(w.x0 < w.x1 && w.x1 <= 2500 && w.y0 < w.y1 && w.y1 <= 1500, "{w:?}");
        // 3.4 deg of longitude at 2 km near 26N is roughly 170 pixels; allow for the viewing angle.
        assert!((120..=260).contains(&w.width()) && (120..=260).contains(&w.height()), "{w:?}");
        assert_eq!(map.samples.len(), CELLS);
        assert!(map.samples.iter().all(|s| s.iter().all(|&i| i != NONE)), "every cell sampled");
        let max = map.samples.iter().flatten().copied().max().unwrap() as usize;
        assert!(max < w.width() * w.height());
        // Cached instance is reused.
        let a = GridMap::for_grid(&conus_2km());
        let b = GridMap::for_grid(&conus_2km());
        assert!(Arc::ptr_eq(&a, &b));
    }

    #[test]
    fn goes_grid_aggregate_rules() {
        let map = GridMap::build(&conus_2km());
        let (w, h) = (map.window.width(), map.window.height());
        // Good pixels average; a cloud-only cell is flagged, not dropped; skip-only cells vanish.
        let cells = map.aggregate(|i| if i % 2 == 0 { Pixel::Good(10.0) } else { Pixel::Good(20.0) });
        assert_eq!(cells.len(), CELLS);
        assert!(cells.iter().all(|c| c.flag == Flag::Ok && (10.0..=20.0).contains(&c.value.unwrap())));
        assert!(cells.iter().any(|c| c.value.unwrap() > 10.0 && c.value.unwrap() < 20.0), "some cells straddle two pixels");
        // One good sample outranks cloudy ones in its cell; far cells do not see it.
        let w0 = map.samples[0][0] as usize;
        let one_good = map.aggregate(|i| if i == w0 { Pixel::Good(7.0) } else { Pixel::Cloud });
        assert_eq!(one_good[0], Cell { idx: 0, value: Some(7.0), flag: Flag::Ok });
        assert_eq!(one_good[CELLS - 1].flag, Flag::Cloud);
        let cloudy = map.aggregate(|_| Pixel::Cloud);
        assert_eq!(cloudy.len(), CELLS);
        assert!(cloudy.iter().all(|c| c.flag == Flag::Cloud && c.value.is_none()));
        let mixed = map.aggregate(|i| if i < w * h / 2 { Pixel::Bad } else { Pixel::Skip });
        assert!(!mixed.is_empty() && mixed.len() < CELLS);
        assert!(mixed.iter().all(|c| c.flag == Flag::BadDqf));
        assert!(map.aggregate(|_| Pixel::Skip).is_empty());
        assert_eq!(cell_id(0), "g5:0:0");
        assert_eq!(cell_id(CELLS - 1), "g5:67:63");
        let (lat, lon) = cell_center(0);
        assert!((lat - 24.325).abs() < 1e-9 && (lon + 83.175).abs() < 1e-9);
        let (lat, lon) = cell_center(CELLS - 1);
        assert!((lat - 27.475).abs() < 1e-9 && (lon + 79.825).abs() < 1e-9);
    }
}
