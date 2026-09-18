import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const file = process.argv[2], original = readFileSync(file, 'utf8');
appendFileSync(process.env.OWNED_QUESTION_LOG, JSON.stringify({ at: Date.now(), event: 'test_external_editor', original }) + '\n');
writeFileSync(file, original + '\n\x1b[31mEDITED\x1b[0m\u202e');
