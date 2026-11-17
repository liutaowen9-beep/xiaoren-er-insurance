type Delta = { type: 'delta'; text: string } | { type: 'done'; finishReason: string };

// UI source numbers are generated only from trusted retrieval. Strip model numbers.
export async function* withoutInlineCitations(events: AsyncIterable<Delta>): AsyncGenerator<Delta> {
  let pending = '';
  const clean = (text: string) => text.replace(/\[(?:来源|证据|引用)?\s*\^?\d+(?:\s*[,，、-]\s*\d+)*\]/g, '');
  for await (const event of events) {
    if (event.type === 'delta') {
      pending = clean(pending + event.text);
      // Retain an unfinished bracket sequence, even when split across chunks.
      let boundary = Math.max(0, pending.length - 24);
      const open = pending.lastIndexOf('[');
      if (open >= 0 && !pending.slice(open).includes(']')) boundary = Math.min(boundary, open);
      if (boundary) { yield { type: 'delta', text: pending.slice(0, boundary) }; pending = pending.slice(boundary); }
    } else {
      if (pending) yield { type: 'delta', text: clean(pending) };
      pending = ''; yield event;
    }
  }
}
