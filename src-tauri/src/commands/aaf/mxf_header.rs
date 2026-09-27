//! Native MXF header identity. The partition pack says exactly how many bytes
//! of header metadata follow, so identity costs one or two small reads rather
//! than a Python parse: on NEXIS that was ~4.7 s per file, serialized by the
//! GIL. Only the sets needed to map a material track to its source package are
//! decoded. Anything unexpected is an error, and the caller falls back to the
//! sidecar's full parser, so this path can never accept what that one rejects.
//!
//! Picture tracks, their CDCI/RGBA descriptor and the file package's timecode
//! are read on the same pass, but only as additive facts: a picture track or
//! timecode that does not parse leaves those facts empty and never costs the
//! audio mapping, which behaves exactly as it did before pictures were read.
use super::linked_probe::{MxfTrack, MxfTrackKind};
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
const TIMECODE: u8 = 0x14;
const MULTIPLE_DESCRIPTOR: u8 = 0x44;
const SOUND_DESCRIPTORS: [u8; 3] = [0x42, 0x47, 0x48];
/// Generic picture, CDCI, RGBA, and MPEG-2 video (a CDCI subclass carrying the
/// same picture properties; FFmpeg writes it for MPEG-2 OP1a).
const PICTURE_DESCRIPTORS: [u8; 4] = [0x27, 0x28, 0x29, 0x51];

/// What the header says about one sound essence track. Present only when the
/// descriptor carried every field; a partial descriptor leaves ffprobe to decide.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct MxfSound { pub sample_rate: u32, pub bits: u32, pub channels: u32, pub samples: u64, pub pcm: bool }

/// What the header says about the one picture essence track. Width, height
/// and edit rate are required; the rest is reported only when present, since
/// FFmpeg, for one, never writes ContainerDuration into a picture descriptor.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct MxfPicture {
    /// Set kind of the descriptor: 0x28 CDCI, 0x29 RGBA, 0x27 generic, 0x51 MPEG.
    pub descriptor: u8,
    pub width: u32,
    pub height: u32,
    /// 0 full frame, 1 separate fields, 2 single field, 3 mixed fields, 4
    /// segmented frame. With separate fields the stored height is one field's.
    pub frame_layout: Option<u8>,
    pub rate_numerator: u32,
    pub rate_denominator: u32,
    /// ContainerDuration (0x3002), in edit units.
    pub container_duration: Option<u64>,
    /// The file package track's own length, in edit units.
    pub length: Option<u64>,
    /// Picture essence coding (0x3201) as `urn:smpte:ul:...`.
    pub coding: Option<String>,
}

/// The file source package's Timecode component: its first frame, counted at
/// the rounded timebase.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct MxfTimecode { pub start: u64, pub rounded_base: u16, pub drop_frame: bool }

impl MxfTimecode {
    /// `HH:MM:SS:FF`, or `HH:MM:SS;FF` for drop-frame at a multiple of 30.
    pub fn label(&self) -> String {
        let base = u64::from(self.rounded_base.max(1));
        let mut frames = self.start;
        let drop = if self.drop_frame && base % 30 == 0 { base / 15 } else { 0 };
        if drop > 0 {
            let per_ten = base * 600 - drop * 9;
            let per_minute = base * 60 - drop;
            let (tens, rest) = (frames / per_ten, frames % per_ten);
            frames += drop * 9 * tens + if rest > drop { drop * ((rest - drop) / per_minute) } else { 0 };
        }
        let separator = if drop > 0 { ';' } else { ':' };
        format!("{:02}:{:02}:{:02}{separator}{:02}", frames / (base * 3600), frames / (base * 60) % 60, frames / base % 60, frames % base)
    }
}

#[derive(Debug, PartialEq)]
pub struct Inspection {
    /// Sound mappings only: the relink identity, unchanged by picture support.
    pub tracks: Vec<MxfTrack>,
    pub sound: Option<MxfSound>,
    /// Picture mappings, each flagged `MxfTrackKind::Picture`. Empty when the
    /// file has no picture or its picture mapping did not parse.
    pub picture_tracks: Vec<MxfTrack>,
    /// Descriptor facts, offered only for a single picture track.
    pub picture: Option<MxfPicture>,
    pub timecode: Option<MxfTimecode>,
}

