# imgsh

Very simple macOS GUI: scan SSH remotes, show them as folders, paste or drag-drop
images/files to `scp` them to `/tmp/imgsh/` on the remote (created if needed).

## Stack

- Bun + Tauri 2 (Rust backend shells out to system `ssh` / `scp`, so your
  `~/.ssh/config`, keys and agent keep working)
- Plain HTML/CSS/JS frontend in `dist/` (no bundler)

## Install with Homebrew

macOS Apple Silicon:

```bash
brew install --cask ductm104/mytab/imgsh
```

Release downloads: https://github.com/ductm104/imgsh/releases

## Build from source

```bash
bun install
bun run dev      # dev window
bun run build    # .dmg in src-tauri/target/release/bundle/
```

## Use

1. Hosts are parsed from `~/.ssh/config` (`Host` entries, wildcards skipped).
   Green dot = reachable, orange = offline.
2. Click a folder to select the paste target, double-click to open `<alias>:/tmp/imgsh/`
   (remote dir is `mkdir -p`'d on open). Paste (⌘V) or drop files onto any folder.
3. After upload, the full path `<alias>:/tmp/imgsh/<file>` is shown in the
   "Uploaded" list and under each file — click to copy. Images can be previewed
   with the 👁 button (downloaded from the remote on demand).
3. Focus the folder, then **⌘V paste** a clipboard image/file, or **drag-drop**
   files from Finder onto it. Pasted images without a name become
   `imgsh-<timestamp>.png/jpg/...`.
4. Files can be deleted from the remote with the × button.

## Commands (Rust, `src-tauri/src/lib.rs`)

- `list_ssh_hosts` — parse `~/.ssh/config`
- `check_host` — `ssh -o BatchMode=yes ... echo ok`
- `list_remote_files` — `mkdir -p /tmp/imgsh; ls -la --time-style=long-iso -p /tmp/imgsh`
- `upload_local_path` / `upload_bytes` — `scp` to `<alias>:/tmp/imgsh/<file>`, then
  `stat` the remote file to verify size (0-byte uploads report an error).
  Pastes are named `imgsh-YYYYMMDD-HHMMSS-mmm.<ext>`; existing names get
  `-2`, `-3`, … suffixes so nothing is ever overwritten.
- `download_file` — `scp` remote → local temp for image preview (max 30MB).
- `delete_remote_file` — `rm -rf /tmp/imgsh/<file>`
