use crate::key_bundle::{self, KeyBundleState, KeyBundleStatus};
use crate::range_download;
use blake2::{
    digest::{Update as BlakeUpdate, VariableOutput},
    Blake2bVar,
};
use flate2::read::GzDecoder;
use key_bundle_core::{
    self, BundleValidationRequest, InstalledReleaseMetadata, CONSTRAINT_SYSTEM_FILE, MANIFEST_FILE,
    MANIFEST_SIGNATURE_FILE, PROVING_KEY_FILE, VERIFYING_KEY_FILE,
};
use reqwest::blocking::Client;
use serde::Serialize;
use sha2::{Digest as ShaDigest, Sha256};
use std::cell::RefCell;
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tar::Archive;
use tauri::{AppHandle, Emitter, Runtime, State};
use url::Url;

const PROOF_ASSET_INSTALL_PROGRESS_EVENT: &str = "proof-asset-install-progress";
const DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const MINIMUM_FREE_BYTES: u64 = 5 * 1024 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct ProofAssetsReleaseDescriptor {
    pub release_tag: String,
    pub profile: String,
    pub archive_url: String,
    pub archive_size: u64,
    pub archive_sha256: String,
    pub archive_blake2b256: String,
    pub key_bundle_prefix: String,
    pub expected_key_version: String,
    pub expected_circuit_id: String,
    pub expected_vk_hash: String,
    pub expected_signature_key_id: String,
    pub trusted_manifest_public_key_hex: String,
    pub expected_cardano_vk_blake2b256: String,
    pub minimum_free_bytes: u64,
}

