import sanitizeHtml from 'sanitize-html';

/**
 * ฟังก์ชันในการลบแท็ก HTML จากข้อความ เพื่อป้องกันการโจมตีแบบ XSS
 * ใช้ library sanitize-html ที่เชื่อถือได้และทดสอบอย่างดี
 */
export const sanitizeHTML = (text: string | null): string | null => {
    if (text === null || text === undefined) return null;

    return sanitizeHtml(text, {
        allowedTags: [],  // ไม่อนุญาตแท็ก HTML ใดๆ
        allowedAttributes: {},  // ไม่อนุญาต attribute ใดๆ
        disallowedTagsMode: 'discard',  // ลบแท็กที่ห้าม
        textFilter: (frameText: string) => frameText.trim()  // ลบ whitespace ส่วนเกิน
    });
};
