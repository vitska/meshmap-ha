const VENDOR = '/local/meshmap/vendor';
const PMTILES_URL = '/local/meshmap/area.pmtiles';
const TILES_URL = '/api/meshmap_vector/{z}/{x}/{y}';
const FONTS_URL = '/api/meshmap_vector/fonts';
const SPRITES_URL = '/api/meshmap_vector/sprites';

let libsPromise = null;
let pmtilesPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('failed to load ' + src));
    document.head.appendChild(script);
  });
}
function loadCss(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}
function loadLibs() {
  if (libsPromise) return libsPromise;
  libsPromise = (async () => {
    loadCss(`${VENDOR}/maplibre-gl.css`);
    if (!window.maplibregl) await loadScript(`${VENDOR}/maplibre-gl.js`);
    if (!window.maplibregl) throw new Error('maplibre unavailable');
  })();
  return libsPromise;
}
function loadPmtiles() {
  if (pmtilesPromise) return pmtilesPromise;
  pmtilesPromise = (async () => {
    // Static .pbf tiles are used for the basemap; only the optional rich
    // style helper (basemaps.js) is loaded here.
    if (!window.basemaps) {
      try {
        await loadScript(`${VENDOR}/basemaps.js`);
      } catch (error) {
        console.warn('mesh-map: basemaps unavailable, using minimal style', error);
      }
    }
  })();
  return pmtilesPromise;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}
function colorFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return hslToHex(hash % 360, 72, 52);
}

function hslToHex(hue, saturation, lightness) {
  const s = saturation / 100;
  const l = lightness / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (value) => Math.round((value + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

const TRACK_STEP_METERS = 6;
const TRACK_MAX_POINTS = 20000;
const TRACK_DEVICE_POINTS = 20000;
const TRACK_MIN_PER_DEVICE = 200;
// Live trails: positions are appended as states arrive, so the track grows
// while a node moves instead of waiting for the next history refresh.
const LIVE_MAX_POINTS = 4000;
const LIVE_JUMP_METERS = 5000;

// History window: the card asks Home Assistant for this many hours of state
// history on first load. Override with `history_hours:` in the card config;
// the Tracks selector can still change it for the current session.
const DEFAULT_HISTORY_HOURS = 1;
const MAX_HISTORY_HOURS = 168;
const HISTORY_CHOICES = [1, 6, 12, 24, 48, 72, 168];

function normalizeHistoryHours(value) {
  const hours = Math.round(Number(value));
  if (!Number.isFinite(hours) || hours < 1) return DEFAULT_HISTORY_HOURS;
  return Math.min(hours, MAX_HISTORY_HOURS);
}

function historyLabel(hours) {
  if (hours === 48) return '2 days';
  if (hours === 72) return '3 days';
  if (hours === 168) return '7 days';
  return `${hours} h`;
}

// Basemap extract bounds (south,west / north,east), finest zoom first.
//  z14-15 : detailed local extract
//  z13    : ~110 km around home
//  z9-12  : ~200 km around home
//  z0-8   : wide regional extract
const TILE_TIERS = [
  { zoom: 14, bounds: [[54.7753, 23.7305], [55.0406, 24.082]] },
  { zoom: 13, bounds: [[54.3, 22.7], [55.5, 25.1]] },
  { zoom: 9, bounds: [[53.9, 20.9], [56.5, 27.0]] },
  { zoom: 0, bounds: [[52.4, 19.4], [58.6, 29.2]] },
];
const DEFAULT_TILE_BOUNDS = TILE_TIERS[TILE_TIERS.length - 1].bounds;
const CDN_GLYPHS_URL = 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf';
const CDN_SPRITE_URL = 'https://protomaps.github.io/basemaps-assets/sprites/v4/light';
const NETWORK_GLYPHS = {
  Meshtastic: 'M',
  MeshCore: 'C',
  Reticulum: 'R',
  MQTT: 'Q',
  Phones: 'P',
  People: 'H',
};

function glyphFor(entry, overrides) {
  if (overrides && typeof overrides[entry.id] === 'string' && overrides[entry.id]) {
    return overrides[entry.id].slice(0, 2);
  }
  return NETWORK_GLYPHS[entry.group] || (entry.name || '?').trim().charAt(0).toUpperCase();
}

const ALLOWED_SHAPES = ['circle', 'square', 'triangle', 'diamond', 'star', 'hexagon', 'pin'];
const DEFAULT_SHAPES = {
  Meshtastic: 'circle',
  MeshCore: 'diamond',
  Reticulum: 'hexagon',
  MQTT: 'square',
  Phones: 'pin',
  People: 'star',
};

function shapeFor(entry, config) {
  const overrides = config.shapes || {};
  const defaults = config.shape_defaults || {};
  const shape = overrides[entry.id] || defaults[entry.group] || DEFAULT_SHAPES[entry.group] || 'circle';
  return ALLOWED_SHAPES.includes(shape) ? shape : 'circle';
}

function metersBetween(a, b) {
  const midLat = (((a[1] + b[1]) / 2) * Math.PI) / 180;
  const dx = (b[0] - a[0]) * 111320 * Math.cos(midLat);
  const dy = (b[1] - a[1]) * 110540;
  return Math.hypot(dx, dy);
}

const LOCAL_LAYERS = [
  { id: 'background', type: 'background', paint: { 'background-color': '#eef0e6' } },
  { id: 'water', type: 'fill', source: 'protomaps', 'source-layer': 'water', paint: { 'fill-color': '#a9d3e0' } },
  { id: 'landcover', type: 'fill', source: 'protomaps', 'source-layer': 'landcover', paint: { 'fill-color': '#dbe8cf', 'fill-opacity': 0.7 } },
  { id: 'landuse', type: 'fill', source: 'protomaps', 'source-layer': 'landuse', paint: { 'fill-color': '#e6e2d3', 'fill-opacity': 0.6 } },
  { id: 'buildings', type: 'fill', source: 'protomaps', 'source-layer': 'buildings', paint: { 'fill-color': '#d8d0c8' } },
  {
    id: 'roads-casing',
    type: 'line',
    source: 'protomaps',
    'source-layer': 'roads',
    paint: { 'line-color': '#c9c2b6', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 15, 6] },
  },
  {
    id: 'roads',
    type: 'line',
    source: 'protomaps',
    'source-layer': 'roads',
    paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 15, 4] },
  },
  { id: 'boundaries', type: 'line', source: 'protomaps', 'source-layer': 'boundaries', paint: { 'line-color': '#9a8f80', 'line-width': 1, 'line-dasharray': [3, 2] } },
];

class MeshMapCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._ready = false;
    this._busy = false;
    this._trailsAt = 0;
    this._entries = [];
    this._mode = 'remote';
    this._styleLoaded = false;
    this._tileErrors = 0;
    this._hidden = new Set();
    this._q = '';
    this._hours = DEFAULT_HISTORY_HOURS;
    this._configHours = DEFAULT_HISTORY_HOURS;
    this._assets = undefined;
    this._trailLayers = [];
    this._tracks = 0;
    this._live = new Map();
    this._trailSig = '';
    this._showHops = true;
    this._links = 0;
    this._trailsLoading = false;
    this._trailToken = 0;
    this._trackDots = 0;
    this._listSig = '';
    this._selected = null;
  }

  setConfig(config) {
    this.config = config || {};
    this._hidden = this._loadHidden();
    const hours = normalizeHistoryHours(this.config.history_hours);
    if (hours !== this._configHours) {
      this._configHours = hours;
      this._hours = hours;
      if (this._ready) {
        this._syncHistorySelect();
        this._clearTrails();
        this._trailsAt = 0;
        this._trailSig = '';
        this._update();
      }
    }
  }

  _hoursOptions() {
    const values = new Set(HISTORY_CHOICES);
    values.add(this._hours);
    return [...values]
      .sort((a, b) => a - b)
      .map(
        (hours) =>
          `<option value="${hours}"${hours === this._hours ? ' selected' : ''}>` +
          `${historyLabel(hours)}</option>`,
      )
      .join('');
  }

  _syncHistorySelect() {
    const select = this.shadowRoot?.getElementById?.('fHours');
    if (select) select.value = String(this._hours);
  }

  _hiddenKey() {
    return `meshmap:hidden:${this._cardName()}`;
  }

  _viewKey() {
    return `meshmap:view:${this._cardName()}`;
  }

  _cardName() {
    const cfg = this.config || {};
    return cfg.title || cfg.zone || (cfg.entities || []).join(',') || 'mesh-map';
  }

  _loadView() {
    try {
      const raw = window.localStorage.getItem(this._viewKey());
      if (!raw) return null;
      const view = JSON.parse(raw);
      const lng = Number(view?.lng);
      const lat = Number(view?.lat);
      const zoom = Number(view?.zoom);
      if (!Number.isFinite(lng) || !Number.isFinite(lat) || !Number.isFinite(zoom)) return null;
      if (Math.abs(lng) > 180 || Math.abs(lat) > 85 || zoom < 0 || zoom > 20) return null;
      return { lng, lat, zoom };
    } catch (error) {
      return null;
    }
  }

  _saveView() {
    if (!this._map) return;
    try {
      const center = this._map.getCenter();
      window.localStorage.setItem(
        this._viewKey(),
        JSON.stringify({
          lat: Number(center.lat.toFixed(6)),
          lng: Number(center.lng.toFixed(6)),
          zoom: Number(this._map.getZoom().toFixed(2)),
        }),
      );
    } catch (error) {
      // private mode or quota - position simply is not remembered
    }
  }

  _loadHidden() {
    try {
      const raw = window.localStorage.getItem(this._hiddenKey());
      if (!raw) return new Set();
      const ids = JSON.parse(raw);
      if (!Array.isArray(ids)) return new Set();
      return new Set(ids.filter((id) => typeof id === 'string'));
    } catch (error) {
      return new Set();
    }
  }

  _saveHidden() {
    try {
      window.localStorage.setItem(
        this._hiddenKey(),
        JSON.stringify(Array.from(this._hidden)),
      );
    } catch (error) {
      // private mode or quota - selection simply is not persisted
    }
  }

  connectedCallback() {
    this._ensure();
    if (this._map) this._syncSize();
  }

  disconnectedCallback() {
    if (this._sizeTimer) clearInterval(this._sizeTimer);
    this._sizeTimer = null;
    if (this._onWindowResize) window.removeEventListener('resize', this._onWindowResize);
    this._onWindowResize = null;
    if (this._resizeObserver) this._resizeObserver.disconnect();
    this._resizeObserver = null;
  }

  /**
   * Keep the canvas in step with the card box. HA often mounts the card at a
   * provisional size (and the panel/header can change it afterwards); a stale
   * size leaves tiles only in the old viewport and markers at old positions.
   */
  _syncSize() {
    if (!this._map) return;
    const container = this._map.getContainer();
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (!width || !height) return;
    if (width === this._mapWidth && height === this._mapHeight) return;
    this._mapWidth = width;
    this._mapHeight = height;
    this._map.resize();
    this._applyCoverage();
    this._map.triggerRepaint();
  }

  /**
   * The local basemap is an extract, not the whole planet: keep the view inside
   * its bounds and never zoom out past the point where the viewport would need
   * tiles that do not exist (they show as empty background otherwise).
   */
  _applyCoverage() {
    if (!this._map) return;
    const tiers = this.config.tile_tiers || TILE_TIERS;
    if (!Array.isArray(tiers) || !tiers.length) return;
    const bounds = this._coverageForZoom(this._map.getZoom(), tiers);
    const key = JSON.stringify(bounds);
    this._tileBounds = bounds;
    if (this._coverageApplied !== key) {
      this._coverageApplied = key;
      this._map.setMaxBounds([[bounds[0][1], bounds[0][0]], [bounds[1][1], bounds[1][0]]]);
    }
    // Zoom-out limit comes from the widest tier, so the viewport always stays
    // inside tiles that actually exist.
    const minZoom = this._coverageMinZoom(tiers[tiers.length - 1].bounds);
    if (Number.isFinite(minZoom)) {
      this._map.setMinZoom(Math.max(1, minZoom));
    }
  }

  _coverageForZoom(zoom, tiers) {
    for (const tier of tiers) {
      if (zoom >= tier.zoom) return tier.bounds;
    }
    return tiers[tiers.length - 1].bounds;
  }

  _coverageMinZoom(bounds) {
    const container = this._map.getContainer();
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (!width || !height) return NaN;
    const south = bounds[0][0];
    const west = bounds[0][1];
    const north = bounds[1][0];
    const east = bounds[1][1];
    const lonSpan = ((east - west) * Math.PI) / 180;
    const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const mercSpan = Math.abs(merc(north) - merc(south));
    if (lonSpan <= 0 || mercSpan <= 0) return NaN;
    const zoomLon = Math.log2((2 * Math.PI * width) / (256 * lonSpan));
    const zoomLat = Math.log2((2 * Math.PI * height) / (256 * mercSpan));
    return Math.max(zoomLon, zoomLat);
  }

  _startSizeWatch(container) {
    if (this._resizeObserver) {
      this._syncSize();
      return;
    }
    this._resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => this._syncSize());
    });
    this._resizeObserver.observe(container);
    this._onWindowResize = () => this._syncSize();
    window.addEventListener('resize', this._onWindowResize);
    // Belt and braces: HA grid/panel changes do not always emit a resize.
    this._sizeTimer = setInterval(() => this._syncSize(), 2000);
    this._syncSize();
  }

  set hass(hass) {
    this._hass = hass;
    this._ensure();
    if (this._ready) this._update();
  }

  getCardSize() {
    return 8;
  }

  _setStatus(text) {
    const el = this.shadowRoot.getElementById('status');
    if (el) el.textContent = text;
  }

  _syncCounts() {
    const counts = this.shadowRoot.getElementById('counts');
    if (!counts) return;
    const shown = (this._entries || []).length;
    const total = (this._allFull || []).length;
    const tracks = this._trailsLoading ? 'loading…' : String(this._tracks);
    counts.textContent = `${shown}/${total} shown · tracks ${tracks}`;
  }

  _setTracksLoading(flag) {
    this._trailsLoading = flag;
    const spin = this.shadowRoot.getElementById('fSpin');
    if (spin) spin.hidden = !flag;
    const hours = this.shadowRoot.getElementById('fHours');
    if (hours) {
      hours.disabled = flag;
      hours.title = flag ? 'loading history…' : '';
    }
    this._syncCounts();
  }

  _clearTrails() {
    if (!this._map) return;
    const trails = this._map.getSource('trails');
    if (trails) trails.setData({ type: 'FeatureCollection', features: [] });
    const points = this._map.getSource('trackpoints');
    if (points) points.setData({ type: 'FeatureCollection', features: [] });
    this._live.clear();
    this._trailSig = '';
    this._renderTrailLayers([]);
    this._tracks = 0;
    this._trackDots = 0;
    this._syncCounts();
  }

  async _waitForSize(container, timeoutMs) {
    if (!container) return;
    const started = Date.now();
    while (container.clientWidth === 0 || container.clientHeight === 0) {
      if (Date.now() - started > timeoutMs) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  _updateDiag() {
    const el = this.shadowRoot.getElementById('diag');
    if (!el || !this._map) return;
    const center = this._map.getCenter();
    const source = this._map.getSource('protomaps');
    const loaded = source && typeof source.loaded === 'function' ? (source.loaded() ? 1 : 0) : '?';
    const container = this.shadowRoot.getElementById('map');
    const size = `${container ? container.clientWidth : 0}x${container ? container.clientHeight : 0}`;
    let layerCount = 0;
    let featureCount = 0;
    let tilesLoaded = '?';
    try {
      layerCount = (this._map.getStyle()?.layers || []).length;
      featureCount = this._map.querySourceFeatures('protomaps', { sourceLayer: 'earth' }).length;
      tilesLoaded = this._map.areTilesLoaded() ? '1' : '0';
    } catch (error) {
      featureCount = -1;
    }
    el.textContent =
      `v64 ${this._mode} z${this._map.getZoom().toFixed(1)} ` +
      `${center.lat.toFixed(3)},${center.lng.toFixed(3)} ` +
      `L${layerCount} F${featureCount} T${tilesLoaded} src${loaded} err${this._tileErrors} ` +
      `${size}`;
  }

  async _localTilesAvailable() {
    try {
      const sample = TILES_URL.replace('{z}/{x}/{y}', '0/0/0');
      const response = await fetch(sample, { cache: 'no-store' });
      // HA views answer GET only; a 405 still proves the endpoint exists.
      return response.ok || response.status === 405 || response.status === 416;
    } catch {
      return false;
    }
  }

  /**
   * Protomaps' rich style carries the label layers (cities, streets, water,
   * POIs). They need glyphs for text and a sprite for icons, so `labels` is
   * only enabled when both assets were found; otherwise the same style is used
   * without its symbol layers and the map still renders cleanly.
   */
  _localStyle({ full = true, labels = false, glyphs = null, sprite = null } = {}) {
    let layers = LOCAL_LAYERS;
    if (full) {
      try {
        if (window.basemaps && window.basemaps.layers && window.basemaps.LIGHT) {
          const rich = window.basemaps.layers('protomaps', window.basemaps.LIGHT, { lang: 'en' });
          const styled = Array.isArray(rich)
            ? rich.filter((layer) => labels || layer.type !== 'symbol')
            : [];
          if (styled.length > 0) {
            layers = styled;
          }
        }
      } catch (error) {
        console.warn('mesh-map: full basemap style failed, using minimal', error);
      }
    }
    const style = {
      version: 8,
      // Device pins are symbol layers too, so glyphs are always needed even
      // when the basemap's own label layers are disabled.
      glyphs: glyphs || CDN_GLYPHS_URL,
      sources: {
        protomaps: {
          type: 'vector',
          tiles: [`${location.origin}${TILES_URL}`],
          minzoom: 0,
          maxzoom: 15,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        },
      },
      layers,
    };
    if (labels && sprite) style.sprite = sprite;
    return style;
  }

  async _urlOk(url, timeout = 2500) {
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        signal: AbortSignal.timeout(timeout),
      });
      // HA views answer GET only; a 405 still proves the endpoint exists.
      return response.ok || response.status === 405;
    } catch {
      return false;
    }
  }

  /**
   * Prefer the tile service's own glyph/sprite endpoints (same origin, cached
   * by HA, no CDN dependency) and fall back to the Protomaps CDN for an older
   * integration that only serves tiles.
   */
  async _chooseAssets() {
    if (this._assets !== undefined) return this._assets;

    const origin = location.origin;
    const localGlyphs = `${origin}${FONTS_URL}/{fontstack}/{range}`;
    const localSprite = `${origin}${SPRITES_URL}/light`;
    const localFont = await this._urlOk(
      `${origin}${FONTS_URL}/Noto%20Sans%20Regular/0-255.pbf`,
    );

    if (localFont) {
      const localSpriteOk = await this._urlOk(`${localSprite}.json`);
      const cdnSpriteOk = localSpriteOk ? false : await this._urlOk(`${CDN_SPRITE_URL}.json`);
      this._assets = {
        glyphs: localGlyphs,
        sprite: localSpriteOk ? localSprite : cdnSpriteOk ? CDN_SPRITE_URL : null,
      };
      return this._assets;
    }

    const cdnFont = await this._urlOk(
      CDN_GLYPHS_URL.replace('{fontstack}/{range}', 'Noto%20Sans%20Regular/0-255'),
    );
    if (cdnFont) {
      const cdnSpriteOk = await this._urlOk(`${CDN_SPRITE_URL}.json`);
      this._assets = {
        glyphs: CDN_GLYPHS_URL,
        sprite: cdnSpriteOk ? CDN_SPRITE_URL : null,
      };
    } else {
      this._assets = null;
    }
    return this._assets;
  }

  async _ensure() {
    if (this._ready || this._busy || !this._hass) return;
    this._busy = true;
    const height = this.config.height || 'calc(100vh - 120px)';
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; position: relative; }
        #map { height: ${height}; width: 100%; border-radius: 8px; background: #0b0f14; }
        .panel {
          position: absolute; z-index: 500; top: 10px; left: 10px;
          background: rgba(20,20,20,.9); color: #eee; padding: 6px 8px;
          border-radius: 6px; font: 12px system-ui, sans-serif; line-height: 1.45;
          width: 230px; max-width: calc(100% - 20px); max-height: calc(100% - 20px);
          overflow: auto; box-sizing: border-box;
        }
        .panel summary { cursor: pointer; font-weight: 600; margin-bottom: 4px; }
        .panel input[type="text"] {
          width: 100%; box-sizing: border-box; margin: 2px 0 4px; padding: 3px 6px;
          border-radius: 4px; border: 1px solid #555; background: #222; color: #eee; font-size: 12px;
        }
        .panel .item { display: flex; align-items: center; gap: 6px; cursor: pointer; }
        .panel .item span.name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .panel .sw {
          width: 13px; height: 13px; border-radius: 50%; flex: 0 0 auto;
          display: inline-flex; align-items: center; justify-content: center;
          color: #fff; font-size: 8px; font-weight: 700; line-height: 1;
        }
        .panel .group {
          display: flex; align-items: center; justify-content: space-between;
          color: #9aa; margin: 5px 0 1px; font-size: 11px;
          text-transform: uppercase; letter-spacing: .04em;
        }
        .panel .group button {
          text-transform: none; letter-spacing: 0; margin-left: 2px; padding: 0 4px;
        }
        .panel .row { display: flex; justify-content: space-between; margin-top: 4px; }
        .panel .muted { color: #999; font-size: 11px; }
        .panel button {
          background: #333; color: #ddd; border: 1px solid #555; border-radius: 4px;
          font-size: 11px; padding: 1px 6px; cursor: pointer; margin-left: 4px;
        }
        .panel .hours {
          display: flex; align-items: center; justify-content: space-between;
          margin-top: 4px; gap: 6px;
        }
        .panel select {
          background: #222; color: #eee; border: 1px solid #555; border-radius: 4px;
          font-size: 11px; padding: 1px 4px;
        }
        .panel select:disabled { opacity: .6; }
        .spin {
          display: inline-block; width: 9px; height: 9px; margin-left: 5px;
          border: 2px solid #666; border-top-color: #4da3ff; border-radius: 50%;
          vertical-align: -1px; animation: mmspin .8s linear infinite;
        }
        .spin[hidden] { display: none; }
        @keyframes mmspin { to { transform: rotate(360deg); } }
        .info {
          position: absolute; z-index: 600; left: 10px; bottom: 10px;
          background: rgba(20,20,20,.94); color: #eee; padding: 8px 10px;
          border-radius: 6px; font: 12px system-ui, sans-serif; line-height: 1.45;
          width: 240px; max-width: calc(100% - 20px); max-height: 45%;
          overflow: auto; box-sizing: border-box; display: none;
        }
        .info .close {
          float: right; cursor: pointer; border: none; background: none; color: #bbb;
          font-size: 14px; line-height: 1; padding: 0;
        }
        .info .k { color: #999; }
        .panel.hidden { display: none; }
        .diag {
          display: none;
          position: absolute; right: 6px; bottom: 6px; z-index: 600;
          font: 11px ui-monospace, monospace; color: #000;
          background: #ffcc00; padding: 3px 6px; border-radius: 3px;
          max-width: calc(100% - 12px); white-space: normal;
        }
        .diag.on { display: block; }
      </style>
      <div id="map"></div>
      <div class="panel${this.config.show_filter === false ? ' hidden' : ''}">
        <details open>
          <summary>${escapeHtml(this.config.title || 'Show on map')}</summary>
          <input type="text" id="fQuery" placeholder="search name…">
          <div style="text-align:right"><button id="allOn">all</button><button id="allOff">none</button></div>
          <label class="hours">Tracks:
            <select id="fHours">${this._hoursOptions()}</select><span id="fSpin" class="spin" hidden></span>
          </label>
          <label class="item"><input type="checkbox" id="fHops" checked>hop links</label>
          <div id="list"></div>
        </details>
        <div class="row"><span id="counts" class="muted"></span><span id="status" class="muted"></span></div>
      </div>
      <div class="info" id="info"></div>
      <div id="diag" class="diag${this.config.debug ? ' on' : ''}"></div>`;
    try {
      await loadLibs();
      const [tilesAvailable, assets] = await Promise.all([
        this._localTilesAvailable(),
        this._chooseAssets(),
      ]);
      if (!tilesAvailable) {
        throw new Error('local vector tiles missing (meshmap_vector)');
      }
      await loadPmtiles();
      const richStyle = Boolean(window.basemaps && window.basemaps.layers && window.basemaps.LIGHT);
      const labels = richStyle && Boolean(assets && assets.glyphs);
      const style = this._localStyle({
        full: richStyle,
        labels,
        glyphs: assets?.glyphs,
        sprite: assets?.sprite,
      });
      this._mode = 'local';
      this._setStatus(richStyle ? (labels ? 'local · labels' : 'local') : 'local (minimal)');

      const container = this.shadowRoot.getElementById('map');
      await this._waitForSize(container, 8000);
      this._map = new maplibregl.Map({
        container,
        style,
        center: [23.9, 54.9],
        zoom: 12,
        maxZoom: 16,
        attributionControl: true,
      });
      this._map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      this._applyCoverage();

      this._mapWidth = 0;
      this._mapHeight = 0;
      this._startSizeWatch(container);

      this._map.on('error', (event) => {
        const message = event?.error?.message || String(event?.error || event || '');
        this._tileErrors += 1;
        console.warn('mesh-map error:', message, event?.error || event);
        this._updateDiag();
      });
      let diagTicks = 0;
      const diagTimer = setInterval(() => {
        this._updateDiag();
        diagTicks += 1;
        if (diagTicks >= 15) clearInterval(diagTimer);
      }, 1000);
      this._updateDiag();

      this._map.on('load', () => {
        this._addLayers();
        this._trailsAt = 0;
        this._update();
        this._map.resize();
        this._updateDiag();
      });

      this._map.on('style.load', () => {
        this._styleLoaded = true;
        this._addLayers();
        this._trailsAt = 0;
        this._update();
        this._setStatus(this._mode);
        this._map.resize();
        this._updateDiag();
      });

      this._map.on('zoomend', () => {
        this._applyCoverage();
      });
      this._map.on('moveend', (event) => {
        this._updateDiag();
        // Only user gestures are remembered; programmatic fits (config bounds,
        // zone radius) must not overwrite the saved view.
        if (event?.originalEvent) this._saveView();
      });

      this._map.on('click', (event) => {
        const features = this._map.queryRenderedFeatures(event.point, { layers: ['devices-icons'] });
        if (!features.length) {
          this._select(null);
          return;
        }
        const props = features[0].properties;
        // Highlight the pin, then let Home Assistant open its usual entity
        // dialog - the same one any HA card shows. The in-card panel would be a
        // duplicate of it, so it stays hidden for pin clicks.
        this._select(props, { panel: false });
        this._openMoreInfo(props.id);
      });

      // Defensive: style.load can fire before handlers are attached in some
      // layouts (sections/grid), which would leave the card without pins/tracks.
      const ensureLayers = () => {
        try {
          if (this._map.isStyleLoaded()) this._styleLoaded = true;
          this._addLayers();
          this._trailsAt = 0;
          this._update();
        } catch (error) {
          console.warn('mesh-map: layer ensure failed', error);
        }
      };
      this._map.once('idle', ensureLayers);
      setTimeout(ensureLayers, 1500);

      this._bindPanel();
      this._ready = true;

      // If the rich style never finishes loading, fall back to the minimal
      // style rather than leaving a blank canvas.
      setTimeout(() => {
        if (!this._styleLoaded) {
          this._setStatus('local (fallback)');
          try {
            this._map.setStyle(this._localStyle({ full: false }));
          } catch (error) {
            console.warn('mesh-map: style fallback failed', error);
          }
        }
      }, 9000);

      // No runtime style switching: the local basemap must stay stable.
    } catch (error) {
      console.warn('mesh-map init failed:', error);
      const container = this.shadowRoot.querySelector('#map');
      if (container) container.textContent = 'map error: ' + error.message;
      this._setStatus('init error');
    } finally {
      this._busy = false;
    }
  }

  _openMoreInfo(entityId) {
    if (!entityId) return;
    // Standard HA entity dialog: any card can raise hass-more-info, and HA's
    // dialog listens on document. composed is required to cross the shadow root.
    this.dispatchEvent(
      new CustomEvent('hass-more-info', {
        detail: { entityId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  _select(props, options = {}) {
    this._selected = props || null;
    const info = this.shadowRoot.getElementById('info');
    const showPanel = options.panel !== false;
    if (!props) {
      if (info) {
        info.style.display = 'none';
        info.innerHTML = '';
      }
      if (this._map && this._map.getLayer('devices-selected')) {
        this._map.setFilter('devices-selected', ['==', ['get', 'id'], '']);
      }
      return;
    }
    if (this._map && this._map.getLayer('devices-selected')) {
      this._map.setFilter('devices-selected', ['==', ['get', 'id'], props.id]);
    }
    if (!info) return;
    if (!showPanel) {
      info.style.display = 'none';
      info.innerHTML = '';
      return;
    }
    const updated = new Date(Number(props.last)).toLocaleString();
    info.innerHTML =
      `<button class="close" title="close">×</button>` +
      `<b>${escapeHtml(props.name)}</b><br>` +
      `<span class="k">${['Phones', 'People'].includes(props.kind) ? 'Home Assistant' : props.kind + ' node'}</span><br>` +
      `<span class="k">entity:</span> ${escapeHtml(props.id)}<br>` +
      `<span class="k">state:</span> ${escapeHtml(props.state)}<br>` +
      `<span class="k">updated:</span> ${updated}`;
    info.style.display = 'block';
    const close = info.querySelector('.close');
    if (close) close.addEventListener('click', () => this._select(null));
  }

  _bindPanel() {
    const query = this.shadowRoot.getElementById('fQuery');
    if (query) {
      query.addEventListener('input', () => {
        this._q = query.value;
        this._trailsAt = 0;
        this._update();
      });
    }
    const hours = this.shadowRoot.getElementById('fHours');
    if (hours) {
      hours.addEventListener('change', () => {
        this._hours = normalizeHistoryHours(hours.value);
        this._trailsAt = 0;
        this._clearTrails();
        this._setTracksLoading(true);
        this._setStatus(`${this._mode} · loading tracks…`);
        this._update();
      });
    }
    const hops = this.shadowRoot.getElementById('fHops');
    if (hops) {
      hops.addEventListener('change', () => {
        this._showHops = hops.checked;
        this._applyHopsVisibility();
      });
    }
    const allOn = this.shadowRoot.getElementById('allOn');
    if (allOn) {
      allOn.addEventListener('click', () => {
        this._hidden.clear();
        this._saveHidden();
        this._trailsAt = 0;
        this._update();
      });
    }
    const allOff = this.shadowRoot.getElementById('allOff');
    if (allOff) {
      allOff.addEventListener('click', () => {
        for (const entry of this._allFull || []) this._hidden.add(entry.id);
        this._saveHidden();
        this._trailsAt = 0;
        this._update();
      });
    }
    const list = this.shadowRoot.getElementById('list');
    if (list) {
      list.addEventListener('change', (event) => {
        const input = event.target;
        if (!input || input.type !== 'checkbox' || !input.dataset.id) return;
        if (input.checked) this._hidden.delete(input.dataset.id);
        else this._hidden.add(input.dataset.id);
        this._saveHidden();
        this._trailsAt = 0;
        this._update();
      });
      list.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-group]');
        if (!button) return;
        event.preventDefault();
        const group = button.dataset.group;
        const mode = button.dataset.mode;
        for (const entry of this._allFull || []) {
          if (entry.group !== group) continue;
          if (mode === 'on') this._hidden.delete(entry.id);
          else this._hidden.add(entry.id);
        }
        this._saveHidden();
        this._trailsAt = 0;
        this._update();
      });
    }
  }

  _addLayers() {
    if (!this._map.getSource('trails')) {
      this._map.addSource('trails', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
    if (!this._map.getSource('trackpoints')) {
      this._map.addSource('trackpoints', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
    if (!this._map.getLayer('trackpoints')) {
      this._map.addLayer({
        id: 'trackpoints',
        type: 'circle',
        source: 'trackpoints',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 1.2, 13, 2, 16, 3.5],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.9,
        },
      });
    }
    if (!this._map.getSource('links')) {
      this._map.addSource('links', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
    if (!this._map.getLayer('links-casing')) {
      this._map.addLayer({
        id: 'links-casing',
        type: 'line',
        source: 'links',
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': '#ffffff',
          'line-width': 5,
          'line-opacity': 0.7,
        },
      });
    }
    if (!this._map.getLayer('links')) {
      this._map.addLayer({
        id: 'links',
        type: 'line',
        source: 'links',
        filter: ['==', ['get', 'kind'], 'neighbor'],
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          // green: healthy link, amber: weak, red: very weak / negative SNR
          'line-color': [
            'case',
            ['>=', ['to-number', ['get', 'snr'], 0], 0], '#16a34a',
            ['>=', ['to-number', ['get', 'snr'], 0], -6], '#f59e0b',
            '#dc2626',
          ],
          'line-width': 2.5,
          'line-opacity': 0.95,
        },
      });
    }
    if (!this._map.getLayer('links-trace')) {
      this._map.addLayer({
        id: 'links-trace',
        type: 'line',
        source: 'links',
        filter: ['==', ['get', 'kind'], 'traceroute'],
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': '#7c3aed',
          'line-width': 2,
          'line-dasharray': [3, 2],
          'line-opacity': 0.95,
        },
      });
    }
    this._applyHopsVisibility();
    if (!this._map.getSource('devices')) {
      this._map.addSource('devices', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
    if (!this._map.getLayer('devices-icons')) {
      this._map.addLayer({
        id: 'devices-icons',
        type: 'symbol',
        source: 'devices',
        layout: {
          'icon-image': ['get', 'icon'],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.55, 14, 0.95],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'text-field': ['get', 'glyph'],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 9, 8, 14, 12],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'text-anchor': 'center',
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': 'rgba(0,0,0,0.45)',
          'text-halo-width': 1,
        },
      });
    }
    if (!this._map.getLayer('devices-selected')) {
      this._map.addLayer({
        id: 'devices-selected',
        type: 'symbol',
        source: 'devices',
        filter: ['==', ['get', 'id'], ''],
        layout: {
          'icon-image': ['get', 'iconSelected'],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.7, 14, 1.15],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      });
    }
  }

  _markerImage(shape, color, glyph, selected) {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const c = size / 2;
    const r = size * 0.4;
    ctx.clearRect(0, 0, size, size);
    ctx.beginPath();
    if (shape === 'square') {
      const s = r * 0.95;
      ctx.rect(c - s, c - s, s * 2, s * 2);
    } else if (shape === 'triangle') {
      ctx.moveTo(c, c - r);
      ctx.lineTo(c + r * 0.95, c + r * 0.75);
      ctx.lineTo(c - r * 0.95, c + r * 0.75);
      ctx.closePath();
    } else if (shape === 'diamond') {
      ctx.moveTo(c, c - r);
      ctx.lineTo(c + r, c);
      ctx.lineTo(c, c + r);
      ctx.lineTo(c - r, c);
      ctx.closePath();
    } else if (shape === 'star') {
      for (let i = 0; i < 10; i += 1) {
        const radius = i % 2 === 0 ? r : r * 0.45;
        const angle = (Math.PI / 5) * i - Math.PI / 2;
        const x = c + radius * Math.cos(angle);
        const y = c + radius * Math.sin(angle);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    } else if (shape === 'hexagon') {
      for (let i = 0; i < 6; i += 1) {
        const angle = (Math.PI / 3) * i - Math.PI / 2;
        const x = c + r * Math.cos(angle);
        const y = c + r * Math.sin(angle);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    } else if (shape === 'pin') {
      ctx.arc(c, c - r * 0.25, r * 0.72, Math.PI, 0);
      ctx.lineTo(c, c + r);
      ctx.closePath();
    } else {
      ctx.arc(c, c, r, 0, Math.PI * 2);
    }
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = selected ? 7 : 4;
    ctx.strokeStyle = selected ? '#facc15' : '#111111';
    ctx.stroke();
    return ctx.getImageData(0, 0, size, size);
  }

  _syncMarkerImages(entries) {
    const missing = [];
    for (const entry of entries) {
      for (const selected of [false, true]) {
        const shape = shapeFor(entry, this.config);
        const color = colorFor(entry.id);
        const glyph = glyphFor(entry, this.config.glyphs);
        const imageId = `mk:${shape}:${color}:${glyph}:${selected ? 1 : 0}`;
        entry[selected ? 'iconSelected' : 'icon'] = imageId;
        if (!this._map.hasImage(imageId)) {
          this._map.addImage(
            imageId,
            this._markerImage(shape, color, glyph, selected),
            { pixelRatio: 2 },
          );
        }
        if (!this._map.hasImage(imageId)) missing.push(imageId);
      }
    }
    return missing;
  }

  _renderTrailLayers(features) {
    for (const layerId of this._trailLayers) {
      if (this._map.getLayer(layerId)) this._map.removeLayer(layerId);
    }
    this._trailLayers = [];

    // Mask under the coloured line: a dark outer casing plus a white inner one,
    // so a track stays readable over buildings, roads and landuse alike. The
    // casings are source-wide (added first), the per-device colours go on top.
    if (features.length) {
      const casings = [
        { id: 'trail-casing-dark', color: '#0b1220', width: 9, opacity: 0.45 },
        { id: 'trail-casing-light', color: '#ffffff', width: 6, opacity: 0.9 },
      ];
      for (const casing of casings) {
        try {
          this._map.addLayer({
            id: casing.id,
            type: 'line',
            source: 'trails',
            layout: {
              'line-cap': 'round',
              'line-join': 'round',
            },
            paint: {
              'line-color': casing.color,
              'line-width': casing.width,
              'line-opacity': casing.opacity,
            },
          });
          this._trailLayers.push(casing.id);
        } catch (error) {
          console.warn('mesh-map: trail casing failed', error);
        }
      }
    }

    features.forEach((feature, index) => {
      const layerId = `trail-line-${index}`;
      try {
        this._map.addLayer({
          id: layerId,
          type: 'line',
          source: 'trails',
          filter: ['==', ['get', 'id'], feature.properties.id],
          layout: {
            'line-cap': 'round',
            'line-join': 'round',
          },
          paint: {
            'line-color': feature.properties.color,
            'line-width': 3.2,
            'line-opacity': 1,
          },
        });
        this._trailLayers.push(layerId);
      } catch (error) {
        console.warn('mesh-map: trail layer failed', error);
      }
    });
    // Pins must stay above tracks.
    if (this._map.getLayer('devices-icons')) this._map.moveLayer('devices-icons');
    if (this._map.getLayer('devices-selected')) this._map.moveLayer('devices-selected');
  }

  _collect() {
    const out = [];
    for (const state of Object.values(this._hass.states)) {
      const id = state.entity_id;
      if (!id.startsWith('device_tracker.') && !id.startsWith('person.')) continue;
      const lat = state.attributes?.latitude;
      const lon = state.attributes?.longitude;
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
      const network = state.attributes?.mesh_network;
      const group = network
        ? String(network)
        : id.startsWith('person.')
          ? 'People'
          : 'Phones';
      out.push({
        id,
        name: state.attributes?.friendly_name || id,
        nodeId: state.attributes?.node_id || null,
        lat,
        lon,
        state: state.state,
        group,
        mesh: Boolean(network),
        last: state.last_updated,
      });
    }
    const groupRank = (group) => {
      const rank = ['Phones', 'People'].indexOf(group);
      return rank === -1 ? 10 : rank;
    };
    let filtered = out;
    const allowed = this.config.entities;
    if (Array.isArray(allowed) && allowed.length > 0) {
      const set = new Set(allowed);
      filtered = filtered.filter((entry) => set.has(entry.id));
    }
    const groups = this.config.groups;
    if (Array.isArray(groups) && groups.length > 0) {
      const set = new Set(groups);
      filtered = filtered.filter((entry) => set.has(entry.group));
    }
    filtered.sort((a, b) => {
      const byGroup = groupRank(a.group) - groupRank(b.group) || a.group.localeCompare(b.group);
      return byGroup !== 0 ? byGroup : a.name.localeCompare(b.name);
    });
    return filtered;
  }

  _applyInitialView() {
    if (this._viewApplied || !this._map) return;
    const container = this.shadowRoot.getElementById('map');
    if (!container || container.clientWidth === 0 || container.clientHeight === 0) {
      return; // wait until the card actually has a size (sections/grid layout)
    }
    const config = this.config;
    // Remembered position/zoom always wins over the configured view, so a
    // reload puts the map back exactly where the user left it.
    const saved = this._loadView();
    if (saved) {
      this._map.jumpTo({ center: [saved.lng, saved.lat], zoom: saved.zoom });
      this._viewApplied = true;
      setTimeout(() => {
        if (this._map) this._map.resize();
      }, 300);
      return;
    }
    // Config uses HA/zone style [lat, lon]; MapLibre wants [lng, lat].
    const toLngLat = (pair) => {
      const first = Number(pair?.[0]);
      const second = Number(pair?.[1]);
      if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
      return Math.abs(first) <= 85 ? [second, first] : [first, second];
    };
    // The local PMTiles extract only goes to z15; fitting beyond that would
    // paint only the style background (gray).
    const fit = (bounds) => {
      this._map.fitBounds(bounds, { padding: 30, duration: 0, maxZoom: 15 });
      setTimeout(() => {
        if (this._map) this._map.resize();
      }, 300);
    };

    if (Array.isArray(config.bounds) && config.bounds.length === 2) {
      const a = toLngLat(config.bounds[0]);
      const b = toLngLat(config.bounds[1]);
      if (a && b) {
        fit([
          [Math.min(a[0], b[0]), Math.min(a[1], b[1])],
          [Math.max(a[0], b[0]), Math.max(a[1], b[1])],
        ]);
        this._viewApplied = true;
        return;
      }
    }

    if (config.zone) {
      const zone = this._hass.states[config.zone];
      if (zone) {
        const latitude = zone.attributes?.latitude;
        const longitude = zone.attributes?.longitude;
        const radius = Number(zone.attributes?.radius) || 100;
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          const dLat = radius / 111320;
          const dLon = radius / (111320 * Math.cos((latitude * Math.PI) / 180));
          fit([
            [longitude - dLon, latitude - dLat],
            [longitude + dLon, latitude + dLat],
          ]);
          this._viewApplied = true;
          return;
        }
      }
    }

    if (Array.isArray(config.center) && config.center.length === 2) {
      const c = toLngLat(config.center);
      if (c) {
        this._map.setCenter(c);
        this._map.setZoom(Math.min(Number(config.zoom) || 12, 15));
        this._viewApplied = true;
        return;
      }
    }

    if (Number.isFinite(Number(config.zoom))) {
      this._map.setZoom(Math.min(Number(config.zoom), 15));
      this._viewApplied = true;
    }
  }

  _renderList(all) {
    const query = this._q.trim().toLowerCase();
    const hiddenSig = Array.from(this._hidden).sort().join(',');
    const signature = all.map((e) => e.id).join('|') + '#' + query + '#' + hiddenSig;
    if (signature === this._listSig) return;
    this._listSig = signature;

    const list = this.shadowRoot.getElementById('list');
    if (!list) return;
    const visible = all.filter(
      (e) => !query || e.name.toLowerCase().includes(query) || e.id.toLowerCase().includes(query),
    );
    const groupRank = (group) => {
      const rank = ['Phones', 'People'].indexOf(group);
      return rank === -1 ? 10 : rank;
    };
    const titles = [...new Set(visible.map((e) => e.group))].sort(
      (a, b) => groupRank(a) - groupRank(b) || a.localeCompare(b),
    );
    let html = '';
    for (const title of titles) {
      const items = visible.filter((e) => e.group === title);
      if (!items.length) continue;
      html += `<div class="group"><span>${escapeHtml(title)} (${items.length})</span><span>` +
        `<button data-group="${escapeHtml(title)}" data-mode="on">all</button>` +
        `<button data-group="${escapeHtml(title)}" data-mode="off">none</button></span></div>`;
      for (const entry of items) {
        const checked = this._hidden.has(entry.id) ? '' : 'checked';
        html += `<label class="item"><input type="checkbox" data-id="${escapeHtml(entry.id)}" ${checked}>` +
          `<span class="sw" style="background:${colorFor(entry.id)}">${escapeHtml(glyphFor(entry, this.config.glyphs))}</span>` +
          `<span class="name">${escapeHtml(entry.name)}</span></label>`;
      }
    }
    const panel = this.shadowRoot.querySelector('.panel');
    const scrollTop = panel ? panel.scrollTop : 0;
    list.innerHTML = html || '<div class="muted">no matches</div>';
    if (panel) panel.scrollTop = scrollTop;
  }

  _update() {
    if (!this._map) return;
    this._applyInitialView();
    const all = this._collect();
    this._allFull = all;
    this._renderList(all);

    const query = this._q.trim().toLowerCase();
    const entries = all.filter((entry) => {
      if (this._hidden.has(entry.id)) return false;
      if (!query) return true;
      return entry.name.toLowerCase().includes(query) || entry.id.toLowerCase().includes(query);
    });
    this._entries = entries;
    this._syncMarkerImages(entries);

    const source = this._map.getSource('devices');
    if (source) {
      source.setData({
        type: 'FeatureCollection',
        features: entries.map((entry) => ({
          type: 'Feature',
          properties: {
            id: entry.id,
            name: entry.name,
            state: entry.state,
            kind: entry.group,
            color: colorFor(entry.id),
            glyph: glyphFor(entry, this.config.glyphs),
            icon: entry.icon,
            iconSelected: entry.iconSelected,
            last: Date.parse(entry.last) || Date.now(),
          },
          geometry: { type: 'Point', coordinates: [entry.lon, entry.lat] },
        })),
      });
    }

    if (this._selected && !entries.some((e) => e.id === this._selected.id)) this._select(null);

    // Hop links (neighbour + traceroute edges) between the pins.
    this._syncLinks();
    this._syncSize();

    const counts = this.shadowRoot.getElementById('counts');
    this._syncCounts();

    const now = Date.now();
    // Only require the trails source. isStyleLoaded() can stay false with the
    // PMTiles vector source, which previously blocked track loading entirely.
    const trailsSource = this._map.getSource('trails');
    if (!trailsSource) {
      this._setTracksLoading(false);
      return;
    }

    if (entries.length === 0) {
      this._live.clear();
      this._trailSig = '';
      this._drawTrails();
      this._tracks = 0;
      this._setTracksLoading(false);
      this._syncCounts();
      return;
    }

    // Extend the trail with the current position right away, so a moving node
    // draws in real time; the history fetch below backfills the past.
    const moved = this._appendLive(entries);
    if (moved || !this._trailSig) this._drawTrails();

    if (now - this._trailsAt > 5 * 60 * 1000) {
      this._trailsAt = now;
      this._loadTrails(entries);
    }
  }

  /** Append the current position of every shown node to its live trail. */
  _appendLive(entries) {
    const live = this._live;
    const keep = new Set(entries.map((entry) => entry.id));
    let changed = false;

    for (const id of Array.from(live.keys())) {
      if (!keep.has(id)) {
        live.delete(id);
        changed = true;
      }
    }

    for (const entry of entries) {
      const color = colorFor(entry.id);
      const record = live.get(entry.id);
      if (!record) {
        live.set(entry.id, { coords: [[entry.lon, entry.lat]], color, kind: entry.group });
        changed = true;
        continue;
      }
      record.color = color;
      const coords = record.coords;
      const last = coords[coords.length - 1];
      if (last && last[0] === entry.lon && last[1] === entry.lat) continue;
      if (last && metersBetween(last, [entry.lon, entry.lat]) > LIVE_JUMP_METERS) {
        // GPS glitch or a tracker that reappeared far away: start a new line
        // instead of drawing a straight jump across the map.
        coords.length = 0;
      }
      coords.push([entry.lon, entry.lat]);
      if (coords.length > LIVE_MAX_POINTS) {
        coords.splice(0, coords.length - LIVE_MAX_POINTS);
      }
      changed = true;
    }
    return changed;
  }

  /** Render the live trails into the map sources and layers. */
  _drawTrails() {
    if (!this._map) return;
    const trailSource = this._map.getSource('trails');
    if (!trailSource) return;

    const features = [];
    for (const [id, record] of this._live) {
      if (!record || record.coords.length < 2) continue;
      features.push({
        type: 'Feature',
        properties: { id, kind: record.kind, color: record.color },
        geometry: { type: 'LineString', coordinates: record.coords },
      });
    }
    trailSource.setData({ type: 'FeatureCollection', features });

    const signature = features.map((feature) => feature.properties.id).join(',');
    if (signature !== this._trailSig) {
      this._renderTrailLayers(features);
      this._trailSig = signature;
    }

    const trackSource = this._map.getSource('trackpoints');
    if (trackSource) {
      const points = this._buildTrackPoints(features);
      trackSource.setData({ type: 'FeatureCollection', features: points });
      this._trackDots = points.length;
    }

    this._tracks = features.length;
    this._syncCounts();
    this._setStatus(`${this._mode} · tracks ${features.length} · ${this._trackDots} dots`);
  }

  /** Dotted trail per device, budget shared proportionally between devices. */
  _buildTrackPoints(features) {
    const points = [];
    const makePoint = (coordinates, color) => ({
      type: 'Feature',
      properties: { color },
      geometry: { type: 'Point', coordinates },
    });
    const dense = [];
    for (const feature of features) {
      const coords = feature.geometry.coordinates;
      const color = feature.properties.color;
      const trail = [];
      let previous = null;
      for (const coord of coords) {
        if (previous) {
          // Stationary nodes repeat the same position; do not spend the
          // whole budget on identical dots.
          if (previous[0] === coord[0] && previous[1] === coord[1]) continue;
          const distance = metersBetween(previous, coord);
          const steps = Math.min(500, Math.max(1, Math.ceil(distance / TRACK_STEP_METERS)));
          for (let step = 1; step < steps; step += 1) {
            const t = step / steps;
            trail.push([
              previous[0] + (coord[0] - previous[0]) * t,
              previous[1] + (coord[1] - previous[1]) * t,
            ]);
          }
        }
        trail.push(coord);
        previous = coord;
        if (trail.length >= TRACK_DEVICE_POINTS) break;
      }
      if (trail.length) dense.push({ color, trail });
    }
    const denseTotal = dense.reduce((sum, item) => sum + item.trail.length, 0);
    const scale = denseTotal > TRACK_MAX_POINTS ? TRACK_MAX_POINTS / denseTotal : 1;
    for (const { color, trail } of dense) {
      const budget = Math.max(TRACK_MIN_PER_DEVICE, Math.floor(trail.length * scale));
      const stride = Math.max(1, Math.ceil(trail.length / budget));
      for (let index = 0; index < trail.length; index += stride) {
        points.push(makePoint(trail[index], color));
      }
      if ((trail.length - 1) % stride !== 0) {
        points.push(makePoint(trail[trail.length - 1], color));
      }
    }
    return points;
  }

  /** Draw neighbour / traceroute hop lines between the node pins. */
  _syncLinks() {
    if (!this._map) return;
    const source = this._map.getSource('links');
    if (!source) return;
    const coords = new Map();
    for (const entry of this._allFull || []) {
      if (entry.nodeId) coords.set(String(entry.nodeId).toLowerCase(), [entry.lon, entry.lat]);
    }
    const features = [];
    const seen = new Set();
    for (const state of Object.values(this._hass.states)) {
      const links = state.attributes?.links;
      if (!Array.isArray(links)) continue;
      for (const link of links) {
        const from = coords.get(String(link.from || '').toLowerCase());
        const to = coords.get(String(link.to || '').toLowerCase());
        if (!from || !to) continue;
        const kind = link.kind === 'traceroute' ? 'traceroute' : 'neighbor';
        const key = `${kind}:${link.from}:${link.to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const snr = Number(link.snr);
        features.push({
          type: 'Feature',
          properties: { kind, snr: Number.isFinite(snr) ? snr : null },
          geometry: { type: 'LineString', coordinates: [from, to] },
        });
      }
    }
    source.setData({ type: 'FeatureCollection', features });
    this._links = features.length;
  }

  _applyHopsVisibility() {
    if (!this._map) return;
    for (const layerId of ['links-casing', 'links', 'links-trace']) {
      if (this._map.getLayer(layerId)) {
        this._map.setLayoutProperty(layerId, 'visibility', this._showHops ? 'visible' : 'none');
      }
    }
  }

  async _loadTrails(entries) {
    const token = (this._trailToken += 1);
    this._setTracksLoading(true);
    const hours = this._hours || DEFAULT_HISTORY_HOURS;
    const start = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    // HA caps /api/history/period at start + 24 h when end_time is omitted, so
    // a 3 day or 7 day range came back with old data only (or nothing at all).
    // Ask for the end explicitly, with a small margin for clock skew.
    const end = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const ids = entries.map((e) => e.id).join(',');
    try {
      const series = await this._hass.callApi(
        'GET',
        `history/period/${start}?filter_entity_id=${encodeURIComponent(ids)}` +
          `&end_time=${encodeURIComponent(end)}`,
      );
      if (token !== this._trailToken) return;

      // History seeds the live trails: it holds the whole window, and the live
      // appends keep them growing from there in real time.
      const order = new Map(entries.map((entry) => [entry.id, entry]));
      for (const item of series || []) {
        if (!Array.isArray(item) || item.length === 0) continue;
        const entityId = item[0].entity_id;
        const entry = order.get(entityId);
        if (!entry) continue;
        // Consecutive duplicates carry no shape (stationary nodes repeat their
        // position every poll) and would bloat every redraw.
        const coords = [];
        for (const state of item) {
          const lat = state.attributes?.latitude;
          const lon = state.attributes?.longitude;
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
          const previous = coords[coords.length - 1];
          if (previous && previous[0] === lon && previous[1] === lat) continue;
          coords.push([lon, lat]);
        }
        if (!coords.length) continue;
        if (coords.length > LIVE_MAX_POINTS) {
          coords.splice(0, coords.length - LIVE_MAX_POINTS);
        }
        this._live.set(entityId, {
          coords,
          color: colorFor(entityId),
          kind: entry.group,
        });
      }

      // Rebuild the line layers against the refreshed data.
      this._trailSig = '';
      this._drawTrails();
      this._setTracksLoading(false);
    } catch (error) {
      if (token !== this._trailToken) return;
      console.warn('mesh-map: history failed', error);
      this._setTracksLoading(false);
      this._setStatus('tracks error');
      this._trailsAt = Date.now() - 4 * 60 * 1000;
    }
  }
}

customElements.define('mesh-map-card', MeshMapCard);