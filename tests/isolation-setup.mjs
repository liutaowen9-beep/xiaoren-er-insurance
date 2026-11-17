// Loaded before any test modules: refuse unmocked HTTP, independent of local .env files.
process.env.DEEPSEEK_API_KEY = '';
process.env.MOYU_REPORT_TESTING = '1';
globalThis.fetch = async () => { throw new Error('Isolation test guard: unmocked network request denied'); };
