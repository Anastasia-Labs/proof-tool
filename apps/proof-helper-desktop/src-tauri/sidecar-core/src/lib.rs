use serde::{Deserialize, Serialize};
use std::error::Error;
use std::fmt;
use std::path::{Path, PathBuf};
use url::Url;

const STARTUP_EVENT: &str = "proof_tool_helper_ready";
const DEFAULT_HELPER_ADDR: &str = "127.0.0.1:0";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServeHelperLaunch {
    pub site_url: String,
    pub keys_dir: PathBuf,
    pub destination_keys_dir: PathBuf,
    pub fixture: bool,
    pub dev_create_keys: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct HelperStartup {
    #[serde(rename = "type")]
    pub event_type: String,
    pub helper_url: String,
    pub site_url: String,
    pub pairing_url: String,
    pub token: String,
    pub allowed_origins: Vec<String>,
    pub sidecar_version: String,
    pub protocol_version: String,
    pub circuit_id: String,
    pub key_state: String,
    pub key_ready: bool,
    pub key_version: Option<String>,
    pub key_hash: Option<String>,
    pub key_compatibility: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SidecarCoreError {
    EmptyKeysDir,
    EmptySiteUrl,
    InvalidSiteUrl(String),
    SiteUrlMissingHost,
    UnsupportedSiteUrlScheme(String),
    InvalidStartupJson(String),
    UnexpectedStartupEvent(String),
    InvalidHelperUrl(String),
    HelperUrlNotLoopback(String),
    EmptyToken,
    InvalidPairingUrl(String),
    PairingUrlLeaksSecretQuery,
    MissingPairingFragment,
    PairingFragmentMissingHelper,
    PairingFragmentMissingToken,
    PairingFragmentHelperMismatch { expected: String, actual: String },
    PairingFragmentTokenMismatch,
}

impl fmt::Display for SidecarCoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyKeysDir => write!(f, "keys directory is empty"),
            Self::EmptySiteUrl => write!(f, "site URL is empty"),
            Self::InvalidSiteUrl(err) => write!(f, "invalid site URL: {err}"),
            Self::SiteUrlMissingHost => write!(f, "site URL must include a host"),
            Self::UnsupportedSiteUrlScheme(scheme) => {
                write!(f, "unsupported site URL scheme: {scheme}")
            }
            Self::InvalidStartupJson(err) => write!(f, "parse sidecar startup JSON: {err}"),
            Self::UnexpectedStartupEvent(event) => {
                write!(f, "unexpected sidecar startup event: {event}")
            }
            Self::InvalidHelperUrl(err) => write!(f, "invalid helper URL: {err}"),
            Self::HelperUrlNotLoopback(url) => write!(f, "helper URL is not loopback: {url}"),
            Self::EmptyToken => write!(f, "sidecar startup token is empty"),
            Self::InvalidPairingUrl(err) => write!(f, "invalid pairing URL: {err}"),
            Self::PairingUrlLeaksSecretQuery => {
                write!(f, "pairing URL must put helper and token in the fragment")
            }
            Self::MissingPairingFragment => write!(f, "pairing URL is missing a fragment"),
            Self::PairingFragmentMissingHelper => {
                write!(f, "pairing URL fragment is missing helper")
            }
            Self::PairingFragmentMissingToken => write!(f, "pairing URL fragment is missing pair"),
            Self::PairingFragmentHelperMismatch { expected, actual } => write!(
                f,
                "pairing URL helper mismatch: expected {expected}, got {actual}"
            ),
            Self::PairingFragmentTokenMismatch => write!(f, "pairing URL token mismatch"),
        }
    }
}

impl Error for SidecarCoreError {}

pub fn serve_helper_args(launch: &ServeHelperLaunch) -> Result<Vec<String>, SidecarCoreError> {
    let site_url = normalize_site_url(&launch.site_url)?;
    let keys_dir = launch.keys_dir.display().to_string();
    if keys_dir.trim().is_empty() {
        return Err(SidecarCoreError::EmptyKeysDir);
    }

    let mut args = vec![
        "serve-helper".to_string(),
        "--addr".to_string(),
        DEFAULT_HELPER_ADDR.to_string(),
        "--keys-dir".to_string(),
        keys_dir,
        "--destination-keys-dir".to_string(),
        launch.destination_keys_dir.display().to_string(),
        "--site-url".to_string(),
        site_url,
        "--no-open".to_string(),
    ];
    if launch.fixture {
        args.push("--fixture".to_string());
    }
    if launch.dev_create_keys {
        args.push("--dev-create-keys".to_string());
    }
    Ok(args)
}

