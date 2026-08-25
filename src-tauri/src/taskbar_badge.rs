//! Taskbar / dock badge for a turn that finished while you were looking away.
//!
//! Windows has no numeric badge API — `set_badge_count` is a no-op there —
//! so the number is drawn onto an overlay icon and applied with
//! `ITaskbarList3::SetOverlayIcon` (the top-right mark on the taskbar button).
//! macOS uses the dock count. Linux is a no-op.
//!
//! Count only moves when the main window is not focused (or is minimized);
//! focusing the window clears it. Completing a turn while you are already
//! watching the window does not badge: the timeline is the notice.

use parking_lot::Mutex;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager, UserAttentionType};

/// Shown on the overlay. Two digits is the most a 16×16 overlay can carry.
pub fn badge_label(count: u32) -> Option<String> {
    match count {
        0 => None,
        1..=99 => Some(count.to_string()),
        _ => Some("99".to_string()),
    }
}

pub fn on_turn_completed(app: &AppHandle) {
    if is_watching(app) {
        return;
    }
    let count = {
        let mut n = count().lock();
        *n = (*n).saturating_add(1).min(99);
        *n
    };
    schedule_paint(app, count);
}

pub fn clear(app: &AppHandle) {
    {
        let mut n = count().lock();
        if *n == 0 {
            return;
        }
        *n = 0;
    }
    schedule_paint(app, 0);
}

fn count() -> &'static Mutex<u32> {
    static COUNT: OnceLock<Mutex<u32>> = OnceLock::new();
    COUNT.get_or_init(|| Mutex::new(0))
}

fn is_watching(app: &AppHandle) -> bool {
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    let focused = window.is_focused().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    focused && !minimized
}

fn schedule_paint(app: &AppHandle, n: u32) {
    let handle = app.clone();
    if app.run_on_main_thread(move || paint(&handle, n)).is_err() {
        paint(app, n);
    }
}

fn paint(app: &AppHandle, n: u32) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    #[cfg(windows)]
    overlay::apply(&window, n);
    #[cfg(target_os = "macos")]
    {
        let value = if n == 0 { None } else { Some(i64::from(n)) };
        if let Err(error) = window.set_badge_count(value) {
            tracing::debug!("dock badge: {error}");
        }
    }
    let attention = if n == 0 {
        None
    } else {
        Some(UserAttentionType::Informational)
    };
    if let Err(error) = window.request_user_attention(attention) {
        tracing::debug!("taskbar attention: {error}");
    }
}

/// 3×5 digits, MSB is the left column.
const GLYPHS: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111],
    [0b010, 0b110, 0b010, 0b010, 0b111],
    [0b111, 0b001, 0b111, 0b100, 0b111],
    [0b111, 0b001, 0b111, 0b001, 0b111],
    [0b101, 0b101, 0b111, 0b001, 0b001],
    [0b111, 0b100, 0b111, 0b001, 0b111],
    [0b111, 0b100, 0b111, 0b101, 0b111],
    [0b111, 0b001, 0b001, 0b001, 0b001],
    [0b111, 0b101, 0b111, 0b101, 0b111],
    [0b111, 0b101, 0b111, 0b001, 0b111],
];

/// BGRA, top-down, `size × size`. Exported for tests.
pub fn render_badge(size: u32, label: &str) -> Vec<u8> {
    let size = size.max(12);
    let mut px = vec![0u8; (size * size * 4) as usize];
    let cx = (size as f32 - 1.0) * 0.5;
    let radius = size as f32 * 0.5 - 0.35;
    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 - cx;
            let dy = y as f32 - cx;
            let cover = (radius - (dx * dx + dy * dy).sqrt() + 0.5).clamp(0.0, 1.0);
            if cover <= 0.0 {
                continue;
            }
            let i = ((y * size + x) * 4) as usize;
            let a = (cover * 255.0).round() as u8;
            // Windows overlay convention: red disc, white numeral.
            px[i] = 35;
            px[i + 1] = 17;
            px[i + 2] = 232;
            px[i + 3] = a;
        }
    }

    let digits: Vec<u8> = label
        .bytes()
        .filter_map(|b| b.is_ascii_digit().then_some(b - b'0'))
        .collect();
    if digits.is_empty() {
        return px;
    }
    let n = digits.len() as u32;
    let gap = 1u32;
    let glyph_w = 3;
    let glyph_h = 5;
    let block_w = n * glyph_w + n.saturating_sub(1) * gap;
    let max_w = size.saturating_sub(4);
    let max_h = size.saturating_sub(4);
    let scale = (max_w / block_w).min(max_h / glyph_h).max(1);
    let draw_w = block_w * scale;
    let draw_h = glyph_h * scale;
    let ox = (size.saturating_sub(draw_w)) / 2;
    let oy = (size.saturating_sub(draw_h)) / 2;
    for (di, digit) in digits.iter().enumerate() {
        let glyph = GLYPHS[*digit as usize];
        let gx = ox + di as u32 * (glyph_w + gap) * scale;
        for row in 0..glyph_h {
            let bits = glyph[row as usize];
            for col in 0..glyph_w {
                if bits & (1 << (2 - col)) == 0 {
                    continue;
                }
                for sy in 0..scale {
                    for sx in 0..scale {
                        let x = gx + col * scale + sx;
                        let y = oy + row * scale + sy;
                        if x >= size || y >= size {
                            continue;
                        }
                        let i = ((y * size + x) * 4) as usize;
                        px[i] = 255;
                        px[i + 1] = 255;
                        px[i + 2] = 255;
                        px[i + 3] = 255;
                    }
                }
            }
        }
    }
    px
}

