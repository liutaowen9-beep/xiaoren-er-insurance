// Shared framing handles UTF-8 boundaries, CR/LF, comments and split chunks.
export async function* readSSE(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let eventSize = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 1000000) throw new Error('SSE frame too large');
      let end: number;
      while ((end = buffer.search(/[\r\n]/)) !== -1) {
        if (!done && buffer[end] === '\r' && end === buffer.length - 1) break;
        const line = buffer.slice(0, end);
        const delimiter = buffer[end] === '\r' && buffer[end + 1] === '\n' ? 2 : 1;
        buffer = buffer.slice(end + delimiter);
        if (!line) {
          if (data.length) yield data.join('\n');
          data = []; eventSize = 0;
        } else if (line.startsWith('data:')) {
          const text = line.slice(5).replace(/^ /, '');
          eventSize += text.length;
          if (eventSize > 1000000) throw new Error('SSE event too large');
          data.push(text);
        }
      }
      if (done) break;
    }
    // Incomplete events at EOF are ignored; consumers require an explicit done.
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
