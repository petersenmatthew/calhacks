export type FlowEdge = { from: string; to: string };

/** Walk upstream and downstream separately so siblings never become descendants. */
export function connectedPaths(edges: FlowEdge[], node: string | null): Set<string> {
  const paths = new Set<string>();
  if (!node) return paths;
  for (const upstream of [true, false]) {
    const visited = new Set<string>();
    const pending = [node];
    while (pending.length) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const edge of edges) {
        if ((upstream ? edge.to : edge.from) !== current) continue;
        paths.add(`${edge.from}:${edge.to}`);
        pending.push(upstream ? edge.from : edge.to);
      }
    }
  }
  return paths;
}
