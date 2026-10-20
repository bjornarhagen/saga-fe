// Adapted from bjornarhagen.no's AsciiBackdrop: an exact cell grid and a
// sparse-to-dense glyph ramp. Here the input is the chart's own SVG geometry.
const activeBackdrops = new WeakMap();
const ramp = ' .:-=+*#%@';
const paintProperties = [
  'color', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-opacity',
  'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
  'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'vector-effect',
  'paint-order', 'visibility', 'display', 'clip-path', 'clip-rule',
  'font-family', 'font-size', 'font-style', 'font-weight', 'text-anchor',
];
const bounded = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;

function dataGeometry(svg) {
  // Area fills and sparklines are direct paths without a series attribute.
  // Selection markers must stay sharp and continue to update on hover.
  return [...svg.querySelectorAll('[data-chart-series], :scope > path')]
    .filter(element => !element.closest('.chart-selection'));
}

function chartImage(svg, geometry, width, height, win) {
  const clone = svg.cloneNode(true);
  const originals = [svg, ...svg.querySelectorAll('*')];
  const copies = [clone, ...clone.querySelectorAll('*')];
  const retained = new Set([svg]);
  for (const element of geometry) {
    for (let parent = element; parent && parent !== svg; parent = parent.parentElement) retained.add(parent);
  }
  originals.forEach((original, index) => {
    const copy = copies[index];
    if (!retained.has(original) && !original.closest('defs')) {
      copy.remove();
      return;
    }
    const computed = win.getComputedStyle(original);
    for (const property of paintProperties) {
      let value = computed.getPropertyValue(property);
      if (value === 'currentcolor' || value === 'currentColor') value = computed.color;
      if (value) copy.style.setProperty(property, value);
    }
    // All paints are resolved before leaving the document. No external CSS,
    // fonts, page labels or chart metadata are needed by the image decoder.
    copy.removeAttribute('class');
    for (const attribute of [...copy.attributes]) {
      if (attribute.name.startsWith('data-') || attribute.name.startsWith('aria-')) copy.removeAttribute(attribute.name);
    }
  });
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.style.setProperty('width', `${width}px`);
  clone.style.setProperty('height', `${height}px`);
  // Preserve the original viewBox and preserveAspectRatio, including the
  // stretched sparklines, so raster pixels align with tooltip coordinates.
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new win.XMLSerializer().serializeToString(clone))}`;
}

function loadImage(src, win) {
  return new Promise((resolve, reject) => {
    const image = new win.Image();
    const finish = (callback, result) => {
      win.clearTimeout(timer);
      image.onload = image.onerror = null;
      callback(result);
    };
    const timer = win.setTimeout(() => finish(reject, new Error('Chart image unavailable')), 8000);
    image.onload = () => finish(resolve, image);
    image.onerror = () => finish(reject, new Error('Chart image unavailable'));
    // img-src permits data: in the application CSP; blob: is not required.
    image.src = src;
  });
}

/**
 * Paint the chart's data as ASCII while its original SVG retains all input
 * geometry, axes and live selection markers. Call the returned cleanup before
 * replacing the plot. Call again after resizing or changing theme/settings.
 * Rasterization failure is a quiet no-op and leaves the source visible.
 */
export async function applyAsciiBackdrop(plot, { cellSize = 7, opacity = .9, mix = .85 } = {}) {
  activeBackdrops.get(plot)?.();
  const doc = plot?.ownerDocument;
  const win = doc?.defaultView;
  const svg = plot?.querySelector('svg');
  let canvas;
  let disposed = false;
  const restored = [];
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    canvas?.remove();
    for (const { element, value, priority } of restored) {
      if (value) element.style.setProperty('opacity', value, priority);
      else element.style.removeProperty('opacity');
    }
    if (activeBackdrops.get(plot) === cleanup) activeBackdrops.delete(plot);
  };
  if (!doc || !win || !svg) return cleanup;
  activeBackdrops.set(plot, cleanup);

  try {
    const bounds = svg.getBoundingClientRect();
    const geometry = dataGeometry(svg);
    if (!bounds.width || !bounds.height || !geometry.length) return cleanup;
    const width = bounds.width, height = bounds.height;
    const size = bounded(cellSize, 7, 3, 24);
    const sourceMix = bounded(mix, .85, 0, 1);
    const font = win.getComputedStyle(plot).getPropertyValue('--font-mono').trim() || 'ui-monospace, monospace';
    try { await doc.fonts?.load(`16px ${font}`, ramp); } catch { /* use the mono fallback */ }
    if (disposed) return cleanup;

    const image = await loadImage(chartImage(svg, geometry, width, height, win), win);
    if (disposed || !svg.isConnected) return cleanup;
    canvas = doc.createElement('canvas');
    const context = canvas.getContext('2d');
    const raster = doc.createElement('canvas');
    const rasterContext = raster.getContext('2d');
    const sampler = doc.createElement('canvas');
    const sample = sampler.getContext('2d', { willReadFrequently: true });
    if (!context || !rasterContext || !sample) return cleanup;
    context.font = `16px ${font}`;
    const aspect = context.measureText('M').width / 16 || .6;
    const columns = Math.max(1, Math.round(width / size));
    const cellWidth = width / columns;
    const rows = Math.max(1, Math.round(height / (cellWidth / aspect)));
    const cellHeight = height / rows;
    // Nine subpixels per cell retain thin lines that a single averaged sample
    // would lose. Area fills still map to quieter, less dense characters.
    const samples = 3;
    sampler.width = columns * samples;
    sampler.height = rows * samples;
    const dpr = Math.min(win.devicePixelRatio || 1, 2);
    // CSS-pixel dimensions also preserve non-scaling stroke weights. Only
    // the final text canvas needs the device-pixel ratio for sharp glyphs.
    raster.width = Math.max(1, Math.round(width));
    raster.height = Math.max(1, Math.round(height));
    // Fix the SVG viewport at the chart's aspect ratio before sampling.
    // Drawing the SVG directly into the non-square character-cell grid can
    // apply preserveAspectRatio again and squeeze/centre the chart geometry.
    rasterContext.drawImage(image, 0, 0, raster.width, raster.height);
    sample.drawImage(raster, 0, 0, sampler.width, sampler.height);
    const pixels = sample.getImageData(0, 0, sampler.width, sampler.height).data;
    canvas.width = Math.ceil(width * dpr);
    canvas.height = Math.ceil(height * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.font = `${cellHeight * .8}px ${font}`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    let painted = 0;
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        let coverage = 0, strongest = 0, colorIndex = 0;
        for (let y = 0; y < samples; y++) {
          for (let x = 0; x < samples; x++) {
            const index = ((row * samples + y) * sampler.width + column * samples + x) * 4;
            const alpha = pixels[index + 3] / 255;
            coverage += alpha;
            if (alpha > strongest) { strongest = alpha; colorIndex = index; }
          }
        }
        if (strongest < .025) continue;
        const density = Math.sqrt(strongest * .65 + coverage / (samples * samples) * .35);
        const character = ramp[Math.max(1, Math.round(density * (ramp.length - 1)))];
        context.fillStyle = `rgb(${pixels[colorIndex]}, ${pixels[colorIndex + 1]}, ${pixels[colorIndex + 2]})`;
        context.globalAlpha = .45 + density * .55;
        context.fillText(character, (column + .5) * cellWidth, (row + .5) * cellHeight);
        painted++;
      }
    }
    if (!painted || disposed) return cleanup;
    const currentBounds = svg.getBoundingClientRect();
    // A resize during image decoding invalidates the snapshot. The page's
    // ResizeObserver will redraw it; leave the source visible in the meantime.
    if (Math.abs(currentBounds.width - width) > .5 || Math.abs(currentBounds.height - height) > .5) return cleanup;
    const plotBounds = plot.getBoundingClientRect();
    canvas.className = 'ascii-lab-backdrop';
    canvas.setAttribute('aria-hidden', 'true');
    Object.assign(canvas.style, {
      position: 'absolute',
      left: `${currentBounds.left - plotBounds.left - plot.clientLeft + plot.scrollLeft}px`,
      top: `${currentBounds.top - plotBounds.top - plot.clientTop + plot.scrollTop}px`,
      width: `${width}px`, height: `${height}px`,
      pointerEvents: 'none', userSelect: 'none',
      opacity: String(bounded(opacity, .9, 0, 1)),
    });
    // Only data paint is mixed out. Opacity leaves SVG hit testing intact;
    // using visibility/display would break series-specific hover inspection.
    for (const element of geometry) {
      const originalOpacity = Number(win.getComputedStyle(element).opacity);
      restored.push({ element, value: element.style.getPropertyValue('opacity'), priority: element.style.getPropertyPriority('opacity') });
      element.style.setProperty('opacity', String((Number.isFinite(originalOpacity) ? originalOpacity : 1) * (1 - sourceMix)));
    }
    plot.append(canvas);
  } catch {
    cleanup();
  }
  return cleanup;
}
