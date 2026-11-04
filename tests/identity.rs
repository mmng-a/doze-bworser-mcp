use doze_bworser_mcp::{read_config, service_lock};
use serde_json::json;

#[test]
fn config_validation_and_supervisor_exclusion() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("config.json");
    let mut config = json!({"token":"a".repeat(64),"socket_path":"test","node_path":"node","daemon_path":"daemon.mjs","chrome_path":"chrome","operation_timeout_seconds":20});
    std::fs::write(&path, config.to_string()).unwrap();
    assert!(read_config(&path).is_ok());
    config["operation_timeout_seconds"] = json!(0);
    std::fs::write(&path, config.to_string()).unwrap();
    assert!(read_config(&path).is_err());
    let owner = service_lock(&path).unwrap();
    assert!(service_lock(&path).is_err());
    drop(owner);
    assert!(service_lock(&path).is_ok());
}
