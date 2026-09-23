/**
 * Interactive family-tree renderer.
 *
 * Plain SVG, no charting library. Responsibilities:
 *   - lay nodes out in generation bands, reducing edge crossings
 *   - keep spouses side by side
 *   - draw parent links as orthogonal connectors, marriages as a direct bar
 *   - zoom (wheel / pinch / buttons), pan (drag), focus, search highlight
 *   - report clicks so the page can open a detail panel or expand a branch
 *
 * Verified edges are solid; anything not yet verified is dashed. That
 * distinction is deliberately visual and always on -- a user should never have
 * to check a legend to know whether a link is confirmed.
 */

const CARD_W = 168;
const CARD_H = 62;
const GAP_X = 26;
const GAP_Y = 108;
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Creates an SVG element.
 *
 * `fill` and `stroke` are written into the inline STYLE rather than as
 * presentation attributes: a presentation attribute is not a CSS declaration,
 * so `var(--accent)` never resolves there. Routing paint through style is what
 * lets the tree follow the light/dark theme tokens.
 */
const PAINT_PROPS = new Set(['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity']);

const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, tag);
  const style = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (PAINT_PROPS.has(key)) style.push(`${key}:${value}`);
    else node.setAttribute(key, String(value));
  }
  if (style.length) node.setAttribute('style', style.join(';'));
  return node;
};

const truncate = (text, max) =>
  String(text ?? '').length > max ? `${String(text).slice(0, max - 1)}…` : String(text ?? '');

/**
 * @param {object} options
 * @param {Array}  options.nodes   person views carrying `generation`
 * @param {Array}  options.edges   { from, to, type, subtype, status }
 * @param {string} options.focusId
 * @param {Function} options.onSelect      (personId) => void
 * @param {Function} options.onExpand      (personId, direction) => void
 */
