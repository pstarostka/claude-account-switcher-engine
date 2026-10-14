//! The page and the Rust side talk through strings — command names and event
//! names — so a renamed one fails at runtime, in a menu nobody opened, rather
//! than at compile time. This reads the three files and holds them to each other.

use regex::Regex;
use std::collections::BTreeSet;

fn read(path: &str) -> String {
    std::fs::read_to_string(format!("{}/{path}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn all(re: &str, text: &str) -> BTreeSet<String> {
    Regex::new(re)
        .unwrap()
        .captures_iter(text)
        .map(|m| m[1].to_owned())
        .collect()
}

fn rust_sources() -> String {
    ["src/main.rs", "src/tray.rs"].map(read).join("\n")
}

#[test]
fn every_command_the_page_invokes_is_registered_and_every_registered_one_is_invoked() {
    let main = read("src/main.rs");
    let handler = main
        .split("generate_handler![")
        .nth(1)
        .unwrap()
        .split(']')
        .next()
        .unwrap();
    let registered = all(r"(\w+)", handler);
    let invoked = all(r"invoke\('(\w+)'", &read("ui/api.js"));

    let missing: Vec<_> = invoked.difference(&registered).collect();
    assert!(
        missing.is_empty(),
        "api.js invokes commands main.rs never registers: {missing:?}"
    );
    let dead: Vec<_> = registered.difference(&invoked).collect();
    assert!(
        dead.is_empty(),
        "main.rs registers commands nothing invokes: {dead:?}"
    );
}

#[test]
fn every_event_the_page_listens_for_is_emitted_and_the_other_way_round() {
    let listened = all(r"on\('([\w:]+)'", &read("ui/api.js"));
    let emitted = all(r#"emit\("([\w:]+)""#, &rust_sources());
    assert_eq!(listened, emitted);
}

#[test]
fn the_renderer_and_the_bridge_agree_on_its_methods() {
    // An exposed method nothing calls is surface kept alive by nothing but habit.
    let api = read("ui/api.js");
    let body = api.split("window.api = {").nth(1).unwrap();
    let exposed = all(r"(?m)^  (\w+):", body);
    let used = all(r"window\.api\.(\w+)", &read("ui/renderer.js"));
    assert_eq!(exposed, used);
}