pub fn parse_helper_startup_line(line: &str) -> Result<HelperStartup, SidecarCoreError> {
    let startup: HelperStartup = serde_json::from_str(line.trim())
        .map_err(|err| SidecarCoreError::InvalidStartupJson(err.to_string()))?;
    validate_helper_startup(&startup)?;
    Ok(startup)
}

pub fn validate_helper_startup(startup: &HelperStartup) -> Result<(), SidecarCoreError> {
    if startup.event_type != STARTUP_EVENT {
        return Err(SidecarCoreError::UnexpectedStartupEvent(
            startup.event_type.clone(),
        ));
    }
    if startup.token.is_empty() {
        return Err(SidecarCoreError::EmptyToken);
    }

    let helper_url = Url::parse(&startup.helper_url)
        .map_err(|err| SidecarCoreError::InvalidHelperUrl(err.to_string()))?;
    if !is_loopback_http_url(&helper_url) {
        return Err(SidecarCoreError::HelperUrlNotLoopback(
            startup.helper_url.clone(),
        ));
    }

    let pairing_url = Url::parse(&startup.pairing_url)
        .map_err(|err| SidecarCoreError::InvalidPairingUrl(err.to_string()))?;
    if pairing_url
        .query_pairs()
        .any(|(key, _)| key == "helper" || key == "pair")
    {
        return Err(SidecarCoreError::PairingUrlLeaksSecretQuery);
    }

    let fragment = pairing_url
        .fragment()
        .ok_or(SidecarCoreError::MissingPairingFragment)?;
    let mut fragment_helper = None;
    let mut fragment_token = None;
    for (key, value) in url::form_urlencoded::parse(fragment.as_bytes()) {
        if key == "helper" {
            fragment_helper = Some(value.into_owned());
        } else if key == "pair" {
            fragment_token = Some(value.into_owned());
        }
    }

    let fragment_helper = fragment_helper.ok_or(SidecarCoreError::PairingFragmentMissingHelper)?;
    let fragment_token = fragment_token.ok_or(SidecarCoreError::PairingFragmentMissingToken)?;
    if fragment_helper != startup.helper_url {
        return Err(SidecarCoreError::PairingFragmentHelperMismatch {
            expected: startup.helper_url.clone(),
            actual: fragment_helper,
        });
    }
    if fragment_token != startup.token {
        return Err(SidecarCoreError::PairingFragmentTokenMismatch);
    }
    Ok(())
}

pub fn push_candidate_set(out: &mut Vec<PathBuf>, dir: &Path, os: &str, arch: &str) {
    out.push(dir.join("proof-tool"));
    if let Some(suffix) = target_triple_suffix(os, arch) {
        out.push(dir.join(format!("proof-tool-{suffix}")));
    }
}

pub fn target_triple_suffix(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("linux", "x86_64") => Some("x86_64-unknown-linux-gnu"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        ("windows", "x86_64") => Some("x86_64-pc-windows-msvc.exe"),
        _ => None,
    }
}

fn normalize_site_url(value: &str) -> Result<String, SidecarCoreError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(SidecarCoreError::EmptySiteUrl);
    }
    let parsed =
        Url::parse(trimmed).map_err(|err| SidecarCoreError::InvalidSiteUrl(err.to_string()))?;
    match parsed.scheme() {
        "http" | "https" => {}
        scheme => {
            return Err(SidecarCoreError::UnsupportedSiteUrlScheme(
                scheme.to_string(),
            ))
        }
    }
    if parsed.host_str().is_none() {
        return Err(SidecarCoreError::SiteUrlMissingHost);
    }
    Ok(trimmed.to_string())
}