impl Inspection {
    /// The picture and timecode facts as one diagnostics fragment.
    pub fn picture_summary(&self) -> String {
        let mut out = String::new();
        if !self.picture_tracks.is_empty() { out += &format!(" · {} picture mappings", self.picture_tracks.len()); }
        if let Some(p) = &self.picture {
            out += &format!(" · {}x{} layout {:?} at {}/{} · duration {:?} length {:?} · coding {} · descriptor 0x{:02x}", p.width, p.height,
                p.frame_layout, p.rate_numerator, p.rate_denominator, p.container_duration, p.length, p.coding.as_deref().unwrap_or("unknown"), p.descriptor);
        }
        if let Some(tc) = &self.timecode { out += &format!(" · TC {} base {}", tc.label(), tc.rounded_base); }
        out
    }
}

struct Set<'a> { kind: u8, props: HashMap<u16, &'a [u8]> }
/// A material track segment's data definition and its components.
type Segment<'s, 'a> = (&'a [u8], Vec<&'s Set<'a>>);

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
fn dotted(value: &[u8]) -> String {
    value.chunks(4).map(|c| c.iter().map(|b| format!("{b:02x}")).collect::<String>()).collect::<Vec<_>>().join(".")
}
fn umid(value: &[u8]) -> Result<String, AppError> {
    if value.len() != 32 { return Err(invalid("bad package UMID")); }
    Ok(format!("urn:smpte:umid:{}", dotted(value)))
}

/// Standard sound data definition, or Avid's legacy sound AUID (stored with its
/// halves swapped, as MXF stores every AUID that is not a SMPTE UL).
fn is_sound(value: &[u8]) -> bool {
    const LEGACY: [u8; 16] = [0x80, 0x7d, 0x00, 0x60, 0x08, 0x14, 0x3e, 0x6f, 0x78, 0xe1, 0xeb, 0xe1, 0x6c, 0xef, 0x11, 0xd2];
    value.len() == 16 && (value == LEGACY || (value[..7] == [0x06, 0x0e, 0x2b, 0x34, 0x04, 0x01, 0x01] && value[8..13] == [0x01, 0x03, 0x02, 0x02, 0x02]))
}

/// Standard picture data definition, or Avid's legacy picture AUID
/// {6f3c8ce1-6cef-11d2-807d-006008143e6f}, halves swapped like the sound one.
fn is_picture(value: &[u8]) -> bool {
    const LEGACY: [u8; 16] = [0x80, 0x7d, 0x00, 0x60, 0x08, 0x14, 0x3e, 0x6f, 0x6f, 0x3c, 0x8c, 0xe1, 0x6c, 0xef, 0x11, 0xd2];
    value.len() == 16 && (value == LEGACY || (value[..7] == [0x06, 0x0e, 0x2b, 0x34, 0x04, 0x01, 0x01] && value[8..13] == [0x01, 0x03, 0x02, 0x02, 0x01]))
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
    // The data definition and components of a material track's segment. Every
    // track is resolved this far, as it always was, before its kind matters.
    let segment_clips = |track: &Set| -> Result<Option<Segment<'_, '_>>, AppError> {
        let segment = resolve(get(track, 0x4803)?)?;
        Ok(Some(match segment.kind {
            SEQUENCE => (get(segment, 0x0201)?, refs(get(segment, 0x1001)?)?.into_iter().map(resolve).collect::<Result<Vec<_>, _>>()?),
            SOURCE_CLIP => (get(segment, 0x0201)?, vec![segment]),
            _ => return Ok(None),
        }))
    };
    let origin = |set: &Set| set.props.get(&0x4B02).map_or(Ok(0), |v| i64_be(v));
    // Material track → (identity, file source package, file package slot).
    let map = |track: &Set, clips: &[&Set], kind: MxfTrackKind| -> Result<(MxfTrack, &Set, &Set), AppError> {
        let (label, wanted): (&str, fn(&[u8]) -> bool) = match kind { MxfTrackKind::Sound => ("audio", is_sound), MxfTrackKind::Picture => ("picture", is_picture) };
        if clips.len() != 1 || clips[0].kind != SOURCE_CLIP { return Err(invalid(&format!("{label} track contains unsupported nested edits"))); }
        let clip = clips[0];
        let mob_id = umid(get(clip, 0x1101)?)?;
        let slot_id = u32_be(get(clip, 0x1102)?)?;
        let matching: Vec<_> = sources.iter().filter(|(uid, _)| *uid == mob_id).collect();
        if matching.len() != 1 { return Err(invalid(&format!("{label} source package is missing or ambiguous"))); }
        let package = matching[0].1;
        let slots: Vec<&Set> = refs(get(package, 0x4403)?)?.into_iter().map(resolve).collect::<Result<Vec<_>, _>>()?
            .into_iter().filter(|s| s.kind == TRACK && s.props.get(&0x4801).is_some_and(|v| u32_be(v).ok() == Some(slot_id))).collect();
        if slots.len() != 1 || !wanted(get(resolve(get(slots[0], 0x4803)?)?, 0x0201)?) {
            return Err(invalid(&format!("{label} source slot is missing or ambiguous")));
        }
        let start = clip.props.get(&0x1201).map_or(Ok(0), |v| i64_be(v))?;
        Ok((MxfTrack { material_track_id: u32_be(get(track, 0x4801)?)?, mob_id, slot_id,
            aligned: origin(track)? == 0 && origin(slots[0])? == 0 && start == 0, kind }, package, slots[0]))
    };
    let mut tracks = Vec::new();
    let mut sound_package = None;
    let mut picture_candidates = Vec::new();
    for id in refs(get(materials[0], 0x4403)?)? {
        let track = resolve(id)?;
        if track.kind != TRACK { continue; }
        let Some((definition, clips)) = segment_clips(track)? else { continue };
        if is_picture(definition) { picture_candidates.push((track, clips)); continue; }
        if !is_sound(definition) { continue; }
        let (identity, package, _) = map(track, &clips, MxfTrackKind::Sound)?;
        tracks.push(identity);
        sound_package = Some(package);
    }
    // A picture mapping that does not parse is dropped whole: it is extra
    // information, and a partial list would read as the file's whole picture.
    let pictures: Vec<(MxfTrack, &Set, &Set)> = picture_candidates.iter().map(|(track, clips)| map(track, clips, MxfTrackKind::Picture))
        .collect::<Result<Vec<_>, _>>().ok().filter(|p| p.len() <= 256).unwrap_or_default();
    if tracks.is_empty() && pictures.is_empty() { return Err(invalid("no recognized audio source mappings")); }
    if tracks.len() > 256 { return Err(invalid("more than 256 audio streams")); }
    // Descriptor facts are only offered for the single-track case ffprobe
    // would otherwise confirm; anything richer keeps the full probe.
    let sound = if tracks.len() == 1 { sound_package.and_then(|package| descriptor(&sets, package)) } else { None };
    let picture = match pictures.as_slice() { [(identity, package, slot)] => picture_descriptor(&sets, package, slot, identity.slot_id), _ => None };
    // Timecode is read only when every mapping comes from one file package.
    let mut packages = sound_package.into_iter().chain(pictures.iter().map(|(_, package, _)| *package));
    let timecode = packages.next().filter(|first| packages.all(|p| std::ptr::eq(p, *first))).and_then(|package| timecode(&sets, package));
    Ok(Inspection { tracks, sound, picture_tracks: pictures.into_iter().map(|(identity, _, _)| identity).collect(), picture, timecode })
}

fn get<'a>(set: &Set<'a>, tag: u16) -> Result<&'a [u8], AppError> {
    set.props.get(&tag).copied().ok_or_else(|| invalid("missing property"))
}

