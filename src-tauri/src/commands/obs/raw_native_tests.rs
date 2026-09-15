//! Opt-in signed-runtime gate: only caller-launched generated windows. Exercises
//! the real Rust supervisor, SCM_RIGHTS transport and private OBS outputs.
use super::*;
use crate::commands::obs::raw_service::{RawFeed, RawStatus};
use std::{io::{Read, Write}, os::fd::{AsRawFd, OwnedFd}};

#[derive(Default, serde::Serialize)]
struct RawRecording {
    capture: u64, broadcast: u64, width: u32, height: u32,
    video: u64, audio: u64, first_video_ns: u64, last_video_ns: u64,
    first_audio_ns: u64, last_audio_ns: u64, audio_frames: u32,
}

fn read_part(input: &mut std::fs::File, bytes: &mut [u8], deadline: std::time::Instant) -> std::io::Result<usize> {
    let mut used = 0;
    while used < bytes.len() {
        if std::time::Instant::now() >= deadline {
            return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "raw consumer never reached EOF"));
        }
        match input.read(&mut bytes[used..]) {
            Ok(0) => break,
            Ok(count) => used += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                let mut poll = libc::pollfd {fd:input.as_raw_fd(), events:libc::POLLIN, revents:0};
                if unsafe {libc::poll(&mut poll, 1, 20)} < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Err(error) => return Err(error),
        }
    }
    Ok(used)
}

fn record_raw(reader: OwnedFd, directory: &std::path::Path, name: &str) -> tokio::task::JoinHandle<RawRecording> {
    let audio_path = directory.join(format!("{name}.f32"));
    tokio::task::spawn_blocking(move || {
        let mut input = std::fs::File::from(reader);
        let mut pcm = std::fs::OpenOptions::new().write(true).create_new(true).open(audio_path).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        let mut report = RawRecording::default();
        loop {
            let mut header = [0u8;64];
            let count = read_part(&mut input, &mut header, deadline).unwrap();
            if count == 0 { break; }
            assert_eq!(count,64,"clean stop left a partial header");
            assert_eq!(&header[..4],b"SBR1");
            assert!(matches!(header[4],1|2));
            for offset in [5,6,7,58,59,60,61,62,63] { assert_eq!(header[offset],0); }
            let u64_at = |offset|u64::from_be_bytes(header[offset..offset+8].try_into().unwrap());
            let u32_at = |offset|u32::from_be_bytes(header[offset..offset+4].try_into().unwrap());
            let capture = u64_at(8); let broadcast = u64_at(16); let timestamp = u64_at(24);
            assert!((1..=MAX_GENERATION).contains(&capture) && (1..=MAX_GENERATION).contains(&broadcast));
            assert!(timestamp > 0);
            if report.capture == 0 { report.capture = capture; report.broadcast = broadcast; }
            assert_eq!((capture,broadcast),(report.capture,report.broadcast));
            let size = u32_at(32) as usize;
            if header[4] == 1 {
                let (width,height,stride) = (u32_at(36),u32_at(40),u32_at(44));
                assert!((2..=1920).contains(&width) && (2..=1080).contains(&height) && width%2==0 && height%2==0);
                assert_eq!(stride,width*4); assert_eq!(size,(width*height*4) as usize);
                assert_eq!(&header[48..58],&[0;10]);
                if report.video == 0 { report.width=width; report.height=height; report.first_video_ns=timestamp; }
                assert_eq!((width,height),(report.width,report.height));
                assert!(timestamp > report.last_video_ns); report.last_video_ns=timestamp; report.video+=1;
            } else {
                let frames = u32_at(48);
                assert!((1..=4096).contains(&frames)); assert_eq!(size,frames as usize*8);
                assert_eq!(&header[36..48],&[0;12]); assert_eq!(u32_at(52),48000);
                assert_eq!(&header[56..58],&[0,2]);
                if report.audio == 0 { report.first_audio_ns=timestamp; }
                else {
                    let expected = report.last_audio_ns + u64::from(report.audio_frames)*1_000_000_000/48000;
                    assert!(timestamp.abs_diff(expected)<=2,"raw audio timestamps lost continuity");
                }
                report.last_audio_ns=timestamp; report.audio_frames=frames; report.audio+=1;
            }
            let mut payload = vec![0u8;size];
            assert_eq!(read_part(&mut input,&mut payload,deadline).unwrap(),size,"clean stop left a partial payload");
            if header[4] == 2 {
                let frames = size/8;
                let mut interleaved = vec![0u8;size];
                for frame in 0..frames { for channel in 0..2 {
                    let source = (channel*frames+frame)*4;
                    interleaved[(frame*2+channel)*4..(frame*2+channel+1)*4].copy_from_slice(&payload[source..source+4]);
                }}
                pcm.write_all(&interleaved).unwrap();
            }
        }
        assert!(report.video>=5 && report.audio>=5,"both raw tracks must reach the independent consumer");
        report
    })
}

