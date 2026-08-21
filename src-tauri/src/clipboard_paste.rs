//! What is on the clipboard that a prompt could use.
//!
//! Two different things arrive under one keystroke, and only one of them the
//! webview can see:
//!
//! * **Files copied in Explorer.** The clipboard holds `CF_HDROP`, a list of
//!   real paths. The webview is given `File` objects with no path at all — a
//!   deliberate browser restriction — so the paths have to be read here or not
//!   at all. Nothing is copied: the files already exist, and `grok` reads
//!   outside the working directory happily, so the path is the whole job.
//!
//! * **A screenshot.** There is no file behind it, only a bitmap. That is the
//!   one case with nothing to point at, so it is written out — to our own
//!   directory, never the user's project, which is only possible because the
//!   agent will read a path from anywhere.
//!
//! What the agent does with an image once it has the path is its own business,
//! and today the answer is "runs code on it": `read_file` refuses binary, and
//! grok falls back to a script. Worth knowing before expecting it to *look* at
//! a screenshot.

use std::path::PathBuf;

use base64::Engine;

/// Where pasted screenshots go: ours, so a paste never writes into a repo.
fn pasted_dir() -> PathBuf {
    crate::config::app_home().join("pasted")
}

/// Absolute paths of the files on the clipboard, newest copy first.
///
/// An empty list is the answer for "nothing, or nothing we can use" — a paste
/// with no files on the clipboard is the overwhelmingly common case, so it is
/// not an error.
#[cfg(windows)]
pub fn clipboard_file_paths() -> Vec<String> {
    use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
    use windows::Win32::System::Ole::CF_HDROP;
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

    /// Closes the clipboard however this function leaves.
    struct Clipboard;
    impl Drop for Clipboard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }

    let mut paths = Vec::new();
    unsafe {
        // Another process can hold the clipboard; that is a "not now", not a
        // failure worth reporting to someone who only pressed Ctrl+V.
        if OpenClipboard(None).is_err() {
            return paths;
        }
        let _guard = Clipboard;

        let Ok(handle) = GetClipboardData(CF_HDROP.0 as u32) else {
            return paths;
        };
        if handle.is_invalid() {
            return paths;
        }
        let drop_handle = HDROP(handle.0);

        // u32::MAX asks for the count rather than a name.
        let count = DragQueryFileW(drop_handle, u32::MAX, None);
        for index in 0..count {
            let len = DragQueryFileW(drop_handle, index, None);
            if len == 0 {
                continue;
            }
            // +1 for the terminator the API writes but does not count.
            let mut buffer = vec![0u16; len as usize + 1];
            let written = DragQueryFileW(drop_handle, index, Some(&mut buffer));
            if written == 0 {
                continue;
            }
            buffer.truncate(written as usize);
            paths.push(String::from_utf16_lossy(&buffer));
        }
    }
    paths
}

#[cfg(not(windows))]
pub fn clipboard_file_paths() -> Vec<String> {
    // The webview hands us the paths on platforms where it is allowed to.
    Vec::new()
}

/// The extension for an image the webview pasted, from its mime type.
///
/// A short allow-list rather than a general mapping: this names a file that an
/// agent is about to be pointed at, and a mime type is attacker-controlled in
/// the sense that it arrives from whatever produced the clipboard entry.
fn extension_for(mime: &str) -> &'static str {
    match mime.trim().to_ascii_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        _ => "png",
    }
}

/// Write a pasted bitmap out and answer with its path.
///
/// Only for clipboard data with no file behind it. Anything the user copied in
/// Explorer already has a path, and copying it again would leave them with two
/// files and no idea which one the agent read.
pub fn save_pasted_image(data_base64: &str, mime: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|e| format!("clipboard image is not valid base64: {e}"))?;
    if bytes.is_empty() {
        return Err("clipboard image is empty".into());
    }

    let dir = pasted_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    // Time first so the directory sorts the way a person reads it, then enough
    // of a uuid that two pastes in one second cannot collide.
    let stamp = crate::agent_runtime::now_unix_secs();
    let unique = uuid::Uuid::new_v4().to_string();
    let name = format!("{stamp}-{}.{}", &unique[..8], extension_for(mime));
    let path = dir.join(name);

    std::fs::write(&path, &bytes).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(path.display().to_string())
}

