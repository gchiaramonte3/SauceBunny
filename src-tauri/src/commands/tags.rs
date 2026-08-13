//! Finder tags: read and write the REAL macOS ones.
//!
//! WHY NOT A PRIVATE COLOUR STORE. A colour kept in the app's own JSON is
//! invisible to Finder, does not pick up the tags a user has already applied
//! there, and breaks the moment a folder is moved or renamed because it is
//! keyed by path. macOS already solved all three: tags live in an extended
//! attribute ON the file, so they travel with it, and both apps read the same
//! thing. Colouring a folder here colours it in Finder, and vice versa, for
//! free.
//!
//! THE FORMAT, which is not documented anywhere official. The xattr is
//! `com.apple.metadata:_kMDItemUserTags` and its value is a BINARY plist
//! containing an array of strings. Each string is the tag name, a newline, and
//! a colour index 0-7 — `"Red\n6"`. A name with no colour is just the name,
//! or the name with index 0. Finder also writes an empty 32-byte
//! `com.apple.FinderInfo` alongside; we match that so a file we tag is
//! byte-shaped like one Finder tagged.
//!
//! FAILURE IS PER FILE, never fatal. A file on a filesystem without xattr
//! support, or one we cannot write, returns/keeps nothing rather than failing
//! a whole batch — the same rule the transcript bulk read follows.

use serde::{Deserialize, Serialize};

const TAG_ATTR: &str = "com.apple.metadata:_kMDItemUserTags";
const FINDER_INFO_ATTR: &str = "com.apple.FinderInfo";

/// One tag: a label plus one of Finder's eight colour slots (0 = no colour).
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct FinderTag {
    pub name: String,
    /// 0 = none, 1-7 = grey, green, purple, blue, yellow, red, orange.
    pub color: u8,
}

/// A file and whatever tags it carries.
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TaggedPath {
    pub path: String,
    pub tags: Vec<FinderTag>,
}

/// Parse the plist array into tags. `"Red\n6"` -> name "Red", colour 6.
fn decode(raw: &[u8]) -> Vec<FinderTag> {
    let Ok(val) = plist::Value::from_reader_xml(raw)
        .or_else(|_| plist::from_bytes::<plist::Value>(raw))
    else {
        return Vec::new();
    };
    let Some(arr) = val.as_array() else { return Vec::new() };
    arr.iter()
        .filter_map(|v| v.as_string())
        .map(|s| {
            // Split on the LAST newline: a tag name may legitimately contain
            // one, and the colour is always the final component.
            match s.rsplit_once('\n') {
                Some((name, idx)) => FinderTag {
                    name: name.to_string(),
                    color: idx.trim().parse().unwrap_or(0),
                },
                // A bare name is a tag with no colour, which is legal.
                None => FinderTag { name: s.to_string(), color: 0 },
            }
        })
        .collect()
}

/// Build the binary plist Finder expects.
fn encode(tags: &[FinderTag]) -> Result<Vec<u8>, String> {
    let strings: Vec<plist::Value> = tags
        .iter()
        .map(|t| plist::Value::String(format!("{}\n{}", t.name, t.color)))
        .collect();
    let mut buf = Vec::new();
    plist::to_writer_binary(&mut buf, &plist::Value::Array(strings))
        .map_err(|e| format!("encode tags: {e}"))?;
    Ok(buf)
}

/// Read tags for many paths in one round trip. Unreadable paths come back with
/// an empty list rather than failing the batch.
#[tauri::command]
pub async fn read_finder_tags(paths: Vec<String>) -> Result<Vec<TaggedPath>, crate::AppError> {
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let tags = match xattr::get(&path, TAG_ATTR) {
            Ok(Some(raw)) => decode(&raw),
            _ => Vec::new(),
        };
        out.push(TaggedPath { path, tags });
    }
    Ok(out)
}

/// Replace a path's tags. An empty list REMOVES the attribute rather than
/// writing an empty array, so an untagged file is byte-identical to one that
/// was never tagged.
#[tauri::command]
pub async fn set_finder_tags(
    path: String,
    tags: Vec<FinderTag>,
) -> Result<(), crate::AppError> {
    if !std::path::Path::new(&path).exists() {
        return Err(format!("Not found: {path}").into());
    }
    if tags.is_empty() {
        // remove_err is ignored: "there was no attribute" is the desired end
        // state, not a failure.
        let _ = xattr::remove(&path, TAG_ATTR);
        return Ok(());
    }
    let encoded = encode(&tags)?;
    xattr::set(&path, TAG_ATTR, &encoded)
        .map_err(|e| crate::AppError::Io(format!("write tags: {e}")))?;
    // Finder writes an empty FinderInfo alongside a tag write when one is not
    // already present. Matching that keeps a file we tagged indistinguishable
    // from one Finder tagged.
    if matches!(xattr::get(&path, FINDER_INFO_ATTR), Ok(None)) {
        let _ = xattr::set(&path, FINDER_INFO_ATTR, &[0u8; 32]);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_coloured_tag() {
        let tags = vec![FinderTag { name: "Red".into(), color: 6 }];
        let back = decode(&encode(&tags).unwrap());
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].name, "Red");
        assert_eq!(back[0].color, 6);
    }

    #[test]
    fn round_trips_several() {
        let tags = vec![
            FinderTag { name: "Approved".into(), color: 2 },
            FinderTag { name: "Needs work".into(), color: 6 },
        ];
        let back = decode(&encode(&tags).unwrap());
        assert_eq!(back.len(), 2);
        assert_eq!(back[1].name, "Needs work");
        assert_eq!(back[1].color, 6);
    }

    #[test]
    fn a_bare_name_is_a_tag_with_no_colour() {
        // Finder writes label-only tags without a colour component.
        let mut buf = Vec::new();
        plist::to_writer_binary(
            &mut buf,
            &plist::Value::Array(vec![plist::Value::String("Archive".into())]),
        )
        .unwrap();
        let back = decode(&buf);
        assert_eq!(back[0].name, "Archive");
        assert_eq!(back[0].color, 0);
    }

    #[test]
    fn a_name_containing_a_newline_keeps_it() {
        // The colour is the LAST component, so splitting on the first newline
        // would truncate the name and lose the colour.
        let tags = vec![FinderTag { name: "two\nlines".into(), color: 4 }];
        let back = decode(&encode(&tags).unwrap());
        assert_eq!(back[0].name, "two\nlines");
        assert_eq!(back[0].color, 4);
    }

    #[test]
    fn finder_writes_index_1_for_every_colour() {
        // Measured on a real Tahoe machine, from folders Finder renders in four
        // DIFFERENT colours. The index is not the colour: Finder resolves a
        // named tag from its own tag list and writes 1 regardless. Trusting it
        // painted every Finder-tagged folder grey, so the frontend resolves by
        // NAME first (see swatchForTag in src/lib/finder-tags.ts) and this test
        // pins the encoding that makes that necessary.
        for name in ["Purple", "Red", "Green", "Blue"] {
            // What Finder actually leaves on disk: the colour NAME, then 1.
            let on_disk = vec![FinderTag { name: name.into(), color: 1 }];
            let back = decode(&encode(&on_disk).unwrap());
            assert_eq!(back.len(), 1, "{name}");
            assert_eq!(back[0].name, name);
            assert_eq!(back[0].color, 1, "Finder really does write 1 for {name}");
        }
    }

    #[test]
    fn garbage_decodes_to_nothing_rather_than_panicking() {
        assert!(decode(b"not a plist at all").is_empty());
        assert!(decode(&[]).is_empty());
    }
}
