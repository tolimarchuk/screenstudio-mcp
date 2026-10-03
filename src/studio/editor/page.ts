// Code that runs inside Screen Studio's renderer. It is sent as text, so it
// stays plain JavaScript that only relies on the editor's own objects.
const j = JSON.stringify;

// Finds every open editor through the app's React tree. All editor windows share
// one tree, reachable from any editor window the main renderer knows about.
export const PRELUDE = `
const __ss = (() => {
  const isCtx = (o) => o && typeof o === 'object' && 'playback' in o && 'view' in o && 'project' in o && 'exportManager' in o;
  const contexts = () => {
    const found = new Set();
    const wins = [window.$$focused?.view?.targetWindow, window.lastActiveWindow].filter(Boolean);
    for (const w of wins) {
      let doc; try { doc = w.document; } catch { continue; }
      const el = [doc.body, ...doc.body.querySelectorAll('*')].slice(0, 500).find((e) => Object.keys(e).some((k) => k.startsWith('__reactFiber')));
      if (!el) continue;
      let f = el[Object.keys(el).find((k) => k.startsWith('__reactFiber'))];
      while (f.return) f = f.return;
      const stack = [f]; let n = 0;
      while (stack.length && n++ < 500000) {
        const x = stack.pop();
        for (const v of [x.memoizedProps, x.stateNode]) {
          if (!v || typeof v !== 'object') continue;
          if (isCtx(v)) { found.add(v); continue; }
          for (const k in v) { let w2; try { w2 = v[k]; } catch { continue; } if (isCtx(w2)) found.add(w2); }
        }
        if (x.sibling) stack.push(x.sibling);
        if (x.child) stack.push(x.child);
      }
      if (found.size) break;
    }
    return [...found].filter((c) => !c.playback.isDestroyed);
  };
  const get = (path) => {
    const c = contexts().find((c) => c.project.path === path);
    if (!c) throw new Error('This project is not open in the Screen Studio editor. Open it with screenstudio_editor_open.');
    return c;
  };
  // Set while an apply runs, so writes from another call or another server
  // process cannot land between a paced edit's steps.
  const busy = () => (window.__ssmcpBusy ??= {});
  const edit = (path) => {
    const b = busy()[path];
    if (b) throw new Error('An edit is still running on this project (started ' + Math.round((Date.now() - b.since) / 1000) + 's ago). Wait for it, then read screenstudio_editor_state.');
    return get(path);
  };
  const scene = (c, id) => {
    const s = id ? c.project.scenes.find((s) => s.id === id) : c.project.scenes[0];
    if (!s) throw new Error('Scene does not exist.');
    return s;
  };
  const summary = (c) => {
    const p = c.project;
    const data = p.serialize();
    return {
      projectPath: p.path, name: p.name, dirty: p.isDirty,
      editGeneration: p.editGeneration,
      focused: c === window.$$focused,
      playheadMs: c.playback.playbackTimeMs, playing: c.playback.isPlaying,
      playbackDurationMs: p.playbackDurationMs, sourceDurationMs: p.sourceDurationMs,
      canUndo: p.history.canUndo, canRedo: p.history.canRedo,
      editRunning: !!busy()[p.path],
      scenes: data.scenes.map((s) => ({ id: s.id, name: s.name, slices: s.slices, zooms: s.zooms, layouts: s.layouts, masks: s.masks, voiceOvers: s.voiceOvers })),
      config: data.config,
    };
  };
  return { contexts, get, edit, busy, scene, summary };
})();
`;

const CLIP_FIELDS = {
  volume: 1,
  systemAudioVolume: 1,
  externalDeviceAudioVolume: 1,
  hideCursor: false,
  disableSmoothMouseMovement: false,
};

/** Refuses a preview taken at a different time or after an intervening edit. */
export const previewSeekScript = (path: string, playbackMs: number) => `
  const c = __ss.edit(${j(path)});
  const editGeneration = c.project.editGeneration;
  const requested = Math.max(0, Math.min(${Number(playbackMs)}, c.project.playbackDurationMs));
  c.playback.pause();
  c.playback.goTo(requested);
  await new Promise((r) => setTimeout(r, 700));
  const w = c.view.targetWindow;
  // Editor windows can be hidden while the app's main renderer stays visible.
  // Their requestAnimationFrame stops, so it is not a reliable readiness signal.
  if (c.project.editGeneration !== editGeneration)
    throw new Error('The project changed during preview capture. Read the current editor state.');
  if (c.playback.isPlaying || Math.abs(c.playback.playbackTimeMs - requested) > 1)
    throw new Error('The playhead moved during preview capture. Stop scrubbing before requesting another frame.');
  if ([...w.document.querySelectorAll('video')].some((v) => v.seeking))
    throw new Error('The preview is still seeking. Retry after it settles.');
  return { playheadMs: Math.round(c.playback.playbackTimeMs), editGeneration };
`;

