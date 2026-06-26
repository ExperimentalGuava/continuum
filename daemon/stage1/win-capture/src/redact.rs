// Defense-in-depth PII scrub. Stage 2 redacts again at close() (the canonical PII boundary),
// but card- and SSN-shaped digit runs should never leave the capture process in the first place.
// Emails are intentionally NOT scrubbed here — they're high-signal and Stage 2's NER handles them.
use regex::Regex;
use std::sync::OnceLock;

pub fn redact(s: &str) -> String {
    static CARD: OnceLock<Regex> = OnceLock::new();
    static SSN: OnceLock<Regex> = OnceLock::new();
    let card = CARD.get_or_init(|| Regex::new(r"\b(?:\d[ -]?){13,16}\b").unwrap());
    let ssn = SSN.get_or_init(|| Regex::new(r"\b\d{3}-\d{2}-\d{4}\b").unwrap());
    let s = card.replace_all(s, "[REDACTED]");
    let s = ssn.replace_all(&s, "[REDACTED]");
    s.into_owned()
}
