pub(crate) fn surface_name(surface_type: u8) -> &'static str {
    match surface_type {
        0 => "asphalt",
        1 => "paving",
        2 => "concrete",
        3 => "unpaved",
        4 => "gravel",
        _ => "asphalt",
    }
}

pub(crate) fn rail_type_name(rt: u8) -> &'static str {
    match rt {
        0 => "rail",
        1 => "tram",
        2 => "light_rail",
        3 => "narrow_gauge",
        4 => "funicular",
        _ => "rail",
    }
}

pub(crate) fn rail_usage_name(u: u8) -> &'static str {
    match u {
        0 => "main",
        1 => "branch",
        2 => "industrial",
        _ => "main",
    }
}

pub(crate) fn building_type_name(bt: u8) -> &'static str {
    match bt {
        0 => "residential_multi",
        1 => "commercial",
        2 => "warehouse",
        3 => "education",
        4 => "healthcare",
        5 => "worship",
        6 => "hospitality",
        7 => "garage",
        8 => "farm",
        9 => "public",
        _ => "default",
    }
}

pub(crate) fn industrial_type_name(st: u8) -> &'static str {
    match st {
        0 => "industrial_area",
        1 => "quarry",
        2 => "farm",
        3 => "factory",
        4 => "wastewater",
        10 => "wind_turbine",
        _ => "industrial_area",
    }
}
