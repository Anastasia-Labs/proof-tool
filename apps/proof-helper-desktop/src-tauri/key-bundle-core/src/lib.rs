use blake2::{
    digest::{Update as BlakeUpdate, VariableOutput},
    Blake2bVar,
};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest as ShaDigest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const KEY_VERSION: &str = "ownership-destination-v1";
pub const CIRCUIT_ID: &str = "root-ownership-destination-v1/bls12-381/groth16";
pub const MANIFEST_FILE: &str = "manifest.json";
pub const MANIFEST_SIGNATURE_FILE: &str = "manifest.sig";
pub const PROVING_KEY_FILE: &str = "ownership.pk";
pub const VERIFYING_KEY_FILE: &str = "ownership.vk";

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct KeyManifest {
    pub schema: String,
    pub key_version: String,
    pub circuit_id: String,
    pub curve: String,
    pub backend: String,
    pub vk_hash: String,
    pub proving_key_sha256: String,
    pub proving_key_blake2b256: String,
    pub proving_key_size: u64,
    pub verifying_key_sha256: String,
    pub verifying_key_size: u64,
    pub signature_key_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BundleInspection {
    pub state: String,
    pub ready: bool,
    pub key_version: Option<String>,
    pub vk_hash: Option<String>,
    pub circuit_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct InstallRequest {
    pub source_dir: PathBuf,
    pub active_dir: PathBuf,
    pub downloading_dir: PathBuf,
    pub trusted_manifest_public_key_hex: String,
    pub expected_signature_key_id: String,
    pub min_free_bytes: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct InstallOutcome {
    pub manifest: KeyManifest,
    pub active_dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InstallProgress {
    pub file_name: String,
    pub copied_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone)]
pub struct FileDigest {
    pub sha256: String,
    pub blake2b256: String,
    pub size: u64,
}

pub fn inspect_active_bundle(active_dir: &Path) -> BundleInspection {
    if !active_dir.exists() {
        return inspection(
            "missing",
            false,
            None,
            Some("key bundle is not installed".to_string()),
        );
    }
    let manifest_path = active_dir.join(MANIFEST_FILE);
    let pk_path = active_dir.join(PROVING_KEY_FILE);
    let vk_path = active_dir.join(VERIFYING_KEY_FILE);
    let sig_path = active_dir.join(MANIFEST_SIGNATURE_FILE);
    if !manifest_path.exists() || !pk_path.exists() || !vk_path.exists() || !sig_path.exists() {
        return inspection(
            "invalid",
            false,
            None,
            Some("key bundle is incomplete".to_string()),
        );
    }
    let manifest = match read_manifest(&manifest_path) {
        Ok(value) => value,
        Err(err) => return inspection("invalid", false, None, Some(err)),
    };
    if let Err(err) = validate_manifest_metadata(&manifest) {
        return inspection("invalid", false, Some(manifest), Some(err));
    }
    if let Err(err) = validate_key_files(&manifest, &pk_path, &vk_path) {
        return inspection("invalid", false, Some(manifest), Some(err));
    }
    inspection("ready", true, Some(manifest), None)
}

pub fn install_bundle(request: &InstallRequest) -> Result<InstallOutcome, String> {
    install_bundle_with_progress(request, |_| Ok(()))
}

pub fn install_bundle_with_progress<F>(
    request: &InstallRequest,
    mut on_progress: F,
) -> Result<InstallOutcome, String>
where
    F: FnMut(InstallProgress) -> Result<(), String>,
{
    if let Some(required) = request.min_free_bytes {
        ensure_space_available(request.active_dir.parent(), required)?;
    }

    let manifest_path = request.source_dir.join(MANIFEST_FILE);
    let sig_path = request.source_dir.join(MANIFEST_SIGNATURE_FILE);
    let pk_path = request.source_dir.join(PROVING_KEY_FILE);
    let vk_path = request.source_dir.join(VERIFYING_KEY_FILE);

    let manifest_bytes = fs::read(&manifest_path).map_err(|err| format!("read manifest: {err}"))?;
    let manifest: KeyManifest =
        serde_json::from_slice(&manifest_bytes).map_err(|err| format!("parse manifest: {err}"))?;
    validate_manifest_metadata(&manifest)?;
    if manifest.signature_key_id != request.expected_signature_key_id {
        return Err(format!(
            "manifest signature key id {:?}, want {:?}",
            manifest.signature_key_id, request.expected_signature_key_id
        ));
    }
    verify_manifest_signature(
        &manifest_bytes,
        &fs::read_to_string(&sig_path).map_err(|err| format!("read manifest signature: {err}"))?,
        &request.trusted_manifest_public_key_hex,
    )?;
    validate_key_files(&manifest, &pk_path, &vk_path)?;

    if request.downloading_dir.exists() {
        fs::remove_dir_all(&request.downloading_dir)
            .map_err(|err| format!("remove stale temporary key bundle: {err}"))?;
    }
    fs::create_dir_all(&request.downloading_dir)
        .map_err(|err| format!("create temporary key bundle directory: {err}"))?;

    if let Err(err) = stage_bundle_files(
        request,
        &manifest_path,
        &sig_path,
        &pk_path,
        &vk_path,
        &mut on_progress,
    ) {
        let _ = fs::remove_dir_all(&request.downloading_dir);
        return Err(err);
    }

    let tmp_manifest = request.downloading_dir.join(MANIFEST_FILE);
    let tmp_sig = request.downloading_dir.join(MANIFEST_SIGNATURE_FILE);
    let tmp_pk = request.downloading_dir.join(PROVING_KEY_FILE);
    let tmp_vk = request.downloading_dir.join(VERIFYING_KEY_FILE);
    let tmp_manifest_bytes =
        fs::read(&tmp_manifest).map_err(|err| format!("read temporary manifest: {err}"))?;
    verify_manifest_signature(
        &tmp_manifest_bytes,
        &fs::read_to_string(&tmp_sig)
            .map_err(|err| format!("read temporary manifest signature: {err}"))?,
        &request.trusted_manifest_public_key_hex,
    )?;
    validate_key_files(&manifest, &tmp_pk, &tmp_vk)?;

    if request.active_dir.exists() {
        fs::remove_dir_all(&request.active_dir)
            .map_err(|err| format!("remove existing active key bundle: {err}"))?;
    }
    if let Some(parent) = request.active_dir.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("create key cache root: {err}"))?;
    }
    fs::rename(&request.downloading_dir, &request.active_dir)
        .map_err(|err| format!("activate key bundle: {err}"))?;

    Ok(InstallOutcome {
        manifest,
        active_dir: request.active_dir.clone(),
    })
}

fn stage_bundle_files<F>(
    request: &InstallRequest,
    manifest_path: &Path,
    sig_path: &Path,
    pk_path: &Path,
    vk_path: &Path,
    on_progress: &mut F,
) -> Result<(), String>
where
    F: FnMut(InstallProgress) -> Result<(), String>,
{
    copy_file_with_progress(
        MANIFEST_FILE,
        manifest_path,
        &request.downloading_dir.join(MANIFEST_FILE),
        on_progress,
    )?;
    copy_file_with_progress(
        MANIFEST_SIGNATURE_FILE,
        sig_path,
        &request.downloading_dir.join(MANIFEST_SIGNATURE_FILE),
        on_progress,
    )?;
    copy_file_with_progress(
        PROVING_KEY_FILE,
        pk_path,
        &request.downloading_dir.join(PROVING_KEY_FILE),
        on_progress,
    )?;
    copy_file_with_progress(
        VERIFYING_KEY_FILE,
        vk_path,
        &request.downloading_dir.join(VERIFYING_KEY_FILE),
        on_progress,
    )
}

pub fn delete_cache(active_dir: &Path, downloading_dir: &Path) -> Result<(), String> {
    if active_dir.exists() {
        fs::remove_dir_all(active_dir).map_err(|err| format!("delete active key cache: {err}"))?;
    }
    if downloading_dir.exists() {
        fs::remove_dir_all(downloading_dir)
            .map_err(|err| format!("delete temporary key cache: {err}"))?;
    }
    Ok(())
}

pub fn digest_file(path: &Path) -> Result<FileDigest, String> {
    let mut file = File::open(path).map_err(|err| format!("open {}: {err}", path.display()))?;
    let mut sha = Sha256::new();
    let mut blake = Blake2bVar::new(32).map_err(|err| format!("create blake2b digest: {err}"))?;
    let mut buf = [0_u8; 64 * 1024];
    let mut size = 0_u64;
    loop {
        let read = file
            .read(&mut buf)
            .map_err(|err| format!("read {}: {err}", path.display()))?;
        if read == 0 {
            break;
        }
        ShaDigest::update(&mut sha, &buf[..read]);
        BlakeUpdate::update(&mut blake, &buf[..read]);
        size += read as u64;
    }
    let mut blake_out = [0_u8; 32];
    blake
        .finalize_variable(&mut blake_out)
        .map_err(|err| format!("finalize blake2b digest: {err}"))?;
    Ok(FileDigest {
        sha256: format!("sha256:{}", hex::encode(sha.finalize())),
        blake2b256: format!("blake2b256:{}", hex::encode(blake_out)),
        size,
    })
}

pub fn verify_manifest_signature(
    manifest_bytes: &[u8],
    signature_hex: &str,
    public_key_hex: &str,
) -> Result<(), String> {
    let public_key_bytes = hex::decode(public_key_hex.trim())
        .map_err(|err| format!("decode manifest public key: {err}"))?;
    let public_key: [u8; 32] = public_key_bytes
        .try_into()
        .map_err(|_| "manifest public key must be 32 bytes".to_string())?;
    let verifying_key = VerifyingKey::from_bytes(&public_key)
        .map_err(|err| format!("manifest public key: {err}"))?;

    let signature_bytes = hex::decode(signature_hex.trim())
        .map_err(|err| format!("decode manifest signature: {err}"))?;
    let signature: [u8; 64] = signature_bytes
        .try_into()
        .map_err(|_| "manifest signature must be 64 bytes".to_string())?;
    let signature = Signature::from_bytes(&signature);
    verifying_key
        .verify(manifest_bytes, &signature)
        .map_err(|_| "manifest signature did not verify".to_string())
}

fn read_manifest(path: &Path) -> Result<KeyManifest, String> {
    let bytes = fs::read(path).map_err(|err| format!("read manifest: {err}"))?;
    serde_json::from_slice(&bytes).map_err(|err| format!("parse manifest: {err}"))
}

fn validate_manifest_metadata(manifest: &KeyManifest) -> Result<(), String> {
    if manifest.schema != "proof-tool-key-manifest-v1" {
        return Err(format!(
            "manifest schema {:?} is not supported",
            manifest.schema
        ));
    }
    if manifest.key_version != KEY_VERSION {
        return Err(format!(
            "manifest key version {:?}, want {:?}",
            manifest.key_version, KEY_VERSION
        ));
    }
    if manifest.circuit_id != CIRCUIT_ID {
        return Err(format!(
            "manifest circuit id {:?}, want {:?}",
            manifest.circuit_id, CIRCUIT_ID
        ));
    }
    if manifest.curve != "BLS12-381" {
        return Err(format!(
            "manifest curve {:?}, want BLS12-381",
            manifest.curve
        ));
    }
    if manifest.backend != "groth16" {
        return Err(format!(
            "manifest backend {:?}, want groth16",
            manifest.backend
        ));
    }
    if manifest.vk_hash.trim().is_empty() {
        return Err("manifest vk_hash is required".to_string());
    }
    if manifest.proving_key_size == 0 || manifest.verifying_key_size == 0 {
        return Err("manifest key sizes must be nonzero".to_string());
    }
    if manifest.signature_key_id.trim().is_empty() {
        return Err("manifest signature_key_id is required".to_string());
    }
    Ok(())
}

fn validate_key_files(
    manifest: &KeyManifest,
    pk_path: &Path,
    vk_path: &Path,
) -> Result<(), String> {
    let pk = digest_file(pk_path)?;
    if pk.sha256 != manifest.proving_key_sha256 {
        return Err(format!(
            "proving key sha256 mismatch: manifest {}, file {}",
            manifest.proving_key_sha256, pk.sha256
        ));
    }
    if pk.blake2b256 != manifest.proving_key_blake2b256 {
        return Err(format!(
            "proving key blake2b256 mismatch: manifest {}, file {}",
            manifest.proving_key_blake2b256, pk.blake2b256
        ));
    }
    if pk.size != manifest.proving_key_size {
        return Err(format!(
            "proving key size mismatch: manifest {}, file {}",
            manifest.proving_key_size, pk.size
        ));
    }

    let vk = digest_file(vk_path)?;
    if vk.sha256 != manifest.verifying_key_sha256 {
        return Err(format!(
            "verifying key sha256 mismatch: manifest {}, file {}",
            manifest.verifying_key_sha256, vk.sha256
        ));
    }
    if vk.blake2b256 != manifest.vk_hash {
        return Err(format!(
            "verifying key hash mismatch: manifest {}, file {}",
            manifest.vk_hash, vk.blake2b256
        ));
    }
    if vk.size != manifest.verifying_key_size {
        return Err(format!(
            "verifying key size mismatch: manifest {}, file {}",
            manifest.verifying_key_size, vk.size
        ));
    }
    Ok(())
}

fn copy_file_with_progress<F>(
    file_name: &'static str,
    from: &Path,
    to: &Path,
    on_progress: &mut F,
) -> Result<(), String>
where
    F: FnMut(InstallProgress) -> Result<(), String>,
{
    let mut src = File::open(from).map_err(|err| format!("open {}: {err}", from.display()))?;
    let mut dst = File::create(to).map_err(|err| format!("create {}: {err}", to.display()))?;
    let total_bytes = src
        .metadata()
        .map_err(|err| format!("stat {}: {err}", from.display()))?
        .len();
    let mut buf = [0_u8; 64 * 1024];
    let mut copied_bytes = 0_u64;
    loop {
        let read = src
            .read(&mut buf)
            .map_err(|err| format!("read {}: {err}", from.display()))?;
        if read == 0 {
            break;
        }
        dst.write_all(&buf[..read])
            .map_err(|err| format!("write {}: {err}", to.display()))?;
        copied_bytes += read as u64;
        on_progress(InstallProgress {
            file_name: file_name.to_string(),
            copied_bytes,
            total_bytes,
        })
        .map_err(|err| format!("stage {file_name}: {err}"))?;
    }
    if total_bytes == 0 {
        on_progress(InstallProgress {
            file_name: file_name.to_string(),
            copied_bytes: 0,
            total_bytes: 0,
        })
        .map_err(|err| format!("stage {file_name}: {err}"))?;
    }
    dst.flush()
        .map_err(|err| format!("flush {}: {err}", to.display()))
}

fn ensure_space_available(_path: Option<&Path>, required: u64) -> Result<(), String> {
    if required == 0 {
        return Err("minimum free space must be greater than zero".to_string());
    }
    let Some(path) = _path else {
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

fn inspection(
    state: &str,
    ready: bool,
    manifest: Option<KeyManifest>,
    error: Option<String>,
) -> BundleInspection {
    BundleInspection {
        state: state.to_string(),
        ready,
        key_version: manifest.as_ref().map(|value| value.key_version.clone()),
        vk_hash: manifest.as_ref().map(|value| value.vk_hash.clone()),
        circuit_id: manifest.as_ref().map(|value| value.circuit_id.clone()),
        error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use tempfile::TempDir;

    const SIGNING_KEY_BYTES: [u8; 32] = [7; 32];
    const SIGNATURE_KEY_ID: &str = "test-signer";

    #[test]
    fn installs_valid_bundle_atomically() {
        let fixture = Fixture::new();
        let outcome = install_bundle(&fixture.request()).expect("install bundle");
        assert_eq!(outcome.manifest.key_version, KEY_VERSION);
        assert!(fixture.active_dir().join(MANIFEST_FILE).exists());
        assert!(fixture.active_dir().join(PROVING_KEY_FILE).exists());
        assert!(!fixture.downloading_dir().exists());

        let status = inspect_active_bundle(&fixture.active_dir());
        assert!(status.ready);
        assert_eq!(status.state, "ready");
    }

    #[test]
    fn reports_staging_progress_for_each_bundle_file() {
        let fixture = Fixture::new();
        let mut events = Vec::new();
        install_bundle_with_progress(&fixture.request(), |progress| {
            events.push(progress);
            Ok(())
        })
        .expect("install bundle");

        assert_final_progress(
            &events,
            MANIFEST_FILE,
            &fixture.source_dir().join(MANIFEST_FILE),
        );
        assert_final_progress(
            &events,
            MANIFEST_SIGNATURE_FILE,
            &fixture.source_dir().join(MANIFEST_SIGNATURE_FILE),
        );
        assert_final_progress(
            &events,
            PROVING_KEY_FILE,
            &fixture.source_dir().join(PROVING_KEY_FILE),
        );
        assert_final_progress(
            &events,
            VERIFYING_KEY_FILE,
            &fixture.source_dir().join(VERIFYING_KEY_FILE),
        );
    }

    #[test]
    fn cancellation_during_staging_removes_temporary_bundle_and_preserves_active() {
        let fixture = Fixture::new();
        install_bundle(&fixture.request()).expect("initial install");

        let err = install_bundle_with_progress(&fixture.request(), |progress| {
            if progress.file_name == PROVING_KEY_FILE && progress.copied_bytes > 0 {
                return Err("cancelled by user".to_string());
            }
            Ok(())
        })
        .unwrap_err();

        assert!(err.contains("cancelled by user"));
        assert!(!fixture.downloading_dir().exists());
        let status = inspect_active_bundle(&fixture.active_dir());
        assert!(status.ready);
        assert_eq!(status.state, "ready");
    }

    #[test]
    fn rejects_wrong_manifest_signature() {
        let fixture = Fixture::new();
        fs::write(fixture.source_dir().join(MANIFEST_SIGNATURE_FILE), "00").unwrap();
        let err = install_bundle(&fixture.request()).unwrap_err();
        assert!(err.contains("manifest signature"));
        assert!(!fixture.active_dir().exists());
    }

    #[test]
    fn rejects_corrupt_proving_key_before_activation() {
        let fixture = Fixture::new();
        fs::write(fixture.source_dir().join(PROVING_KEY_FILE), b"corrupt").unwrap();
        let err = install_bundle(&fixture.request()).unwrap_err();
        assert!(err.contains("proving key"));
        assert!(!fixture.active_dir().exists());
    }

    #[test]
    fn rejects_wrong_signature_key_id() {
        let fixture = Fixture::new();
        let mut request = fixture.request();
        request.expected_signature_key_id = "other-signer".to_string();
        let err = install_bundle(&request).unwrap_err();
        assert!(err.contains("signature key id"));
        assert!(!fixture.active_dir().exists());
    }

    #[test]
    fn rejects_insufficient_disk_space_before_activation() {
        let fixture = Fixture::new();
        let mut request = fixture.request();
        request.min_free_bytes = Some(u64::MAX);
        let err = install_bundle(&request).unwrap_err();
        assert!(err.contains("not enough disk space"));
        assert!(!fixture.active_dir().exists());
    }

    #[test]
    fn delete_cache_removes_active_and_temporary_dirs() {
        let fixture = Fixture::new();
        install_bundle(&fixture.request()).expect("install bundle");
        fs::create_dir_all(fixture.downloading_dir()).unwrap();
        fs::write(fixture.downloading_dir().join("partial"), b"partial").unwrap();
        delete_cache(&fixture.active_dir(), &fixture.downloading_dir()).expect("delete cache");
        assert!(!fixture.active_dir().exists());
        assert!(!fixture.downloading_dir().exists());
        let status = inspect_active_bundle(&fixture.active_dir());
        assert_eq!(status.state, "missing");
    }

    fn assert_final_progress(events: &[InstallProgress], file_name: &str, source_path: &Path) {
        let want_size = fs::metadata(source_path).unwrap().len();
        let last = events
            .iter()
            .rev()
            .find(|event| event.file_name == file_name)
            .unwrap_or_else(|| panic!("missing progress for {file_name}"));
        assert_eq!(last.copied_bytes, want_size, "{file_name} copied bytes");
        assert_eq!(last.total_bytes, want_size, "{file_name} total bytes");
    }

    struct Fixture {
        tmp: TempDir,
        public_key_hex: String,
    }

    impl Fixture {
        fn new() -> Self {
            let tmp = TempDir::new().unwrap();
            let source_dir = tmp.path().join("source");
            fs::create_dir_all(&source_dir).unwrap();
            fs::write(source_dir.join(PROVING_KEY_FILE), b"test proving key").unwrap();
            fs::write(source_dir.join(VERIFYING_KEY_FILE), b"test verifying key").unwrap();

            let pk_digest = digest_file(&source_dir.join(PROVING_KEY_FILE)).unwrap();
            let vk_digest = digest_file(&source_dir.join(VERIFYING_KEY_FILE)).unwrap();
            let manifest = KeyManifest {
                schema: "proof-tool-key-manifest-v1".to_string(),
                key_version: KEY_VERSION.to_string(),
                circuit_id: CIRCUIT_ID.to_string(),
                curve: "BLS12-381".to_string(),
                backend: "groth16".to_string(),
                vk_hash: vk_digest.blake2b256,
                proving_key_sha256: pk_digest.sha256,
                proving_key_blake2b256: pk_digest.blake2b256,
                proving_key_size: pk_digest.size,
                verifying_key_sha256: vk_digest.sha256,
                verifying_key_size: vk_digest.size,
                signature_key_id: SIGNATURE_KEY_ID.to_string(),
            };
            let manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
            fs::write(source_dir.join(MANIFEST_FILE), &manifest_bytes).unwrap();

            let signing_key = SigningKey::from_bytes(&SIGNING_KEY_BYTES);
            let signature = signing_key.sign(&manifest_bytes);
            fs::write(
                source_dir.join(MANIFEST_SIGNATURE_FILE),
                hex::encode(signature.to_bytes()),
            )
            .unwrap();

            Self {
                tmp,
                public_key_hex: hex::encode(signing_key.verifying_key().to_bytes()),
            }
        }

        fn request(&self) -> InstallRequest {
            InstallRequest {
                source_dir: self.source_dir(),
                active_dir: self.active_dir(),
                downloading_dir: self.downloading_dir(),
                trusted_manifest_public_key_hex: self.public_key_hex.clone(),
                expected_signature_key_id: SIGNATURE_KEY_ID.to_string(),
                min_free_bytes: Some(1),
            }
        }

        fn source_dir(&self) -> PathBuf {
            self.tmp.path().join("source")
        }

        fn active_dir(&self) -> PathBuf {
            self.tmp.path().join("cache").join("active")
        }

        fn downloading_dir(&self) -> PathBuf {
            self.tmp.path().join("cache").join("downloading.tmp")
        }
    }
}
