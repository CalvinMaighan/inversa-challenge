//! GOES-R fixed-grid projection and the map from ABI pixels to a region's 0.05 deg GOES grid (T7).
//!
//! Formulas are the GOES-R Product Definition and Users' Guide (PUG) vol. 3, section 5.1.2.8:
//! scan angles (x, y) in radians to geodetic lat/lon on the GRS80 ellipsoid, and back.
//! A [`GridMap`] is computed once per distinct (ABI grid, region environment grid) pair and
//! cached: it holds the x/y index window covering the region's bbox and, for every GOES cell,
//! the window pixels sampled at a 4x4 sub-grid of the cell. ABI pixels are ~2 km, GOES cells
//! ~5.5 km, so each cell averages about eight pixels. The decoder reads one hyperslab per
//! region (PLAN.md C-A4: windowing per region), so a four-region app reads four small windows
//! of a full-disk file instead of one spanning the Caribbean.
//!
//! The GOES grid of a region is its frame environment grid (`Layout::env`, 5 x cellDeg): for
//! the python region 68 x 64 cells, id `g5:<col>:<row>` from the south-west corner.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use crate::hotspot::Grid;
use crate::model::Flag;

/// Sub-samples per cell side. 4 gives sixteen samples about 1.4 km apart in a 5.5 km cell.
const SUB: usize = 4;
const NONE: u32 = u32::MAX;

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

    fn key(&self, env: &Grid) -> GridKey {
        GridKey {
            bits: [self.proj.h, self.proj.r_eq, self.proj.r_pol, self.proj.lon0_deg, self.x0, self.dx, self.y0, self.dy]
                .map(f64::to_bits),
            nx: self.nx,
            ny: self.ny,
            env: [env.west.to_bits(), env.south.to_bits(), env.cell_deg.to_bits(), env.cols as u64, env.rows as u64],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct GridKey {
    bits: [u64; 8],
    nx: usize,
    ny: usize,
    env: [u64; 5],
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

    pub fn height(&self) -> usize {
        self.y1 - self.y0
    }
}

/// Bbox window plus, per GOES cell of one region, the window-relative flat pixel index of each
/// sub-sample.
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

/// Aggregated GOES cell. `value` is the mean of the good pixels when `flag` is `Ok`, else `None`.
/// `region` is the app region index the cell belongs to (set by the decoder; 0 from `aggregate`).
#[derive(Debug, Clone, PartialEq)]
pub struct Cell {
    pub region: u8,
    pub idx: usize,
    pub value: Option<f64>,
    pub flag: Flag,
}

impl GridMap {
    /// Cached map for a (file grid, region env grid) pair; built on first use (about 70k forward
    /// projections for the python region, a few ms).
    pub fn for_grid(grid: &FixedGrid, env: &Grid) -> Arc<GridMap> {
        static MAPS: OnceLock<Mutex<HashMap<GridKey, Arc<GridMap>>>> = OnceLock::new();
        let maps = MAPS.get_or_init(|| Mutex::new(HashMap::new()));
        let key = grid.key(env);
        if let Some(m) = maps.lock().unwrap().get(&key) {
            return m.clone();
        }
        let built = Arc::new(GridMap::build(grid, env));
        maps.lock().unwrap().entry(key).or_insert(built).clone()
    }

    pub fn build(grid: &FixedGrid, env: &Grid) -> GridMap {
        let cells = env.cells();
        // Absolute pixel indices first, then shrink to the window and make them relative.
        let mut abs: Vec<[Option<(usize, usize)>; SUB * SUB]> = Vec::with_capacity(cells);
        let (mut x0, mut x1, mut y0, mut y1) = (usize::MAX, 0usize, usize::MAX, 0usize);
        for idx in 0..cells {
            let (col, row) = env.col_row_of(idx);
            let mut s = [None; SUB * SUB];
            for (k, slot) in s.iter_mut().enumerate() {
                let fx = (k % SUB) as f64 + 0.5;
                let fy = (k / SUB) as f64 + 0.5;
                let lon = env.west + (col as f64 + fx / SUB as f64) * env.cell_deg;
                let lat = env.south + (row as f64 + fy / SUB as f64) * env.cell_deg;
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
            return GridMap { window: Window { x0: 0, x1: 0, y0: 0, y1: 0 }, samples: vec![[NONE; SUB * SUB]; cells] };
        }
        let window = Window { x0, x1, y0, y1 };
        let w = window.width();
        let samples = abs
            .iter()
            .map(|s| s.map(|p| p.map_or(NONE, |(i, j)| ((j - y0) * w + (i - x0)) as u32)))
            .collect();
        GridMap { window, samples }
    }

    /// Does the file's grid reach this region at all?
    pub fn covers(&self) -> bool {
        self.window.width() > 0 && self.window.height() > 0
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
            out.push(Cell { region: 0, idx, value, flag });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::config::App;

    // Test-only inverse projection: the decoder only projects lat/lon to scan angles.
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

    /// ABI CONUS 2 km grid as written in every GOES-19 CONUS file (x/y scale_factor and add_offset).
    pub fn conus_2km() -> FixedGrid {
        FixedGrid { proj: Proj::goes_east(), x0: -0.101332, dx: 5.6e-05, nx: 2500, y0: 0.128212, dy: -5.6e-05, ny: 1500 }
    }

    /// The python region's environment grid (68 x 64 cells of 0.05 deg).
    pub fn python_env() -> Grid {
        App::builtin("python").unwrap().regions[0].layout.env
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
        let env = python_env();
        for (lat, lon) in [(env.south, env.west), (env.north(), env.east()), (25.7617, -80.1918), (0.0, -75.0)] {
            let (x, y) = p.to_scan(lat, lon).unwrap();
            let (lat2, lon2) = p.to_lat_lon(x, y).unwrap();
            assert!((lat - lat2).abs() < 1e-6 && (lon - lon2).abs() < 1e-6, "{lat},{lon} -> {lat2},{lon2}");
        }
        assert!(p.to_lat_lon(0.2, 0.2).is_none(), "off-earth ray");
        assert!(p.to_scan(0.0, 120.0).is_none(), "far side of the Earth");
    }

    #[test]
    fn goes_grid_window_and_samples_cover_bbox() {
        let env = python_env();
        assert_eq!((env.cols, env.rows), (68, 64));
        let map = GridMap::build(&conus_2km(), &env);
        let w = map.window;
        assert!(w.x0 < w.x1 && w.x1 <= 2500 && w.y0 < w.y1 && w.y1 <= 1500, "{w:?}");
        // 3.4 deg of longitude at 2 km near 26N is roughly 170 pixels; allow for the viewing angle.
        assert!((120..=260).contains(&w.width()) && (120..=260).contains(&w.height()), "{w:?}");
        assert_eq!(map.samples.len(), env.cells());
        assert!(map.samples.iter().all(|s| s.iter().all(|&i| i != NONE)), "every cell sampled");
        let max = map.samples.iter().flatten().copied().max().unwrap() as usize;
        assert!(max < w.width() * w.height());
        assert!(map.covers());
        // Cached instance is reused, per (file grid, region) pair.
        let a = GridMap::for_grid(&conus_2km(), &env);
        let b = GridMap::for_grid(&conus_2km(), &env);
        assert!(Arc::ptr_eq(&a, &b));
        // Another region of the same file grid has its own window: the Mexican Caribbean (18.3 N
        // and up) is inside the CONUS sector (south edge about 14.6 N); Colombia (9.7-13.5 N) is
        // outside it entirely, so a CONUS file yields no rows there.
        let lf = App::builtin("lionfish").unwrap();
        let co = GridMap::for_grid(&conus_2km(), &lf.region("co-caribbean").unwrap().layout.env);
        assert!(!Arc::ptr_eq(&a, &co));
        assert!(!co.covers(), "CONUS does not reach Colombia: {:?}", co.window);
        assert!(co.aggregate(|_| Pixel::Good(1.0)).is_empty(), "no samples, no rows");
        let mx = GridMap::for_grid(&conus_2km(), &lf.region("mx-caribbean").unwrap().layout.env);
        let mx_env = lf.region("mx-caribbean").unwrap().layout.env;
        assert!(mx.covers() && mx.window.y1 <= 1500 && mx.window != w, "{:?}", mx.window);
        assert!(mx.window.y0 > w.y0, "further south in the image than the Keys: {:?} vs {w:?}", mx.window);
        assert_eq!(mx.samples.len(), mx_env.cells());
        assert!(mx.samples.iter().all(|s| s.iter().all(|&i| i != NONE)), "every Mexican cell sampled");
    }

    #[test]
    fn goes_grid_aggregate_rules() {
        let env = python_env();
        let cells_n = env.cells();
        let map = GridMap::build(&conus_2km(), &env);
        let (w, h) = (map.window.width(), map.window.height());
        // Good pixels average; a cloud-only cell is flagged, not dropped; skip-only cells vanish.
        let cells = map.aggregate(|i| if i % 2 == 0 { Pixel::Good(10.0) } else { Pixel::Good(20.0) });
        assert_eq!(cells.len(), cells_n);
        assert!(cells.iter().all(|c| c.flag == Flag::Ok && (10.0..=20.0).contains(&c.value.unwrap())));
        assert!(cells.iter().any(|c| c.value.unwrap() > 10.0 && c.value.unwrap() < 20.0), "some cells straddle two pixels");
        // One good sample outranks cloudy ones in its cell; far cells do not see it.
        let w0 = map.samples[0][0] as usize;
        let one_good = map.aggregate(|i| if i == w0 { Pixel::Good(7.0) } else { Pixel::Cloud });
        assert_eq!(one_good[0], Cell { region: 0, idx: 0, value: Some(7.0), flag: Flag::Ok });
        assert_eq!(one_good[cells_n - 1].flag, Flag::Cloud);
        let cloudy = map.aggregate(|_| Pixel::Cloud);
        assert_eq!(cloudy.len(), cells_n);
        assert!(cloudy.iter().all(|c| c.flag == Flag::Cloud && c.value.is_none()));
        let mixed = map.aggregate(|i| if i < w * h / 2 { Pixel::Bad } else { Pixel::Skip });
        assert!(!mixed.is_empty() && mixed.len() < cells_n);
        assert!(mixed.iter().all(|c| c.flag == Flag::BadDqf));
        assert!(map.aggregate(|_| Pixel::Skip).is_empty());
        assert_eq!(env.cell_id(0), "0:0");
        assert_eq!(env.cell_id(cells_n - 1), "67:63");
        let (lon, lat) = env.center(0);
        assert!((lat - (env.south + 0.025)).abs() < 1e-9 && (lon - (env.west + 0.025)).abs() < 1e-9);
        let (lon, lat) = env.center(cells_n - 1);
        assert!((lat - (env.north() - 0.025)).abs() < 1e-9 && (lon - (env.east() - 0.025)).abs() < 1e-9);
    }
}