/// Biggest image the composer will show a thumbnail for.
///
/// A preview travels to the webview as a data URL, so it costs its own size
/// again in base64 and then sits in the DOM. Past this the chip shows the file
/// without a picture, which is a better trade than a composer that stutters
/// because someone attached a screenshot of a 5K display.
const PREVIEW_MAX_BYTES: u64 = 6 * 1024 * 1024;

/// True for the extensions a webview `<img>` can actually paint.
///
/// By extension, not by sniffing: this only decides whether to *try* a preview,
/// and a wrong guess costs a chip without a picture rather than anything worse.
fn looks_like_image(path: &std::path::Path) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "avif" | "ico"
    )
}

fn mime_for(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        _ => "image/png",
    }
}

/// A `data:` URL for an attached image, or `None` when there should be no
/// thumbnail — not an image, too big, or unreadable.
///
/// `None` is never an error the composer has to explain: the chip simply shows
/// the file by name, which is what a non-image attachment looks like anyway.
pub fn image_preview(path: &str) -> Option<String> {
    let path = std::path::Path::new(path);
    if !looks_like_image(path) {
        return None;
    }
    let size = std::fs::metadata(path).ok()?.len();
    if size == 0 || size > PREVIEW_MAX_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{};base64,{encoded}", mime_for(path)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_common_image_types_and_falls_back_to_png() {
        assert_eq!(extension_for("image/png"), "png");
        assert_eq!(extension_for("image/jpeg"), "jpg");
        assert_eq!(extension_for("IMAGE/JPEG"), "jpg");
        assert_eq!(extension_for(" image/webp "), "webp");
        // A clipboard entry can claim anything; the file still has to be one of
        // ours, and a screenshot is a png far more often than it is not.
        assert_eq!(extension_for("application/x-msdownload"), "png");
        assert_eq!(extension_for(""), "png");
    }

    #[test]
    fn refuses_something_that_is_not_an_image() {
        assert!(save_pasted_image("not base64!!", "image/png").is_err());
        assert!(save_pasted_image("", "image/png").is_err());
    }

    #[test]
    fn a_written_paste_lands_in_our_own_directory_not_a_project() {
        // 1x1 transparent png.
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        let path = save_pasted_image(png, "image/png").expect("write");
        let path = std::path::PathBuf::from(path);
        assert!(path.is_file());
        assert_eq!(path.parent(), Some(pasted_dir().as_path()));
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("png"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn only_paintable_extensions_get_a_thumbnail() {
        use std::path::Path;
        for yes in ["a.png", "b.JPG", "c.jpeg", "d.webp", "e.svg", "f.Gif"] {
            assert!(looks_like_image(Path::new(yes)), "{yes}");
        }
        for no in ["a.rs", "b.pdf", "c.zip", "noextension", "d.png.txt"] {
            assert!(!looks_like_image(Path::new(no)), "{no}");
        }
    }

    #[test]
    fn a_missing_or_oversized_file_simply_has_no_thumbnail() {
        // None is not an error the composer explains — the chip shows a name.
        assert!(image_preview(r"Z:\nowhere\gone.png").is_none());
        assert!(image_preview(r"Z:\nowhere\notes.txt").is_none());
    }

    #[test]
    fn an_image_on_disk_comes_back_as_a_data_url() {
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        let path = save_pasted_image(png, "image/png").expect("write");
        let url = image_preview(&path).expect("preview");
        assert!(url.starts_with("data:image/png;base64,"), "{url}");
        // The payload is the file, not a re-encode of something else.
        assert!(url.ends_with(png), "{url}");
        let _ = std::fs::remove_file(path);
    }

    #[cfg(windows)]
    #[test]
    fn asking_for_clipboard_files_never_panics() {
        // Whatever is on the clipboard while the suite runs, including nothing
        // and including another process holding it. Printed so the same test
        // doubles as the manual check: copy files, run with --nocapture.
        let paths = clipboard_file_paths();
        println!("clipboard holds {} file(s)", paths.len());
        for p in &paths {
            println!("   {p}");
        }
    }
}
