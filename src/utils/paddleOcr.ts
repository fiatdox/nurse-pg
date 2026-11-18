import { join } from 'path';
import type { PaddleOcrService } from 'ppu-paddle-ocr';

/**
 * PaddleOCR (PP-OCRv6 tiny ผ่าน onnxruntime-node) — ตัวเลือกที่สองของการอ่าน HN จากภาพ
 *
 * โมเดลวางไว้ในเครื่องเหมือน tessdata เพราะเครือข่ายโรงพยาบาลออกอินเทอร์เน็ตไม่ได้
 * ถ้าปล่อยค่าเริ่มต้นของไลบรารี มันจะไปโหลดโมเดลจาก Hugging Face ตอนใช้ครั้งแรกแล้วค้าง
 *
 * import แบบ lazy: onnxruntime เป็นไบนารีขนาดใหญ่ ถ้าโหลดไม่ขึ้นบนเครื่องใดเครื่องหนึ่ง
 * ต้องกระทบแค่โหมดนี้ ไม่ใช่ทำให้ทั้งเซิร์ฟเวอร์สตาร์ตไม่ได้
 */
const MODEL_DIR = process.env.PADDLEOCR_DIR || join(process.cwd(), 'assets', 'paddleocr');

let servicePromise: Promise<PaddleOcrService> | null = null;

const getService = (): Promise<PaddleOcrService> => {
    if (!servicePromise) {
        servicePromise = (async () => {
            const { PaddleOcrService } = await import('ppu-paddle-ocr');
            const service = new PaddleOcrService({
                model: {
                    detection: join(MODEL_DIR, 'PP-OCRv6_tiny_det.ort'),
                    recognition: join(MODEL_DIR, 'PP-OCRv6_tiny_rec.ort'),
                    charactersDictionary: join(MODEL_DIR, 'ppocrv6_tiny_dict.txt'),
                },
            });
            await service.initialize();
            return service;
        })().catch(err => {
            // ล้างทิ้ง ไม่งั้นจะติด promise ที่ล้มไว้ตลอดอายุโปรเซส แก้ไฟล์โมเดลแล้วก็ยังใช้ไม่ได้
            servicePromise = null;
            throw err;
        });
    }
    return servicePromise;
};

/** อ่านข้อความทั้งภาพ คืนเป็นข้อความหลายบรรทัด การคัดเลข HN ทำที่ hnCandidatesFrom เหมือน tesseract */
export const paddleRecognize = async (image: Buffer): Promise<string> => {
    const service = await getService();
    const ab = image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength) as ArrayBuffer;
    const result = await service.recognize(ab);
    return result.text;
};
