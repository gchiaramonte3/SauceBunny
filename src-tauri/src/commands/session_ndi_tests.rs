use super::*;
#[test] fn a_join_during_commit_uses_native_source_truth_not_a_stale_render() {
    let shared=HostShared {generation:7,..HostShared::default()};
    shared.commit_program(source("b",true),"ndi:review-b",7,0).unwrap();
    for kind in ["file","ndi"] {
        let old=SessionMsg::LoadSource {from:"m0".into(),source_kind:kind.into(),url:Some("old-or-private".into()),
            fingerprint:None,title:None,duration:None,review_key:"old-review".into(),live_state:None};
        assert!(matches!(shared.welcome_source(old).unwrap(),SessionMsg::LoadSource {url,review_key,..}
            if url.as_deref()==Some("b") && review_key=="ndi:review-b"));
    }
}
    fn source(id:&str, ready:bool) -> Arc<crate::commands::ndi::Program> {
        let p=crate::commands::ndi::Program::new(id.into(),"Premiere".into(),None);
        if ready { p.publish(1,b"init");p.publish(2,b"keyframe segment"); }
        p
    }
    #[test] fn private_sources_are_denied_and_only_one_publication_is_authorized() {
        let shared=HostShared { generation:7, ..HostShared::default() };
        let a=source("a",true);let b=source("b",true);
        assert!(shared.program_for_peer("a").is_none());
        shared.publish_program(a,7,0).unwrap();
        let old=shared.program_for_peer("a").unwrap();
        assert!(shared.program_for_peer("b").is_none());
        shared.publish_program(b,7,0).unwrap();
        assert!(!old.active());assert!(shared.program_for_peer("a").is_none());assert!(shared.program_for_peer("b").is_some());
    }
    #[test] fn a_failed_candidate_or_stale_request_cannot_replace_the_working_feed() {
        let shared=HostShared { generation:7, ..HostShared::default() };
        shared.publish_program(source("a",true),7,0).unwrap();
        assert!(shared.publish_program(source("not-ready",false),7,0).is_err());
        assert!(shared.publish_program(source("b",true),6,0).is_err());
        assert!(shared.publish_program(source("b",true),7,1).is_err());
        assert!(shared.program_for_peer("a").is_some());
    }
    #[test] fn unpublishing_is_scoped_even_when_the_same_source_is_republished() {
        let shared=HostShared { generation:7, ..HostShared::default() };let p=source("a",true);
        let revision=shared.publish_program(p.clone(),7,0).unwrap();
        assert_eq!(shared.publish_program(p.clone(),7,0).unwrap(),revision);
        shared.unpublish_program("a",6,0,revision).unwrap();assert!(shared.program_for_peer("a").is_some());
        shared.unpublish_program("a",7,0,revision).unwrap();assert!(shared.program_for_peer("a").is_none());
        let newer=shared.publish_program(p,7,0).unwrap();assert_ne!(revision,newer);
        shared.unpublish_program("a",7,0,revision).unwrap();assert!(shared.program_for_peer("a").is_some());
    }
    #[test] fn presenter_changes_and_room_teardown_revoke_existing_readers() {
        let shared=HostShared { generation:7, ..HostShared::default() };
        shared.publish_program(source("a",true),7,0).unwrap();
        let lease=shared.program_for_peer("a").unwrap();
        shared.revoke_program();shared.presenter.store(1,Ordering::Release);shared.presenter_epoch.store(1,Ordering::Release);
        assert!(!lease.active());assert!(shared.program_for_peer("a").is_none());
        assert!(shared.publish_program(source("b",true),7,1).is_err());
    }
    #[test] fn a_welcome_can_never_advertise_a_private_candidate() {
        let shared=HostShared { generation:7, ..HostShared::default() };
        assert!(shared.verified_program_source(Some("private"),"ndi:private").is_err());
        shared.commit_program(source("a",true),"ndi:review-a",7,0).unwrap();
        assert!(shared.verified_program_source(Some("private"),"ndi:private").is_err());
        assert!(shared.verified_program_source(Some("a"),"ndi:wrong-review").is_err());
        assert!(shared.verified_program_source(Some("a"),"ndi:review-a").is_ok());
    }
    #[test] fn stop_retains_review_identity_for_late_joiners_but_revokes_all_media_permission() {
        let shared=HostShared { generation:7, ..HostShared::default() };
        let p=source("a",true);
        let revision=shared.commit_program(p.clone(),"ndi:sequence-pass",7,0).unwrap();
        let lease=shared.program_for_peer("a").unwrap();
        assert!(shared.stop_program_publication("a",7,0,revision).unwrap());
        assert!(!lease.active());assert!(shared.program_for_peer("a").is_none());
        assert!(p.encoded_ready(),"local preview must keep running");
        let wire=shared.verified_program_source(Some("a"),"ndi:sequence-pass").unwrap();
        assert!(matches!(wire,SessionMsg::LoadSource {live_state:Some(crate::commands::ndi::NdiPublicationState::Stopped),review_key,..} if review_key=="ndi:sequence-pass"));
        assert!(!shared.stop_program_publication("a",7,0,revision).unwrap(),"duplicate stop cannot emit another change");
        let newer=shared.commit_program(p,"ndi:sequence-pass",7,0).unwrap();
        assert_ne!(revision,newer);
        assert!(!shared.stop_program_publication("a",7,0,revision).unwrap());
        assert!(matches!(shared.program_source_msg(),Some(SessionMsg::LoadSource {live_state:Some(crate::commands::ndi::NdiPublicationState::Live),..})));
    }
    #[test] fn invalid_review_identity_cannot_partially_commit_a_new_program() {
        let shared=HostShared { generation:7, ..HostShared::default() };
        shared.commit_program(source("a",true),"ndi:review-a",7,0).unwrap();
        assert!(shared.commit_program(source("b",true),"/private/file/path",7,0).is_err());
        assert!(shared.program_for_peer("a").is_some());
        assert!(shared.program_for_peer("b").is_none());
        assert!(shared.verified_program_source(Some("a"),"ndi:review-a").is_ok());
    }
    #[test] fn changed_file_source_or_handoff_cannot_welcome_with_the_old_program() {
        let shared=HostShared { generation:7, ..HostShared::default() };
        shared.commit_program(source("a",true),"ndi:review-a",7,0).unwrap();
        shared.revoke_program();
        assert!(shared.program_source_msg().is_none());
        assert!(shared.verified_program_source(Some("a"),"ndi:review-a").is_err());
    }
    #[test] fn live_source_wire_extension_accepts_the_previous_release() {
        let legacy=r#"{"kind":"loadSource","from":"m0","sourceKind":"ndi","url":"a","fingerprint":null,"title":"Premiere","duration":null,"reviewKey":"ndi:a"}"#;
        let parsed:SessionMsg=serde_json::from_str(legacy).unwrap();
        assert!(matches!(parsed,SessionMsg::LoadSource {live_state:None,..}));
        let shared=HostShared { generation:7, ..HostShared::default() };
        shared.commit_program(source("a",true),"ndi:a",7,0).unwrap();
        let json=serde_json::to_string(&shared.program_source_msg().unwrap()).unwrap();
        assert!(json.contains("\"liveState\":\"live\""));
    }