impl ProofAssetsReleaseDescriptor {
    pub fn download_configured(&self) -> bool {
        !self.archive_url.trim().is_empty()
            && self.archive_size > 0
            && !self.archive_sha256.trim().is_empty()
            && !self.archive_blake2b256.trim().is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProofAssetInstallPhase {
    Checking,
    Downloading,
    VerifyingArchive,
    Extracting,
    VerifyingBundle,
    Activating,
    Complete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProofAssetInstallProgress {
    pub release_tag: String,
    pub phase: ProofAssetInstallPhase,
    pub file_name: Option<String>,
    pub copied_bytes: u64,
    pub total_bytes: u64,
    pub message: String,
}

#[derive(Debug, Clone, Copy)]
enum ArchiveKind {
    Tar,
    TarGz,
}

#[derive(Debug, Clone)]
struct ArchiveDigest {
    sha256: String,
    blake2b256: String,
    size: u64,
}

pub fn active_descriptor() -> ProofAssetsReleaseDescriptor {
    ProofAssetsReleaseDescriptor {
        release_tag: "proof-assets-ownership-destination-v2-preprod-9fac96b-g3a".to_string(),
        profile: "preprod-single-destination".to_string(),
        archive_url: "https://github.com/Anastasia-Labs/proof-tool-release/releases/download/proof-assets-ownership-destination-v2-preprod-9fac96b-g3a/proof-assets-ownership-destination-v2-preprod-9fac96b-g3a.tar".to_string(),
        archive_size: 1_417_943_040,
        archive_sha256:
            "sha256:ee2f232f828da815428965ceb7d57719e32b706fce3373cff603de73a29fdff9"
                .to_string(),
        archive_blake2b256:
            "blake2b256:2a44af40ef01cbdca91728098c96978af247ca65dd7ea632090393709a516a28"
                .to_string(),
        key_bundle_prefix: "key-bundle/ownership-destination-v2-preprod-9fac96b-g3a".to_string(),
        expected_key_version: "ownership-destination-v2".to_string(),
        expected_circuit_id: "root-ownership-destination-v2/bls12-381/groth16".to_string(),
        expected_vk_hash:
            "blake2b256:b1c03cf24376bcd6c743cb372169ff71f93b210e0d8d52b2c6831808f50ded80"
                .to_string(),
        expected_signature_key_id: "preprod-local-destination-v2-9fac96b-g3a".to_string(),
        trusted_manifest_public_key_hex:
            "2af3b300b9e641ede236d4b7d48b43eccfb843ffa9aca74abb38f98e7211eccb".to_string(),
        expected_cardano_vk_blake2b256:
            "blake2b256:06ce913c931a53561fe5d022ed45a5fbc033b06d80eebdd9f646d23a05b7d5c4"
                .to_string(),
        minimum_free_bytes: MINIMUM_FREE_BYTES,
    }
}

#[tauri::command]
pub fn install_proof_assets_release<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, KeyBundleState>,
) -> Result<KeyBundleStatus, String> {
    state.cancel_activation.store(false, Ordering::SeqCst);
    let descriptor = active_descriptor();
    let install_result = install_release_from_descriptor(&app, &state, &descriptor);
    state.cancel_activation.store(false, Ordering::SeqCst);
    install_result?;
    key_bundle::inspect_key_bundle(&app)
}

fn install_release_from_descriptor<R: Runtime>(
    app: &AppHandle<R>,
    state: &KeyBundleState,
    descriptor: &ProofAssetsReleaseDescriptor,
) -> Result<(), String> {
    validate_descriptor_for_download(descriptor)?;
    let paths = key_bundle::key_cache_paths(app)?;
    ensure_space_available(paths.active_dir.parent(), descriptor.minimum_free_bytes)?;
    emit_progress(
        app,
        descriptor,
        ProofAssetInstallPhase::Checking,
        None,
        0,
        descriptor.archive_size,
        "Checking disk space and release identity.",
    )?;

    let client = Client::builder()
        .connect_timeout(DOWNLOAD_CONNECT_TIMEOUT)
        .build()
        .map_err(|err| format!("create download client: {err}"))?;

    // Probe with a one-byte range request. 206 means the server honors
    // ranges, so download the archive as parallel ranges (GitHub's CDN gives
    // several times the single-connection throughput that way). Any other
    // success status means the server ignored the header and this response is
    // already streaming the full body, so fall back to consuming it directly.
    let probe = client
        .get(&descriptor.archive_url)
        .header(reqwest::header::RANGE, "bytes=0-0")
        .send()
        .map_err(|err| format!("download proof assets: {err}"))?
        .error_for_status()
        .map_err(|err| format!("download proof assets: {err}"))?;

    let kind = ArchiveKind::from_url(&descriptor.archive_url);
    let mut on_progress = |progress| {
        if state.cancel_activation.load(Ordering::SeqCst) {
            return Err("proof assets install cancelled".to_string());
        }
        app.emit(PROOF_ASSET_INSTALL_PROGRESS_EVENT, progress)
            .map_err(|err| format!("emit proof asset install progress: {err}"))
    };
    let cancelled = || state.cancel_activation.load(Ordering::SeqCst);

    if probe.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        drop(probe);
        let source = Arc::new(range_download::HttpRangeSource {
            client,
            url: descriptor.archive_url.clone(),
        });
        let reader = range_download::ParallelRangeReader::new(
            source,
            descriptor.archive_size,
            range_download::DEFAULT_CHUNK_SIZE,
            range_download::DEFAULT_WORKERS,
        );
        install_archive_from_reader(
            descriptor,
            &paths.active_dir,
            &paths.downloading_dir,
            reader,
            kind,
            &mut on_progress,
            &cancelled,
        )
    } else {
        install_archive_from_reader(
            descriptor,
            &paths.active_dir,
            &paths.downloading_dir,
            probe,
            kind,
            &mut on_progress,
            &cancelled,
        )
    }
}

fn validate_descriptor_for_download(
    descriptor: &ProofAssetsReleaseDescriptor,
) -> Result<(), String> {
    if !descriptor.download_configured() {
        return Err(
            "proof assets release archive is not configured; choose a public distribution route and pin archive size plus hashes"
                .to_string(),
        );
    }
    if descriptor.profile.trim().is_empty() {
        return Err("proof assets release profile is not configured".to_string());
    }
    if !descriptor
        .expected_cardano_vk_blake2b256
        .starts_with("blake2b256:")
    {
        return Err("expected Cardano verifier key BLAKE2b-256 is not pinned".to_string());
    }
    let parsed = Url::parse(&descriptor.archive_url)
        .map_err(|err| format!("proof assets archive URL is invalid: {err}"))?;
    if parsed.scheme() != "https" {
        return Err("proof assets archive URL must use https".to_string());
    }
    Ok(())
}

fn install_archive_from_reader<R, F, C>(
    descriptor: &ProofAssetsReleaseDescriptor,
    active_dir: &Path,
    downloading_dir: &Path,
    reader: R,
    kind: ArchiveKind,
    on_progress: &mut F,
    cancelled: &C,
) -> Result<(), String>
where
    R: Read,
    F: FnMut(ProofAssetInstallProgress) -> Result<(), String>,
    C: Fn() -> bool,
{
    if downloading_dir.exists() {
        fs::remove_dir_all(downloading_dir)
            .map_err(|err| format!("remove stale temporary key bundle: {err}"))?;
    }
    fs::create_dir_all(downloading_dir)
        .map_err(|err| format!("create temporary key bundle directory: {err}"))?;

    let result = (|| {
        let digest = extract_archive(
            descriptor,
            downloading_dir,
            reader,
            kind,
            on_progress,
            cancelled,
        )?;
        emit_progress_value(
            descriptor,
            ProofAssetInstallPhase::VerifyingArchive,
            None,
            digest.size,
            descriptor.archive_size,
            "Verifying archive size and checksums.",
            on_progress,
        )?;
        verify_archive_digest(descriptor, &digest)?;

        emit_progress_value(
            descriptor,
            ProofAssetInstallPhase::VerifyingBundle,
            None,
            digest.size,
            descriptor.archive_size,
            "Verifying signed key manifest.",
            on_progress,
        )?;
        key_bundle_core::validate_staged_bundle(&BundleValidationRequest {
            bundle_dir: downloading_dir,
            trusted_manifest_public_key_hex: &descriptor.trusted_manifest_public_key_hex,
            expected_signature_key_id: &descriptor.expected_signature_key_id,
            expected_key_version: &descriptor.expected_key_version,
            expected_circuit_id: &descriptor.expected_circuit_id,
            expected_vk_hash: Some(&descriptor.expected_vk_hash),
        })?;

        key_bundle_core::write_release_metadata(
            downloading_dir,
            &InstalledReleaseMetadata {
                release_tag: descriptor.release_tag.clone(),
                installed_at: unix_installed_at(),
            },
        )?;

        emit_progress_value(
            descriptor,
            ProofAssetInstallPhase::Activating,
            None,
            digest.size,
            descriptor.archive_size,
            "Activating verified proof assets.",
            on_progress,
        )?;
        if cancelled() {
            return Err("proof assets install cancelled".to_string());
        }
        key_bundle_core::activate_staged_bundle(active_dir, downloading_dir)?;
        emit_progress_value(
            descriptor,
            ProofAssetInstallPhase::Complete,
            None,
            descriptor.archive_size,
            descriptor.archive_size,
            "Proof assets installed and verified.",
            on_progress,
        )
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(downloading_dir);
    }
    result
}

fn extract_archive<R, F, C>(
    descriptor: &ProofAssetsReleaseDescriptor,
    downloading_dir: &Path,
    reader: R,
    kind: ArchiveKind,
    on_progress: &mut F,
    cancelled: &C,
) -> Result<ArchiveDigest, String>
where
    R: Read,
    F: FnMut(ProofAssetInstallProgress) -> Result<(), String>,
    C: Fn() -> bool,
{
    match kind {
        ArchiveKind::Tar => {
            let progress = ProgressSink::new(on_progress);
            let digest_reader = DigestingReader::new(descriptor, reader, &progress, cancelled)?;
            let mut archive = Archive::new(digest_reader);
            extract_required_files(
                descriptor,
                downloading_dir,
                &mut archive,
                &progress,
                cancelled,
            )?;
            let mut digest_reader = archive.into_inner();
            io::copy(&mut digest_reader, &mut io::sink())
                .map_err(|err| format!("finish archive download: {err}"))?;
            digest_reader.finish()
        }
        ArchiveKind::TarGz => {
            let progress = ProgressSink::new(on_progress);
            let digest_reader = DigestingReader::new(descriptor, reader, &progress, cancelled)?;
            let decoder = GzDecoder::new(digest_reader);
            let mut archive = Archive::new(decoder);
            extract_required_files(
                descriptor,
                downloading_dir,
                &mut archive,
                &progress,
                cancelled,
            )?;
            let mut decoder = archive.into_inner();
            io::copy(&mut decoder, &mut io::sink())
                .map_err(|err| format!("finish compressed archive: {err}"))?;
            let digest_reader = decoder.into_inner();
            digest_reader.finish()
        }
    }
}

fn extract_required_files<R, F, C>(
    descriptor: &ProofAssetsReleaseDescriptor,
    downloading_dir: &Path,
    archive: &mut Archive<R>,
    progress: &ProgressSink<'_, F>,
    cancelled: &C,
) -> Result<(), String>
where
    R: Read,
    F: FnMut(ProofAssetInstallProgress) -> Result<(), String>,
    C: Fn() -> bool,
{
    let required = [
        MANIFEST_FILE,
        MANIFEST_SIGNATURE_FILE,
        PROVING_KEY_FILE,
        VERIFYING_KEY_FILE,
        CONSTRAINT_SYSTEM_FILE,
    ];
    let mut seen = HashSet::new();
    for entry in archive
        .entries()
        .map_err(|err| format!("read proof assets archive: {err}"))?
    {
        if cancelled() {
            return Err("proof assets install cancelled".to_string());
        }
        let mut entry = entry.map_err(|err| format!("read proof assets archive entry: {err}"))?;
        let path = entry
            .path()
            .map_err(|err| format!("read archive entry path: {err}"))?
            .into_owned();
        let Some(file_name) = bundle_file_for_entry(&path, &descriptor.key_bundle_prefix)? else {
            continue;
        };
        if !seen.insert(file_name) {
            return Err(format!("archive contains duplicate {file_name}"));
        }
        let output_path = downloading_dir.join(file_name);
        copy_entry_with_progress(
            descriptor,
            file_name,
            &mut entry,
            &output_path,
            progress,
            cancelled,
        )?;
    }

    for file_name in required {
        if !seen.contains(file_name) {
            return Err(format!("archive is missing {file_name}"));
        }
    }
    Ok(())
}

fn copy_entry_with_progress<R, F, C>(
    descriptor: &ProofAssetsReleaseDescriptor,
    file_name: &'static str,
    entry: &mut tar::Entry<'_, R>,
    output_path: &Path,
    progress: &ProgressSink<'_, F>,
    cancelled: &C,
) -> Result<(), String>
where
    R: Read,
    F: FnMut(ProofAssetInstallProgress) -> Result<(), String>,
    C: Fn() -> bool,
{
    let mut out =
        File::create(output_path).map_err(|err| format!("create staged {file_name}: {err}"))?;
    let total_bytes = entry.header().size().unwrap_or(0);
    let mut copied_bytes = 0_u64;
    let mut buf = [0_u8; 64 * 1024];
    loop {
        if cancelled() {
            return Err("proof assets install cancelled".to_string());
        }
        let read = entry
            .read(&mut buf)
            .map_err(|err| format!("extract {file_name}: {err}"))?;
        if read == 0 {
            break;
        }
        out.write_all(&buf[..read])
            .map_err(|err| format!("write staged {file_name}: {err}"))?;
        copied_bytes += read as u64;
        progress.emit(ProofAssetInstallProgress {
            release_tag: descriptor.release_tag.clone(),
            phase: ProofAssetInstallPhase::Extracting,
            file_name: Some(file_name.to_string()),
            copied_bytes,
            total_bytes,
            message: "Extracting proof asset files.".to_string(),
        })?;
    }
    out.flush()
        .map_err(|err| format!("flush staged {file_name}: {err}"))
}

fn bundle_file_for_entry(
    path: &Path,
    key_bundle_prefix: &str,
) -> Result<Option<&'static str>, String> {
    let archive_path = normalized_archive_path(path)?;
    let prefix = key_bundle_prefix.trim_matches('/');
    let relative = if prefix.is_empty() {
        archive_path.as_str()
    } else if let Some(value) = archive_path.strip_prefix(&format!("{prefix}/")) {
        value
    } else {
        return Ok(None);
    };
    match relative {
        MANIFEST_FILE => Ok(Some(MANIFEST_FILE)),
        MANIFEST_SIGNATURE_FILE => Ok(Some(MANIFEST_SIGNATURE_FILE)),
        PROVING_KEY_FILE => Ok(Some(PROVING_KEY_FILE)),
        VERIFYING_KEY_FILE => Ok(Some(VERIFYING_KEY_FILE)),
        CONSTRAINT_SYSTEM_FILE => Ok(Some(CONSTRAINT_SYSTEM_FILE)),
        _ => Ok(None),
    }
}

fn normalized_archive_path(path: &Path) -> Result<String, String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => parts.push(value.to_string_lossy().to_string()),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!(
                    "archive entry path is not safe: {}",
                    path.display()
                ));
            }
        }
    }
    Ok(parts.join("/"))
}