fn descriptor(sets: &HashMap<&[u8], Set>, package: &Set) -> Option<MxfSound> {
    let descriptor = sets.get(*package.props.get(&0x4701)?)?;
    // Only a lone sound descriptor (true OP-Atom) proves the file's only stream
    // is this audio. A MultipleDescriptor file can carry video as stream 0, and
    // the caller binds stream 0 without ffprobe, so it must be probed instead.
    if descriptor.kind == MULTIPLE_DESCRIPTOR || !SOUND_DESCRIPTORS.contains(&descriptor.kind) { return None; }
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

fn picture_descriptor(sets: &HashMap<&[u8], Set>, package: &Set, slot: &Set, slot_id: u32) -> Option<MxfPicture> {
    let top = sets.get(*package.props.get(&0x4701)?)?;
    let descriptor = if top.kind == MULTIPLE_DESCRIPTOR {
        // OP1a: the sub-descriptor linked to this slot, else the only picture one.
        let pictures: Vec<&Set> = refs(top.props.get(&0x3F01)?).ok()?.into_iter().filter_map(|id| sets.get(id))
            .filter(|d| PICTURE_DESCRIPTORS.contains(&d.kind)).collect();
        let linked: Vec<&Set> = pictures.iter().copied().filter(|d| d.props.get(&0x3006).is_some_and(|v| u32_be(v).ok() == Some(slot_id))).collect();
        match (linked.as_slice(), pictures.as_slice()) { ([one], _) | ([], [one]) => *one, _ => return None }
    } else { top };
    if !PICTURE_DESCRIPTORS.contains(&descriptor.kind) { return None; }
    let field = |tag| descriptor.props.get(&tag).copied();
    let (rate_n, rate_d) = rational(field(0x3001)?).ok()?;
    let (width, height) = (u32_be(field(0x3203)?).ok()?, u32_be(field(0x3202)?).ok()?);
    if width == 0 || height == 0 { return None; }
    let frame_layout = match field(0x320C) { None => None, Some([layout]) => Some(*layout), Some(_) => return None };
    // An absent count is None; a present one that is malformed or negative
    // rejects the descriptor rather than being reported as absent.
    let count = |value: Option<&[u8]>| match value { None => Some(None), Some(v) => i64_be(v).ok().and_then(|n| u64::try_from(n).ok()).map(Some) };
    let container_duration = count(field(0x3002))?;
    let length = count(sets.get(*slot.props.get(&0x4803)?)?.props.get(&0x0202).copied())?;
    let coding = match field(0x3201) { None => None, Some(ul) if ul.len() == 16 => Some(format!("urn:smpte:ul:{}", dotted(ul))), Some(_) => return None };
    Some(MxfPicture { descriptor: descriptor.kind, width, height, frame_layout, rate_numerator: u32::try_from(rate_n).ok().filter(|n| *n > 0)?,
        rate_denominator: u32::try_from(rate_d).ok().filter(|d| *d > 0)?, container_duration, length, coding })
}

/// The file package's one timecode track: a Timecode component, alone or as
/// the only component of a sequence. More than one, or one inside an edited
/// sequence, is not a single start timecode and reports none.
fn timecode(sets: &HashMap<&[u8], Set>, package: &Set) -> Option<MxfTimecode> {
    let mut found = Vec::new();
    for track in refs(package.props.get(&0x4403)?).ok()?.into_iter().filter_map(|id| sets.get(id)).filter(|t| t.kind == TRACK) {
        let Some(segment) = track.props.get(&0x4803).and_then(|id| sets.get(*id)) else { continue };
        match segment.kind {
            TIMECODE => found.push(segment),
            SEQUENCE => {
                let components: Vec<&Set> = segment.props.get(&0x1001).and_then(|v| refs(v).ok()).unwrap_or_default()
                    .into_iter().filter_map(|id| sets.get(id)).collect();
                match components.as_slice() {
                    [one] if one.kind == TIMECODE => found.push(*one),
                    many if many.iter().any(|c| c.kind == TIMECODE) => return None,
                    _ => {}
                }
            }
            _ => {}
        }
    }
    let [component] = found.as_slice() else { return None };
    let start = u64::try_from(i64_be(component.props.get(&0x1501)?).ok()?).ok()?;
    let rounded_base = match component.props.get(&0x1502)? { [a, b] => u16::from_be_bytes([*a, *b]), _ => return None };
    let drop_frame = match component.props.get(&0x1503)? { [flag] => *flag != 0, _ => return None };
    (rounded_base > 0).then_some(MxfTimecode { start, rounded_base, drop_frame })
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

    // DNxHD fixtures from `aaf-sidecar/make_mxf_header_fixtures.py`. Their
    // expected values come from the reference parser (audio) and ffprobe
    // (picture and timecode) run over the complete files, not from this reader.
    const PICTURE_OPATOM: &[u8] = include_bytes!("fixtures/picture-opatom.mxf-head");
    const PICTURE_OP1A: &[u8] = include_bytes!("fixtures/picture-op1a.mxf-head");
    const STANDARD_PICTURE: [u8; 16] = [0x06, 0x0e, 0x2b, 0x34, 0x04, 0x01, 0x01, 0x01, 0x01, 0x03, 0x02, 0x02, 0x01, 0x00, 0x00, 0x00];

    #[derive(Deserialize)]
    struct PictureExpected { tracks: serde_json::Value, width: u32, height: u32, r_frame_rate: String, nb_frames: u64, timecode: String }

    fn picture_expected(name: &str) -> PictureExpected {
        let all: BTreeMap<String, PictureExpected> = serde_json::from_str(include_str!("fixtures/picture-expected.json")).unwrap();
        all.into_iter().find(|(key, _)| key == name).unwrap().1
    }
    fn replace_all(bytes: &[u8], from: &[u8], to: &[u8]) -> Vec<u8> {
        assert_eq!(from.len(), to.len());
        let mut out = bytes.to_vec();
        let mut hits = 0;
        let mut at = 0;
        while let Some(offset) = out[at..].windows(from.len()).position(|w| w == from) {
            out[at + offset..at + offset + to.len()].copy_from_slice(to); hits += 1; at += offset + to.len();
        }
        assert!(hits > 0, "the fixture no longer contains the bytes being replaced");
        out
    }
    fn assert_picture_matches(inspection: &Inspection, expected: &PictureExpected) {
        let picture = inspection.picture.as_ref().expect("picture facts");
        assert_eq!((picture.width, picture.height), (expected.width, expected.height));
        assert_eq!(format!("{}/{}", picture.rate_numerator, picture.rate_denominator), expected.r_frame_rate);
        assert_eq!(picture.length, Some(expected.nb_frames));
        assert_eq!(picture.descriptor, 0x28, "DNxHD is described by a CDCI descriptor");
        assert_eq!(picture.frame_layout, Some(0));
        assert_eq!(picture.coding.as_deref(), Some("urn:smpte:ul:060e2b34.0401010a.04010202.71130000"));
        assert_eq!(inspection.timecode.as_ref().map(MxfTimecode::label).as_deref(), Some(expected.timecode.as_str()));
        assert_eq!(inspection.picture_tracks.len(), 1);
        assert!(inspection.picture_tracks.iter().all(|t| t.kind == MxfTrackKind::Picture && t.aligned));
    }

    #[test]
    fn a_picture_only_opatom_reports_its_picture_and_timecode() {
        let expected = picture_expected("picture-opatom");
        assert!(expected.tracks.is_string(), "the reference parser rejects a file with no audio");
        let inspection = read_bytes(PICTURE_OPATOM).unwrap();
        assert!(inspection.tracks.is_empty() && inspection.sound.is_none());
        assert_picture_matches(&inspection, &expected);
        let picture = inspection.picture.as_ref().unwrap();
        // FFmpeg never writes ContainerDuration into a picture descriptor.
        assert_eq!(picture.container_duration, None);
        assert_eq!(inspection.timecode, Some(MxfTimecode { start: 86400, rounded_base: 24, drop_frame: false }));
        assert_eq!(inspection.picture_tracks[0].slot_id, 2);
    }

    #[test]
    fn an_op1a_with_picture_keeps_the_reference_audio_identity() {
        let expected = picture_expected("picture-op1a");
        let tracks: Vec<MxfTrack> = serde_json::from_value(expected.tracks.clone()).unwrap();
        let inspection = read_bytes(PICTURE_OP1A).unwrap();
        assert_eq!(inspection.tracks, tracks);
        assert!(inspection.tracks.iter().all(|t| t.kind == MxfTrackKind::Sound));
        // A MultipleDescriptor may carry video as stream 0: still no shortcut.
        assert_eq!(inspection.sound, None);
        assert_picture_matches(&inspection, &expected);
        assert!(inspection.timecode.as_ref().is_some_and(|tc| tc.drop_frame && tc.rounded_base == 30));
    }

    #[test]
    fn the_audio_fixtures_report_their_mpeg_picture_and_no_picture() {
        let op1a = read_bytes(OP1A).unwrap();
        let picture = op1a.picture.unwrap();
        assert_eq!((picture.descriptor, picture.width, picture.height, picture.rate_numerator, picture.rate_denominator), (0x51, 320, 240, 25, 1));
        for audio in [OPATOM, LEGACY] {
            let inspection = read_bytes(audio).unwrap();
            assert!(inspection.picture_tracks.is_empty() && inspection.picture.is_none());
        }
    }

    #[test]
    fn avids_legacy_picture_definition_is_recognized() {
        const LEGACY_PICTURE: [u8; 16] = [0x80, 0x7d, 0x00, 0x60, 0x08, 0x14, 0x3e, 0x6f, 0x6f, 0x3c, 0x8c, 0xe1, 0x6c, 0xef, 0x11, 0xd2];
        let legacy = read_bytes(&replace_all(PICTURE_OPATOM, &STANDARD_PICTURE, &LEGACY_PICTURE)).unwrap();
        assert_eq!(legacy.picture, read_bytes(PICTURE_OPATOM).unwrap().picture);
        assert!(legacy.picture.is_some());
    }

    #[test]
    fn a_damaged_picture_leaves_the_audio_exactly_as_it_was() {
        let clean = read_bytes(PICTURE_OP1A).unwrap();
        // Zero width: the descriptor is dropped, the mapping and audio stay.
        let widthless = read_bytes(&patch_all(PICTURE_OP1A, [0x32, 0x03, 0x00, 0x04], &0_u32.to_be_bytes())).unwrap();
        assert_eq!(widthless.picture, None);
        assert_eq!((&widthless.tracks, &widthless.sound, &widthless.picture_tracks), (&clean.tracks, &clean.sound, &clean.picture_tracks));
        // The material picture clip points at a slot that does not exist: the
        // picture mapping goes, and nothing about the audio changes.
        let dangling = replace_all(PICTURE_OP1A, &[0x11, 0x02, 0x00, 0x04, 0, 0, 0, 2], &[0x11, 0x02, 0x00, 0x04, 0, 0, 0, 9]);
        let unmapped = read_bytes(&dangling).unwrap();
        assert!(unmapped.picture_tracks.is_empty() && unmapped.picture.is_none());
        assert_eq!((&unmapped.tracks, &unmapped.sound), (&clean.tracks, &clean.sound));
        // Timecode comes from the audio's file package alone now; it is unchanged.
        assert_eq!(unmapped.timecode, clean.timecode);
        // A timebase of zero is not a timecode.
        let baseless = read_bytes(&patch_all(PICTURE_OP1A, [0x15, 0x02, 0x00, 0x02], &0_u16.to_be_bytes())).unwrap();
        assert_eq!(baseless.timecode, None);
        assert_eq!((&baseless.tracks, &baseless.picture), (&clean.tracks, &clean.picture));
    }

    #[test]
    fn a_picture_only_file_whose_picture_does_not_map_still_fails() {
        let dangling = replace_all(PICTURE_OPATOM, &[0x11, 0x02, 0x00, 0x04, 0, 0, 0, 2], &[0x11, 0x02, 0x00, 0x04, 0, 0, 0, 9]);
        assert!(read_bytes(&dangling).is_err());
    }

    #[test]
    fn timecode_labels_count_drop_frame_correctly() {
        let label = |start, rounded_base, drop_frame| MxfTimecode { start, rounded_base, drop_frame }.label();
        assert_eq!(label(107_890, 30, true), "00:59:59;28");
        assert_eq!(label(1800, 30, true), "00:01:00;02");
        assert_eq!(label(17_982, 30, true), "00:10:00;00");
        assert_eq!(label(215_784, 60, true), "01:00:00;00");
        assert_eq!(label(86_400, 24, false), "01:00:00:00");
        assert_eq!(label(90_000, 25, true), "01:00:00:00", "drop-frame only applies at multiples of 30");
    }
}
