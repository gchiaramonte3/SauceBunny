// Opt-in real-SDK harness. Advertises synthetic picture + stereo tones only;
// never captures the screen, microphone, or any existing NDI source.
#include <cstddef>
#include <Processing.NDI.Lib.h>
#include <dlfcn.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <mutex>
#include <thread>
#include <vector>
#include <unistd.h>
#import <Foundation/Foundation.h>

extern "C" void sauce_ndi_run(const char*,const char*,void*,void(*)(void*,int,const uint8_t*,size_t),bool(*)(void*));
extern "C" void sauce_ndi_run_with_timing(const char*,const char*,void*,void(*)(void*,int,const uint8_t*,size_t),bool(*)(void*),uint64_t(*)(void*));
extern "C" char* sauce_ndi_query(const char*,bool);
extern "C" void sauce_ndi_free(char*);
extern "C" bool sauce_ndi_timing_helpers_test();
struct Capture {
    std::atomic<bool> done{false};
    std::atomic<bool> stall{false};
    std::ofstream file;
    std::mutex lock;
    int segments=0;
    bool sawLive=false, sawStale=false, recovered=false, sawInitialPlaceholder=false;
    double expectedInputFps=30, maxOutputFps=0;
    bool sawInputRate=false;
    int timingSamples=0, acceptedTimingSamples=0, metadataSamples=0;
    bool sawRepeatedTiming=false, sawBoundedMetadata=false, sawInvalidMetadata=false, invalidTimingPacket=false;
    int64_t lastAcceptedTick=-1;
    explicit Capture(const char* path):file(path,std::ios::binary){}
};
static double metric(const std::string& state,const char* name) {
    const std::string key=std::string("\"")+name+"\":";
    const auto offset=state.find(key);
    return offset==std::string::npos ? -1 : strtod(state.c_str()+offset+key.size(),nullptr);
}
static void output(void* ctx,int kind,const uint8_t* bytes,size_t length) {
    auto& c=*(Capture*)ctx;std::lock_guard<std::mutex> guard(c.lock);
    if(kind==3) {
        const std::string state((const char*)bytes,length);std::cerr<<state<<"\n";
        if(state.find("\"phase\":\"stale\"")!=std::string::npos)c.sawStale=true;
        if(state.find("\"phase\":\"live\"")!=std::string::npos){c.sawLive=true;if(c.sawStale)c.recovered=true;}
        if(state.find("\"phase\":\"connecting\"")!=std::string::npos && state.find("\"inputWidth\":8")!=std::string::npos)c.sawInitialPlaceholder=true;
        c.sawInputRate|=fabs(metric(state,"inputFps")-c.expectedInputFps)<0.01;
        c.maxOutputFps=std::max(c.maxOutputFps,metric(state,"outputFps"));
    }
    else if(kind==4) {
        // Probe observations never enter the encoded .mp4 output.
        NSData* data=[NSData dataWithBytes:bytes length:length];
        NSDictionary* sample=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        if(![sample isKindOfClass:[NSDictionary class]]){c.invalidTimingPacket=true;return;}
        c.timingSamples++;
        id tick=sample[@"outputTick"],metadata=sample[@"metadata"];
        c.invalidTimingPacket|=length>16384 || [sample[@"outputTimescale"] intValue]!=30 || ![sample[@"probeId"] isEqual:@"1"];
        if([sample[@"outputAccepted"] boolValue]) {
            c.acceptedTimingSamples++;
            c.invalidTimingPacket|=![tick isKindOfClass:[NSString class]] || [tick longLongValue]<=c.lastAcceptedTick;
            c.lastAcceptedTick=[tick longLongValue];
        }
        c.sawRepeatedTiming|=[sample[@"sameTimingAsPreviousCapture"] boolValue];
        c.sawBoundedMetadata|=[sample[@"metadataTruncated"] boolValue];
        c.sawInvalidMetadata|=[sample[@"metadataInvalidUtf8"] boolValue];
        if([metadata isKindOfClass:[NSString class]]){c.metadataSamples++;c.invalidTimingPacket|=[metadata lengthOfBytesUsingEncoding:NSUTF8StringEncoding]>2048;}
        id timecode=sample[@"ndiTimecode"];
        if([sample[@"inputValid"] boolValue])c.invalidTimingPacket|=![timecode isKindOfClass:[NSString class]];
    }
    else if(kind==1 || kind==2) {c.file.write((const char*)bytes,length);if(kind==2)c.segments++;}
}
static bool stopped(void* ctx){return ((Capture*)ctx)->done.load();}
static uint64_t timingEnabled(void*){return 1;}
int main(int argc,char** argv) {
    if(!sauce_ndi_timing_helpers_test()){std::cerr<<"Timing metadata/precision helpers failed\n";return 5;}
    if(argc!=3 && argc!=5 && argc!=6){std::cerr<<"usage: ndi-smoke /absolute/libndi.dylib output.mp4 [fps numerator denominator [continuous]]\n";return 2;}
    const bool continuous=argc==6 && std::string(argv[5])=="continuous";
    if(argc==6 && !continuous)return 2;
    const int rateN=argc>=5?atoi(argv[3]):30,rateD=argc>=5?atoi(argv[4]):1;
    const double inputFps=rateD>0?(double)rateN/rateD:0;
    if(inputFps<23 || inputFps>60){std::cerr<<"Use a prototype test rate between 23 and 60 fps\n";return 2;}
    void* library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);
    if(!library){std::cerr<<dlerror()<<"\n";return 2;}
    auto load=(const NDIlib_v6*(*)())dlsym(library,"NDIlib_v6_load");
    if(!load)return 2;const auto* api=load();if(!api->initialize())return 2;
    std::string name="Sauce Bunny synthetic NDI test "+std::to_string(getpid());
    NDIlib_send_create_t cfg;cfg.p_ndi_name=name.c_str();cfg.clock_video=true;cfg.clock_audio=false;
    auto sender=api->send_create(&cfg);if(!sender)return 2;
    Capture capture(argv[2]);
    const std::string previewPath=std::string(argv[2])+".preview.mp4";
    Capture preview(previewPath.c_str());
    capture.expectedInputFps=preview.expectedInputFps=inputFps;
    std::atomic<bool> refreshWorked{false};
    std::thread transmit([&]{
        std::vector<uint8_t> pixels(1920*1280*4,255);std::vector<float> audio((int)ceil(48000.0/inputFps)*2);
        NDIlib_video_frame_v2_t v;v.xres=1920;v.yres=1080;v.FourCC=NDIlib_FourCC_video_type_BGRA;
        v.frame_rate_N=rateN;v.frame_rate_D=rateD;v.frame_format_type=NDIlib_frame_format_type_progressive;v.p_data=pixels.data();v.line_stride_in_bytes=1920*4;
        NDIlib_audio_frame_v2_t a;a.sample_rate=48000;a.no_channels=2;a.no_samples=1600;a.channel_stride_in_bytes=1600*sizeof(float);a.p_data=audio.data();
        int frame=0, placeholderFrames=0;int64_t sampleCursor=0;
        while(!capture.done){
            if(capture.stall){std::this_thread::sleep_for(std::chrono::milliseconds(20));continue;}
            for(int y=0;y<1080;y++)for(int x=0;x<1920;x++){const int i=(y*1920+x)*4;pixels[i]=(x+frame*8)%256;pixels[i+1]=y%256;pixels[i+2]=64;}
            // Keep exactly 48 kHz of audio per source second, including the
            // alternating 1601/1602 sample blocks at 30000/1001 fps. Sending
            // 1600 samples for every 60-fps frame would double the audio clock.
            const int64_t sampleEnd=(int64_t)(frame+1)*48000*rateD/rateN;
            const int count=(int)(sampleEnd-sampleCursor);
            a.no_samples=count;a.channel_stride_in_bytes=count*sizeof(float);
            for(int i=0;i<count;i++){const double t=(sampleCursor+i)/48000.0;audio[i]=0.2*sin(t*440*2*M_PI);audio[count+i]=0.1*sin(t*880*2*M_PI);}
            sampleCursor=sampleEnd;
            // Reproduce Premiere's blank startup raster before real picture.
            // Keep it until both receivers have joined, then for 1.5 seconds.
            const bool placeholder=placeholderFrames<(int)ceil(inputFps*1.5);
            if(api->send_get_no_connections(sender,0)>=2)placeholderFrames++;
            const bool portrait=frame>=inputFps*3 && frame<inputFps*4;
            v.xres=placeholder?8:portrait?720:1920;v.yres=placeholder?8:portrait?1280:1080;
            // Synthetic fixture clock + frame metadata, NOT a claim about
            // what the official Premiere transmitter supplies. Exercise
            // bounded and malformed input while parked on its placeholder.
            std::string metadata=placeholder ? (frame%2 ? "<sauce-test payload=\""+std::string(3000,'x')+"\"/>" : std::string("\xff"))
                : "<sauce-test frame=\""+std::to_string(frame)+"\"/>";
            v.p_metadata=metadata.c_str();v.timecode=(int64_t)frame*10000000*rateD/rateN;
            api->send_send_audio_v2(sender,&a);api->send_send_video_v2(sender,&v);frame++;
        }
    });
    // Discovery names include the host prefix. Find this process's exact name.
    auto finder=api->find_create_v2(nullptr);std::string discovered;
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(8);
    while(std::chrono::steady_clock::now()<deadline){api->find_wait_for_sources(finder,200);uint32_t n=0;const auto* sources=api->find_get_current_sources(finder,&n);
        for(uint32_t i=0;i<n;i++)if(std::string(sources[i].p_ndi_name).find(name)!=std::string::npos)discovered=sources[i].p_ndi_name;
        if(!discovered.empty())break;}
    if(discovered.empty()){capture.done=true;transmit.join();api->find_destroy(finder);api->send_destroy(sender);api->destroy();return 3;}
    std::thread previewReceiver([&]{sauce_ndi_run(argv[1],discovered.c_str(),&preview,output,stopped);});
    std::thread timer([&]{
        std::this_thread::sleep_for(std::chrono::seconds(2));
        char* discovery=sauce_ndi_query(argv[1],true);
        refreshWorked=discovery && std::string(discovery).find("\"available\":true")!=std::string::npos;
        if(discovery)sauce_ndi_free(discovery);
        std::this_thread::sleep_for(std::chrono::seconds(2));preview.done=true;
        previewReceiver.join();
        // A discovery and a second receiver have now both torn down while
        // the main receiver must continue through sender stall and recovery.
        if(continuous) {
            // Long, uninterrupted tones for decoder continuity tests. Keep the
            // normal stall/recovery smoke as the default, independent gate.
            std::this_thread::sleep_for(std::chrono::seconds(24));
        } else {
            capture.stall=true;
            std::this_thread::sleep_for(std::chrono::seconds(4));capture.stall=false;
            std::this_thread::sleep_for(std::chrono::seconds(6));
        }
        capture.done=true;
    });
    sauce_ndi_run_with_timing(argv[1],discovered.c_str(),&capture,output,stopped,timingEnabled);
    capture.done=true;transmit.join();timer.join();
    api->find_destroy(finder);api->send_destroy(sender);api->destroy();dlclose(library);
    std::cerr<<"independent media segments: "<<capture.segments<<"\n";
    std::cerr<<"live: "<<capture.sawLive<<", stalled: "<<capture.sawStale<<", recovered: "<<capture.recovered<<"\n";
    std::cerr<<"preview segments: "<<preview.segments<<", concurrent discovery: "<<refreshWorked<<"\n";
    std::cerr<<"initial placeholder deferred: "<<capture.sawInitialPlaceholder<<"\n";
    std::cerr<<"input fps verified: "<<capture.sawInputRate<<" ("<<inputFps<<"), maximum measured output fps: "<<capture.maxOutputFps<<"\n";
    std::cerr<<"timing probe samples: "<<capture.timingSamples<<", accepted: "<<capture.acceptedTimingSamples
        <<", repeated timing: "<<capture.sawRepeatedTiming<<", bounded metadata: "<<capture.sawBoundedMetadata
        <<", invalid UTF-8: "<<capture.sawInvalidMetadata<<", metadata samples: "<<capture.metadataSamples
        <<", probe-free preview samples: "<<preview.timingSamples<<"\n";
    // A one-second boundary can contain 31 frame completions; the encoded
    // timestamp cadence is independently checked as 30/1 by ffprobe.
    return capture.segments>=(continuous?200:10) && capture.sawLive && (continuous || (capture.sawStale && capture.recovered)) && capture.sawInitialPlaceholder && preview.segments>=3 && refreshWorked && capture.sawInputRate && capture.maxOutputFps<31.5
        // SDK/frame-sync may omit metadata. Helper tests validate our bounded
        // copy even when propagation is absent; report absence, do not fake it.
        && capture.timingSamples>20 && capture.acceptedTimingSamples>20 && capture.sawRepeatedTiming
        && !capture.invalidTimingPacket && preview.timingSamples==0 ? 0 : 4;
}
