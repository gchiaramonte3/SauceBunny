//! Strict, bounded adapter from the pinned OBS/FFmpeg fragmented MP4 output
//! to the existing live Program records. Never emit a partial media fragment.
use std::io;

pub(super) const LIMIT: usize = 2 * 1024 * 1024;

#[derive(Default)]
pub(super) struct Framer {
    atom: Vec<u8>,
    expected: Option<usize>,
    pending: Vec<u8>,
    phase: Phase,
}

#[derive(Default)]
enum Phase { #[default] FileType, Movie, Fragment, Media, End }

fn invalid() -> io::Error { io::Error::new(io::ErrorKind::InvalidData, "Invalid or oversized OBS media fragment") }

impl Framer {
    pub(super) fn push(&mut self, mut input: &[u8], mut emit: impl FnMut(i32, &[u8])) -> io::Result<()> {
        while !input.is_empty() {
            let target = self.expected.unwrap_or(8);
            let count = input.len().min(target - self.atom.len());
            self.atom.extend_from_slice(&input[..count]);
            input = &input[count..];
            if self.atom.len() != target { continue; }
            if self.expected.is_none() {
                // The pinned encoder uses normal, finite 32-bit atom sizes.
                // Reject zero/extended lengths before allocation, not afterward.
                let size = u32::from_be_bytes(self.atom[..4].try_into().map_err(|_|invalid())?) as usize;
                if !(8..=LIMIT).contains(&size) || size + self.pending.len() > LIMIT { return Err(invalid()); }
                self.expected = Some(size);
                if size != 8 { continue; }
            }
            let kind: [u8; 4] = self.atom[4..8].try_into().map_err(|_|invalid())?;
            match (&self.phase, &kind) {
                (Phase::FileType, b"ftyp") => { self.pending.append(&mut self.atom); self.phase = Phase::Movie; }
                (Phase::Movie, b"moov") => {
                    self.pending.append(&mut self.atom); emit(1, &self.pending); self.pending.clear(); self.phase = Phase::Fragment;
                }
                (Phase::Fragment, b"moof") => { self.pending.append(&mut self.atom); self.phase = Phase::Media; }
                (Phase::Media, b"mdat") => {
                    self.pending.append(&mut self.atom); emit(2, &self.pending); self.pending.clear(); self.phase = Phase::Fragment;
                }
                (Phase::Fragment, b"mfra") => { self.phase = Phase::End; }
                _ => return Err(invalid()),
            }
            self.atom.clear();
            self.expected = None;
        }
        Ok(())
    }
    pub(super) fn finish(&self) -> io::Result<()> {
        if self.atom.is_empty() && self.pending.is_empty() && matches!(self.phase, Phase::Fragment | Phase::End) { Ok(()) }
        else { Err(io::Error::new(io::ErrorKind::UnexpectedEof, "OBS media ended inside a fragment")) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn atom(kind: &[u8; 4], payload: usize) -> Vec<u8> {
        let mut data = ((8 + payload) as u32).to_be_bytes().to_vec();
        data.extend_from_slice(kind); data.resize(8 + payload, 1); data
    }
    fn stream() -> Vec<u8> {
        [atom(b"ftyp", 10), atom(b"moov", 15), atom(b"moof", 20), atom(b"mdat", 40), atom(b"mfra", 8)].concat()
    }
    #[test]
    fn every_read_boundary_preserves_complete_records() {
        let bytes = stream();
        for size in 1..bytes.len() {
            let mut framer = Framer::default(); let mut records = Vec::new();
            for chunk in bytes.chunks(size) { framer.push(chunk, |kind, data|records.push((kind, data.to_vec()))).unwrap(); }
            framer.finish().unwrap();
            assert_eq!(records, vec![(1, [atom(b"ftyp", 10), atom(b"moov", 15)].concat()),
                (2, [atom(b"moof", 20), atom(b"mdat", 40)].concat())]);
        }
    }
    #[test]
    fn rejects_bad_lengths_before_allocating_payload() {
        for size in [0, 1, 7, LIMIT as u32 + 1, u32::MAX] {
            let mut data = size.to_be_bytes().to_vec(); data.extend_from_slice(b"ftyp");
            let mut framer = Framer::default(); assert!(framer.push(&data, |_, _|panic!()).is_err());
            assert_eq!(framer.atom.len(), 8);
        }
    }
    #[test]
    fn combined_record_limit_and_order_are_enforced() {
        let mut framer = Framer::default();
        framer.push(&atom(b"ftyp", LIMIT - 16), |_, _|panic!()).unwrap();
        assert!(framer.push(&atom(b"moov", 1), |_, _|panic!()).is_err());
        for kind in [b"mdat", b"moof", b"moov", b"free"] {
            assert!(Framer::default().push(&atom(kind, 1), |_, _|panic!()).is_err());
        }
    }
    #[test]
    fn truncated_fragments_never_escape() {
        let bytes = stream();
        for cut in 0..(bytes.len() - 16) {
            let mut framer = Framer::default(); let mut media = 0;
            framer.push(&bytes[..cut], |kind, _|if kind == 2 { media += 1; }).unwrap();
            assert_eq!(media, 0);
            // Complete init is a legal boundary, but never a ready media stream.
            if cut != 41 { assert!(framer.finish().is_err()); }
        }
    }
}