fn is_loopback_http_url(parsed: &Url) -> bool {
    if parsed.scheme() != "http" {
        return false;
    }
    matches!(
        parsed.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("::1")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serve_helper_args_include_loopback_no_open_and_optional_flags() {
        let args = serve_helper_args(&ServeHelperLaunch {
            site_url: " http://127.0.0.1:3000 ".to_string(),
            keys_dir: PathBuf::from("/tmp/proof-helper/keys"),
            destination_keys_dir: PathBuf::from("/tmp/proof-helper/destination-keys"),
            fixture: true,
            dev_create_keys: true,
        })
        .expect("build args");

        assert_eq!(
            args,
            vec![
                "serve-helper",
                "--addr",
                "127.0.0.1:0",
                "--keys-dir",
                "/tmp/proof-helper/keys",
                "--destination-keys-dir",
                "/tmp/proof-helper/destination-keys",
                "--site-url",
                "http://127.0.0.1:3000",
                "--no-open",
                "--fixture",
                "--dev-create-keys",
            ]
        );
    }

    #[test]
    fn serve_helper_args_reject_non_http_site_url() {
        let err = serve_helper_args(&ServeHelperLaunch {
            site_url: "file:///tmp/site.html".to_string(),
            keys_dir: PathBuf::from("/tmp/keys"),
            destination_keys_dir: PathBuf::from("/tmp/destination-keys"),
            fixture: false,
            dev_create_keys: false,
        })
        .unwrap_err();

        assert_eq!(
            err,
            SidecarCoreError::UnsupportedSiteUrlScheme("file".to_string())
        );
    }

    #[test]
    fn startup_json_accepts_fragment_pairing() {
        let startup = parse_helper_startup_line(
            r##"{
              "type":"proof_tool_helper_ready",
              "helper_url":"http://127.0.0.1:49152",
              "site_url":"https://proof.example",
              "pairing_url":"https://proof.example/#helper=http%3A%2F%2F127.0.0.1%3A49152&pair=tok_123",
              "token":"tok_123",
              "allowed_origins":["https://proof.example"],
              "sidecar_version":"0.1.0",
              "protocol_version":"proof-helper-v1",
              "circuit_id":"ownership-v1",
              "key_state":"ready",
              "key_ready":true,
              "key_version":"ownership-v1",
              "key_hash":"abc",
              "key_compatibility":"ready"
            }"##,
        )
        .expect("parse startup");

        assert_eq!(startup.helper_url, "http://127.0.0.1:49152");
        assert_eq!(startup.token, "tok_123");
    }

    #[test]
    fn startup_json_rejects_pairing_secret_in_query() {
        let err = parse_helper_startup_line(
            r##"{
              "type":"proof_tool_helper_ready",
              "helper_url":"http://127.0.0.1:49152",
              "site_url":"https://proof.example",
              "pairing_url":"https://proof.example/?pair=tok_123&helper=http%3A%2F%2F127.0.0.1%3A49152",
              "token":"tok_123",
              "allowed_origins":["https://proof.example"],
              "sidecar_version":"0.1.0",
              "protocol_version":"proof-helper-v1",
              "circuit_id":"ownership-v1",
              "key_state":"ready",
              "key_ready":true,
              "key_version":"ownership-v1",
              "key_hash":"abc",
              "key_compatibility":"ready"
            }"##,
        )
        .unwrap_err();

        assert_eq!(err, SidecarCoreError::PairingUrlLeaksSecretQuery);
    }

    #[test]
    fn startup_json_rejects_non_loopback_helper_url() {
        let err = parse_helper_startup_line(
            r##"{
              "type":"proof_tool_helper_ready",
              "helper_url":"http://192.0.2.10:49152",
              "site_url":"https://proof.example",
              "pairing_url":"https://proof.example/#helper=http%3A%2F%2F192.0.2.10%3A49152&pair=tok_123",
              "token":"tok_123",
              "allowed_origins":["https://proof.example"],
              "sidecar_version":"0.1.0",
              "protocol_version":"proof-helper-v1",
              "circuit_id":"ownership-v1",
              "key_state":"ready",
              "key_ready":true,
              "key_version":"ownership-v1",
              "key_hash":"abc",
              "key_compatibility":"ready"
            }"##,
        )
        .unwrap_err();

        assert_eq!(
            err,
            SidecarCoreError::HelperUrlNotLoopback("http://192.0.2.10:49152".to_string())
        );
    }

    #[test]
    fn candidate_paths_match_tauri_sidecar_suffixes() {
        let mut candidates = Vec::new();
        push_candidate_set(
            &mut candidates,
            Path::new("/opt/proof-helper/binaries"),
            "linux",
            "x86_64",
        );
        assert_eq!(
            candidates,
            vec![
                PathBuf::from("/opt/proof-helper/binaries/proof-tool"),
                PathBuf::from("/opt/proof-helper/binaries/proof-tool-x86_64-unknown-linux-gnu"),
            ]
        );

        assert_eq!(
            target_triple_suffix("windows", "x86_64"),
            Some("x86_64-pc-windows-msvc.exe")
        );
        assert_eq!(target_triple_suffix("linux", "aarch64"), None);
    }
}
