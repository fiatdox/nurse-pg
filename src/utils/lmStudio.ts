/**
 * ตัวเชื่อมกับ LM Studio (OpenAI-compatible)
 *
 * เรียกจากเซิร์ฟเวอร์เท่านั้น ห้ามให้เบราว์เซอร์ยิงตรง เพราะที่อยู่ของโมเดล
 * อยู่ในเครือข่ายภายในและไม่ควรเปิดให้เครื่องผู้ใช้เข้าถึงโดยตรง
 */

const URL_BASE = () => String(process.env.LM_STUDIO_URL ?? '').replace(/\/+$/, '');
const MODEL = () => String(process.env.LM_STUDIO_MODEL ?? '');
const TIMEOUT = () => Number(process.env.LM_STUDIO_TIMEOUT_MS) || 180_000;

export const isConfigured = (): boolean => Boolean(URL_BASE() && MODEL());

export interface ChatResult {
    text: string;
    model: string;
    elapsedMs: number;
    /** โมเดลตระกูลที่คิดก่อนตอบจะใช้ token ส่วนหนึ่งไปกับการคิด ไม่ได้อยู่ในคำตอบ */
    reasoningTokens: number;
    truncated: boolean;
}

export class LMStudioError extends Error {
    constructor(message: string, readonly kind: 'unreachable' | 'timeout' | 'bad_response') {
        super(message);
    }
}

export const chat = async (
    system: string,
    user: string,
    { maxTokens = 2500, temperature = 0.3 } = {}
): Promise<ChatResult> => {
    const started = Date.now();

    let res: Response;
    try {
        res = await fetch(`${URL_BASE()}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: MODEL(),
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: user },
                ],
                temperature,
                // เผื่อโควตาให้พอสำหรับโมเดลที่คิดก่อนตอบ ถ้าตั้งน้อยคำตอบจะถูกตัดกลางประโยค
                max_tokens: maxTokens,
            }),
            signal: AbortSignal.timeout(TIMEOUT()),
        });
    } catch (error) {
        const timedOut = (error as Error)?.name === 'TimeoutError';
        throw new LMStudioError(
            timedOut
                ? `โมเดลใช้เวลานานเกิน ${Math.round(TIMEOUT() / 1000)} วินาที`
                : 'ติดต่อเซิร์ฟเวอร์โมเดลไม่ได้',
            timedOut ? 'timeout' : 'unreachable'
        );
    }

    if (!res.ok) {
        throw new LMStudioError(`เซิร์ฟเวอร์โมเดลตอบกลับ ${res.status}`, 'bad_response');
    }

    const json = (await res.json()) as {
        choices?: { message?: { content?: string }; finish_reason?: string }[];
        usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
    };
    const choice = json.choices?.[0];

    return {
        text: String(choice?.message?.content ?? ''),
        model: MODEL(),
        elapsedMs: Date.now() - started,
        reasoningTokens: Number(json.usage?.completion_tokens_details?.reasoning_tokens ?? 0),
        truncated: choice?.finish_reason === 'length',
    };
};

/**
 * ดึงก้อน JSON ก้อนแรกออกจากคำตอบ
 * โมเดลชอบห่อด้วย ```json หรือเขียนคำอธิบายนำหน้า จึงเชื่อ JSON.parse ตรงๆ ไม่ได้
 */
export const extractJSON = <T>(text: string): T | null => {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = (fenced?.[1] ?? text).match(/\{[\s\S]*\}/);
    if (!candidate) return null;
    try {
        return JSON.parse(candidate[0]) as T;
    } catch {
        return null;
    }
};
