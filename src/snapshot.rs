//! Render Chromium's accessibility tree using DevTools' uid/role/name notation.

use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT_SNAPSHOT: AtomicU64 = AtomicU64::new(1);

pub fn render(nodes: &[Value]) -> (String, HashMap<String, u64>) {
    let by_id: HashMap<_, _> = nodes
        .iter()
        .filter_map(|n| Some((n["nodeId"].as_str()?, n)))
        .collect();
    let snapshot = NEXT_SNAPSHOT.fetch_add(1, Ordering::Relaxed);
    let mut text = String::new();
    let mut elements = HashMap::new();
    let mut stack = nodes.first().map(|n| vec![(n, 0)]).unwrap_or_default();
    while let Some((node, depth)) = stack.pop() {
        let role = node["role"]["value"].as_str().unwrap_or("none");
        if role == "InlineTextBox" {
            continue;
        }
        let shown = node["ignored"] != true && !matches!(role, "none" | "generic");
        if shown {
            let mut attrs = Vec::new();
            if let Some(backend) = node["backendDOMNodeId"].as_u64() {
                let uid = format!("{snapshot}_{}", elements.len());
                attrs.push(format!("uid={uid}"));
                elements.insert(uid, backend);
            }
            if role != "StaticText" {
                attrs.push(role.to_owned());
            }
            if let Some(name) = node["name"]["value"].as_str().filter(|s| !s.is_empty()) {
                attrs.push(serde_json::to_string(name).unwrap());
            }
            let mut properties = BTreeMap::new();
            for key in ["value", "description"] {
                if let Some(value) = node[key].get("value") {
                    properties.insert(key, value.clone());
                }
            }
            for prop in node["properties"].as_array().into_iter().flatten() {
                if let Some(name) = prop["name"].as_str() {
                    let value = &prop["value"]["value"];
                    let value = match (prop["value"]["type"].as_str(), value.as_str()) {
                        (Some("tristate"), Some("true")) => Value::Bool(true),
                        (Some("tristate"), Some("false")) => Value::Bool(false),
                        _ => value.clone(),
                    };
                    properties.insert(name, value);
                }
            }
            for (name, capability) in [
                ("disabled", "disableable"),
                ("expanded", "expandable"),
                ("focused", "focusable"),
                ("selected", "selectable"),
            ] {
                if properties.get(name).is_some_and(Value::is_boolean) {
                    properties.insert(capability, Value::Bool(true));
                }
            }
            for (name, value) in properties {
                match value {
                    Value::Bool(true) => attrs.push(name.to_owned()),
                    Value::String(s) if !s.is_empty() => {
                        attrs.push(format!("{name}={}", serde_json::to_string(&s).unwrap()))
                    }
                    Value::Number(n) => attrs.push(format!("{name}=\"{n}\"")),
                    _ => {}
                }
            }
            text.push_str(&"  ".repeat(depth));
            text.push_str(&attrs.join(" "));
            text.push('\n');
        }
        // DevTools also collapses text children that repeat their parent's name.
        let children: Vec<_> = node["childIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|id| by_id.get(id.as_str()?).copied())
            .collect();
        let redundant = shown
            && !children.is_empty()
            && children.iter().all(|c| c["role"]["value"] == "StaticText")
            && children
                .iter()
                .filter_map(|c| c["name"]["value"].as_str())
                .collect::<String>()
                .split_whitespace()
                .collect::<String>()
                == node["name"]["value"]
                    .as_str()
                    .unwrap_or("")
                    .split_whitespace()
                    .collect::<String>();
        if !redundant {
            stack.extend(
                children
                    .into_iter()
                    .rev()
                    .map(|c| (c, depth + usize::from(shown))),
            );
        }
    }
    (text, elements)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tree_keeps_roles_names_values_states_and_reading_order() {
        let nodes = json!([
            {"nodeId":"1","backendDOMNodeId":1,"role":{"value":"RootWebArea"},"name":{"value":"Example"},"properties":[{"name":"url","value":{"value":"https://example.com/"}}],"childIds":["2","3"]},
            {"nodeId":"2","backendDOMNodeId":2,"role":{"value":"textbox"},"name":{"value":"Name"},"value":{"value":"Alice"},"properties":[{"name":"required","value":{"value":true}}]},
            {"nodeId":"3","backendDOMNodeId":3,"role":{"value":"button"},"name":{"value":"Apply"},"properties":[{"name":"disabled","value":{"value":true}}],"childIds":["4"]},
            {"nodeId":"4","backendDOMNodeId":4,"role":{"value":"StaticText"},"name":{"value":"Apply"}}
        ]);
        let (text, elements) = render(nodes.as_array().unwrap());
        assert!(text.contains("RootWebArea \"Example\" url=\"https://example.com/\""));
        assert!(text.contains("textbox \"Name\" required value=\"Alice\""));
        assert!(text.contains("button \"Apply\" disableable disabled"));
        assert_eq!(text.matches("Apply").count(), 1);
        assert_eq!(elements.len(), 3);
        let (_, next) = render(nodes.as_array().unwrap());
        assert!(elements.keys().all(|id| !next.contains_key(id)));
    }
}
