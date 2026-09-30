//! Explainable hotspot scoring (PRD section 8, T11).
//!
//! `score = density × activity × access` per 0.01° cell (PLAN.md C15) and frame time.
//! `score` holds the kernel density and the per-cell product, `rules` the per-species
//! activity and access rule tables, `backtest` the top-10% hit-rate check.

pub mod backtest;
pub mod rules;
pub mod score;

/// Focus species, in EVF1 species order (PLAN.md C4). The discriminant is `taxa.id`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Species {
    Python = 1,
    Tegu = 2,
    Iguana = 3,
    Lionfish = 4,
}

pub const SPECIES: [Species; 4] = [Species::Python, Species::Tegu, Species::Iguana, Species::Lionfish];

impl Species {
    /// Accepts the name (`python`) or the taxon id (`1`).
    pub fn parse(s: &str) -> Option<Species> {
        match s.trim().to_ascii_lowercase().as_str() {
            "python" | "1" => Some(Species::Python),
            "tegu" | "2" => Some(Species::Tegu),
            "iguana" | "3" => Some(Species::Iguana),
            "lionfish" | "4" => Some(Species::Lionfish),
            _ => None,
        }
    }

    pub fn from_taxon_id(id: i64) -> Option<Species> {
        SPECIES.iter().copied().find(|s| s.taxon_id() == id)
    }

    pub fn name(self) -> &'static str {
        match self {
            Species::Python => "python",
            Species::Tegu => "tegu",
            Species::Iguana => "iguana",
            Species::Lionfish => "lionfish",
        }
    }

    pub fn taxon_id(self) -> i64 {
        self as i64
    }

    /// Position in the EVF1 hotspot section.
    pub fn index(self) -> usize {
        self as usize - 1
    }

    /// Density decay half-life (PRD section 8).
    pub fn half_life_days(self) -> f64 {
        match self {
            Species::Python => 21.0,
            Species::Tegu => 14.0,
            Species::Iguana => 14.0,
            Species::Lionfish => 60.0,
        }
    }
}

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
    /// PLAN.md C15: west −83.2, south 24.3, 0.01°, 340 × 320.
    pub const REGION: Grid = Grid { west: -83.2, south: 24.3, cell_deg: 0.01, cols: 340, rows: 320 };

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
    use super::*;

    #[test]
    fn hotspot_grid_cell_ids_round_trip() {
        let g = Grid::REGION;
        assert_eq!(g.cells(), 108_800);
        assert_eq!(g.col_row(-83.2, 24.3), Some((0, 0)));
        assert_eq!(g.col_row(-83.19, 24.31), Some((1, 1)));
        assert_eq!(g.col_row(-79.8, 27.5), None);
        assert_eq!(g.col_row(-79.805, 27.495), Some((339, 319)));
        let idx = g.index(12, 7);
        assert_eq!(g.cell_id(idx), "12:7");
        assert_eq!(g.parse_cell("12:7"), Some(idx));
        assert_eq!(g.parse_cell("340:7"), None);
        let (lon, lat) = g.center(idx);
        assert!((lon - (-83.2 + 12.5 * 0.01)).abs() < 1e-9);
        assert!((lat - (24.3 + 7.5 * 0.01)).abs() < 1e-9);
        assert_eq!(Species::parse("Lionfish"), Some(Species::Lionfish));
        assert_eq!(Species::parse("2"), Some(Species::Tegu));
        assert_eq!(Species::parse("manatee"), None);
        assert_eq!(Species::Iguana.index(), 2);
    }
}
