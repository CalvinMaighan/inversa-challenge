//! Named rule sets (T11, PRD section 8). A taxon's config picks one by name (`rules` in
//! `spec/apps/*.json`); the set holds its activity and access rules.
//!
//! Each rule maps the conditions at a cell to a multiplier and cites its rationale. A rule
//! returns `None` when the conditions it needs are missing; the score then uses a neutral 1.0
//! and the explain output says "no data" for that term.

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

/// The activity and access rules one taxon runs.
pub struct RuleSet {
    pub name: &'static str,
    pub activity: &'static [Rule],
    pub access: &'static [Rule],
}

/// Multipliers, kept as named constants so the tests can hand-compute expectations.
pub const PYTHON_WARM_BOOST: f32 = 1.5;
pub const PYTHON_COLD_SUPPRESS: f32 = 0.3;
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

pub static RULE_SETS: [RuleSet; 2] = [
    RuleSet { name: "python", activity: &PYTHON_ACTIVITY, access: &PYTHON_ACCESS },
    RuleSet { name: "lionfish", activity: &LIONFISH_ACTIVITY, access: &LIONFISH_ACCESS },
];

pub fn ruleset(name: &str) -> Option<&'static RuleSet> {
    RULE_SETS.iter().find(|r| r.name == name)
}

pub fn names() -> Vec<&'static str> {
    RULE_SETS.iter().map(|r| r.name).collect()
}

/// Product of the rules' multipliers; a rule without data contributes 1.0.
pub fn multiplier(rules: &[Rule], c: &Conditions) -> f32 {
    rules.iter().map(|r| (r.applies)(c).unwrap_or(1.0)).product()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every rule in every set, for the audit below.
    fn all_rules() -> Vec<(&'static str, &'static Rule)> {
        RULE_SETS.iter().flat_map(|s| s.activity.iter().chain(s.access).map(move |r| (s.name, r))).collect()
    }

    #[test]
    fn rules_have_rationale() {
        let rules = all_rules();
        assert_eq!(rules.len(), 4);
        for (set, rule) in rules {
            assert!(!rule.name.trim().is_empty(), "{set} rule without a name");
            assert!(rule.rationale.trim().len() >= 40, "{set} {} has no real rationale", rule.name);
        }
        for s in &RULE_SETS {
            assert!(!s.activity.is_empty());
            assert!(!s.access.is_empty());
            assert!(std::ptr::eq(ruleset(s.name).unwrap(), s));
        }
        assert!(ruleset("dragon").is_none());
        assert_eq!(names(), ["python", "lionfish"]);
    }

    #[test]
    fn hotspot_rules_no_data_is_neutral() {
        let none = Conditions { month: 6, ..Default::default() };
        assert_eq!((PYTHON_ACTIVITY[0].applies)(&none), None);
        assert_eq!((LIONFISH_ACCESS[0].applies)(&none), None);
        assert_eq!((PYTHON_ACCESS[0].applies)(&none), None);
        assert_eq!(multiplier(&PYTHON_ACTIVITY, &none), 1.0);
        assert_eq!(multiplier(&LIONFISH_ACCESS, &none), 1.0);
    }

    #[test]
    fn hotspot_rules_thresholds() {
        let c = |air: f32| Conditions { air_c: Some(air), month: 7, ..Default::default() };
        assert_eq!(multiplier(&PYTHON_ACTIVITY, &c(25.0)), 1.5);
        assert_eq!(multiplier(&PYTHON_ACTIVITY, &c(12.0)), 0.3);
        assert_eq!(multiplier(&PYTHON_ACTIVITY, &c(18.0)), 1.0);
        // LST fills in when air is missing.
        assert_eq!(multiplier(&PYTHON_ACTIVITY, &Conditions { lst_c: Some(30.0), month: 7, ..Default::default() }), 1.5);
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
