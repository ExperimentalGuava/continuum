// Windows.Media.Ocr wrapper. Builds a SoftwareBitmap from our BGRA frame and runs the
// on-device OCR engine — no network, no model download (the language packs ship with Windows).
use crate::capture::Frame;
use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Security::Cryptography::CryptographicBuffer;

pub struct Engine {
    inner: OcrEngine,
}

impl Engine {
    // None if no OCR language is installed for the user's profile — on most Win10/11 installs
    // an English pack is present; otherwise the user adds one in Settings → Language.
    pub fn new() -> Option<Engine> {
        match OcrEngine::TryCreateFromUserProfileLanguages() {
            Ok(inner) => Some(Engine { inner }),
            Err(e) => {
                eprintln!(
                    "continuum-capture: no OCR engine for your languages ({e}). \
                     Add an OCR-capable language pack (Settings → Time & language → Language)."
                );
                None
            }
        }
    }

    pub fn run(&self, f: &Frame) -> Option<String> {
        let buf = CryptographicBuffer::CreateFromByteArray(&f.bgra).ok()?;
        let bmp =
            SoftwareBitmap::CreateCopyFromBuffer(&buf, BitmapPixelFormat::Bgra8, f.w as i32, f.h as i32)
                .ok()?;
        let result = self.inner.RecognizeAsync(&bmp).ok()?.get().ok()?;
        let text = result.Text().ok()?.to_string();
        let t = text.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    }
}
