// Indexer worker: parses notes off the main thread. Same function runs in-process when workers are unavailable.
import { parseMetadata } from './parse';

self.onmessage = (e: MessageEvent<{ id: number; text: string }>) => {
	self.postMessage({ id: e.data.id, cache: parseMetadata(e.data.text) });
};
