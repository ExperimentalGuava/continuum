// GDI screen capture of the focused window + a cheap perceptual-hash change gate.
//
// We grab the focused window with PrintWindow(PW_RENDERFULLCONTENT) — which handles most
// DWM-composited windows — falling back to a screen BitBlt of the window rect. The frame is
// returned as top-down BGRA, ready for Windows.Media.Ocr.
//
// This is the macOS `screen.swift` analog. v2 can swap in Windows.Graphics.Capture for the
// GPU-composited surfaces (some hardware-accelerated Chrome content) that PrintWindow renders
// black; until then we accept that gap (the architecture treats OCR as best-effort anyway).
use std::ffi::c_void;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

pub struct Frame {
    pub w: u32,
    pub h: u32,
    pub bgra: Vec<u8>, // top-down, 4 bytes/px
}

// OcrEngine rejects images larger than its MaxImageDimension; clamp the longest side. Smaller
// also means faster OCR and a cheaper hash, at negligible accuracy cost for screen text.
const MAX_DIM: i32 = 2600;
const PW_RENDERFULLCONTENT: u32 = 0x0000_0002;

pub fn capture(hwnd: HWND) -> Option<Frame> {
    unsafe {
        let mut r = RECT::default();
        GetWindowRect(hwnd, &mut r).ok()?;
        let w = r.right - r.left;
        let h = r.bottom - r.top;
        if w <= 0 || h <= 0 {
            return None;
        }

        let screen = GetDC(None);
        let mem = HDC(CreateCompatibleDC(screen).0);
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp);

        let ok = PrintWindow(hwnd, mem, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool();
        if !ok {
            let _ = BitBlt(mem, 0, 0, w, h, screen, r.left, r.top, SRCCOPY);
        }

        // Downscale through a second DC (HALFTONE = decent quality) when the window is large.
        let scale = (MAX_DIM as f32 / w.max(h) as f32).min(1.0);
        let (fw, fh, read_dc, read_bmp, scratch) = if scale < 1.0 {
            let dw = ((w as f32) * scale) as i32;
            let dh = ((h as f32) * scale) as i32;
            let dc2 = HDC(CreateCompatibleDC(screen).0);
            let bmp2 = CreateCompatibleBitmap(screen, dw, dh);
            let old2 = SelectObject(dc2, bmp2);
            SetStretchBltMode(dc2, HALFTONE);
            let _ = StretchBlt(dc2, 0, 0, dw, dh, mem, 0, 0, w, h, SRCCOPY);
            (dw, dh, dc2, bmp2, Some((dc2, bmp2, old2)))
        } else {
            (w, h, mem, bmp, None)
        };

        let mut buf = vec![0u8; (fw * fh * 4) as usize];
        let mut bi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: fw,
                biHeight: -fh, // negative => top-down rows
                biPlanes: 1,
                biBitCount: 32,
                biCompression: 0, // BI_RGB
                ..Default::default()
            },
            ..Default::default()
        };
        GetDIBits(
            read_dc,
            read_bmp,
            0,
            fh as u32,
            Some(buf.as_mut_ptr() as *mut c_void),
            &mut bi,
            DIB_RGB_COLORS,
        );

        if let Some((dc2, bmp2, old2)) = scratch {
            SelectObject(dc2, old2);
            let _ = DeleteObject(bmp2);
            let _ = DeleteDC(dc2);
        }
        SelectObject(mem, old);
        let _ = DeleteObject(bmp);
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);

        Some(Frame {
            w: fw as u32,
            h: fh as u32,
            bgra: buf,
        })
    }
}

// 64-bit dHash: downsample to a 9x8 grayscale grid (center-sample per cell), then set a bit
// where a cell is brighter than its right neighbor. Robust to tiny pixel jitter — the Hamming
// gate in main.rs uses it to skip OCR when the window hasn't meaningfully changed.
pub fn dhash(f: &Frame) -> u64 {
    let (gw, gh) = (9usize, 8usize);
    let (w, h) = (f.w as usize, f.h as usize);
    if w == 0 || h == 0 {
        return 0;
    }
    let mut grid = [[0u32; 9]; 8];
    for gy in 0..gh {
        for gx in 0..gw {
            let px = ((gx * w) / gw + w / (2 * gw)).min(w - 1);
            let py = ((gy * h) / gh + h / (2 * gh)).min(h - 1);
            let i = (py * w + px) * 4;
            let b = f.bgra[i] as u32;
            let g = f.bgra[i + 1] as u32;
            let r = f.bgra[i + 2] as u32;
            grid[gy][gx] = (r * 30 + g * 59 + b * 11) / 100; // luma
        }
    }
    let mut hash = 0u64;
    let mut bit = 0u32;
    for gy in 0..gh {
        for gx in 0..(gw - 1) {
            if grid[gy][gx] < grid[gy][gx + 1] {
                hash |= 1 << bit;
            }
            bit += 1;
        }
    }
    hash
}

pub fn hamming(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}
