//! AAF addresses are metadata, not URLs to open. Only local filesystem paths
//! reach the decoder; a server name is retained as a mapping namespace.
use super::model::{AafPathMapping, AafSource};
use std::{collections::BTreeSet, path::{Component, Path, PathBuf}};

#[derive(Debug)]
pub struct Locator { pub path: PathBuf, pub authority: Option<String> }

fn safe(path: &Path) -> bool {
    path.is_absolute() && !path.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir))
        && !path.to_string_lossy().contains(['\0', '\\'])
}

pub fn parse(value: &str) -> Option<Locator> {
    // Avid Windows exports may use UNC paths rather than file URLs.
    let unc;
    let value = if value.starts_with("\\\\") {
        unc = format!("file:{}", value.replace('\\', "/")); unc.as_str()
    } else { value };
    if value.starts_with('/') && !value.starts_with("//") {
        let path = PathBuf::from(value);
        return safe(&path).then_some(Locator { path, authority: None });
    }
    // Reject traversal before URL normalization discards dot segments.
    if value.split(['/', '\\']).any(|p| matches!(p.to_ascii_lowercase().as_str(), "." | ".." | "%2e" | "%2e%2e" | ".%2e" | "%2e.")) { return None; }
    let url = url::Url::parse(value).ok()?;
    if url.scheme() != "file" || !url.username().is_empty() || url.password().is_some()
        || url.port().is_some() || url.query().is_some() || url.fragment().is_some() { return None; }
    let authority = url.host_str().filter(|h| *h != "localhost").map(str::to_ascii_lowercase);
    // Removing the authority decodes the path without following the address.
    let local = url::Url::parse(&format!("file://{}", url.path())).ok()?;
    let path = local.to_file_path().ok()?;
    if !safe(&path) { return None; }
    Some(Locator { path, authority })
}

pub fn locators(source: &AafSource) -> impl Iterator<Item = Locator> + '_ {
    source.locators.iter().filter_map(|l| parse(l))
}

pub fn candidates(source: &AafSource, mappings: &[AafPathMapping]) -> BTreeSet<PathBuf> {
    let mut paths = BTreeSet::new();
    for locator in locators(source) {
        for mapping in mappings {
            if mapping.authority == locator.authority {
                if let Ok(suffix) = locator.path.strip_prefix(&mapping.from) {
                    if safe(&locator.path) { paths.insert(Path::new(&mapping.to).join(suffix)); }
                }
            }
        }
        if locator.authority.is_some() {
            // One known workspace path, not a scan of other mounted volumes.
            if let Ok(relative) = locator.path.strip_prefix("/") { paths.insert(Path::new("/Volumes").join(relative)); }
        } else {
            paths.insert(locator.path.clone());
            let text = locator.path.to_string_lossy();
            if let Some(index) = text.find("/Volumes/") { paths.insert(PathBuf::from(&text[index..])); }
        }
    }
    paths
}

/// Try known suffixes first, whether the chosen root is a renamed workspace,
/// Avid MediaFiles, MXF, or a workstation's numbered media directory.
pub fn under_root(source: &AafSource, root: &Path) -> BTreeSet<PathBuf> {
    let mut paths = BTreeSet::new();
    for locator in locators(source) {
        let parts: Vec<_> = locator.path.iter().skip(1).collect();
        for start in 0..parts.len().min(32) {
            paths.insert(root.join(parts[start..].iter().collect::<PathBuf>()));
        }
    }
    paths
}

pub fn contained(path: &Path, root: &Path) -> bool {
    std::fs::canonicalize(path).ok().is_some_and(|p| p.starts_with(root))
}

pub fn remember(source: &AafSource, mappings: &mut Vec<AafPathMapping>) {
    let Some(binding) = &source.resolved else { return; };
    let Some(new) = Path::new(&binding.path).parent() else { return; };
    // Only addresses with the matching filename can justify a prefix mapping.
    // A manually selected renamed file remains an individual binding.
    for locator in locators(source) {
        if locator.path.file_name() != Path::new(&binding.path).file_name() { continue; }
        let Some(old) = locator.path.parent() else { continue; };
        let mapping = AafPathMapping { from: old.to_string_lossy().into_owned(), to: new.to_string_lossy().into_owned(), authority: locator.authority };
        if !mappings.iter().any(|m| m.from == mapping.from && m.to == mapping.to && m.authority == mapping.authority) { mappings.push(mapping); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn server_urls_decode_without_becoming_network_requests() {
        let address = parse("file://TestNexis/Show%20Audio/Avid%20MediaFiles/MXF/Edit.2/A01.mxf").unwrap();
        assert_eq!(address.authority.as_deref(), Some("testnexis"));
        assert_eq!(address.path, Path::new("/Show Audio/Avid MediaFiles/MXF/Edit.2/A01.mxf"));
        assert_eq!(parse(r"\\TestNexis\Show Audio\Avid MediaFiles\MXF\Edit.2\A01.mxf").unwrap().path, address.path);
        for bad in ["https://example.test/a.mxf", "smb://nexis/workspace/a.mxf", "../a.wav", "file://server/share/../secret", "file://server/share/%2e%2e/secret", "file://server/share/%2f..%2fsecret", "file:///tmp/a%00.mxf"] { assert!(parse(bad).is_none(), "{bad}"); }
    }
}
