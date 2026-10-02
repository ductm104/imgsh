use serde::Serialize;
#[cfg(target_os = "macos")]
use tauri::Manager;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const REMOTE_DIR: &str = "/tmp/imgsh";

#[derive(Debug, Serialize, Clone)]
struct SshHost {
    alias: String,
    hostname: String,
    user: String,
    port: String,
}

#[derive(Debug, Serialize, Clone)]
struct RemoteFile {
    name: String,
    is_dir: bool,
    size: u64,
    modified: String,
}

fn ssh_config_path() -> PathBuf {
    dirs_home().join(".ssh").join("config")
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
}

fn sanitize_filename(name: &str) -> String {
    let base = name.rsplit('/').next().unwrap_or(name);
    let base = base.rsplit('\\').next().unwrap_or(base);
    let clean: String = base
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ' | '(' | ')') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let clean = clean.trim().to_string();
    if clean.is_empty() || clean == "." || clean == ".." {
        unique_image_name("png")
    } else {
        clean
    }
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// UTC timestamp `YYYYMMDD-HHMMSS-mmm` for filename convention (no deps).
fn utc_stamp() -> String {
    let ms_total = now_millis();
    let secs = (ms_total / 1000) as i64;
    let ms = (ms_total % 1000) as i64;
    // Howard Hinnant's civil_from_days
    let z = secs.div_euclid(86400) + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    let sod = secs.rem_euclid(86400);
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}-{:03}",
        y,
        m,
        d,
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60,
        ms
    )
}

fn unique_image_name(ext: &str) -> String {
    format!("imgsh-{}.{}", utc_stamp(), ext)
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn remote_exists(alias: &str, name: &str) -> bool {
    let remote = format!("{}/{}", REMOTE_DIR, name);
    let cmd = format!("test -e {}", shell_quote(&remote));
    let args = ssh_base_args(alias, &cmd);
    Command::new("ssh")
        .args(&args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Split `name.tar.gz` -> ("name.tar", "gz").
fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 && i < name.len() - 1 => (&name[..i], &name[i + 1..]),
        _ => (name, ""),
    }
}

/// Return a filename guaranteed not to exist in remote /tmp/imgsh/.
/// `photo.png` -> `photo.png`, or `photo-2.png`, `photo-3.png`, ...
fn unique_remote_name(alias: &str, desired: &str) -> String {
    let clean = sanitize_filename(desired);
    if !remote_exists(alias, &clean) {
        return clean;
    }
    let (stem, ext) = split_ext(&clean);
    for n in 2..=1000 {
        let candidate = if ext.is_empty() {
            format!("{}-{}", stem, n)
        } else {
            format!("{}-{}.{}", stem, n, ext)
        };
        if !remote_exists(alias, &candidate) {
            return candidate;
        }
    }
    // practically unreachable; fall back to timestamp
    unique_image_name(split_ext(&clean).1)
}

#[tauri::command]
fn list_ssh_hosts() -> Result<Vec<SshHost>, String> {
    let path = ssh_config_path();
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read {}: {}", path.display(), e))?;

    // Parse config into blocks: Host <names> followed by keys until next Host
    let mut blocks: Vec<(Vec<String>, HashMap<String, String>)> = vec![];
    let mut cur_names: Option<Vec<String>> = None;
    let mut cur_map: HashMap<String, String> = HashMap::new();

    let flush = |names: &Option<Vec<String>>,
                 map: &HashMap<String, String>,
                 out: &mut Vec<(Vec<String>, HashMap<String, String>)>| {
        if let Some(n) = names {
            out.push((n.clone(), map.clone()));
        }
    };

    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // split key / value (key + whitespace/= + value)
        let mut parts = line.splitn(2, |c: char| c == ' ' || c == '\t' || c == '=');
        let key = parts.next().unwrap_or("").trim().to_lowercase();
        let val = parts.next().unwrap_or("").trim().trim_matches('"').to_string();
        if key == "host" {
            flush(&cur_names, &cur_map, &mut blocks);
            let names: Vec<String> = val.split_whitespace().map(|s| s.to_string()).collect();
            cur_names = Some(names);
            cur_map = HashMap::new();
        } else if cur_names.is_some() && !key.is_empty() {
            cur_map.entry(key).or_insert(val);
        }
    }
    flush(&cur_names, &cur_map, &mut blocks);

    let mut hosts = vec![];
    for (names, map) in blocks {
        for alias in names {
            if alias.contains('*') || alias.contains('?') || alias.contains('!') {
                continue;
            }
            let hostname = map
                .get("hostname")
                .cloned()
                .unwrap_or_else(|| alias.clone());
            let user = map.get("user").cloned().unwrap_or_default();
            let port = map.get("port").cloned().unwrap_or_else(|| "22".into());
            hosts.push(SshHost {
                alias,
                hostname,
                user,
                port,
            });
        }
    }
    hosts.sort_by(|a, b| a.alias.cmp(&b.alias));
    Ok(hosts)
}

