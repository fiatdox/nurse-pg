import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// --- Configuration ---
const LOG_DIRECTORY = 'logs';
const MAX_LOG_AGE_DAYS = 30;
// ---------------------

const cleanupLogs = async () => {
    console.log('🧹 Starting log cleanup process...');

    const maxAgeMs = MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000;
    const now = Date.now();

    try {
        const files = await readdir(LOG_DIRECTORY);

        if (files.length === 0) {
            console.log('No log files found. Nothing to do.');
            return;
        }

        let deletedCount = 0;

        for (const file of files) {
            const filePath = join(LOG_DIRECTORY, file);
            try {
                const fileStat = await stat(filePath);
                const fileAgeMs = now - fileStat.mtime.getTime();

                if (fileStat.isFile() && fileAgeMs > maxAgeMs) {
                    console.log(`- Deleting old log file: ${filePath} (age: ${Math.floor(fileAgeMs / (1000 * 60 * 60 * 24))} days)`);
                    await unlink(filePath);
                    deletedCount++;
                }
            } catch (err) {
                console.error(`! Could not process file ${filePath}:`, err);
            }
        }

        console.log(`✅ Successfully deleted ${deletedCount} old log file(s).`);

    } catch (error: any) {
        if (error.code === 'ENOENT') {
            console.log(`Log directory '${LOG_DIRECTORY}' not found. Nothing to clean up.`);
        } else {
            console.error('❌ An error occurred during log cleanup:', error);
        }
    }
};

// Run the cleanup function
cleanupLogs();