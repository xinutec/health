//! `backend::fetch_drain`: the pure parts of the continuous drain (#1889).

use backend::fetch_drain::{FIX_CELL_DEG, Fix, cells_of};

/// A fix every 30 s along a slow walk asks ONE question per cell, not one per
/// fix; the first fix in a cell is the one kept.
#[test]
fn cells_keep_one_fix_per_cell_in_first_seen_order() {
    let base = (51.5, -0.12);
    let fixes: Vec<Fix> = (0i32..20)
        .map(|i| {
            (
                1_700_000_000 + i64::from(i) * 30,
                base.0 + f64::from(i) * 0.0004,
                base.1,
            )
        })
        .collect();
    let cells = cells_of(&fixes);
    // 20 × 0.0004° = 0.008° of latitude: inside one cell of 0.01°, or two when
    // the walk crosses a cell edge — never twenty.
    assert!(cells.len() <= 2, "{cells:?}");
    assert_eq!(cells[0], (base.0, base.1));
}

/// Two fixes a cell apart are two questions, and a return to the first cell is
/// not a third.
#[test]
fn cells_distinct_by_cell_and_deduped_on_return() {
    let a = (48.85, 2.35);
    let b = (a.0 + FIX_CELL_DEG * 1.5, a.1);
    let fixes: Vec<Fix> = vec![(1, a.0, a.1), (2, b.0, b.1), (3, a.0 + 0.001, a.1 + 0.001)];
    let cells = cells_of(&fixes);
    assert_eq!(cells, vec![a, b]);
}

/// A western longitude floors towards the pole-ward side consistently: fixes at
/// -0.1201 and -0.1299 share a cell, -0.1301 does not.
#[test]
fn cells_floor_negative_longitudes() {
    let fixes: Vec<Fix> = vec![(1, 51.5, -0.1201), (2, 51.5, -0.1299), (3, 51.5, -0.1301)];
    assert_eq!(cells_of(&fixes).len(), 2);
}

#[test]
fn nothing_in_nothing_out() {
    assert!(cells_of(&[]).is_empty());
}
