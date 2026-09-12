//! Bounded demultiplexing of the helper's inherited stdout, not a network protocol.
use std::io;
pub(super) const MAX_CHUNK: usize = 16384;
pub(super) const MAX_GENERATION: u64 = 9_007_199_254_740_991;
const HEADER: usize = 14;
#[derive(Default)]
pub(super) struct Wire { bytes: Vec<u8>, length: Option<usize> }
pub(super) struct Record<'a> { pub kind: u8, pub slot: usize, pub generation: u64, pub payload: &'a [u8] }
fn invalid() -> io::Error { io::Error::new(io::ErrorKind::InvalidData, "Invalid OBS service record") }
impl Wire {
    pub(super) fn push(&mut self, mut input: &[u8], mut emit: impl FnMut(Record<'_>)) -> io::Result<()> {
        while !input.is_empty() {
            let target = self.length.unwrap_or(HEADER);
            let take = input.len().min(target - self.bytes.len());
            self.bytes.extend_from_slice(&input[..take]); input = &input[take..];
            if self.bytes.len() != target { continue; }
            if self.length.is_none() {
                let size = u32::from_be_bytes(self.bytes[10..14].try_into().map_err(|_|invalid())?) as usize;
                let generation = u64::from_be_bytes(self.bytes[2..10].try_into().map_err(|_|invalid())?);
                if !(1..=3).contains(&self.bytes[0]) || self.bytes[1] > 1 || !(1..=MAX_GENERATION).contains(&generation) ||
                    size > MAX_CHUNK || (self.bytes[0] == 3) != (size == 0) { return Err(invalid()); }
                self.length = Some(HEADER + size);
                if size > 0 { continue; }
            }
            emit(Record { kind:self.bytes[0], slot:self.bytes[1] as usize,
                generation:u64::from_be_bytes(self.bytes[2..10].try_into().map_err(|_|invalid())?), payload:&self.bytes[HEADER..] });
            self.bytes.clear(); self.length = None;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(kind: u8, slot: u8, generation: u64, bytes: &[u8]) -> Vec<u8> {
        [vec![kind,slot], generation.to_be_bytes().to_vec(), (bytes.len() as u32).to_be_bytes().to_vec(), bytes.to_vec()].concat()
    }
    #[test]
    fn interleaved_generations_survive_every_read_boundary() {
        let data = [record(1,0,1,b"first"), record(2,1,2,b"state"), record(3,0,1,b""), record(1,0,3,b"replacement")].concat();
        for size in 1..=data.len() {
            let mut wire = Wire::default(); let mut records = Vec::new();
            for part in data.chunks(size) { wire.push(part, |r| records.push((r.kind,r.slot,r.generation,r.payload.to_vec()))).unwrap(); }
            assert_eq!(records, [(1,0,1,b"first".to_vec()),(2,1,2,b"state".to_vec()),(3,0,1,vec![]),(1,0,3,b"replacement".to_vec())]);
        }
    }
    #[test]
    fn rejects_invalid_header_before_payload_allocation() {
        for bytes in [record(0,0,1,b"x"),record(1,2,1,b"x"),record(1,0,0,b"x"),record(3,0,1,b"x"),
            record(1,0,MAX_GENERATION+1,b"x"),record(1,0,1,&vec![0;MAX_CHUNK+1])] {
            let mut wire = Wire::default();
            assert!(wire.push(&bytes[..HEADER], |_|panic!("invalid record delivered")).is_err());
            assert_eq!(wire.bytes.len(), HEADER);
        }
    }
}
