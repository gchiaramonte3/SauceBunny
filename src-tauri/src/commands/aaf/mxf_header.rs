//! Native MXF header identity. The partition pack says exactly how many bytes
//! of header metadata follow, so identity costs one or two small reads rather
//! than a Python parse: on NEXIS that was ~4.7 s per file, serialized by the
//! GIL. Only the sets needed to map a material track to its source package are
//! decoded. Anything unexpected is an error, and the caller falls back to the
//! sidecar's full parser, so this path can never accept what that one rejects.
use super::linked_probe::MxfTrack;
use crate::AppError;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, io::{Read, Seek, SeekFrom}, path::Path};

const FIRST_READ: usize = 64 * 1024;
const MAX_HEADER: u64 = 16 * 1024 * 1024;
const RUN_IN: usize = 64 * 1024;

const MATERIAL_PACKAGE: u8 = 0x36;
const SOURCE_PACKAGE: u8 = 0x37;
const TRACK: u8 = 0x3B;
const SEQUENCE: u8 = 0x0F;
const SOURCE_CLIP: u8 = 0x11;
const MULTIPLE_DESCRIPTOR: u8 = 0x44;
const SOUND_DESCRIPTORS: [u8; 3] = [0x42, 0x47, 0x48];

/// What the header says about one sound essence track. Present only when the
/// descriptor carried every field; a partial descriptor leaves ffprobe to decide.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct MxfSound { pub sample_rate: u32, pub bits: u32, pub channels: u32, pub samples: u64, pub pcm: bool }

#[derive(Debug, PartialEq)]
pub struct Inspection { pub tracks: Vec<MxfTrack>, pub sound: Option<MxfSound> }

struct Set<'a> { kind: u8, props: HashMap<u16, &'a [u8]> }

fn invalid(message: &str) -> AppError { AppError::invalid(format!("MXF header: {message}")) }

fn ber(bytes: &[u8], at: usize) -> Result<(u64, usize), AppError> {
    let first = *bytes.get(at).ok_or_else(|| invalid("truncated length"))?;
    if first < 0x80 { return Ok((u64::from(first), at + 1)); }
    let count = usize::from(first & 0x7f);
    if count == 0 || count > 8 { return Err(invalid("unsupported length")); }
    let raw = bytes.get(at + 1..at + 1 + count).ok_or_else(|| invalid("truncated length"))?;
    Ok((raw.iter().fold(0_u64, |value, byte| value << 8 | u64::from(*byte)), at + 1 + count))
}

/// (key, value range) of the KLV starting at `at`.
fn klv(bytes: &[u8], at: usize) -> Result<(&[u8], usize, usize), AppError> {
    let key = bytes.get(at..at + 16).ok_or_else(|| invalid("truncated key"))?;
    let (length, start) = ber(bytes, at + 16)?;
    let end = start.checked_add(usize::try_from(length).map_err(|_| invalid("length overflow"))?).ok_or_else(|| invalid("length overflow"))?;
    Ok((key, start, end))
}

fn is_header_partition(key: &[u8]) -> bool {
    key.len() == 16 && key[..4] == [0x06, 0x0e, 0x2b, 0x34] && key[4] == 0x02 && key[5] == 0x05 && key[8..13] == [0x0d, 0x01, 0x02, 0x01, 0x01] && key[13] == 0x02
}
fn is_fill(key: &[u8]) -> bool { key[..4] == [0x06, 0x0e, 0x2b, 0x34] && key[8..13] == [0x03, 0x01, 0x02, 0x10, 0x01] }
fn set_kind(key: &[u8]) -> Option<u8> {
    (key[..4] == [0x06, 0x0e, 0x2b, 0x34] && key[4] == 0x02 && key[5] == 0x53 && key[8..14] == [0x0d, 0x01, 0x01, 0x01, 0x01, 0x01]).then_some(key[14])
}

