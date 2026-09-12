// Real Rust supervisor -> shared libobs service -> bounded Program rings.
// Only two owned, generated windows/audio sources; no room/NDI publication.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWindowFixture, launchAudioFixture, run, signedRuntimeTeam, visibleFixture } from './obs-window-test-fixture.mjs';
import { verifyIsolatedStereo } from './obs-audio-spectrum.mjs';
import { serviceTestTarget } from './obs-service-test-target.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const { runtime, profile, rawOutput, actions, appProof } = serviceTestTarget(process.argv.slice(2));
const team = await signedRuntimeTeam(runtime, { profile });
const output = await mkdtemp('/private/tmp/sauce-obs-service-');
const cargoArgs = ['test', '--manifest-path', join(root,'src-tauri/Cargo.toml'), '--lib'];
const testModule = 'commands::obs::service::service_tests::';
const testPrefix = `${testModule}native_shared_service_`;
// Compile before the generated apps' 30-second safety deadline begins.
await run('cargo', [...cargoArgs, testModule, '--no-run'], {cwd:root, timeout:120000, maxBuffer:1024*1024});
const a = await buildWindowFixture(output, 'selected');
const b = await buildWindowFixture(output, 'competing', a.executable);

async function verifyRecording(file, tonePair) {
  const metadata = JSON.parse((await run(join(root,'src-tauri/binaries/ffprobe-aarch64-apple-darwin'),
    ['-v','error','-show_streams','-show_packets','-of','json',file],{maxBuffer:8*1024*1024,timeout:10000})).stdout);
  const audio = metadata.streams.find(stream => stream.codec_name === 'aac');
  const video = metadata.streams.find(stream => stream.codec_name === 'h264');
  assert(audio?.channels === 2 && audio.sample_rate === '48000' && video?.has_b_frames === 0);
  for (const stream of [audio,video]) {
    const packets = metadata.packets.filter(packet => packet.stream_index === stream.index);
    assert(packets.length > 100);
    for (let n = 1; n < packets.length; n++) {
      const gap = Number(packets[n].dts_time) - Number(packets[n-1].dts_time);
      assert(gap > 0 && Math.abs(gap - Number(packets[n-1].duration_time)) < .00015,'Program ring delivery lost continuity');
    }
  }
  const seconds = Math.floor(Number(audio.duration)) - 1;
  assert(seconds >= 5 && seconds <= 24, `Insufficient interior audio in ${file}: ${seconds}s`);
  const pcm = (await run(join(root,'src-tauri/binaries/ffmpeg-aarch64-apple-darwin'),
    ['-v','error','-ss','1','-i',file,'-t',String(seconds),'-map','0:a:0','-f','f32le','pipe:1'],
    {encoding:'buffer',maxBuffer:12*1024*1024,timeout:10000})).stdout;
  try {
    return {width:video.width,height:video.height,seconds,channels:verifyIsolatedStereo(pcm,tonePair)};
  } catch (error) { throw new Error(`${file}: ${error.message}`,{cause:error}); }
}

async function verifyCase(action) {
  const directory = join(output, rawOutput ? 'raw-output' : action || 'replacement');
  await mkdir(directory);
  const fixtures = [];
  let result;
  try {
    fixtures.push(await launchAudioFixture(a,directory,'selected','--tone-a'));
    fixtures.push(await launchAudioFixture(b,directory,'competing','--tone-b'));
    for (const fixture of fixtures) await visibleFixture(runtime,fixture);
    const selections = fixtures.map(fixture => ({application:fixture.application, process:fixture.window.pid,
      window:fixture.window.window,crop:{x:0,y:0,width:1,height:1}}));
    const test = rawOutput ? `${testModule}raw_native_tests::native_raw_output_lifecycle` :
      testPrefix + (action ? 'contains_source_loss' : 'survives_slot_stop_and_replacement');
    result = await run('cargo',[...cargoArgs,test,'--','--ignored','--exact','--nocapture'],
      {cwd:root,timeout:35000,maxBuffer:1024*1024,env:{...process.env,SAUCE_OBS_TEST_RUNTIME:runtime,
        SAUCE_OBS_TEST_OUTPUT:directory,SAUCE_OBS_TEST_SELECTIONS:JSON.stringify(selections),SAUCE_OBS_TEST_ACTION:action}});
  } catch (error) {
    await writeFile(join(directory,'supervisor.log'),`${error.stdout ?? ''}\n${error.stderr ?? ''}`);
    throw new Error(`Shared service test failed: ${directory}`,{cause:error});
  } finally { await Promise.all(fixtures.map(fixture => fixture.stop())); }
  await writeFile(join(directory,'supervisor.log'),`${result.stdout}\n${result.stderr}`);
  const recordings = [];
  for (let index = 0; index < (!rawOutput && (!action || action === 'R') ? 3 : 2); index++) {
    recordings.push(await verifyRecording(join(directory,`${index}.mp4`),index === 1 ? 1 : 0));
  }
  if (rawOutput) {
    const raw = JSON.parse(await readFile(join(directory,'raw-results.json'),'utf8'));
    assert(raw.pipeEofConfirmed && raw.generatedMediaOnly && raw.broadcast === false);
    for (const [key,index] of [['first',0],['fresh',0],['survivor',1]]) {
      assert.equal(raw[key].width,recordings[index].width);
      assert.equal(raw[key].height,recordings[index].height);
    }
    const tones = [];
    for (const [name,pair] of [['raw-first',0],['raw-survivor',1]]) {
      tones.push(verifyIsolatedStereo(await readFile(join(directory,`${name}.f32`)),pair));
    }
    await writeFile(join(directory,'raw-audio-results.json'),JSON.stringify({raw,tones},null,2));
  } else if (!action) {
    assert.equal(recordings[2].width,Math.floor(recordings[0].width / 4)*2);
    assert.equal(recordings[2].height,Math.floor(recordings[0].height / 4)*2);
  } else if (action === 'R') {
    assert(recordings[2].width > recordings[0].width && recordings[2].height > recordings[0].height,
      'Explicit restart did not use the new source raster');
  }
  console.log(JSON.stringify({passed:true,action:rawOutput ? 'raw-output' : action || 'replacement',directory,recordings}));
  return {action,recordings};
}
const results = [];
for (const action of actions) {
  results.push(await verifyCase(action));
}
// Even application-profile runs exercise the packaged helper under the Rust
// test supervisor, not the packaged main process, renderer, room or NDI sender.
const evidence = { team, helperProfile: profile, appProof, supervisor: 'cargo-test', generatedMediaOnly: true,
  broadcast: false, results };
await writeFile(join(output,'results.json'),JSON.stringify(evidence,null,2));
console.log(JSON.stringify({passed:true,output,...evidence},null,2));
