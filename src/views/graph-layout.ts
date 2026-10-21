// Force layout for the graph view (PLAN §5.3). d3-force runs in a worker so drawing and input stay at frame rate
// while a big graph settles (10k nodes ≈ 110 ms per tick); the main thread runs it when workers are unavailable.
import { forceCenter, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationNodeDatum } from 'd3-force';

export interface LayoutOptions {
	centerStrength: number;
	repelStrength: number;
	linkStrength: number;
	linkDistance: number;
}

/** Links as node indexes. */
export type LayoutLink = { source: number; target: number };

export function createForces<N extends SimulationNodeDatum>(nodes: N[], links: LayoutLink[], o: LayoutOptions): Simulation<N, LayoutLink> {
	return forceSimulation<N, LayoutLink>(nodes)
		.force('link', forceLink<N, LayoutLink>(links).distance(o.linkDistance * 0.4).strength(o.linkStrength * 0.5))
		.force('charge', forceManyBody<N>().strength(-o.repelStrength * 12).distanceMax(600))
		.force('center', forceCenter(0, 0))
		.force('x', forceX<N>(0).strength(o.centerStrength * 0.05))
		.force('y', forceY<N>(0).strength(o.centerStrength * 0.05))
		.alphaDecay(0.03);
}

export interface Layout {
	/** Pin node `i` at (x, y) while dragging; null releases it. */
	drag(i: number, x: number | null, y: number | null): void;
	stop(): void;
}

let workerBroken = false;

/** Lay out `nodes` (x/y are updated in place), calling `onTick` after each step. */
export function startLayout(nodes: SimulationNodeDatum[], links: LayoutLink[], o: LayoutOptions, onTick: () => void): Layout {
	if (!workerBroken && typeof Worker === 'function') {
		try {
			return inWorker(nodes, links, o, onTick);
		} catch {
			workerBroken = true;
		}
	}
	return inProcess(nodes, links, o, onTick);
}

function inProcess(nodes: SimulationNodeDatum[], links: LayoutLink[], o: LayoutOptions, onTick: () => void): Layout {
	const sim = createForces(nodes, links, o).on('tick', onTick);
	return {
		drag(i, x, y) {
			nodes[i].fx = x;
			nodes[i].fy = y;
			sim.alphaTarget(x === null ? 0 : 0.3).restart();
		},
		stop: () => sim.stop(),
	};
}

function inWorker(nodes: SimulationNodeDatum[], links: LayoutLink[], o: LayoutOptions, onTick: () => void): Layout {
	const worker = new Worker(new URL('./graph.worker.ts', import.meta.url), { type: 'module' });
	let fallback: Layout | null = null;
	worker.onmessage = (e: MessageEvent<Float32Array>) => {
		const xy = e.data;
		for (let i = 0; i < nodes.length; i++) {
			if (nodes[i].fx != null) continue; // being dragged: the pointer owns its position
			nodes[i].x = xy[2 * i];
			nodes[i].y = xy[2 * i + 1];
		}
		onTick();
	};
	worker.onerror = () => {
		// Blocked or broken worker: lay out on the main thread from where it got to.
		workerBroken = true;
		worker.terminate();
		fallback = inProcess(nodes, links, o, onTick);
	};
	worker.postMessage({ type: 'start', nodes: nodes.map(({ x, y, vx, vy }) => ({ x, y, vx, vy })), links, options: o });
	return {
		drag(i, x, y) {
			if (fallback) return fallback.drag(i, x, y);
			nodes[i].fx = x;
			nodes[i].fy = y;
			if (x !== null) {
				nodes[i].x = x;
				nodes[i].y = y!;
			}
			worker.postMessage({ type: 'drag', i, x, y });
		},
		stop() {
			fallback?.stop();
			worker.terminate();
		},
	};
}