export function createTreeRenderer(container, options = {}) {
  const state = {
    nodes: [],
    edges: [],
    focusId: null,
    highlightIds: new Set(),
    highlightEdges: new Set(),
    positions: new Map(),
    view: { x: 0, y: 0, scale: 1 },
    bounds: { width: 0, height: 0 },
  };

  const svg = svgEl('svg', { xmlns: SVG_NS, role: 'img', 'aria-label': 'Family tree' });
  const root = svgEl('g');
  const edgeLayer = svgEl('g', { class: 'edges' });
  const nodeLayer = svgEl('g', { class: 'nodes' });
  root.append(edgeLayer, nodeLayer);
  svg.append(root);
  container.append(svg);

  // ------------------------------------------------------------- layout ---

  /**
   * Orders each generation to reduce crossings, then converts the order into
   * pixel positions.
   *
   * The ordering is the barycentre heuristic: a node wants to sit at the mean
   * position of its neighbours in the generation above. A handful of sweeps is
   * enough for family trees, which are shallow and mostly tree-shaped.
   */
  function layout() {
    state.positions.clear();
    if (!state.nodes.length) {
      state.bounds = { width: 0, height: 0 };
      return;
    }

    const byGeneration = new Map();
    for (const node of state.nodes) {
      const generation = node.generation ?? 0;
      if (!byGeneration.has(generation)) byGeneration.set(generation, []);
      byGeneration.get(generation).push(node);
    }

    // Ancestors have the larger generation number, so descending puts the
    // oldest generation at the top of the drawing.
    const generations = [...byGeneration.keys()].sort((a, b) => b - a);

    const parentsOf = new Map();
    const spouseOf = new Map();
    for (const edge of state.edges) {
      if (edge.type === 'parent') {
        if (!parentsOf.has(edge.to)) parentsOf.set(edge.to, []);
        parentsOf.get(edge.to).push(edge.from);
      } else if (edge.type === 'spouse') {
        if (!spouseOf.has(edge.from)) spouseOf.set(edge.from, []);
        if (!spouseOf.has(edge.to)) spouseOf.set(edge.to, []);
        spouseOf.get(edge.from).push(edge.to);
        spouseOf.get(edge.to).push(edge.from);
      }
    }

    const orderIndex = new Map();
    const reindex = () => {
      for (const generation of generations) {
        byGeneration.get(generation).forEach((node, i) => orderIndex.set(node.id, i));
      }
    };
    reindex();

    // Sweep downwards a few times, sorting each row by its parents' positions.
    for (let pass = 0; pass < 4; pass += 1) {
      for (const generation of generations) {
        const row = byGeneration.get(generation);
        const score = new Map();
        for (const node of row) {
          const parents = (parentsOf.get(node.id) ?? [])
            .map((id) => orderIndex.get(id))
            .filter((v) => v !== undefined);
          score.set(node.id, parents.length
            ? parents.reduce((a, b) => a + b, 0) / parents.length
            : orderIndex.get(node.id) ?? 0);
        }
        row.sort((a, b) => (score.get(a.id) - score.get(b.id)) || a.displayName.localeCompare(b.displayName));
        reindex();
      }
    }

    // Pull each spouse next to their partner, without disturbing the rest.
    for (const generation of generations) {
      const row = byGeneration.get(generation);
      const placed = new Set();
      const result = [];
      for (const node of row) {
        if (placed.has(node.id)) continue;
        result.push(node);
        placed.add(node.id);
        for (const partnerId of spouseOf.get(node.id) ?? []) {
          if (placed.has(partnerId)) continue;
          const partner = row.find((candidate) => candidate.id === partnerId);
          if (partner) { result.push(partner); placed.add(partnerId); }
        }
      }
      byGeneration.set(generation, result);
    }

    // Convert to pixels, centring every row on a shared axis.
    let widest = 0;
    for (const generation of generations) {
      widest = Math.max(widest, byGeneration.get(generation).length);
    }
    const totalWidth = widest * CARD_W + (widest - 1) * GAP_X;

    generations.forEach((generation, rowIndex) => {
      const row = byGeneration.get(generation);
      const rowWidth = row.length * CARD_W + (row.length - 1) * GAP_X;
      const offset = (totalWidth - rowWidth) / 2;
      row.forEach((node, columnIndex) => {
        state.positions.set(node.id, {
          x: offset + columnIndex * (CARD_W + GAP_X),
          y: rowIndex * (CARD_H + GAP_Y),
          node,
        });
      });
    });

    state.bounds = {
      width: totalWidth + CARD_W,
      height: generations.length * (CARD_H + GAP_Y) + CARD_H,
    };
  }

  // -------------------------------------------------------------- render ---

  function render() {
    while (edgeLayer.firstChild) edgeLayer.firstChild.remove();
    while (nodeLayer.firstChild) nodeLayer.firstChild.remove();

    for (const edge of state.edges) {
      const a = state.positions.get(edge.from);
      const b = state.positions.get(edge.to);
      if (!a || !b) continue;

      const verified = edge.status === 'verified';
      const key = `${edge.from}|${edge.to}`;
      const highlighted = state.highlightEdges.has(key) || state.highlightEdges.has(`${edge.to}|${edge.from}`);

      if (edge.type === 'spouse') {
        // A marriage bar joins the two cards at mid-height.
        const left = a.x < b.x ? a : b;
        const right = a.x < b.x ? b : a;
        const y1 = left.y + CARD_H / 2;
        const y2 = right.y + CARD_H / 2;
        edgeLayer.append(svgEl('path', {
          d: y1 === y2
            ? `M ${left.x + CARD_W} ${y1} L ${right.x} ${y2}`
            : `M ${left.x + CARD_W} ${y1} C ${left.x + CARD_W + 26} ${y1}, ${right.x - 26} ${y2}, ${right.x} ${y2}`,
          stroke: highlighted ? 'var(--accent)' : 'var(--violet-500)',
          'stroke-width': highlighted ? 3 : 2,
          'stroke-dasharray': verified ? null : '5 4',
          fill: 'none',
          opacity: state.highlightEdges.size && !highlighted ? 0.22 : 0.9,
        }));
        continue;
      }

      // Parent link: down from the parent, across, then into the child.
      const px = a.x + CARD_W / 2;
      const py = a.y + CARD_H;
      const cx = b.x + CARD_W / 2;
      const cy = b.y;
      const midY = py + (cy - py) / 2;

      edgeLayer.append(svgEl('path', {
        d: `M ${px} ${py} V ${midY} H ${cx} V ${cy}`,
        stroke: highlighted ? 'var(--accent)' : verified ? 'var(--teal-500)' : 'var(--text-faint)',
        'stroke-width': highlighted ? 3 : 1.7,
        'stroke-dasharray': verified ? null : '5 4',
        fill: 'none',
        opacity: state.highlightEdges.size && !highlighted ? 0.18 : 0.85,
      }));

      if (edge.subtype === 'adoptive' || edge.subtype === 'step' || edge.subtype === 'foster') {
        const tag = svgEl('text', {
          x: cx + 5, y: midY - 4, 'font-size': 9, fill: 'var(--text-faint)', stroke: 'none',
        });
        tag.textContent = edge.subtype;
        edgeLayer.append(tag);
      }
    }

    for (const [, position] of state.positions) {
      nodeLayer.append(renderCard(position));
    }

    updateTransform();
  }

  function renderCard({ x, y, node }) {
    const isFocus = node.id === state.focusId;
    const highlighted = state.highlightIds.has(node.id);
    const dimmed = state.highlightIds.size > 0 && !highlighted;

    const group = svgEl('g', {
      class: `node-card${isFocus ? ' focused' : ''}${highlighted ? ' highlight' : ''}`,
      transform: `translate(${x}, ${y})`,
      opacity: dimmed ? 0.3 : 1,
      tabindex: 0,
      role: 'button',
      'aria-label': `${node.displayName}. Open details.`,
    });

    const fill = node.restricted ? 'var(--surface-3)'
      : node.gender === 'male' ? 'var(--blue-100)'
        : node.gender === 'female' ? 'var(--rose-100)' : 'var(--surface-2)';
    const stroke = isFocus || highlighted ? 'var(--accent)'
      : node.gender === 'male' ? 'var(--blue-500)'
        : node.gender === 'female' ? 'var(--rose-500)' : 'var(--border-strong)';

    group.append(svgEl('rect', {
      class: 'bg', width: CARD_W, height: CARD_H, rx: 10,
      fill, stroke, 'stroke-width': isFocus || highlighted ? 2.6 : 1.4,
    }));

    if (node.isLiving === false) {
      group.append(svgEl('rect', { width: 3.5, height: CARD_H, rx: 2, fill: 'var(--text-faint)', opacity: 0.55 }));
    }

    const name = svgEl('text', {
      x: 12, y: 23, 'font-size': 12.5, 'font-weight': 650,
      fill: node.restricted ? 'var(--text-muted)' : 'var(--text)', stroke: 'none',
    });
    name.textContent = truncate(node.displayName, 21);
    group.append(name);

    const detailBits = [];
    const birth = node.birthYear ?? (node.birthDate ? String(node.birthDate).slice(0, 4) : null);
    const death = node.deathDate ? String(node.deathDate).slice(0, 4) : null;
    if (birth && death) detailBits.push(`${birth}–${death}`);
    else if (birth) detailBits.push(node.isLiving === false ? `${birth}–?` : `b. ${birth}`);
    else if (death) detailBits.push(`d. ${death}`);
    if (node.restricted) detailBits.push('private');
    else if (node.detailsHidden) detailBits.push('details hidden');

    if (detailBits.length) {
      const meta = svgEl('text', { x: 12, y: 40, 'font-size': 10.5, fill: 'var(--text-muted)', stroke: 'none' });
      meta.textContent = truncate(detailBits.join(' · '), 24);
      group.append(meta);
    }

    if (node.birthPlace && !node.detailsHidden && !node.restricted) {
      const place = svgEl('text', { x: 12, y: 53, 'font-size': 9.5, fill: 'var(--text-faint)', stroke: 'none' });
      place.textContent = truncate(node.birthPlace, 26);
      group.append(place);
    }

    if (node.isSynthetic) {
      const tag = svgEl('text', {
        x: CARD_W - 9, y: 14, 'font-size': 7.5, 'text-anchor': 'end',
        fill: 'var(--violet-700)', stroke: 'none', 'letter-spacing': '.06em',
      });
      tag.textContent = 'DEMO';
      group.append(tag);
    }

    // Expand handles: a small chevron when more family exists off-screen.
    if (node.hasMoreAncestors) group.append(expandHandle(CARD_W / 2, -9, 'up', node.id));
    if (node.hasMoreDescendants) group.append(expandHandle(CARD_W / 2, CARD_H + 9, 'down', node.id));

    const select = (event) => { event.stopPropagation(); options.onSelect?.(node.id); };
    group.addEventListener('click', select);
    group.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(event); }
    });

    return group;
  }

  function expandHandle(cx, cy, direction, personId) {
    const handle = svgEl('g', {
      class: 'expand-handle', style: 'cursor:pointer',
      role: 'button', 'aria-label': direction === 'up' ? 'Load parents' : 'Load children',
    });
    handle.append(svgEl('circle', {
      cx, cy, r: 8, fill: 'var(--surface)', stroke: 'var(--accent)', 'stroke-width': 1.5,
    }));
    handle.append(svgEl('path', {
      d: direction === 'up'
        ? `M ${cx - 3.5} ${cy + 1.5} L ${cx} ${cy - 2} L ${cx + 3.5} ${cy + 1.5}`
        : `M ${cx - 3.5} ${cy - 1.5} L ${cx} ${cy + 2} L ${cx + 3.5} ${cy - 1.5}`,
      stroke: 'var(--accent)', 'stroke-width': 1.9, fill: 'none',
    }));
    handle.addEventListener('click', (event) => {
      event.stopPropagation();
      options.onExpand?.(personId, direction);
    });
    return handle;
  }

  // --------------------------------------------------- view transform -----

  function updateTransform() {
    root.setAttribute(
      'transform',
      `translate(${state.view.x}, ${state.view.y}) scale(${state.view.scale})`
    );
  }

  /**
   * Scales the whole tree to fit the stage.
   *
   * The insets are asymmetric because the floating toolbar sits over the top
   * of the stage and the legend over the bottom; fitting to the raw rectangle
   * would tuck the oldest generation underneath the controls.
   */
  /** Set when fit() was asked for before the container had a measurable size. */
  let pendingFit = null;

  function fit(inset = {}) {
    const top = inset.top ?? 62;
    const bottom = inset.bottom ?? 52;
    const side = inset.side ?? 44;

    const rect = container.getBoundingClientRect();

    // A view builds its DOM before returning it to the router, so the first
    // fit() usually runs while the stage is still detached and measures 0x0.
    // Remember the request and honour it as soon as the element has a size --
    // otherwise the tree would sit at scale 1 from the origin, overflowing.
    if (!rect.width || !rect.height) {
      if (state.bounds.width) pendingFit = inset;
      return;
    }
    if (!state.bounds.width) return;
    pendingFit = null;

    const usableWidth = Math.max(80, rect.width - side * 2);
    const usableHeight = Math.max(80, rect.height - top - bottom);

    const scale = Math.min(usableWidth / state.bounds.width, usableHeight / state.bounds.height, 1.15);
    state.view.scale = Math.max(0.12, scale);
    state.view.x = side + (usableWidth - state.bounds.width * state.view.scale) / 2;
    state.view.y = top + (usableHeight - state.bounds.height * state.view.scale) / 2;
    updateTransform();
  }

  function centreOn(personId, scale) {
    const position = state.positions.get(personId);
    if (!position) return;
    const rect = container.getBoundingClientRect();
    if (scale) state.view.scale = Math.min(2.4, Math.max(0.12, scale));
    state.view.x = rect.width / 2 - (position.x + CARD_W / 2) * state.view.scale;
    state.view.y = rect.height / 2 - (position.y + CARD_H / 2) * state.view.scale;
    updateTransform();
  }

  function zoomBy(factor, originX, originY) {
    const rect = container.getBoundingClientRect();
    const cx = originX ?? rect.width / 2;
    const cy = originY ?? rect.height / 2;
    const next = Math.min(2.6, Math.max(0.1, state.view.scale * factor));
    const ratio = next / state.view.scale;
    state.view.x = cx - (cx - state.view.x) * ratio;
    state.view.y = cy - (cy - state.view.y) * ratio;
    state.view.scale = next;
    updateTransform();
  }

  // ----------------------------------------------------- pointer input ----

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const pointers = new Map();
  let pinchStart = null;

  svg.addEventListener('pointerdown', (event) => {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      svg.classList.add('dragging');
      svg.setPointerCapture(event.pointerId);
    } else if (pointers.size === 2) {
      dragging = false;
      const [a, b] = [...pointers.values()];
      pinchStart = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale: state.view.scale };
    }
  });

  svg.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const rect = container.getBoundingClientRect();
      const target = pinchStart.scale * (distance / pinchStart.distance);
      zoomBy(target / state.view.scale,
        (a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top);
      return;
    }
    if (!dragging) return;
    state.view.x += event.clientX - lastX;
    state.view.y += event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    updateTransform();
  });

  const endPointer = (event) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (pointers.size === 0) { dragging = false; svg.classList.remove('dragging'); }
  };
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);
  svg.addEventListener('pointerleave', endPointer);

  svg.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = container.getBoundingClientRect();
    zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });

  svg.addEventListener('click', (event) => {
    if (event.target === svg) options.onBackgroundClick?.();
  });

  const onResize = () => { svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%'); };
  window.addEventListener('resize', onResize);
  onResize();

  // Runs the deferred fit the moment the stage is laid out, and keeps the tree
  // framed when the pane is resized before the user has panned.
  const observer = new ResizeObserver(() => {
    if (pendingFit) fit(pendingFit);
  });
  observer.observe(container);

  // ------------------------------------------------------- public API -----

  return {
    setData({ nodes, edges, focusId }) {
      state.nodes = nodes ?? [];
      state.edges = edges ?? [];
      state.focusId = focusId ?? state.focusId;
      layout();
      render();
      return this;
    },
    /** Dims everything except the given people and the links between them. */
    highlight(personIds = [], edgePairs = []) {
      state.highlightIds = new Set(personIds);
      state.highlightEdges = new Set(edgePairs.map(([a, b]) => `${a}|${b}`));
      render();
      return this;
    },
    clearHighlight() {
      state.highlightIds = new Set();
      state.highlightEdges = new Set();
      render();
      return this;
    },
    setFocus(personId) { state.focusId = personId; render(); return this; },
    fit, centreOn, zoomBy,
    zoomIn: () => zoomBy(1.22),
    zoomOut: () => zoomBy(1 / 1.22),
    reset: () => fit(),
    getScale: () => state.view.scale,
    has: (personId) => state.positions.has(personId),
    nodeCount: () => state.nodes.length,
    /** The rendered SVG markup, used by the image and PDF export. */
    toSvgString() {
      const clone = svg.cloneNode(true);
      clone.setAttribute('width', Math.ceil(state.bounds.width));
      clone.setAttribute('height', Math.ceil(state.bounds.height));
      clone.setAttribute('viewBox', `0 0 ${Math.ceil(state.bounds.width)} ${Math.ceil(state.bounds.height)}`);
      clone.querySelector('g').setAttribute('transform', 'translate(0,0) scale(1)');
      return new XMLSerializer().serializeToString(clone);
    },
    destroy() { window.removeEventListener("resize", onResize); observer.disconnect(); svg.remove(); },
  };
}
