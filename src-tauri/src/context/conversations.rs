//! Where two or more people talk to each other, found on the Mac with no
//! model at all (docs/ASK-RANGE-SPEC-2026-10-06.md, section 5).
//!
//! "Every time Donnie and Jillio talk about sibling rivalry" is two questions:
//! when are they talking to each other, and is it about that. The first one
//! needs no model: it is the stretches where those people take turns, a
//! change of speaker at least `min_turns` times, with no pause longer than
//! `gap` seconds. Answering it here means a scan (or a model reading) never
//! pays for the minutes where they are apart.
use super::sequences;
use super::{Address, Context, Line};
use crate::AppError;
use serde::Serialize;

/// A pause this long or shorter is still one exchange (the owner, October 6).
pub const DEFAULT_GAP_SECONDS: f64 = 8.0;
pub const DEFAULT_MIN_TURNS: usize = 2;

#[derive(Serialize)]
pub struct Stretch {
    pub tc_in: String, pub tc_out: String,
    /// How many times the speaker changed between the people asked for.
    pub turns: usize,
    /// Each of them, and how many lines they have in it.
    pub said: Vec<(String, usize)>,
    /// Their lines and, marked by `asked`, anyone else's inside the stretch, in time order.
    pub lines: Vec<Line>,
    #[serde(skip)] pub asked: Vec<bool>,
}

#[derive(Serialize)]
pub struct Conversations { pub sequence: String, pub name: String, pub people: Vec<String>, pub stretches: Vec<Stretch> }

pub struct Ask<'a> { pub people: Vec<&'a str>, pub from: Option<&'a str>, pub to: Option<&'a str>, pub gap: f64, pub min_turns: usize, pub with_others: bool, pub include_bleed: bool }

pub fn find(ctx: &Context, wanted: &str, ask: Ask) -> Result<Conversations, AppError> {
    if ask.people.len() < 2 { return Err(AppError::invalid("Name two or more people: a conversation is between them.")); }
    let document = ctx.document(&sequences::resolve(ctx, wanted)?)?;
    let rate = f64::from(document.manifest.edit_rate.numerator) / f64::from(document.manifest.edit_rate.denominator.max(1));
    let gap = (ask.gap.max(0.0) * rate).round() as i64;
    // Everyone in the range, copies folded with the named people's mics kept,
    // so a line said into Donnie's lav and heard on Jillio's counts once, as Donnie's.
    let (names, _) = sequences::resolve_people(&document, &ask.people)?;
    if names.len() < 2 { return Err(AppError::invalid("Those name one person: a conversation needs two or more.")); }
    let lines = sequences::fold_copies(sequences::in_range(ctx, &document, ask.from, ask.to, ask.include_bleed)?, &names);
    let theirs: Vec<&Line> = lines.iter().filter(|line| names.contains(&line.who)).collect();
    let mut stretches = Vec::new();
    let mut at = 0;
    while at < theirs.len() {
        // Grow a stretch while the next line of theirs starts within `gap` of where it reached.
        let (mut end, mut reach) = (at, theirs[at].span[1]);
        while end + 1 < theirs.len() && theirs[end + 1].span[0] <= reach + gap { end += 1; reach = reach.max(theirs[end].span[1]); }
        let run = &theirs[at..=end];
        let turns = run.windows(2).filter(|pair| pair[0].who != pair[1].who).count();
        let mut said: Vec<(String, usize)> = Vec::new();
        for line in run { match said.iter_mut().find(|(who, _)| *who == line.who) { Some(entry) => entry.1 += 1, None => said.push((line.who.clone(), 1)) } }
        if said.len() >= 2 && turns >= ask.min_turns {
            let (from, to) = (run[0].span[0], reach);
            let inside: Vec<&Line> = lines.iter().filter(|line| line.span[0] >= from && line.span[0] <= to && (ask.with_others || names.contains(&line.who))).collect();
            stretches.push(Stretch { tc_in: sequences::tc(&document, from), tc_out: sequences::tc(&document, to), turns, said,
                asked: inside.iter().map(|line| names.contains(&line.who)).collect(), lines: inside.into_iter().cloned().collect() });
        }
        at = end + 1;
    }
    Ok(Conversations { sequence: Address::Sequence(document.id.clone()).to_string(), name: document.manifest.name.clone(), people: names, stretches })
}

/// The conversations as rows: a line per stretch, then its lines, anyone not asked for marked so.
pub fn rows(ctx: &Context, found: &Conversations) -> String {
    let all: Vec<&Line> = found.stretches.iter().flat_map(|stretch| stretch.lines.iter()).collect();
    let titles = if all.iter().any(|line| !line.in_string_outs.is_empty()) { super::string_outs::titles(ctx) } else { Default::default() };
    let mut out = vec![format!("Conversations between {} in {} ({}): {} {}", found.people.join(" and "), found.name, found.sequence, found.stretches.len(),
        if found.stretches.len() == 1 { "stretch" } else { "stretches" })];
    for stretch in &found.stretches {
        let said: Vec<String> = stretch.said.iter().map(|(who, count)| format!("{who} {count}")).collect();
        out.push(format!("\n{} to {} · {} · {} turns", stretch.tc_in, stretch.tc_out, said.join(", "), stretch.turns));
        for (line, asked) in stretch.lines.iter().zip(&stretch.asked) {
            let row = super::rows::row(line, &ctx.ids, &titles);
            out.push(if *asked { row } else { format!("{row} [not asked for]") });
        }
    }
    out.join("\n")
}
