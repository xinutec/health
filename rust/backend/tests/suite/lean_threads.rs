//! The Lean worker's task pool follows the container's CPU quota.

use backend::lean_worker::cpu_max_threads;

#[test]
fn a_cpu_quota_rounds_up_to_whole_threads() {
    assert_eq!(cpu_max_threads("100000 100000\n"), Some(1));
    assert_eq!(cpu_max_threads("150000 100000\n"), Some(2));
    assert_eq!(cpu_max_threads("300000 100000\n"), Some(3));
    assert_eq!(cpu_max_threads("10000 100000\n"), Some(1));
    assert_eq!(cpu_max_threads("max 100000\n"), None);
    assert_eq!(cpu_max_threads(""), None);
}
