//! Explainable hotspot scoring (PRD section 8, T11).
//!
//! `score = density × activity × access` per scoring cell and frame time, per region of the
//! app (PLAN.md C-A4: grids come from `regions[]`, taxa from `taxa[]`; nothing here names a
//! species or a bbox). `score` holds the kernel density and the per-cell product, `rules` the
//! named activity and access rule sets a taxon's config picks, `backtest` the top-10% hit-rate
//! check.

pub mod backtest;
pub mod lionfish;
pub mod rules;
pub mod score;

/// A regular lat/lon grid anchored at its south-west corner; cells are row-major from that corner.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Grid {
    pub west: f64,
    pub south: f64,
    pub cell_deg: f64,
    pub cols: u32,
    pub rows: u32,
}

impl Grid {
    pub fn cells(&self) -> usize {
        self.cols as usize * self.rows as usize
    }

    pub fn east(&self) -> f64 {
        self.west + self.cols as f64 * self.cell_deg
    }

    pub fn north(&self) -> f64 {
        self.south + self.rows as f64 * self.cell_deg
    }

    /// Fractional column/row of a point, in cell units from the south-west corner.
    pub fn frac(&self, lon: f64, lat: f64) -> (f64, f64) {
        ((lon - self.west) / self.cell_deg, (lat - self.south) / self.cell_deg)
    }

    /// Column and row containing a point, or None outside the grid. The tiny epsilon keeps
    /// points on a cell edge from flooring into the cell below after float division.
    pub fn col_row(&self, lon: f64, lat: f64) -> Option<(u32, u32)> {
        let (fc, fr) = self.frac(lon, lat);
        let c = (fc + 1e-9).floor();
        let r = (fr + 1e-9).floor();
        if c < 0.0 || r < 0.0 || c >= self.cols as f64 || r >= self.rows as f64 {
            return None;
        }
        Some((c as u32, r as u32))
    }

    pub fn index(&self, col: u32, row: u32) -> usize {
        row as usize * self.cols as usize + col as usize
    }

    pub fn col_row_of(&self, idx: usize) -> (u32, u32) {
        ((idx % self.cols as usize) as u32, (idx / self.cols as usize) as u32)
    }

    /// Cell centre as (lon, lat).
    pub fn center(&self, idx: usize) -> (f64, f64) {
        let (c, r) = self.col_row_of(idx);
        (self.west + (c as f64 + 0.5) * self.cell_deg, self.south + (r as f64 + 0.5) * self.cell_deg)
    }

    /// Cell id `<col>:<row>` (PLAN.md C14).
    pub fn cell_id(&self, idx: usize) -> String {
        let (c, r) = self.col_row_of(idx);
        format!("{c}:{r}")
    }

    pub fn parse_cell(&self, id: &str) -> Option<usize> {
        let (c, r) = id.split_once(':')?;
        let c: u32 = c.trim().parse().ok()?;
        let r: u32 = r.trim().parse().ok()?;
        (c < self.cols && r < self.rows).then(|| self.index(c, r))
    }
}

#[cfg(test)]
mod tests {
    use crate::app::config::App;

    #[test]
    fn hotspot_grid_cell_ids_round_trip() {
        let app = App::builtin("python").unwrap();
        let g = app.regions[0].grid;
        assert_eq!(g.cells(), 108_800);
        assert_eq!(g.col_row(g.west, g.south), Some((0, 0)));
        assert_eq!(g.col_row(g.west + 0.01, g.south + 0.01), Some((1, 1)));
        assert_eq!(g.col_row(g.east(), g.north()), None);
        assert_eq!(g.col_row(g.east() - 0.005, g.north() - 0.005), Some((339, 319)));
        let idx = g.index(12, 7);
        assert_eq!(g.cell_id(idx), "12:7");
        assert_eq!(g.parse_cell("12:7"), Some(idx));
        assert_eq!(g.parse_cell("340:7"), None);
        let (lon, lat) = g.center(idx);
        assert!((lon - (g.west + 12.5 * 0.01)).abs() < 1e-9);
        assert!((lat - (g.south + 7.5 * 0.01)).abs() < 1e-9);
        assert_eq!(app.taxon("Python").map(|t| t.id()), Some("python"));
        assert_eq!(app.taxon("manatee"), None);
        assert_eq!(app.taxon("python bivittatus").unwrap().idx, 0);
        assert_eq!(app.taxon("lionfish"), None);
    }
}