fn verify_archive_digest(
    descriptor: &ProofAssetsReleaseDescriptor,
    digest: &ArchiveDigest,
) -> Result<(), String> {
    if digest.size != descriptor.archive_size {
        return Err(format!(
            "archive size mismatch: descriptor {}, download {}",
            descriptor.archive_size, digest.size
        ));
    }
    if digest.sha256 != descriptor.archive_sha256 {
        return Err(format!(
            "archive sha256 mismatch: descriptor {}, download {}",
            descriptor.archive_sha256, digest.sha256
        ));
    }
    if digest.blake2b256 != descriptor.archive_blake2b256 {
        return Err(format!(
            "archive blake2b256 mismatch: descriptor {}, download {}",
            descriptor.archive_blake2b256, digest.blake2b256
        ));
    }
    Ok(())
}

fn emit_progress<R: Runtime>(
    app: &AppHandle<R>,
    descriptor: &ProofAssetsReleaseDescriptor,
    phase: ProofAssetInstallPhase,
    file_name: Option<String>,
    copied_bytes: u64,
    total_bytes: u64,
    message: &str,
) -> Result<(), String> {
    app.emit(
        PROOF_ASSET_INSTALL_PROGRESS_EVENT,
        ProofAssetInstallProgress {
            release_tag: descriptor.release_tag.clone(),
            phase,
            file_name,
            copied_bytes,
            total_bytes,
            message: message.to_string(),
        },
    )
    .map_err(|err| format!("emit proof asset install progress: {err}"))
}