fn u32_be(value: &[u8]) -> Result<u32, AppError> { Ok(u32::from_be_bytes(value.try_into().map_err(|_| invalid("bad 32-bit value"))?)) }
fn i64_be(value: &[u8]) -> Result<i64, AppError> { Ok(i64::from_be_bytes(value.try_into().map_err(|_| invalid("bad 64-bit value"))?)) }
fn rational(value: &[u8]) -> Result<(i64, i64), AppError> {
    if value.len() != 8 { return Err(invalid("bad rational")); }
    Ok((i64::from(u32_be(&value[..4])? as i32), i64::from(u32_be(&value[4..])? as i32)))
}
fn refs(value: &[u8]) -> Result<Vec<&[u8]>, AppError> {
    if value.len() < 8 { return Err(invalid("bad reference batch")); }
    let (count, size) = (u32_be(&value[..4])? as usize, u32_be(&value[4..8])? as usize);
    if size != 16 || value.len() != 8 + count * 16 { return Err(invalid("bad reference batch")); }
    Ok(value[8..].as_chunks::<16>().0.iter().map(|id| id.as_slice()).collect())
}
fn umid(value: &[u8]) -> Result<String, AppError> {
    if value.len() != 32 { return Err(invalid("bad package UMID")); }
    Ok(format!("urn:smpte:umid:{}", value.chunks(4).map(|c| c.iter().map(|b| format!("{b:02x}")).collect::<String>()).collect::<Vec<_>>().join(".")))
}

/// Standard sound data definition, or Avid's legacy sound AUID (stored with its
/// halves swapped, as MXF stores every AUID that is not a SMPTE UL).
fn is_sound(value: &[u8]) -> bool {
    const LEGACY: [u8; 16] = [0x80, 0x7d, 0x00, 0x60, 0x08, 0x14, 0x3e, 0x6f, 0x78, 0xe1, 0xeb, 0xe1, 0x6c, 0xef, 0x11, 0xd2];
    value.len() == 16 && (value == LEGACY || (value[..7] == [0x06, 0x0e, 0x2b, 0x34, 0x04, 0x01, 0x01] && value[8..13] == [0x01, 0x03, 0x02, 0x02, 0x02]))
}

pub fn read(path: &Path) -> Result<Inspection, AppError> {
    let mut file = std::fs::File::open(path)?;
    let size = file.metadata()?.len();
    let mut head = vec![0_u8; FIRST_READ.min(size as usize)];
    file.read_exact(&mut head)?;
    // A run-in may precede the header partition pack (SMPTE 377-1 allows 64 KiB).
    let start = (0..RUN_IN.min(head.len().saturating_sub(16))).find(|&at| is_header_partition(&head[at..at + 16]))
        .ok_or_else(|| invalid("no header partition"))?;
    let (_, pack, pack_end) = klv(&head, start)?;
    let fields = head.get(pack..pack_end).filter(|v| v.len() >= 40).ok_or_else(|| invalid("truncated partition pack"))?;
    let header_bytes = u64::from_be_bytes(fields[32..40].try_into().map_err(|_| invalid("bad header size"))?);
    if header_bytes == 0 { return Err(invalid("no header metadata in the header partition")); }
    if header_bytes > MAX_HEADER { return Err(invalid("header metadata exceeds the inspection limit")); }
    let mut at = pack_end;
    loop {
        let (key, _, end) = klv(&head, at)?;
        if !is_fill(key) { break; }
        at = end;
    }
    let end = at as u64 + header_bytes;
    if end > size { return Err(invalid("header metadata runs past the end of the file")); }
    let metadata = if end as usize <= head.len() { head[at..end as usize].to_vec() } else {
        let mut bytes = vec![0_u8; header_bytes as usize];
        file.seek(SeekFrom::Start(at as u64))?;
        file.read_exact(&mut bytes)?;
        bytes
    };
    parse(&metadata)
}

