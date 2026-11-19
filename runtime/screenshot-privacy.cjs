const { nativeImage } = require('electron');
const { privacyError } = require('./privacy.cjs');

// Decode one opaque black pixel into the same NativeImage format as the screenshot.
const blackPixel = nativeImage.createFromBuffer(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==', 'base64',
)).toBitmap();

function rectFor(quad) {
  if (quad.length !== 8 || !quad.every(Number.isFinite)) throw privacyError();
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

function intersect(rect, clip) {
  if (!clip) return rect;
  return {
    left: Math.max(rect.left, clip.left), right: Math.min(rect.right, clip.right),
    top: Math.max(rect.top, clip.top), bottom: Math.min(rect.bottom, clip.bottom),
  };
}

/** CDP reports boxes relative to the viewport of the renderer that owns the frame. */
async function captureMasks(privacy) {
  const report = await privacy.report(true);
  if (report.privateFrames) throw privacyError();
  const views = new Map();
  const sessionFor = frame => privacy.documentSessions.get(frame.loaderId);
  async function frameView(frame) {
    const targetSession = sessionFor(frame);
    if (!frame.parentId) {
      if (targetSession) throw privacyError();
      return { x: 0, y: 0 };
    }
    if (views.has(frame.id)) return views.get(frame.id);
    const parent = privacy.frames.get(frame.parentId);
    if (!parent) throw privacyError();
    const parentView = await frameView(parent);
    const parentSession = sessionFor(parent);
    const { backendNodeId } = await privacy.send('DOM.getFrameOwner', { frameId: frame.id }, parentSession);
    const { model } = await privacy.send('DOM.getBoxModel', { backendNodeId }, parentSession);
    const rect = rectFor(model.content);
    const bounds = {
      left: rect.left + parentView.x, right: rect.right + parentView.x,
      top: rect.top + parentView.y, bottom: rect.bottom + parentView.y,
    };
    const clip = intersect(bounds, parentView.clip);
    if (targetSession === parentSession) {
      const view = { x: parentView.x, y: parentView.y, clip };
      views.set(frame.id, view);
      return view;
    }

    const [x, y, right, top, farRight, bottom, left, farBottom] = model.content;
    // Page.getLayoutMetrics can report the top-level view even on a child target.
    const { executionContextId } = await privacy.send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'doze-screenshot' }, targetSession);
    const { result: { value: viewport } } = await privacy.send('Runtime.evaluate', {
      expression: '({ width: innerWidth, height: innerHeight, scale: visualViewport.scale })',
      contextId: executionContextId, returnByValue: true,
    }, targetSession);
    // The frame's viewport can be translated only when its embedding box uses the same scale.
    if (x !== left || y !== top || right !== farRight || bottom !== farBottom ||
        Math.abs(right - x - viewport.width) > 0.5 ||
        Math.abs(bottom - y - viewport.height) > 0.5 || viewport.scale !== 1) throw privacyError();
    const view = { x: bounds.left, y: bounds.top, clip };
    views.set(frame.id, view);
    return view;
  }

  const masks = [];
  try {
    for (const { frameId, backendNodeId } of report.captureNodes) {
      const frame = privacy.frames.get(frameId);
      if (!frame) throw privacyError();
      const { model } = await privacy.send('DOM.getBoxModel', { backendNodeId }, sessionFor(frame));
      const rect = rectFor(model.padding);
      const { x, y, clip } = await frameView(frame);
      const visible = intersect({ left: rect.left + x, right: rect.right + x, top: rect.top + y, bottom: rect.bottom + y }, clip);
      if (visible.left < visible.right && visible.top < visible.bottom) masks.push({ frameId, backendNodeId, ...visible });
    }
  } catch (cause) {
    throw new Error(privacyError().message, { cause });
  }
  if (report.version !== privacy.version) throw privacyError();
  return { version: report.version, masks };
}

/** Cover the painted input area before resizing, so text pixels cannot bleed across the mask. */
function maskScreenshot(image, masks, viewportWidth, viewportHeight) {
  if (!masks.length) return image;
  const { width, height } = image.getSize();
  const pixels = image.toBitmap();
  const channels = blackPixel.length;
  if (channels !== 4 || pixels.length !== width * height * channels) throw privacyError();
  const scaleX = width / viewportWidth;
  const scaleY = height / viewportHeight;
  for (const mask of masks) {
    const left = Math.max(0, Math.floor(mask.left * scaleX));
    const right = Math.min(width, Math.ceil(mask.right * scaleX));
    const top = Math.max(0, Math.floor(mask.top * scaleY));
    const bottom = Math.min(height, Math.ceil(mask.bottom * scaleY));
    if (left >= right || top >= bottom) continue;
    for (let y = top; y < bottom; y++) {
      pixels.fill(blackPixel, (y * width + left) * channels, (y * width + right) * channels);
    }
  }
  return nativeImage.createFromBitmap(pixels, { width, height });
}

module.exports = { captureMasks, maskScreenshot };