#[tauri::command]
async fn check_host(alias: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || check_host_blocking(&alias))
        .await
        .map_err(|e| format!("SSH connection task failed: {e}"))?
}

fn check_host_blocking(alias: &str) -> Result<bool, String> {
    // Warms the shared ControlMaster so the first open reuses it.
    let args = ssh_base_args(alias, "echo ok");
    let out = Command::new("ssh")
        .args(&args)
        .output()
        .map_err(|e| format!("failed to run ssh: {}", e))?;
    Ok(out.status.success())
}

fn ssh_base_args(alias: &str, remote_cmd: &str) -> Vec<String> {
    vec![
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "ConnectTimeout=5".into(),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        // Reuse one TCP/auth handshake for 10m: opens reuse it, ~instant.
        "-o".into(),
        "ControlMaster=auto".into(),
        "-o".into(),
        "ControlPath=/tmp/imgsh-ssh-%r@%h:%p".into(),
        "-o".into(),
        "ControlPersist=10m".into(),
        alias.into(),
        remote_cmd.into(),
    ]
}

fn run_ssh_ls(alias: &str) -> Result<String, String> {
    // Single SSH connection: ensure dir, then GNU ls with BSD fallback
    // inside the same session (was 2-3 sequential ssh handshakes before).
    let remote_cmd = format!(
        "mkdir -p {d}; ls -la --time-style=long-iso -p {d} 2>/dev/null || ls -la -p {d}",
        d = REMOTE_DIR
    );
    let args = ssh_base_args(alias, &remote_cmd);
    let out = Command::new("ssh")
        .args(&args)
        .output()
        .map_err(|e| format!("ssh failed: {}", e))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).to_string());
    }
    Err(format!(
        "ls failed: {}",
        String::from_utf8_lossy(&out.stderr)
    ))
}

fn parse_ls(output: &str) -> Vec<RemoteFile> {
    let mut files = vec![];
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("total") {
            continue;
        }
        // GNU: perms links owner group size date time name...
        // BSD fallback: perms links owner group size mon day time name...
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 8 {
            continue;
        }
        let perms = parts[0];
        let size: u64 = parts[4].parse().unwrap_or(0);
        // GNU long-iso date contains '-', BSD mon does not.
        let (modified, name_start) = if parts[5].contains('-') {
            (format!("{} {}", parts[5], parts[6]), 7)
        } else {
            if parts.len() < 9 {
                continue;
            }
            (format!("{} {}", parts[5], parts[6]), 8)
        };
        let mut name = parts[name_start..].join(" ");
        // handle symlink "name -> target"
        if let Some(idx) = name.find(" -> ") {
            name = name[..idx].to_string();
        }
        if name == "." || name == "./" || name == ".." || name == "../" {
            continue;
        }
        let is_dir = perms.starts_with('d') || name.ends_with('/');
        let name = name.trim_end_matches('/').to_string();
        files.push(RemoteFile {
            name,
            is_dir,
            size,
            modified,
        });
    }
    files.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        // latest first: timestamped imgsh names sort newest-first descending
        _ => b.name.to_lowercase().cmp(&a.name.to_lowercase()),
    });
    files
}

#[tauri::command]
async fn list_remote_files(alias: String) -> Result<Vec<RemoteFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = run_ssh_ls(&alias)?;
        Ok(parse_ls(&out))
    })
    .await
    .map_err(|e| format!("SSH listing task failed: {e}"))?
}