fn emit_progress_value<F>(
    descriptor: &ProofAssetsReleaseDescriptor,
    phase: ProofAssetInstallPhase,
    file_name: Option<String>,
    copied_bytes: u64,
    total_bytes: u64,
    message: &str,
    on_progress: &mut F,
) -> Result<(), String>
where
    F: FnMut(ProofAssetInstallProgress) -> Result<(), String>,
{
    on_progress(ProofAssetInstallProgress {
        release_tag: descriptor.release_tag.clone(),
        phase,
        file_name,
        copied_bytes,
        total_bytes,
        message: message.to_string(),
    })
}

fn ensure_space_available(path: Option<&Path>, required: u64) -> Result<(), String> {
    if required == 0 {
        return Err("minimum free space must be greater than zero".to_string());
    }
    let Some(path) = path else {
        return Err("key cache path has no parent directory".to_string());
    };
    let check_path = existing_ancestor(path);
    let available = fs2::available_space(&check_path).map_err(|err| {
        format!(
            "check available disk space at {}: {err}",
            check_path.display()
        )
    })?;
    if available < required {
        return Err(format!(
            "not enough disk space: {available} bytes available, {required} bytes required"
        ));
    }
    Ok(())
}

fn existing_ancestor(path: &Path) -> PathBuf {
    let mut current = path;
    loop {
        if current.exists() {
            return current.to_path_buf();
        }
        match current.parent() {
            Some(parent) => current = parent,
            None => return PathBuf::from("."),
        }
    }
}

