# imgsh

**Give terminal coding agents eyes — without a GUI on the remote machine.**

Coding agents such as [pi](https://github.com/badlogic/pi-mono), OpenCode,
Claude Code and Codex run in a terminal, often on a remote box over SSH. They
can read images, but only if the image file exists on the machine they run on.
Your screenshot lives on your laptop's clipboard, so you end up saving it,
running `scp` by hand and typing the path.

`imgsh` is a small desktop app that removes that friction:

1. Copy a screenshot or image (or drag a file) on your local machine.
2. Paste it into `imgsh` on the SSH host you want.
3. It is uploaded to `<host>:/tmp/imgsh/` and the full remote path is shown —
   click to copy, then paste the path into your agent's prompt.

It uses your system `ssh`/`scp`, so your `~/.ssh/config`, keys, agent and
ProxyJump setups just work. No daemon, no server component, nothing to install
on the remote.

> **Note:** this repository is 100% vibe-coded — every line of code, docs and CI
> config was written by AI coding agents, with no human-written code. Review it
> accordingly before trusting it with your SSH setup.

## Features

- Hosts are discovered automatically from `~/.ssh/config` and shown as folders,
  with a reachable / offline indicator.
- Paste (⌘V) clipboard images/files or drag-and-drop files onto a host.
- Unique names (`imgsh-YYYYMMDD-HHMMSS-mmm.png`); existing files are never
  overwritten.
- Uploads are verified on the remote (0-byte uploads are reported as errors).
- One-click copy of the remote path, image preview, and delete.

## Install (recommended)

macOS (Apple Silicon), via Homebrew:

```bash
brew install --cask ductm104/mytab/imgsh
```

Or download the latest `.dmg` (Apple Silicon or Intel) from the
[Releases page](https://github.com/ductm104/imgsh/releases), open it and drag
`imgsh` to Applications.

> The app is not notarized. If macOS refuses to open it, right-click → Open, or
> run `xattr -dr com.apple.quarantine /Applications/imgsh.app`.

## Usage

1. Make sure you can `ssh <alias>` without a password prompt (key or agent);
   `imgsh` runs `ssh` with `BatchMode=yes`.
2. Launch `imgsh`. Each `Host` in `~/.ssh/config` (wildcards skipped) appears
   as a folder.
3. Click a folder to select it as the paste target; double-click to open
   `<alias>:/tmp/imgsh/` (created with `mkdir -p` if missing).
4. Paste (⌘V) an image/file, or drag files from Finder onto the folder.
5. Click the uploaded entry to copy `/tmp/imgsh/<file>`, then give that path to
   your agent, e.g. *"look at /tmp/imgsh/imgsh-20250101-120000-123.png"*.

## Build and run locally

Requirements:

- macOS with the Xcode Command Line Tools (`xcode-select --install`)
- [Rust](https://rustup.rs) (stable)
- [Bun](https://bun.sh)

```bash
git clone https://github.com/ductm104/imgsh.git
cd imgsh
bun install

bun run dev        # run the app in development mode
bun run dev:hot    # same, with live reload for the frontend in dist/
bun run build      # production build -> src-tauri/target/release/bundle/
```

`bun run build` produces `imgsh.app` under `bundle/macos/` and a `.dmg` under
`bundle/dmg/`. To target another architecture, add the Rust target and pass it
through, e.g.
`rustup target add x86_64-apple-darwin && bun run build --target x86_64-apple-darwin`.

## Publishing a release

Releases are built by GitHub Actions (`.github/workflows/release.yml`) for
Apple Silicon and Intel. To cut one:

```bash
# bump "version" in package.json, src-tauri/tauri.conf.json and src-tauri/Cargo.toml
git commit -am "Release v0.1.0"
git tag v0.1.0
git push origin main v0.1.0
```

The workflow attaches the `.dmg` files to the GitHub release for that tag. Then
update the Homebrew cask in `ductm104/homebrew-mytab` with the new version and
checksum.

## How it works

Stack: Tauri 2 (Rust backend) + plain HTML/CSS/JS in `dist/` (no bundler),
managed with Bun. The Rust commands in `src-tauri/src/lib.rs` shell out to the
system `ssh`/`scp`:

- `list_ssh_hosts` — parse `~/.ssh/config`
- `check_host` — `ssh -o BatchMode=yes ... echo ok`
- `list_remote_files` — `mkdir -p /tmp/imgsh; ls -la ... /tmp/imgsh`
- `upload_local_path` / `upload_bytes` — `scp` to `<alias>:/tmp/imgsh/<file>`,
  then `stat` the remote file to verify its size
- `download_file` — `scp` remote → local temp for previews (max 30MB)
- `delete_remote_file` — `rm -rf /tmp/imgsh/<file>`
