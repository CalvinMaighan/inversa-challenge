//! Per-species rule table (T11, PRD section 8).
//!
//! Each rule maps the conditions at a cell to a multiplier and cites its rationale. A rule
//! returns `None` when the conditions it needs are missing; the score then uses a neutral 1.0
//! and the explain output says "no data" for that term.

use super::Species;

/// Conditions at one cell and time, from the nearest valid readings. `None` means no reading
/// within reach or within the staleness window.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Conditions {
    pub air_c: Option<f32>,
    pub lst_c: Option<f32>,
    pub sst_c: Option<f32>,
    pub stage_m: Option<f32>,
    pub wave_m: Option<f32>,
    pub wind_ms: Option<f32>,
    /// Calendar month in UTC, 1–12.
    pub month: u32,
}

pub struct Rule {
    pub name: &'static str,
    /// Multiplier for these conditions, or `None` when the inputs are missing (neutral 1.0).
    pub applies: fn(&Conditions) -> Option<f32>,
    pub rationale: &'static str,
}

/// Multipliers, kept as named constants so the tests can hand-compute expectations.
pub const PYTHON_WARM_BOOST: f32 = 1.5;
pub const PYTHON_COLD_SUPPRESS: f32 = 0.3;
pub const IGUANA_COLD_STUN_BOOST: f32 = 2.0;
pub const TEGU_BRUMATION_SUPPRESS: f32 = 0.3;
pub const LIONFISH_NO_ACCESS: f32 = 0.1;
pub const LIONFISH_MAX_WAVE_M: f32 = 1.2;
pub const LIONFISH_MAX_WIND_MS: f32 = 8.0;
pub const PYTHON_ACCESS_MAX: f32 = 1.2;
pub const PYTHON_ACCESS_MIN: f32 = 0.6;

fn python_temperature(c: &Conditions) -> Option<f32> {
    let t = c.air_c.or(c.lst_c)?;
    Some(if (21.0..=32.0).contains(&t) {
        PYTHON_WARM_BOOST
    } else if t < 15.0 {
        PYTHON_COLD_SUPPRESS
    } else {
        1.0
    })
}

fn iguana_cold_stun(c: &Conditions) -> Option<f32> {
    let t = c.air_c?;
    Some(if t < 10.0 { IGUANA_COLD_STUN_BOOST } else { 1.0 })
}

fn tegu_brumation(c: &Conditions) -> Option<f32> {
    Some(if c.month >= 10 || c.month <= 2 { TEGU_BRUMATION_SUPPRESS } else { 1.0 })
}

fn lionfish_baseline(_c: &Conditions) -> Option<f32> {
    Some(1.0)
}

fn lionfish_sea_state(c: &Conditions) -> Option<f32> {
    if c.wave_m.is_none() && c.wind_ms.is_none() {
        return None;
    }
    let calm_sea = c.wave_m.is_none_or(|w| w < LIONFISH_MAX_WAVE_M);
    let calm_wind = c.wind_ms.is_none_or(|w| w < LIONFISH_MAX_WIND_MS);
    Some(if calm_sea && calm_wind { 1.0 } else { LIONFISH_NO_ACCESS })
}

/// 1.2 at or below 1 m stage, falling 0.3 per metre to a floor of 0.6 (about 3 m).
fn python_levee_stage(c: &Conditions) -> Option<f32> {
    let stage = c.stage_m?;
    Some((1.5 - 0.3 * stage).clamp(PYTHON_ACCESS_MIN, PYTHON_ACCESS_MAX))
}

fn land_access(_c: &Conditions) -> Option<f32> {
    Some(1.0)
}

static PYTHON_ACTIVITY: [Rule; 1] = [Rule {
    name: "python_warm_temperature",
    applies: python_temperature,
    rationale: "Burmese pythons move and bask most on warm nights; air or land-surface temperature \
                21–32 °C boosts activity 1.5×, below 15 °C they hole up (0.3×).",
}];

static PYTHON_ACCESS: [Rule; 1] = [Rule {
    name: "python_levee_stage",
    applies: python_levee_stage,
    rationale: "Levee and canal-bank patrols reach more ground when water stage is low; the \
                multiplier falls 0.3 per metre of stage, capped between 0.6 and 1.2.",
}];

static IGUANA_ACTIVITY: [Rule; 1] = [Rule {
    name: "iguana_cold_stun_easy_capture_window",
    applies: iguana_cold_stun,
    rationale: "Green iguanas go torpid below about 10 °C air temperature and drop from trees: \
                an easy capture window, so the cell is boosted 2×.",
}];

static TEGU_ACTIVITY: [Rule; 1] = [Rule {
    name: "tegu_brumation",
    applies: tegu_brumation,
    rationale: "Argentine tegus brumate from October through February in South Florida; \
                sightings and trap success fall, so those months are suppressed to 0.3×.",
}];

static LIONFISH_ACTIVITY: [Rule; 1] = [Rule {
    name: "lionfish_year_round",
    applies: lionfish_baseline,
    rationale: "Lionfish are active on reefs year-round with no seasonal window; baseline 1×.",
}];