async fn live(feed: &RawFeed) {
    let mut status = feed.status();
    tokio::time::timeout(Duration::from_secs(2),status.wait_for(|value|matches!(value,RawStatus::Live))).await
        .expect("raw start acknowledgement deadline").expect("raw actor closed before start");
}
async fn terminal(feed: &RawFeed, failure: bool) {
    let mut status = feed.status();
    let ended = *tokio::time::timeout(Duration::from_secs(2),status.wait_for(|value|
        matches!(value,RawStatus::Stopped{..}|RawStatus::Failed{..}))).await
        .expect("raw terminal acknowledgement deadline").expect("raw actor closed before stop");
    if failure { assert!(matches!(ended,RawStatus::Failed{stop_confirmed:true,..}),"{ended:?}"); }
    else { assert!(matches!(ended,RawStatus::Stopped{..}),"{ended:?}"); }
}

#[tokio::test]
#[ignore = "signed OBS runtime and two generated-window fixtures; raw anonymous pipes only, no NDI broadcast"]
async fn native_raw_output_lifecycle() {
    let runtime = PathBuf::from(std::env::var_os("SAUCE_OBS_TEST_RUNTIME").expect("private runtime"));
    let output = PathBuf::from(std::env::var_os("SAUCE_OBS_TEST_OUTPUT").expect("test output directory"));
    let selections: Vec<ObsSelection> = serde_json::from_str(&std::env::var("SAUCE_OBS_TEST_SELECTIONS").unwrap()).unwrap();
    assert_eq!(selections.len(),2);
    let programs: Vec<_> = (0..2).map(|_|Program::new(uuid::Uuid::new_v4().simple().to_string(),"Generated fixture".into(),None)).collect();
    let _guard = StopOnDrop(programs.clone());
    let mut encoded = Vec::new();
    for index in 0..2 {
        assert!(selections[index].valid() && matches!(&selections[index], super::super::ObsSelection::Window(value) if value.application.starts_with("com.saucebunny.capture-test-")));
        encoded.push(record(programs[index].clone(),output.join(format!("{index}.mp4"))));
        enqueue(runtime.clone(),Request{selection:selections[index].clone(),program:programs[index].clone(),permit:Some(WorkerPermit::acquire().unwrap())}).unwrap();
        assert!(until(||programs[index].encoded_ready(),10).await,"generated capture never ready");
    }
    let before = programs[1].retained_media_metrics().2;
    // Exercise the sender's cold-start seam against the real helper: reserve
    // the immutable tuple, but no byte may arrive until the consumer arms it.
    let mut first = super::super::super::prepare_raw_output(&programs[0].id).unwrap();
    let mut generations = first.generations();
    let expected = *tokio::time::timeout(Duration::from_secs(2), generations.wait_for(Option::is_some))
        .await.unwrap().unwrap();
    let expected = expected.unwrap();
    let reader = first.take_reader().unwrap();
    tokio::time::sleep(Duration::from_millis(250)).await;
    let mut byte = 0u8;
    assert_eq!(unsafe { libc::read(reader.as_raw_fd(), (&mut byte as *mut u8).cast(), 1) }, -1,
        "unarmed reservation delivered media or closed its pipe");
    assert_eq!(std::io::Error::last_os_error().kind(), std::io::ErrorKind::WouldBlock);
    assert!(programs.iter().all(|program|program.encoded_ready()));
    let first_reader = record_raw(reader,&output,"raw-first");
    assert!(first.arm(expected));
    let mut survivor = super::super::super::begin_raw_output(&programs[1].id).unwrap();
    let survivor_reader = record_raw(survivor.take_reader().unwrap(),&output,"raw-survivor");
    live(&first).await; live(&survivor).await;
    tokio::time::sleep(Duration::from_millis(5500)).await;
    first.cancel(); terminal(&first,false).await;
    let first_report = first_reader.await.unwrap(); // Real pipe EOF, not merely helper ACK.
    assert!(programs.iter().all(|program|program.encoded_ready()));

    // Deliberately don't consume this fresh pipe. A 200ms record deadline must
    // fail only its raw branch; retired bytes may contain a partial record.
    let before_stall: Vec<_> = programs.iter().map(|program|program.retained_media_metrics().2).collect();
    let mut stalled = super::super::super::begin_raw_output(&programs[0].id).unwrap();
    // watch may legitimately coalesce Started then Failed for this short-lived
    // branch. Confirmed failure plus bytes proves attachment without racing Live.
    terminal(&stalled,true).await;
    let retired = stalled.take_reader().unwrap();
    let retired_bytes = tokio::task::spawn_blocking(move || {
        let mut input = std::fs::File::from(retired); let mut buffer=[0u8;4096]; let mut bytes=0;
        let deadline=std::time::Instant::now()+Duration::from_secs(2);
        loop { let count=read_part(&mut input,&mut buffer,deadline).unwrap(); bytes+=count; if count<buffer.len(){break;} }
        bytes
    }).await.unwrap();
    assert!(retired_bytes>0 && retired_bytes<16*1024*1024);
    assert!(programs.iter().all(|program|program.encoded_ready()));
    let mut fresh = super::super::super::begin_raw_output(&programs[0].id).unwrap();
    let fresh_reader = record_raw(fresh.take_reader().unwrap(),&output,"raw-fresh");
    live(&fresh).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    for index in 0..2 {
        assert!(programs[index].retained_media_metrics().2>before_stall[index]+10,
            "raw-output failure froze an encoded program");
    }

    // Stop the survivor's raw branch near the other capture's teardown. This
    // real-runtime check does not artificially hold the encoder's stop callback.
    programs[0].stop();
    tokio::time::sleep(Duration::from_millis(300)).await;
    survivor.cancel(); terminal(&survivor,false).await; terminal(&fresh,false).await;
    let fresh_report = fresh_reader.await.unwrap();
    let survivor_report = survivor_reader.await.unwrap();
    wait_stopped(&programs[0].id).await.unwrap();
    assert!(programs[1].encoded_ready());
    assert!(programs[1].retained_media_metrics().2>before+40);
    programs[1].stop(); wait_stopped(&programs[1].id).await.unwrap();
    assert!(until(||client().lock().unwrap().is_none(),6).await,"helper was not reaped");
    for recording in encoded { let recording=recording.await.unwrap().unwrap(); assert!(recording.bytes>100_000 && recording.error.is_none()); }
    assert_eq!(first_report.capture,fresh_report.capture);
    assert!(fresh_report.broadcast>first_report.broadcast);
    assert!(fresh_report.first_video_ns>first_report.last_video_ns && fresh_report.first_audio_ns>first_report.last_audio_ns);
    assert_ne!(first_report.capture,survivor_report.capture);
    assert!(survivor_report.last_video_ns>=fresh_report.first_video_ns &&
        survivor_report.last_audio_ns>=fresh_report.first_audio_ns,
        "surviving raw output stopped before the other branch recovered");
    std::fs::write(output.join("raw-results.json"),serde_json::to_vec_pretty(&serde_json::json!({
        "first":first_report,"fresh":fresh_report,"survivor":survivor_report,"retiredBytes":retired_bytes,
        "pipeEofConfirmed":true,"generatedMediaOnly":true,"broadcast":false
    })).unwrap()).unwrap();
}
