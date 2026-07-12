type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null;
}

function contentText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (!Array.isArray(value)) return '';
	return value.map(part => {
		if (typeof part === 'string') return part;
		const item = record(part);
		return typeof item?.text === 'string' ? item.text : typeof item?.content === 'string' ? item.content : '';
	}).join('');
}

/** Extract customer-visible text from the JSON shapes accepted by Capix. */
export function extractCapixJsonText(payload: unknown): string {
	const root = record(payload);
	if (!root) return '';
	const choices = Array.isArray(root.choices) ? root.choices : [];
	const first = record(choices[0]);
	const message = record(first?.message);
	const delta = record(first?.delta);
	return contentText(message?.content)
		|| contentText(delta?.content)
		|| contentText(first?.text)
		|| contentText(root.output_text)
		|| contentText(root.output);
}

export interface ParsedCapixStream {
	text: string;
	receiptId?: string;
	error?: string;
}

/** Parse both OpenAI data-only SSE and named Capix receipt/content events. */
export function parseCapixSseText(source: string): ParsedCapixStream {
	let text = '';
	let receiptId: string | undefined;
	let error: string | undefined;
	for (const block of source.replace(/\r\n/g, '\n').split(/\n\n+/)) {
		let event = 'message';
		const dataLines: string[] = [];
		for (const line of block.split('\n')) {
			if (line.startsWith('event:')) event = line.slice(6).trim();
			if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
		}
		const raw = dataLines.join('\n');
		if (!raw || raw === '[DONE]') continue;
		let payload: unknown;
		try { payload = JSON.parse(raw); } catch { continue; }
		const item = record(payload);
		if (!item) continue;
		if (event === 'content.delta' || item.type === 'content.delta') text += contentText(item.content);
		else text += extractCapixJsonText(item);
		if (event === 'capix.route' || event === 'capix.final' || item.type === 'capix.route' || item.type === 'capix.final') {
			if (typeof item.receiptId === 'string') receiptId = item.receiptId;
		}
		if (event === 'capix.error' || item.type === 'capix.error') {
			error = typeof item.message === 'string' ? item.message : 'Capix inference was interrupted.';
		}
	}
	return { text, receiptId, error };
}