#[tauri::command]
fn delete_remote_file(alias: String, name: String) -> Result<(), String> {
    let clean = sanitize_filename(&name);
    // quote path safely: only allow sanitized name
    let remote = format!("{}/{}", REMOTE_DIR, clean);
    let cmd = format!("rm -rf -- '{}'", remote.replace('\'', "'\\''"));
    let args = ssh_base_args(&alias, &cmd);
    let out = Command::new("ssh")
        .args(&args)
        .output()
        .map_err(|e| format!("ssh failed: {}", e))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

#[derive(Debug, Serialize, Clone)]
struct UploadResult {
    name: String,
    path: String,
    size: u64,
}

fn remote_file_size(alias: &str, remote_path: &str) -> Result<u64, String> {
    // GNU stat first, BSD stat fallback
    for fmt in ["stat -c%s", "stat -f%z"] {
        let cmd = format!("{} {}", fmt, shell_quote(remote_path));
        let args = ssh_base_args(alias, &cmd);
        let out = Command::new("ssh")
            .args(&args)
            .output()
            .map_err(|e| format!("ssh failed: {}", e))?;
        if out.status.success() {
            if let Ok(n) = String::from_utf8_lossy(&out.stdout).trim().parse::<u64>() {
                return Ok(n);
            }
        }
    }
    Err("cannot stat remote file after upload".into())
}

fn scp_to_remote(alias: &str, local: &std::path::Path, remote_name: &str) -> Result<UploadResult, String> {
    let mkdir_cmd = format!("mkdir -p {}", REMOTE_DIR);
    let mkdir_args = ssh_base_args(alias, &mkdir_cmd);
    let mkdir = Command::new("ssh")
        .args(&mkdir_args)
        .output()
        .map_err(|e| format!("ssh failed: {}", e))?;
    if !mkdir.status.success() {
        return Err(format!(
            "mkdir failed: {}",
            String::from_utf8_lossy(&mkdir.stderr)
        ));
    }
    let target = format!("{}:{}/{}", alias, REMOTE_DIR, remote_name);
    let out = Command::new("scp")
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=20",
            "-o",
            "ControlMaster=auto",
            "-o",
            "ControlPath=/tmp/imgsh-ssh-%r@%h:%p",
            "-o",
            "ControlPersist=10m",
            local.to_string_lossy().as_ref(),
            &target,
        ])
        .output()
        .map_err(|e| format!("scp failed: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "scp failed: {} {}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    // Verify the file really landed and is non-empty.
    let remote_path = format!("{}/{}", REMOTE_DIR, remote_name);
    let size = remote_file_size(alias, &remote_path)?;
    if size == 0 {
        return Err(format!("upload produced an empty file: {}", remote_path));
    }
    Ok(UploadResult {
        name: remote_name.to_string(),
        path: remote_path,
        size,
    })
}

#[tauri::command]
fn download_file(alias: String, name: String) -> Result<Vec<u8>, String> {
    let clean = sanitize_filename(&name);
    let remote = format!("{}/{}", REMOTE_DIR, clean);
    let source = format!("{}:{}", alias, remote);
    let tmp = std::env::temp_dir().join(format!("imgsh-dl-{}-{}", now_millis(), clean));
    let out = Command::new("scp")
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=20",
            "-o",
            "ControlMaster=auto",
            "-o",
            "ControlPath=/tmp/imgsh-ssh-%r@%h:%p",
            "-o",
            "ControlPersist=10m",
            &source,
            tmp.to_string_lossy().as_ref(),
        ])
        .output()
        .map_err(|e| format!("scp failed: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "download failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let len = std::fs::metadata(&tmp)
        .map(|m| m.len())
        .unwrap_or(0);
    if len > 30 * 1024 * 1024 {
        let _ = std::fs::remove_file(&tmp);
        return Err("file too large to preview (max 30MB)".into());
    }
    let bytes = std::fs::read(&tmp).map_err(|e| format!("read failed: {}", e))?;
    let _ = std::fs::remove_file(&tmp);
    Ok(bytes)
}

#[tauri::command]
fn upload_local_path(alias: String, local_path: String) -> Result<UploadResult, String> {
    let p = PathBuf::from(&local_path);
    if !p.exists() {
        return Err(format!("File not found: {}", local_path));
    }
    if p.is_dir() {
        return Err("Folders are not supported, only files.".into());
    }
    let fname = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| unique_image_name("bin"));
    let final_name = unique_remote_name(&alias, &fname);
    scp_to_remote(&alias, &p, &final_name)
}

#[tauri::command]
fn upload_bytes(alias: String, filename: String, data: Vec<u8>) -> Result<UploadResult, String> {
    if data.is_empty() {
        return Err("Empty data".into());
    }
    if data.len() > 200 * 1024 * 1024 {
        return Err("File too large (max 200MB)".into());
    }
    let ext_from_magic = if data.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        "png"
    } else if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "jpg"
    } else if data.starts_with(&[0x47, 0x49, 0x46]) {
        "gif"
    } else if data.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        "png"
    } else {
        "bin"
    };
    // Clipboard pastes usually arrive as image.png / without a name:
    // use timestamp convention so pastes never collide.
    let base = sanitize_filename(&filename);
    let is_generic = filename.trim().is_empty()
        || matches!(
            base.to_lowercase().as_str(),
            "image.png" | "image.jpg" | "image.jpeg" | "clipboard.png" | "paste.png"
        )
        || !base.contains('.');
    let desired = if is_generic {
        unique_image_name(ext_from_magic)
    } else {
        base
    };
    let fname = unique_remote_name(&alias, &desired);
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!("imgsh-{}-{}", ms, fname));
    std::fs::write(&tmp, &data).map_err(|e| format!("temp write failed: {}", e))?;
    let res = scp_to_remote(&alias, &tmp, &fname);
    let _ = std::fs::remove_file(&tmp);
    res
}

