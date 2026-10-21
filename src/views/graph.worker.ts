// Graph layout worker: runs the force simulation and posts node positions (x,y pairs) after every step.
import type { Simulation, SimulationNodeDatum } from 'd3-force';
import { createForces, type LayoutLink, type LayoutOptions } from './graph-layout';

let sim: Simulation<SimulationNodeDatum, LayoutLink> | null = null;
let running = false;

function step(): void {
	if (!sim || sim.alpha() < sim.alphaMin()) {
		running = false;
		return;
	}
	sim.tick();
	const nodes = sim.nodes();
	const xy = new Float32Array(nodes.length * 2);
	for (let i = 0; i < nodes.length; i++) {
		xy[2 * i] = nodes[i].x!;
		xy[2 * i + 1] = nodes[i].y!;
	}
	self.postMessage(xy, { transfer: [xy.buffer] });
	setTimeout(step); // lets 'drag' messages in between steps
}

function run(): void {
	if (running) return;
	running = true;
	step();
}

self.onmessage = (e: MessageEvent) => {
	const m = e.data;
	if (m.type === 'start') {
		sim = createForces(m.nodes as SimulationNodeDatum[], m.links as LayoutLink[], m.options as LayoutOptions).stop();
		run();
	} else if (m.type === 'drag' && sim) {
		const n = sim.nodes()[m.i];
		n.fx = m.x;
		n.fy = m.y;
		sim.alphaTarget(m.x === null ? 0 : 0.3);
		if (m.x !== null) sim.alpha(Math.max(sim.alpha(), 0.3));
		run();
	}
};