fn unix_installed_at() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("unix:{seconds}")
}

impl ArchiveKind {
    fn from_url(url: &str) -> Self {
        if url.ends_with(".tar.gz") || url.ends_with(".tgz") {
            Self::TarGz
        } else {
            Self::Tar
        }
    }
}

struct ProgressSink<'a, F>
where
    F: FnMut(ProofAssetInstallProgress) -> Result<(), String>,
{
    callback: RefCell<&'a mut F>,
}

impl<'a, F> ProgressSink<'a, F>
where
    F: FnMut(ProofAssetInstallProgress) -> Result<(), String>,
{
    fn new(callback: &'a mut F) -> Self {
        Self {
            callback: RefCell::new(callback),
        }
    }

    fn emit(&self, progress: ProofAssetInstallProgress) -> Result<(), String> {
        let mut callback = self.callback.borrow_mut();
        (*callback)(progress)
    }
}

struct DigestingReader<'a, R, F, C>
where
    F: FnMut(ProofAssetInstallProgress) -> Result<(), String>,
    C: Fn() -> bool,
{
    descriptor: &'a ProofAssetsReleaseDescriptor,
    inner: R,
    sha: Sha256,
    blake: Blake2bVar,
    read_bytes: u64,
    progress: &'a ProgressSink<'a, F>,
    cancelled: &'a C,
}

impl<'a, R, F, C> DigestingReader<'a, R, F, C>
where
    R: Read,
    F: FnMut(ProofAssetInstallProgress) -> Result<(), String>,
    C: Fn() -> bool,
{
    fn new(
        descriptor: &'a ProofAssetsReleaseDescriptor,
        inner: R,
        progress: &'a ProgressSink<'a, F>,
        cancelled: &'a C,
    ) -> Result<Self, String> {
        Ok(Self {
            descriptor,
            inner,
            sha: Sha256::new(),
            blake: Blake2bVar::new(32).map_err(|err| format!("create blake2b digest: {err}"))?,
            read_bytes: 0,
            progress,
            cancelled,
        })
    }

    fn finish(self) -> Result<ArchiveDigest, String> {
        let mut blake_out = [0_u8; 32];
        self.blake
            .finalize_variable(&mut blake_out)
            .map_err(|err| format!("finalize blake2b digest: {err}"))?;
        Ok(ArchiveDigest {
            sha256: format!("sha256:{}", hex::encode(self.sha.finalize())),
            blake2b256: format!("blake2b256:{}", hex::encode(blake_out)),
            size: self.read_bytes,
        })
    }
}