pub fn parse(metadata: &[u8]) -> Result<Inspection, AppError> {
    let mut sets: HashMap<&[u8], Set> = HashMap::new();
    let mut at = 0;
    while at + 17 <= metadata.len() {
        let (key, start, end) = klv(metadata, at)?;
        let value = metadata.get(start..end).ok_or_else(|| invalid("set runs past the header"))?;
        if let Some(kind) = set_kind(key) {
            let mut props = HashMap::new();
            let mut cursor = 0;
            while cursor + 4 <= value.len() {
                let tag = u16::from_be_bytes([value[cursor], value[cursor + 1]]);
                let len = usize::from(u16::from_be_bytes([value[cursor + 2], value[cursor + 3]]));
                let item = value.get(cursor + 4..cursor + 4 + len).ok_or_else(|| invalid("property runs past its set"))?;
                props.insert(tag, item); cursor += 4 + len;
            }
            if cursor != value.len() { return Err(invalid("malformed local set")); }
            let id = *props.get(&0x3C0A).ok_or_else(|| invalid("set without an instance id"))?;
            if sets.insert(id, Set { kind, props }).is_some() { return Err(invalid("duplicate instance id")); }
        }
        at = end;
    }
    let of_kind = |kind: u8| sets.values().filter(move |s| s.kind == kind);
    let materials: Vec<_> = of_kind(MATERIAL_PACKAGE).collect();
    if materials.len() != 1 { return Err(invalid("expected one material package")); }
    let resolve = |id: &[u8]| sets.get(id).ok_or_else(|| invalid("dangling reference"));
    let sources: Vec<(String, &Set)> = of_kind(SOURCE_PACKAGE).map(|s| Ok((umid(get(s, 0x4401)?)?, s))).collect::<Result<_, AppError>>()?;
    let segment_clip = |track: &Set| -> Result<Option<&Set>, AppError> {
        let segment = resolve(get(track, 0x4803)?)?;
        let (sound, clips) = match segment.kind {
            SEQUENCE => (is_sound(get(segment, 0x0201)?), refs(get(segment, 0x1001)?)?.into_iter().map(resolve).collect::<Result<Vec<_>, _>>()?),
            SOURCE_CLIP => (is_sound(get(segment, 0x0201)?), vec![segment]),
            _ => return Ok(None),
        };
        if !sound { return Ok(None); }
        if clips.len() != 1 || clips[0].kind != SOURCE_CLIP { return Err(invalid("audio track contains unsupported nested edits")); }
        Ok(Some(clips[0]))
    };
    let origin = |set: &Set| set.props.get(&0x4B02).map_or(Ok(0), |v| i64_be(v));
    let mut tracks = Vec::new();
    let mut sound_package = None;
    for id in refs(get(materials[0], 0x4403)?)? {
        let track = resolve(id)?;
        if track.kind != TRACK { continue; }
        let Some(clip) = segment_clip(track)? else { continue };
        let mob_id = umid(get(clip, 0x1101)?)?;
        let slot_id = u32_be(get(clip, 0x1102)?)?;
        let matching: Vec<_> = sources.iter().filter(|(uid, _)| *uid == mob_id).collect();
        if matching.len() != 1 { return Err(invalid("audio source package is missing or ambiguous")); }
        let package = matching[0].1;
        let slots: Vec<&Set> = refs(get(package, 0x4403)?)?.into_iter().map(resolve).collect::<Result<Vec<_>, _>>()?
            .into_iter().filter(|s| s.kind == TRACK && s.props.get(&0x4801).is_some_and(|v| u32_be(v).ok() == Some(slot_id))).collect();
        if slots.len() != 1 || !is_sound(get(resolve(get(slots[0], 0x4803)?)?, 0x0201)?) {
            return Err(invalid("audio source slot is missing or ambiguous"));
        }
        let start = clip.props.get(&0x1201).map_or(Ok(0), |v| i64_be(v))?;
        tracks.push(MxfTrack { material_track_id: u32_be(get(track, 0x4801)?)?, mob_id, slot_id,
            aligned: origin(track)? == 0 && origin(slots[0])? == 0 && start == 0 });
        sound_package = Some((package, slot_id));
    }
    if tracks.is_empty() { return Err(invalid("no recognized audio source mappings")); }
    if tracks.len() > 256 { return Err(invalid("more than 256 audio streams")); }
    // Descriptor facts are only offered for the single-track case ffprobe
    // would otherwise confirm; anything richer keeps the full probe.
    let sound = if tracks.len() == 1 { sound_package.and_then(|(package, slot)| descriptor(&sets, package, slot)) } else { None };
    Ok(Inspection { tracks, sound })
}

fn get<'a>(set: &Set<'a>, tag: u16) -> Result<&'a [u8], AppError> {
    set.props.get(&tag).copied().ok_or_else(|| invalid("missing property"))
}