#[cfg(windows)]
mod overlay {
    use super::{badge_label, render_badge};
    use parking_lot::Mutex;
    use std::sync::OnceLock;
    use tauri::WebviewWindow;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{
        CreateBitmap, CreateDIBSection, DeleteObject, GetDC, ReleaseDC, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::Shell::{ITaskbarList3, TaskbarList};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateIconIndirect, DestroyIcon, HICON, ICONINFO,
    };

    fn overlay_icon() -> &'static Mutex<Option<isize>> {
        static ICON: OnceLock<Mutex<Option<isize>>> = OnceLock::new();
        ICON.get_or_init(|| Mutex::new(None))
    }

    pub fn apply(window: &WebviewWindow, count: u32) {
        let Ok(hwnd) = window.hwnd() else {
            return;
        };
        let hwnd = HWND(hwnd.0);
        let label = badge_label(count);
        let description = match count {
            0 => String::new(),
            1 => "1 completed turn".to_string(),
            n => format!("{n} completed turns"),
        };
        let icon = label.as_deref().and_then(|text| create_icon(hwnd, text));
        if let Err(error) = set_overlay(hwnd, icon, &description) {
            tracing::debug!("taskbar overlay: {error}");
            if let Some(handle) = icon {
                // Unused overlay: we created it and the shell did not take it.
                unsafe {
                    let _ = DestroyIcon(handle);
                }
            }
            return;
        }
        let previous = {
            let mut slot = overlay_icon().lock();
            let prev = *slot;
            *slot = icon.map(|h| h.0 as isize);
            prev
        };
        if let Some(old) = previous {
            // Replaced: the shell now holds `icon`, so the previous handle is ours.
            unsafe {
                let _ = DestroyIcon(HICON(old as *mut std::ffi::c_void));
            }
        }
    }

    fn overlay_px(hwnd: HWND) -> i32 {
        // hwnd is the live main window; DPI 0 falls back to 96.
        let dpi = unsafe { GetDpiForWindow(hwnd) };
        if dpi == 0 {
            return 16;
        }
        ((16 * dpi as i32) / 96).max(16)
    }

    fn create_icon(hwnd: HWND, label: &str) -> Option<HICON> {
        let size = overlay_px(hwnd);
        let pixels = render_badge(size as u32, label);
        unsafe { icon_from_bgra(size, &pixels) }
    }

    /// # Safety
    /// `pixels` must be `size × size` BGRA. GDI objects created here are
    /// destroyed before return; the returned icon is owned by the caller.
    unsafe fn icon_from_bgra(size: i32, pixels: &[u8]) -> Option<HICON> {
        if size <= 0 {
            return None;
        }
        let expected = (size as usize) * (size as usize) * 4;
        if pixels.len() != expected {
            return None;
        }

        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: size,
                biHeight: -size,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let screen = GetDC(None);
        if screen.is_invalid() {
            return None;
        }
        let mut bits = std::ptr::null_mut();
        let color = CreateDIBSection(Some(screen), &info, DIB_RGB_COLORS, &mut bits, None, 0);
        let _ = ReleaseDC(None, screen);
        let color = color.ok()?;
        if bits.is_null() {
            let _ = DeleteObject(color.into());
            return None;
        }
        std::ptr::copy_nonoverlapping(pixels.as_ptr(), bits.cast::<u8>(), pixels.len());

        let mask = CreateBitmap(size, size, 1, 1, None);
        if mask.is_invalid() {
            let _ = DeleteObject(color.into());
            return None;
        }

        let icon_info = ICONINFO {
            fIcon: true.into(),
            xHotspot: 0,
            yHotspot: 0,
            hbmMask: mask,
            hbmColor: color,
        };
        let icon = CreateIconIndirect(&icon_info).ok();
        let _ = DeleteObject(color.into());
        let _ = DeleteObject(mask.into());
        icon
    }

    fn set_overlay(
        hwnd: HWND,
        icon: Option<HICON>,
        description: &str,
    ) -> windows::core::Result<()> {
        unsafe {
            let taskbar: ITaskbarList3 =
                CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER)?;
            taskbar.HrInit()?;
            let mut wide: Vec<u16> = description.encode_utf16().collect();
            wide.push(0);
            taskbar.SetOverlayIcon(hwnd, icon.unwrap_or_default(), PCWSTR(wide.as_ptr()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{badge_label, render_badge};

    #[test]
    fn label_caps_at_two_digits() {
        assert_eq!(badge_label(0), None);
        assert_eq!(badge_label(1).as_deref(), Some("1"));
        assert_eq!(badge_label(9).as_deref(), Some("9"));
        assert_eq!(badge_label(12).as_deref(), Some("12"));
        assert_eq!(badge_label(99).as_deref(), Some("99"));
        assert_eq!(badge_label(100).as_deref(), Some("99"));
        assert_eq!(badge_label(u32::MAX).as_deref(), Some("99"));
    }

    #[test]
    fn disc_is_opaque_in_the_middle_and_empty_in_the_corner() {
        let px = render_badge(16, "1");
        assert_eq!(px.len(), 16 * 16 * 4);
        // Left of centre: inside the disc, outside the numeral.
        let rim = ((8 * 16 + 2) * 4) as usize;
        assert!(px[rim + 3] > 200, "disc body should be opaque");
        assert_eq!(&px[rim..rim + 3], &[35, 17, 232]);
        let corner = 0;
        assert_eq!(px[corner + 3], 0, "corner should stay transparent");
    }

    #[test]
    fn numeral_paints_white_pixels() {
        let px = render_badge(16, "8");
        let white = px
            .chunks_exact(4)
            .filter(|p| p == &[255, 255, 255, 255])
            .count();
        assert!(
            white > 10,
            "glyph 8 should cover a handful of pixels, got {white}"
        );
    }
}