/**
 * Per-clip settings for a new slice: those of the existing slice it overlaps
 * most, so a muted or cursorless clip stays that way when it is re-cut, and
 * neutral ones where it covers footage no slice kept. Runs in the renderer too.
 */
export function clipFields(existing: any[], range: { startMs: number; endMs: number }) {
  let best: any = null;
  let most = 0;
  for (const a of existing) {
    const shared = Math.min(a.sourceEndMs, range.endMs) - Math.max(a.sourceStartMs, range.startMs);
    if (shared > most) [best, most] = [a, shared];
  }
  const { id: _id, sourceStartMs: _s, sourceEndMs: _e, timeScale: _t, ...fields } = best ?? existing[0] ?? {};
  return best ? fields : { ...fields, ...CLIP_FIELDS };
}

/**
 * Applies prepared ops to one scene, in order. With `show`, each step plays out
 * in the editor the way a person would do it, paced by `stepMs`. An op that
 * fails stops the batch: the script returns what ran and `failedAt` instead of
 * throwing, so the caller can still offer the checkpoint.
 */
export const applyScript = (
  path: string,
  sceneId: string,
  prepared: unknown[],
  show?: { stepMs: number },
  expectedGeneration?: number,
) => `
      const c = __ss.edit(${j(path)});
      let generation = ${expectedGeneration ?? "c.project.editGeneration"};
      const unchanged = () => {
        if (generation !== undefined && c.project.editGeneration !== generation)
          throw new Error("The project changed while preparing or applying this edit. Read the current editor state and continue from the person's changes.");
      };
      unchanged();
      const sc = __ss.scene(c, ${j(sceneId)});
      const ops = ${j(prepared)};
      if (ops.some((o) => o.track === 'voiceOvers') && typeof sc.voiceOvers.replace !== 'function')
        throw new Error('This Screen Studio build cannot restore voiceovers, so removing them is not supported.');
      const CLIP_FIELDS = ${j(CLIP_FIELDS)};
      const clipFields = ${clipFields.toString()};
      const out = [];
      const SHOW = ${j(!!show)};
      const STEP = ${Number(show?.stepMs ?? 0)};
      const view = c.view, pb = c.playback;
      const wait = async (ms) => {
        generation = c.project.editGeneration;
        if (SHOW) await new Promise((r) => setTimeout(r, ms));
        unchanged();
      };
      const at = async (sourceMs) => { if (!SHOW) return; try { pb.pause(); pb.goToSourceTime(Math.max(0, sourceMs)); } catch {} await wait(STEP * 0.5); };
      const select = (item) => { if (SHOW) try { view.setSidebarItem(item); } catch {} };
      const root = (r) => { if (SHOW) { try { view.setSidebarRoot(r); } catch {} unchanged(); } };
      const track = (t) => { if (SHOW) try { view.setFocusedTrack(t); } catch {} };
      if (SHOW) { try { view.setVisiblePlaybackDurationMs(c.project.playbackDurationMs * 1.05); } catch {} await wait(STEP * 0.5); }
      const ROOTS = { styles: 'background', output: 'background', crop: 'background', device: 'background', camera: 'background', defaultLayout: 'background', cursor: 'cursor', captions: 'captions', audio: 'audio', animations: 'animation', zooms: 'animation', processing: 'audio' };
      const extras = (t) => ({ ...(t.volume !== undefined ? { volume: t.volume } : {}), ...(t.hideCursor !== undefined ? { hideCursor: t.hideCursor } : {}), ...(t.disableSmoothMouseMovement !== undefined ? { disableSmoothMouseMovement: t.disableSmoothMouseMovement } : {}) });
      const kinds = { zooms: ['zoom', 'zoomId'], masks: ['mask', 'maskId'], layouts: ['layout', 'layoutId'] };
      const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[b % 62]).join('');
      // Refuses a range before anything is removed, so a failed update never loses the item.
      const checkRange = (col, id, start, end) => {
        if (!(end > start)) throw new Error('Item ' + id + ' would end (' + Math.round(end) + 'ms) before it starts (' + Math.round(start) + 'ms).');
        const other = col.serialize().find((x) => x.id !== id && x.sourceStartMs < end && x.sourceEndMs > start);
        if (other) throw new Error('Item ' + id + ' at ' + Math.round(start) + '-' + Math.round(end) + 'ms would overlap ' + other.id + ' (' + Math.round(other.sourceStartMs) + '-' + Math.round(other.sourceEndMs) + 'ms); nothing changed.');
      };
      // Puts a removed item back after a failed re-add, keeping its id when the app allows.
      const putBack = (col, base, label) => {
        const { id, ...rest } = base;
        let back = null;
        try { back = col.add(base); } catch {}
        if (!back) back = col.add(rest);
        if (!back) throw new Error(label + ' ' + id + ' was removed and could not be put back; restore the checkpoint.');
        return back.id;
      };
      // Chop the timeline the way a person would: split at each boundary, delete the unwanted pieces.
      const chop = async (o) => {
        const covered = (a, b) => o.slices.some((t) => a >= t.startMs - 1 && b <= t.endMs + 1);
        const bounds = [...new Set(o.slices.flatMap((t) => [t.startMs, t.endMs]))].sort((a, b) => a - b);
        for (const b of bounds) if (sc.slices.canSplitAt(b)) { await at(b); sc.slices.splitAt(b); await wait(STEP * 0.6); }
        for (const piece of sc.slices.serialize())
          if (!covered(piece.sourceStartMs, piece.sourceEndMs)) { await at((piece.sourceStartMs + piece.sourceEndMs) / 2); select({ type: 'slice', sliceId: piece.id }); await wait(STEP * 0.5); sc.slices.remove(piece.id); await wait(STEP * 0.6); }
        for (const t of o.slices) {
          const item = sc.slices.all.find((x) => Math.abs(x.sourceStartMs - t.startMs) < 2);
          const changes = { ...extras(t), ...(Math.abs((item?.timeScale ?? 1) - 1 / t.speed) > 0.001 ? { timeScale: 1 / t.speed } : {}) };
          if (item && Object.keys(changes).length) { select({ type: 'slice', sliceId: item.id }); try { item.update(changes); } catch {} await wait(STEP * 0.6); }
        }
      };
      const zoomItem = (o, base) => ({
        ...(base ?? {}),
        zoom: o.zoom ?? base?.zoom ?? 1.5,
        type: (o.follow ?? (base ? base.type !== 'manual' : false)) ? 'follow-click-groups' : 'manual',
        manualTargetPoint: o.target ?? base?.manualTargetPoint ?? { x: 0.5, y: 0.5 },
        isDisabled: base?.isDisabled ?? false,
        sourceStartMs: o.startMs ?? base.sourceStartMs,
        sourceEndMs: o.endMs ?? base.sourceEndMs,
        hasInstantAnimation: o.instant ?? base?.hasInstantAnimation ?? false,
        presentation: o.presentation ?? base?.presentation ?? 'screen',
        loupeOptions: { ...(base?.loupeOptions ?? { radius01: 0.35, bevelRatio: 0.2, chromaticAberration: 0.5, hasGlassOptics: true }), ...(o.loupe ?? {}) },
      });
      const addZoom = (item) => {
        const added = sc.zooms.add(item);
        if (!added) throw new Error('Zoom ' + Math.round(item.sourceStartMs) + '-' + Math.round(item.sourceEndMs) + 'ms overlaps another zoom. Remove or shorten that one first.');
        return { zoomId: added.id, startMs: Math.round(added.sourceStartMs), endMs: Math.round(added.sourceEndMs), trimmed: Math.abs(added.sourceStartMs - item.sourceStartMs) > 1 || Math.abs(added.sourceEndMs - item.sourceEndMs) > 1 };
      };
      __ss.busy()[${j(path)}] = { since: Date.now() };
      let failedAt, error;
      try {
      for (const [i, o] of ops.entries()) {
        if (__ss.busy()[${j(path)}]?.cancel) { failedAt = i; error = 'Cancelled before this op.'; break; }
        try {
        if (o.op === 'setSlices') {
          if (SHOW) { track('slices'); await chop(o); }
          const exact = sc.slices.serialize();
          const matches = exact.length === o.slices.length && o.slices.every((t, i) => Math.abs(exact[i].sourceStartMs - t.startMs) < 2 && Math.abs(exact[i].sourceEndMs - t.endMs) < 2 && Math.abs(exact[i].timeScale - 1 / t.speed) < 0.001);
          if (!matches)
            sc.slices.replace(o.slices.map((s) => ({ ...clipFields(exact, s), id: newId(), sourceStartMs: s.startMs, sourceEndMs: s.endMs, timeScale: 1 / s.speed, ...extras(s) })));
          const now = sc.slices.serialize();
          if (now.length !== o.slices.length) throw new Error('Screen Studio kept ' + now.length + ' of ' + o.slices.length + ' slices. Read the editor state and adjust.');
          // Ranges that already match skip replace(), so per-clip settings are written here.
          for (const [k, t] of o.slices.entries()) {
            const want = extras(t);
            const changes = Object.fromEntries(Object.entries(want).filter(([f, v]) => now[k][f] !== v));
            const item = sc.slices.all.find((x) => x.id === now[k].id);
            if (item && Object.keys(changes).length) item.update(changes);
          }
          out.push({ op: o.op, slices: now.length });
        } else if (o.op === 'clearZooms') {
          track('zooms'); await wait(STEP * 0.4);
          sc.zooms.removeAll();
          await wait(STEP * 0.4);
          out.push({ op: o.op });
        } else if (o.op === 'removeZoom') {
          if (!sc.zooms.remove(o.zoomId)) throw new Error('Zoom ' + o.zoomId + ' does not exist.');
          out.push({ op: o.op, zoomId: o.zoomId });
        } else if (o.op === 'addZoom') {
          track('zooms'); await at(o.startMs);
          const r = addZoom(zoomItem(o));
          select({ type: 'zoom', zoomId: r.zoomId }); await wait(STEP);
          out.push({ op: o.op, ...r });
        } else if (o.op === 'updateZoom') {
          const base = sc.zooms.serialize().find((z) => z.id === o.zoomId);
          if (!base) throw new Error('Zoom ' + o.zoomId + ' does not exist.');
          const { id, ...rest } = base;
          const item = zoomItem(o, rest);
          checkRange(sc.zooms, o.zoomId, item.sourceStartMs, item.sourceEndMs);
          await at(base.sourceStartMs); select({ type: 'zoom', zoomId: o.zoomId }); await wait(STEP * 0.5);
          sc.zooms.remove(o.zoomId);
          let r;
          try { r = addZoom(item); } catch (e) {
            const kept = putBack(sc.zooms, base, 'Zoom');
            throw new Error(e.message + (kept === o.zoomId ? ' Zoom ' + o.zoomId + ' was kept as it was.' : ' Zoom ' + o.zoomId + ' was kept as it was, now with id ' + kept + '.'));
          }
          select({ type: 'zoom', zoomId: r.zoomId }); await wait(STEP * 0.7);
          out.push({ op: o.op, replaced: o.zoomId, ...r });
        } else if (o.op === 'addLayout') {
          const item = { type: o.type, sourceStartMs: o.startMs, sourceEndMs: o.endMs, isDisabled: false, version: 2, cameraOverlay: { overlayCameraPosition01: { x: 1, y: 1 } }, splitScreen: {}, fullscreenCamera: {}, screenOnly: {}, cutoutCamera: { cutoutCameraPositionX01: 1 } };
          for (const [k, v] of Object.entries(o.options ?? {})) item[k] = { ...item[k], ...v };
          track('camera-mode'); await at(o.startMs);
          const added = sc.layouts.add(item);
          if (!added) throw new Error('Layout ' + o.startMs + '-' + o.endMs + 'ms overlaps another layout.');
          select({ type: 'layout', layoutId: added.id }); await wait(STEP);
          out.push({ op: o.op, id: added.id, startMs: Math.round(added.sourceStartMs), endMs: Math.round(added.sourceEndMs) });
        } else if (o.op === 'addMask') {
          const item = { type: o.type, sourceStartMs: o.startMs, sourceEndMs: o.endMs, isDisabled: false };
          if (o.bounds) item.bounds = o.bounds;
          if (o.blur !== undefined) item.blur = o.blur;
          if (o.highlightOpacity !== undefined) item.highlightMaskOpacity = o.highlightOpacity;
          track('masks'); await at(o.startMs);
          const added = sc.masks.add(item);
          if (!added) throw new Error('Mask ' + o.startMs + '-' + o.endMs + 'ms overlaps another mask.');
          select({ type: 'mask', maskId: added.id }); await wait(STEP);
          out.push({ op: o.op, id: added.id, startMs: Math.round(added.sourceStartMs), endMs: Math.round(added.sourceEndMs) });
        } else if (o.op === 'updateItem') {
          const col = sc[o.track];
          const base = col.serialize().find((x) => x.id === o.id);
          if (!base) throw new Error(o.track + ' item ' + o.id + ' does not exist.');
          const kind = kinds[o.track];
          const { id, ...rest } = base;
          const merged = { ...rest, ...(o.fields ?? {}), sourceStartMs: o.startMs ?? base.sourceStartMs, sourceEndMs: o.endMs ?? base.sourceEndMs };
          checkRange(col, o.id, merged.sourceStartMs, merged.sourceEndMs);
          await at(base.sourceStartMs); select({ type: kind[0], [kind[1]]: o.id }); await wait(STEP * 0.5);
          col.remove(o.id);
          let added = null;
          try { added = col.add(merged); } catch {}
          if (!added) {
            const kept = putBack(col, base, o.track + ' item');
            throw new Error('Screen Studio refused the updated ' + o.track + ' item ' + o.id + '; it was kept as it was' + (kept === o.id ? '.' : ', now with id ' + kept + '.'));
          }
          select({ type: kind[0], [kind[1]]: added.id }); await wait(STEP * 0.7);
          out.push({ op: o.op, replaced: o.id, id: added.id });
        } else if (o.op === 'removeItem') {
          if (!sc[o.track].remove(o.id)) throw new Error(o.track + ' item ' + o.id + ' does not exist.');
          out.push({ op: o.op, id: o.id });
        } else if (o.op === 'clearTrack') {
          track(o.track === 'layouts' ? 'camera-mode' : o.track); await wait(STEP * 0.4);
          sc[o.track].removeAll();
          await wait(STEP * 0.4);
          out.push({ op: o.op, track: o.track });
        } else if (o.op === 'duplicateItem') {
          const col = sc[o.track]; const item = col.all.find((x) => x.id === o.id);
          if (!item) throw new Error(o.track + ' item ' + o.id + ' does not exist.');
          await at(item.sourceStartMs);
          const before = new Set(col.all.map((x) => x.id));
          col.duplicate(item);
          const created = col.all.find((x) => !before.has(x.id));
          if (!created) throw new Error('No free space after ' + o.id + ' to duplicate into.');
          const kind = kinds[o.track];
          select({ type: kind[0], [kind[1]]: created.id });
          out.push({ op: o.op, id: created.id, startMs: Math.round(created.sourceStartMs), endMs: Math.round(created.sourceEndMs) }); await wait(STEP);
        } else if (o.op === 'setTrackDisabled') {
          track(o.track === 'layouts' ? 'camera-mode' : o.track); await wait(STEP * 0.4);
          for (const item of sc[o.track].all) { try { item.update({ isDisabled: o.disabled }); } catch {} await wait(STEP * 0.15); }
          out.push({ op: o.op, track: o.track, disabled: o.disabled });
        } else if (o.op === 'restoreAutoZooms') {
          track('zooms'); await wait(STEP * 0.4);
          sc.resetZoomRanges();
          out.push({ op: o.op, zooms: sc.zooms.length }); await wait(STEP);
        } else if (o.op === 'splitAt') {
          track('slices'); await at(o.atMs);
          if (!sc.slices.canSplitAt(o.atMs)) throw new Error('Cannot split at ' + o.atMs + 'ms (already a cut, or outside the kept footage).');
          sc.slices.splitAt(o.atMs);
          out.push({ op: o.op, atMs: o.atMs }); await wait(STEP * 0.6);
        } else if (o.op === 'cutRange') {
          track('slices');
          for (const b of [o.startMs, o.endMs]) if (sc.slices.canSplitAt(b)) { await at(b); sc.slices.splitAt(b); await wait(STEP * 0.5); }
          let removed = 0;
          for (const piece of sc.slices.serialize())
            if (piece.sourceStartMs >= o.startMs - 1 && piece.sourceEndMs <= o.endMs + 1) { await at((piece.sourceStartMs + piece.sourceEndMs) / 2); select({ type: 'slice', sliceId: piece.id }); await wait(STEP * 0.4); sc.slices.remove(piece.id); removed++; await wait(STEP * 0.5); }
          // A boundary that could not be split leaves part of the range on screen.
          const left = sc.slices.serialize().filter((p) => Math.min(p.sourceEndMs, o.endMs) - Math.max(p.sourceStartMs, o.startMs) > 1);
          if (left.length) throw new Error('cutRange ' + o.startMs + '-' + o.endMs + 'ms could not split at an existing cut nearby, so kept footage still overlaps it at ' + left.map((p) => Math.round(Math.max(p.sourceStartMs, o.startMs)) + '-' + Math.round(Math.min(p.sourceEndMs, o.endMs)) + 'ms').join(', ') + '. Use a range that ends on the existing cut, or removeSlice.');
          out.push({ op: o.op, removedPieces: removed, ...(removed === 0 ? { alreadyCut: true } : {}) });
        } else if (o.op === 'removeSlice') {
          const piece = sc.slices.all.find((x) => x.id === o.id);
          if (!piece) throw new Error('Slice ' + o.id + ' does not exist.');
          await at((piece.sourceStartMs + piece.sourceEndMs) / 2); select({ type: 'slice', sliceId: o.id }); await wait(STEP * 0.4);
          sc.slices.remove(o.id);
          out.push({ op: o.op, id: o.id }); await wait(STEP * 0.5);
        } else if (o.op === 'mergeSlices') {
          const piece = sc.slices.all.find((x) => x.id === o.id);
          if (!piece) throw new Error('Slice ' + o.id + ' does not exist.');
          await at(piece.sourceStartMs); select({ type: 'slice', sliceId: o.id }); await wait(STEP * 0.4);
          const ok = o.with === 'next' ? piece.mergeWithNext() : piece.mergeWithPrevious();
          if (ok === false) throw new Error('Cannot merge slice ' + o.id + ' with the ' + o.with + ' one.');
          out.push({ op: o.op, id: o.id }); await wait(STEP * 0.5);
        } else if (o.op === 'updateSlice') {
          const piece = sc.slices.all.find((x) => x.id === o.id);
          if (!piece) throw new Error('Slice ' + o.id + ' does not exist.');
          await at(piece.sourceStartMs); select({ type: 'slice', sliceId: o.id }); await wait(STEP * 0.4);
          const { op: _op, id: _id, speed, ...rest } = o;
          piece.update({ ...rest, ...(speed !== undefined ? { timeScale: 1 / speed } : {}) });
          out.push({ op: o.op, id: o.id }); await wait(STEP * 0.5);
        } else if (o.op === 'resetCuts') {
          track('slices'); await wait(STEP * 0.4);
          sc.resetSlices();
          out.push({ op: o.op }); await wait(STEP * 0.6);
        } else if (o.op === 'config') {
          if (SHOW) {
            // One panel, one control at a time, so each change is visible.
            for (const [group, fields] of Object.entries(o.partial)) {
              root(ROOTS[group] ?? 'background'); await wait(STEP * 0.6);
              for (const [field, value] of Object.entries(fields)) { c.project.projectConfig.update({ [group]: { [field]: value } }); await wait(STEP * 0.45); }
            }
          } else c.project.projectConfig.update(o.partial);
          // Read back the actual model, including values the app may clamp or ignore.
          const actual = c.project.serialize().config;
          const check = (wanted, got, key) => {
            if (wanted && typeof wanted === 'object' && !Array.isArray(wanted)) {
              for (const [field, value] of Object.entries(wanted)) check(value, got?.[field], key ? key + '.' + field : field);
            } else if (JSON.stringify(wanted) !== JSON.stringify(got))
              throw new Error('Setting ' + key + ' did not keep the requested value. Read the editor state before continuing.');
          };
          check(o.partial, actual, '');
          out.push({ op: o.op, groups: Object.keys(o.partial) });
        }
        } catch (e) { failedAt = i; error = e?.message ?? String(e); break; }
      }
      } finally {
        delete __ss.busy()[${j(path)}];
        if (SHOW) { try { view.closeSidebarItem?.(); pb.goTo(0); } catch {} }
      }
      return failedAt === undefined ? { results: out } : { results: out, failedAt, error };
    `;