impl<R, F, C> Read for DigestingReader<'_, R, F, C>
where
    R: Read,
    F: FnMut(ProofAssetInstallProgress) -> Result<(), String>,
    C: Fn() -> bool,
{
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if (self.cancelled)() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "proof assets install cancelled",
            ));
        }
        let read = self.inner.read(buf)?;
        if read == 0 {
            return Ok(0);
        }
        ShaDigest::update(&mut self.sha, &buf[..read]);
        BlakeUpdate::update(&mut self.blake, &buf[..read]);
        self.read_bytes += read as u64;
        self.progress
            .emit(ProofAssetInstallProgress {
                release_tag: self.descriptor.release_tag.clone(),
                phase: ProofAssetInstallPhase::Downloading,
                file_name: None,
                copied_bytes: self.read_bytes,
                total_bytes: self.descriptor.archive_size,
                message: "Downloading proof assets.".to_string(),
            })
            .map_err(io::Error::other)?;
        Ok(read)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use key_bundle_core::{digest_file, KeyManifest};
    use tempfile::TempDir;

    const SIGNING_KEY_BYTES: [u8; 32] = [9; 32];
    const SIGNATURE_KEY_ID: &str = "test-release-signer";

    #[test]
    fn active_descriptor_pins_release_identity() {
        let descriptor = active_descriptor();
        assert!(!descriptor.release_tag.is_empty());
        assert!(!descriptor.profile.is_empty());
        assert_eq!(descriptor.expected_key_version, "ownership-destination-v2");
        assert_eq!(
            descriptor.expected_circuit_id,
            "root-ownership-destination-v2/bls12-381/groth16"
        );
        assert!(descriptor.expected_vk_hash.starts_with("blake2b256:"));
        assert!(!descriptor.expected_signature_key_id.is_empty());
        assert_eq!(descriptor.trusted_manifest_public_key_hex.len(), 64);
        assert!(descriptor
            .expected_cardano_vk_blake2b256
            .starts_with("blake2b256:"));
        assert!(descriptor.minimum_free_bytes > 0);
        assert!(descriptor.download_configured());
        assert!(descriptor.archive_url.starts_with("https://github.com/"));
        assert_eq!(descriptor.archive_size, 1_417_943_040);
        assert!(descriptor.archive_sha256.starts_with("sha256:"));
        assert!(descriptor.archive_blake2b256.starts_with("blake2b256:"));
        assert_eq!(
            descriptor.key_bundle_prefix,
            "key-bundle/ownership-destination-v2-preprod-9fac96b-g3a"
        );
    }

    #[test]
    fn descriptor_rejects_unconfigured_or_non_https_archives() {
        let mut descriptor = active_descriptor();
        descriptor.archive_url = String::new();
        descriptor.archive_size = 0;
        descriptor.archive_sha256 = String::new();
        descriptor.archive_blake2b256 = String::new();
        let err = validate_descriptor_for_download(&descriptor).unwrap_err();
        assert!(err.contains("archive is not configured"));

        let mut descriptor = fixture_descriptor(&Fixture::new());
        descriptor.archive_url = "http://example.test/assets.tar".to_string();
        let err = validate_descriptor_for_download(&descriptor).unwrap_err();
        assert!(err.contains("https"));
    }

    #[test]
    fn active_descriptor_matches_release_archive_key_bundle_paths() {
        let descriptor = active_descriptor();
        assert_eq!(
            bundle_file_for_entry(
                Path::new(
                    "./key-bundle/ownership-destination-v2-preprod-9fac96b-g3a/manifest.json"
                ),
                &descriptor.key_bundle_prefix,
            )
            .unwrap(),
            Some(MANIFEST_FILE)
        );
        assert_eq!(
            bundle_file_for_entry(
                Path::new("key-bundle/ownership-destination-v2-preprod-9fac96b-g3a/ownership.pk"),
                &descriptor.key_bundle_prefix,
            )
            .unwrap(),
            Some(PROVING_KEY_FILE)
        );
        assert_eq!(
            bundle_file_for_entry(
                Path::new(
                    "key-bundle/ownership-destination-v2-preprod-9fac96b-g3a/ownership-destination.ccs"
                ),
                &descriptor.key_bundle_prefix,
            )
            .unwrap(),
            Some(CONSTRAINT_SYSTEM_FILE)
        );
        assert_eq!(
            bundle_file_for_entry(
                Path::new(
                    "proof-assets-ownership-destination-v2-preprod-9fac96b-g3a/manifest.json"
                ),
                &descriptor.key_bundle_prefix,
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn installs_valid_tiny_tar_fixture() {
        let fixture = Fixture::new();
        let descriptor = fixture_descriptor(&fixture);
        let file = File::open(fixture.archive_path()).unwrap();
        let mut events = Vec::new();

        install_archive_from_reader(
            &descriptor,
            &fixture.active_dir(),
            &fixture.downloading_dir(),
            file,
            ArchiveKind::Tar,
            &mut |progress| {
                events.push(progress);
                Ok(())
            },
            &|| false,
        )
        .expect("install archive");

        assert!(fixture.active_dir().join(MANIFEST_FILE).exists());
        assert!(fixture
            .active_dir()
            .join(key_bundle_core::RELEASE_METADATA_FILE)
            .exists());
        assert!(!fixture.downloading_dir().exists());
        assert!(events
            .iter()
            .any(|event| event.phase == ProofAssetInstallPhase::Complete));
    }

    #[test]
    fn rejects_wrong_archive_hash_without_replacing_active() {
        let fixture = Fixture::new();
        let descriptor = fixture_descriptor(&fixture);
        let file = File::open(fixture.archive_path()).unwrap();
        install_archive_from_reader(
            &descriptor,
            &fixture.active_dir(),
            &fixture.downloading_dir(),
            file,
            ArchiveKind::Tar,
            &mut |_| Ok(()),
            &|| false,
        )
        .expect("initial install");

        let mut bad_descriptor = descriptor.clone();
        bad_descriptor.archive_sha256 = "sha256:00".to_string();
        let file = File::open(fixture.archive_path()).unwrap();
        let err = install_archive_from_reader(
            &bad_descriptor,
            &fixture.active_dir(),
            &fixture.downloading_dir(),
            file,
            ArchiveKind::Tar,
            &mut |_| Ok(()),
            &|| false,
        )
        .unwrap_err();

        assert!(err.contains("archive sha256 mismatch"));
        let status = key_bundle_core::inspect_active_bundle(&fixture.active_dir());
        assert!(status.ready);
        assert_eq!(
            status.installed_release_tag.as_deref(),
            Some(descriptor.release_tag.as_str())
        );
    }

    #[test]
    fn rejects_wrong_signature_key_id() {
        let fixture = Fixture::new();
        let mut descriptor = fixture_descriptor(&fixture);
        descriptor.expected_signature_key_id = "other-signer".to_string();
        let file = File::open(fixture.archive_path()).unwrap();
        let err = install_archive_from_reader(
            &descriptor,
            &fixture.active_dir(),
            &fixture.downloading_dir(),
            file,
            ArchiveKind::Tar,
            &mut |_| Ok(()),
            &|| false,
        )
        .unwrap_err();

        assert!(err.contains("signature key id"));
        assert!(!fixture.active_dir().exists());
    }

    #[test]
    fn rejects_wrong_expected_verifier_hash() {
        let fixture = Fixture::new();
        let mut descriptor = fixture_descriptor(&fixture);
        descriptor.expected_vk_hash = "blake2b256:00".to_string();
        let file = File::open(fixture.archive_path()).unwrap();
        let err = install_archive_from_reader(
            &descriptor,
            &fixture.active_dir(),
            &fixture.downloading_dir(),
            file,
            ArchiveKind::Tar,
            &mut |_| Ok(()),
            &|| false,
        )
        .unwrap_err();

        assert!(err.contains("vk_hash"));
        assert!(!fixture.active_dir().exists());
    }

    #[test]
    fn rejects_archive_missing_proving_key() {
        let fixture = Fixture::without_archive_file(PROVING_KEY_FILE);
        let descriptor = fixture_descriptor(&fixture);
        let file = File::open(fixture.archive_path()).unwrap();
        let err = install_archive_from_reader(
            &descriptor,
            &fixture.active_dir(),
            &fixture.downloading_dir(),
            file,
            ArchiveKind::Tar,
            &mut |_| Ok(()),
            &|| false,
        )
        .unwrap_err();

        assert!(err.contains("missing ownership.pk"));
        assert!(!fixture.active_dir().exists());
    }

    #[test]
    fn rejects_truncated_archive() {
        let fixture = Fixture::new();
        let descriptor = fixture_descriptor(&fixture);
        let file = File::open(fixture.archive_path()).unwrap().take(128);
        let err = install_archive_from_reader(
            &descriptor,
            &fixture.active_dir(),
            &fixture.downloading_dir(),
            file,
            ArchiveKind::Tar,
            &mut |_| Ok(()),
            &|| false,
        )
        .unwrap_err();

        assert!(err.contains("archive") || err.contains("unexpected EOF"));
        assert!(!fixture.active_dir().exists());
    }

    #[test]
    fn cancellation_before_activation_preserves_existing_active_bundle() {
        let fixture = Fixture::new();
        let descriptor = fixture_descriptor(&fixture);
        let file = File::open(fixture.archive_path()).unwrap();
        install_archive_from_reader(
            &descriptor,
            &fixture.active_dir(),
            &fixture.downloading_dir(),
            file,
            ArchiveKind::Tar,
            &mut |_| Ok(()),
            &|| false,
        )
        .expect("initial install");

        let file = File::open(fixture.archive_path()).unwrap();
        let err = install_archive_from_reader(
            &descriptor,
            &fixture.active_dir(),
            &fixture.downloading_dir(),
            file,
            ArchiveKind::Tar,
            &mut |progress| {
                if progress.phase == ProofAssetInstallPhase::Activating {
                    return Err("cancelled by test".to_string());
                }
                Ok(())
            },
            &|| false,
        )
        .unwrap_err();

        assert!(err.contains("cancelled by test"));
        let status = key_bundle_core::inspect_active_bundle(&fixture.active_dir());
        assert!(status.ready);
        assert!(!fixture.downloading_dir().exists());
    }

    fn fixture_descriptor(fixture: &Fixture) -> ProofAssetsReleaseDescriptor {
        let digest = key_bundle_core::digest_file(&fixture.archive_path()).unwrap();
        ProofAssetsReleaseDescriptor {
            release_tag: "test-release".to_string(),
            profile: "test-profile".to_string(),
            archive_url: "https://example.test/proof-assets.tar".to_string(),
            archive_size: digest.size,
            archive_sha256: digest.sha256,
            archive_blake2b256: digest.blake2b256,
            key_bundle_prefix: "bundle".to_string(),
            expected_key_version: key_bundle_core::KEY_VERSION.to_string(),
            expected_circuit_id: key_bundle_core::CIRCUIT_ID.to_string(),
            expected_vk_hash: fixture.vk_hash.clone(),
            expected_signature_key_id: SIGNATURE_KEY_ID.to_string(),
            trusted_manifest_public_key_hex: fixture.public_key_hex.clone(),
            expected_cardano_vk_blake2b256: "blake2b256:test-cardano-vk".to_string(),
            minimum_free_bytes: 1,
        }
    }

    struct Fixture {
        tmp: TempDir,
        public_key_hex: String,
        vk_hash: String,
    }

    impl Fixture {
        fn new() -> Self {
            Self::without_archive_file("")
        }

        fn without_archive_file(omitted_file_name: &str) -> Self {
            let tmp = TempDir::new().unwrap();
            let bundle_dir = tmp.path().join("bundle");
            fs::create_dir_all(&bundle_dir).unwrap();
            fs::write(bundle_dir.join(PROVING_KEY_FILE), b"test proving key").unwrap();
            fs::write(bundle_dir.join(VERIFYING_KEY_FILE), b"test verifying key").unwrap();
            fs::write(
                bundle_dir.join(CONSTRAINT_SYSTEM_FILE),
                b"test constraint system",
            )
            .unwrap();

            let pk_digest = digest_file(&bundle_dir.join(PROVING_KEY_FILE)).unwrap();
            let vk_digest = digest_file(&bundle_dir.join(VERIFYING_KEY_FILE)).unwrap();
            let ccs_digest = digest_file(&bundle_dir.join(CONSTRAINT_SYSTEM_FILE)).unwrap();
            let manifest = KeyManifest {
                schema: "proof-tool-key-manifest-v1".to_string(),
                key_version: key_bundle_core::KEY_VERSION.to_string(),
                circuit_id: key_bundle_core::CIRCUIT_ID.to_string(),
                curve: "BLS12-381".to_string(),
                backend: "groth16".to_string(),
                vk_hash: vk_digest.blake2b256.clone(),
                proving_key_sha256: pk_digest.sha256,
                proving_key_blake2b256: pk_digest.blake2b256,
                proving_key_size: pk_digest.size,
                verifying_key_sha256: vk_digest.sha256,
                verifying_key_size: vk_digest.size,
                constraint_system_hash: Some(ccs_digest.blake2b256),
                signature_key_id: SIGNATURE_KEY_ID.to_string(),
            };
            let manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
            fs::write(bundle_dir.join(MANIFEST_FILE), &manifest_bytes).unwrap();

            let signing_key = SigningKey::from_bytes(&SIGNING_KEY_BYTES);
            let signature = signing_key.sign(&manifest_bytes);
            fs::write(
                bundle_dir.join(MANIFEST_SIGNATURE_FILE),
                hex::encode(signature.to_bytes()),
            )
            .unwrap();

            let archive_path = tmp.path().join("proof-assets.tar");
            let archive = File::create(&archive_path).unwrap();
            let mut builder = tar::Builder::new(archive);
            builder
                .append_dir("bundle", &bundle_dir)
                .expect("append bundle dir");
            for file_name in [
                MANIFEST_FILE,
                MANIFEST_SIGNATURE_FILE,
                PROVING_KEY_FILE,
                VERIFYING_KEY_FILE,
                CONSTRAINT_SYSTEM_FILE,
            ] {
                if file_name == omitted_file_name {
                    continue;
                }
                builder
                    .append_path_with_name(
                        bundle_dir.join(file_name),
                        format!("bundle/{file_name}"),
                    )
                    .expect("append bundle file");
            }
            builder.finish().unwrap();

            Self {
                tmp,
                public_key_hex: hex::encode(signing_key.verifying_key().to_bytes()),
                vk_hash: vk_digest.blake2b256,
            }
        }

        fn archive_path(&self) -> PathBuf {
            self.tmp.path().join("proof-assets.tar")
        }

        fn active_dir(&self) -> PathBuf {
            self.tmp.path().join("cache").join("active")
        }

        fn downloading_dir(&self) -> PathBuf {
            self.tmp.path().join("cache").join("downloading.tmp")
        }
    }
}
