use std::process::Command;

#[test]
fn shared_stdio_endpoint() {
    let status = Command::new("node")
        .args([
            "--test",
            "runtime/service.test.mjs",
            "runtime/viewer.test.mjs",
        ])
        .env("DOZE_TEST_BINARY", env!("CARGO_BIN_EXE_doze-bworser-mcp"))
        .status()
        .expect("Node.js is required to test the MCP endpoint");
    assert!(status.success());
}