fn descriptor(sets: &HashMap<&[u8], Set>, package: &Set, slot: u32) -> Option<MxfSound> {
    let mut descriptor = sets.get(*package.props.get(&0x4701)?)?;
    if descriptor.kind == MULTIPLE_DESCRIPTOR {
        let children: Vec<&Set> = refs(descriptor.props.get(&0x3F01)?).ok()?.into_iter().filter_map(|id| sets.get(id)).collect();
        let linked: Vec<_> = children.into_iter().filter(|d| SOUND_DESCRIPTORS.contains(&d.kind) && d.props.get(&0x3006).and_then(|v| u32_be(v).ok()) == Some(slot)).collect();
        if linked.len() != 1 { return None; }
        descriptor = linked[0];
    }
    if !SOUND_DESCRIPTORS.contains(&descriptor.kind) { return None; }
    let field = |tag| descriptor.props.get(&tag).copied();
    let (rate_n, rate_d) = rational(field(0x3D03)?).ok()?;
    let (edit_n, edit_d) = rational(field(0x3001)?).ok()?;
    let duration = i64_be(field(0x3002)?).ok()?;
    if rate_d != 1 || rate_n <= 0 || edit_n <= 0 || edit_d <= 0 || duration < 0 { return None; }
    // ContainerDuration counts edit units; convert to audio samples exactly.
    let samples = i128::from(duration) * i128::from(rate_n) * i128::from(edit_d);
    if samples % i128::from(edit_n) != 0 { return None; }
    let container = field(0x3004)?;
    // SMPTE 382 wave/AES3 audio mappings (0d.01.03.01.02.06.xx) are uncompressed PCM.
    // Sound essence coding is optional; when present it must say uncompressed.
    let pcm = container.len() == 16 && container[..4] == [0x06, 0x0e, 0x2b, 0x34] && container[8..14] == [0x0d, 0x01, 0x03, 0x01, 0x02, 0x06]
        && field(0x3D06).is_none_or(|coding| coding.len() == 16 && coding[8..12] == [0x04, 0x02, 0x02, 0x01]);
    Some(MxfSound { sample_rate: u32::try_from(rate_n).ok()?, bits: u32_be(field(0x3D01)?).ok()?, channels: u32_be(field(0x3D07)?).ok()?,
        samples: u64::try_from(samples / i128::from(edit_n)).ok()?, pcm })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    const OPATOM: &[u8] = include_bytes!("fixtures/opatom.mxf-head");
    const OP1A: &[u8] = include_bytes!("fixtures/op1a.mxf-head");
    const LEGACY: &[u8] = include_bytes!("fixtures/legacy.mxf-head");

    fn read_bytes(bytes: &[u8]) -> Result<Inspection, AppError> {
        let path = std::env::temp_dir().join(format!("mxf-header-{}.mxf", uuid::Uuid::new_v4()));
        std::fs::write(&path, bytes).unwrap();
        let result = read(&path);
        std::fs::remove_file(path).unwrap();
        result
    }
    fn patch_all(bytes: &[u8], tag: [u8; 4], value: &[u8]) -> Vec<u8> {
        let mut out = bytes.to_vec();
        let mut at = 0; let mut patched = 0;
        while let Some(offset) = out[at..].windows(4).position(|w| w == tag) {
            let start = at + offset + 4;
            out[start..start + value.len()].copy_from_slice(value); patched += 1; at = start;
        }
        assert!(patched > 0, "the fixture no longer contains the property being patched");
        out
    }

    #[test]
    fn identities_match_the_reference_parser_for_every_fixture() {
        let expected: BTreeMap<String, Vec<MxfTrack>> = serde_json::from_str(include_str!("fixtures/expected.json")).unwrap();
        assert_eq!(expected.len(), 3);
        for (name, bytes) in [("opatom", OPATOM), ("op1a", OP1A), ("legacy", LEGACY)] {
            assert_eq!(read_bytes(bytes).unwrap().tracks, expected[name], "{name}");
        }
    }

    #[test]
    fn single_track_pcm_reports_its_format_and_multi_track_leaves_it_to_ffprobe() {
        assert_eq!(read_bytes(OPATOM).unwrap().sound, Some(MxfSound { sample_rate: 48000, bits: 24, channels: 1, samples: 96000, pcm: true }));
        assert_eq!(read_bytes(LEGACY).unwrap().sound.map(|s| s.samples), Some(96000));
        assert_eq!(read_bytes(OP1A).unwrap().sound, None);
    }

    #[test]
    fn a_nonzero_clip_start_is_reported_as_unaligned() {
        let shifted = patch_all(OPATOM, [0x12, 0x01, 0x00, 0x08], &1_i64.to_be_bytes());
        assert!(read_bytes(&shifted).unwrap().tracks.iter().all(|t| !t.aligned));
    }

    #[test]
    fn unusual_or_damaged_headers_fail_so_the_full_parser_decides() {
        let mut oversized = OPATOM.to_vec();
        let (_, pack, _) = klv(&oversized, 0).unwrap();
        oversized[pack + 32..pack + 40].copy_from_slice(&(MAX_HEADER + 1).to_be_bytes());
        assert!(read_bytes(&oversized).is_err());
        assert!(read_bytes(&OPATOM[..3000]).is_err());
        assert!(read_bytes(&[0_u8; 4096]).is_err());
        let mut empty = OPATOM.to_vec();
        empty[pack + 32..pack + 40].copy_from_slice(&0_u64.to_be_bytes());
        assert!(read_bytes(&empty).is_err());
    }
}