static LIONFISH_ACCESS: [Rule; 1] = [Rule {
    name: "lionfish_sea_state",
    applies: lionfish_sea_state,
    rationale: "Dive removals need waves under 1.2 m and wind under 8 m/s; rougher water \
                keeps boats in port, so the cell drops to 0.1×.",
}];

static LAND_ACCESS: [Rule; 1] = [Rule {
    name: "land_access",
    applies: land_access,
    rationale: "Land species: crews can reach any cell by road or airboat; no access penalty.",
}];

pub fn activity_rules(species: Species) -> &'static [Rule] {
    match species {
        Species::Python => &PYTHON_ACTIVITY,
        Species::Tegu => &TEGU_ACTIVITY,
        Species::Iguana => &IGUANA_ACTIVITY,
        Species::Lionfish => &LIONFISH_ACTIVITY,
    }
}

pub fn access_rules(species: Species) -> &'static [Rule] {
    match species {
        Species::Python => &PYTHON_ACCESS,
        Species::Lionfish => &LIONFISH_ACCESS,
        Species::Tegu | Species::Iguana => &LAND_ACCESS,
    }
}

/// Every rule in the table, for audits.
#[allow(dead_code)]
pub fn all_rules() -> Vec<(Species, &'static Rule)> {
    super::SPECIES
        .iter()
        .flat_map(|&s| activity_rules(s).iter().chain(access_rules(s)).map(move |r| (s, r)))
        .collect()
}

/// Product of the rules' multipliers; a rule without data contributes 1.0.
pub fn multiplier(rules: &[Rule], c: &Conditions) -> f32 {
    rules.iter().map(|r| (r.applies)(c).unwrap_or(1.0)).product()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_have_rationale() {
        let rules = all_rules();
        assert_eq!(rules.len(), 8);
        for (species, rule) in rules {
            assert!(!rule.name.trim().is_empty(), "{species:?} rule without a name");
            assert!(rule.rationale.trim().len() >= 40, "{species:?} {} has no real rationale", rule.name);
        }
        for s in super::super::SPECIES {
            assert!(!activity_rules(s).is_empty());
            assert!(!access_rules(s).is_empty());
        }
    }

    #[test]
    fn hotspot_rules_no_data_is_neutral() {
        let none = Conditions { month: 6, ..Default::default() };
        assert_eq!((PYTHON_ACTIVITY[0].applies)(&none), None);
        assert_eq!((IGUANA_ACTIVITY[0].applies)(&none), None);
        assert_eq!((LIONFISH_ACCESS[0].applies)(&none), None);
        assert_eq!((PYTHON_ACCESS[0].applies)(&none), None);
        assert_eq!(multiplier(&PYTHON_ACTIVITY, &none), 1.0);
        assert_eq!(multiplier(&LIONFISH_ACCESS, &none), 1.0);
        // Month is always known.
        assert_eq!((TEGU_ACTIVITY[0].applies)(&Conditions { month: 12, ..Default::default() }), Some(0.3));
        assert_eq!((TEGU_ACTIVITY[0].applies)(&Conditions { month: 5, ..Default::default() }), Some(1.0));
    }

    #[test]
    fn hotspot_rules_thresholds() {
        let c = |air: f32| Conditions { air_c: Some(air), month: 7, ..Default::default() };
        assert_eq!(multiplier(&PYTHON_ACTIVITY, &c(25.0)), 1.5);
        assert_eq!(multiplier(&PYTHON_ACTIVITY, &c(12.0)), 0.3);
        assert_eq!(multiplier(&PYTHON_ACTIVITY, &c(18.0)), 1.0);
        // LST fills in when air is missing.
        assert_eq!(multiplier(&PYTHON_ACTIVITY, &Conditions { lst_c: Some(30.0), month: 7, ..Default::default() }), 1.5);
        assert_eq!(multiplier(&IGUANA_ACTIVITY, &c(8.0)), 2.0);
        assert_eq!(multiplier(&IGUANA_ACTIVITY, &c(10.0)), 1.0);
        let sea = |wave: f32, wind: f32| Conditions { wave_m: Some(wave), wind_ms: Some(wind), month: 7, ..Default::default() };
        assert_eq!(multiplier(&LIONFISH_ACCESS, &sea(0.5, 3.0)), 1.0);
        assert_eq!(multiplier(&LIONFISH_ACCESS, &sea(2.0, 3.0)), 0.1);
        assert_eq!(multiplier(&LIONFISH_ACCESS, &sea(0.5, 12.0)), 0.1);
        let stage = |s: f32| Conditions { stage_m: Some(s), month: 7, ..Default::default() };
        assert_eq!(multiplier(&PYTHON_ACCESS, &stage(0.2)), 1.2);
        assert!((multiplier(&PYTHON_ACCESS, &stage(2.0)) - 0.9).abs() < 1e-6);
        assert_eq!(multiplier(&PYTHON_ACCESS, &stage(4.0)), 0.6);
    }
}
