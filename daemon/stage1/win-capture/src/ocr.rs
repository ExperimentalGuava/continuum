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
    // Prefer the user's profile languages, then fall back to ANY installed OCR language — so the
    // daemon works on corporate machines whose display language (e.g. en-AU) ships without an OCR
    // pack even though another installed language has one. None only if no OCR language exists at all.
    pub fn new() -> Option<Engine> {
        if let Ok(inner) = OcrEngine::TryCreateFromUserProfileLanguages() {
            return Some(Engine { inner });
        }
        if let Ok(langs) = OcrEngine::AvailableRecognizerLanguages() {
            if langs.Size().unwrap_or(0) > 0 {
                if let Ok(lang) = langs.GetAt(0) {
                    if let Ok(inner) = OcrEngine::TryCreateFromLanguage(&lang) {
                        let name = lang.DisplayName().map(|h| h.to_string()).unwrap_or_default();
                        eprintln!("continuum-capture: OCR via fallback language {name}");
                        return Some(Engine { inner });
                    }
                }
            }
        }
        eprintln!(
            "continuum-capture: no OCR engine available. Add an OCR language pack \
             (Settings -> Time & language -> Language -> Optional features -> Optical character recognition)."
        );
        None
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