/// Stop all imgsh SSH ControlMaster background processes.
/// Sockets live in /tmp (see ControlPath in ssh_base_args).
/// Masters are intentionally NOT stopped on app quit: they idle-expire via
/// ControlPersist=10m so reopening the app within a few minutes reuses them.
fn stop_control_masters() -> usize {
    let tmp = PathBuf::from("/tmp");
    let entries = std::fs::read_dir(&tmp).map(|r| r.collect::<Vec<_>>()).unwrap_or_default();
    let mut stopped = 0;
    for e in entries {
        let Ok(entry) = e else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("imgsh-ssh-") {
            continue;
        }
        let sock = tmp.join(&name);
        let sock_arg = format!("ControlPath={}", sock.display());
        let ok = Command::new("ssh")
            .args(["-O", "exit", "-o", "ControlMaster=auto", "-o", &sock_arg, "x"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if ok {
            stopped += 1;
        }
    }
    stopped
}

#[tauri::command]
fn cleanup_masters() -> Result<usize, String> {
    Ok(stop_control_masters())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamp_format() {
        let s = utc_stamp();
        // YYYYMMDD-HHMMSS-mmm
        assert_eq!(s.len(), 19);
        assert_eq!(&s[8..9], "-");
        assert_eq!(&s[15..16], "-");
        assert!(s[..8].chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn ext_split() {
        assert_eq!(split_ext("photo.png"), ("photo", "png"));
        assert_eq!(split_ext("a.tar.gz"), ("a.tar", "gz"));
        assert_eq!(split_ext("noext"), ("noext", ""));
        assert_eq!(split_ext(".hidden"), (".hidden", ""));
    }

    #[test]
    fn sanitize() {
        assert_eq!(sanitize_filename("a/b\\c.png"), "c.png");
        assert_eq!(sanitize_filename("../x"), "x");
        assert_eq!(sanitize_filename("a:b*c"), "a_b_c");
        assert!(sanitize_filename("").starts_with("imgsh-"));
    }

    #[test]
    fn quote() {
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn parse_gnu_long_iso() {
        let out = "total 508\n\
drw-rw-r-- 2 midu midu 200 2026-10-01 09:31 ./\n\
-rw-r--r-- 1 midu midu 159555 2026-10-01 09:31 imgsh-20261001-023136-250.png\n\
-rw-r--r-- 1 midu midu 15118 2026-10-01 09:00 my photo.png\n";
        let files = parse_ls(out);
        assert_eq!(files.len(), 2);
        // latest first (name descending)
        assert_eq!(files[0].name, "my photo.png");
        assert_eq!(files[1].name, "imgsh-20261001-023136-250.png");
        assert_eq!(files[1].size, 159555);
        assert_eq!(files[1].modified, "2026-10-01 09:31");
    }

    #[test]
    fn parse_bsd_ls() {
        let out = "total 508\n\
-rw-r--r-- 1 midu midu 159555 Oct 1 09:31 imgsh-20261001-023136-250.png\n\
drwxr-xr-x 2 midu midu 200 Oct 1 09:31 subdir/\n";
        let files = parse_ls(out);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].name, "subdir");
        assert!(files[0].is_dir);
        assert_eq!(files[1].name, "imgsh-20261001-023136-250.png");
        assert_eq!(files[1].modified, "Oct 1");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Preserve the webview and its SSH/file state between Dock opens.
                // Only cancel closing if hiding succeeded.
                if window.hide().is_ok() {
                    api.prevent_close();
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (window, event);
        })
        .invoke_handler(tauri::generate_handler![
            list_ssh_hosts,
            check_host,
            list_remote_files,
            delete_remote_file,
            download_file,
            upload_local_path,
            upload_bytes,
            cleanup_masters
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(error) = window.show().and_then(|_| window.set_focus()) {
                        eprintln!("failed to reopen main window: {error}");
                    }
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
