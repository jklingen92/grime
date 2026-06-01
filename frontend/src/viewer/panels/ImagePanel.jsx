// Image adjustment controls. Live updates patch state.image.current; the
// SVG filter and image src/transform respond automatically.

import { useViewerConfig, useViewerDispatch, useViewerState } from '../state/ViewerContext.jsx';
import { autoContrastImage } from '../api/endpoints.js';
import { formatSliderVal } from '../state/imageParams.js';

export default function ImagePanel() {
  const config = useViewerConfig();
  const state = useViewerState();
  const dispatch = useViewerDispatch();

  const sliders = state.image.current;

  function patchSlider(key, value) {
    dispatch({ type: 'IMAGE_PATCH_CURRENT', patch: { [key]: value } });
  }

  function toggleBool(key) {
    dispatch({ type: 'IMAGE_PATCH_CURRENT', patch: { [key]: !sliders[key] } });
  }

  async function onAutoContrast() {
    if (!config.imageAutocontrastUrl) return;
    try {
      const data = await autoContrastImage(config);
      if (!data.ok) {
        alert(data.error || 'Auto contrast failed.');
        return;
      }
      dispatch({
        type: 'IMAGE_PATCH_CURRENT',
        patch: { black: data.black, white: data.white },
      });
    } catch (err) {
      alert('Auto contrast failed: ' + (err?.message || err));
    }
  }

  function onReset() {
    dispatch({ type: 'IMAGE_RESET_LOCAL' });
  }

  return (
    <div id="dp-image-panel" className="visible">
      <h3>Image adjustments</h3>
      <div id="dp-image-instructions">
        <span>
          Drag sliders for a live preview. Click <em>Save adjusted image</em> in the toolbar to persist.
        </span>
      </div>

      {['brightness', 'contrast', 'gamma'].map((key) => {
        const ranges = {
          brightness: { min: -100, max: 100 },
          contrast: { min: 0, max: 200 },
          gamma: { min: 10, max: 300 },
        };
        return (
          <div className="dp-image-slider-row" key={key}>
            <label htmlFor={'dp-image-' + key} style={{ textTransform: 'capitalize' }}>
              {key}
            </label>
            <input
              id={'dp-image-' + key}
              type="range"
              className="form-range"
              min={ranges[key].min}
              max={ranges[key].max}
              step="1"
              value={sliders[key]}
              onChange={(e) => patchSlider(key, parseInt(e.target.value, 10))}
            />
            <span className="dp-image-val">{formatSliderVal(key, sliders[key])}</span>
          </div>
        );
      })}

      <div className="dp-image-section-title">Levels</div>
      <div className="dp-image-slider-row">
        <label htmlFor="dp-image-black">Black</label>
        <input
          id="dp-image-black"
          type="range"
          className="form-range"
          min="0"
          max="254"
          step="1"
          value={sliders.black}
          onChange={(e) => patchSlider('black', parseInt(e.target.value, 10))}
        />
        <span className="dp-image-val">{sliders.black}</span>
      </div>
      <div className="dp-image-slider-row">
        <label htmlFor="dp-image-white">White</label>
        <input
          id="dp-image-white"
          type="range"
          className="form-range"
          min="1"
          max="255"
          step="1"
          value={sliders.white}
          onChange={(e) => patchSlider('white', parseInt(e.target.value, 10))}
        />
        <span className="dp-image-val">{sliders.white}</span>
      </div>

      <div className="dp-image-section-title">Tools</div>
      <div className="dp-image-btn-group">
        <button
          id="dp-image-autocontrast-btn"
          type="button"
          className="btn btn-sm btn-outline-secondary"
          title="Set black/white levels to 1% histogram cutoffs"
          onClick={onAutoContrast}
        >
          <i className="fa-solid fa-wand-magic-sparkles me-1" />
          Auto contrast
        </button>
        <button
          id="dp-image-grayscale-btn"
          type="button"
          className={'btn btn-sm btn-outline-secondary' + (sliders.grayscale ? ' active' : '')}
          title="Desaturate to greyscale"
          onClick={() => toggleBool('grayscale')}
        >
          <i className="fa-solid fa-circle-half-stroke me-1" />
          Grayscale
        </button>
        <button
          id="dp-image-invert-btn"
          type="button"
          className={'btn btn-sm btn-outline-secondary' + (sliders.invert ? ' active' : '')}
          title="Invert colours (negative)"
          onClick={() => toggleBool('invert')}
        >
          <i className="fa-solid fa-adjust me-1" />
          Invert
        </button>
        <button
          id="dp-image-sharpen-btn"
          type="button"
          className={'btn btn-sm btn-outline-secondary' + (sliders.sharpen ? ' active' : '')}
          title="Unsharp mask — applied on save, no live preview"
          onClick={() => toggleBool('sharpen')}
        >
          <i className="fa-solid fa-braille me-1" />
          Sharpen
        </button>
      </div>
      {sliders.sharpen && (
        <small id="dp-image-sharpen-note" className="dp-image-sharpen-note">
          Sharpening is applied on save (no live preview)
        </small>
      )}

      <div className="dp-image-section-title">Threshold / Binarize</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.82em' }}>
        <input
          id="dp-image-threshold-enable"
          type="checkbox"
          className="form-check-input"
          checked={sliders.threshold !== null}
          onChange={(e) =>
            patchSlider('threshold', e.target.checked ? 128 : null)
          }
        />
        <label htmlFor="dp-image-threshold-enable" style={{ color: '#444', cursor: 'pointer' }}>
          Enable
        </label>
      </div>
      <div className="dp-image-slider-row">
        <label htmlFor="dp-image-threshold">Level</label>
        <input
          id="dp-image-threshold"
          type="range"
          className="form-range"
          min="0"
          max="255"
          step="1"
          value={sliders.threshold !== null ? sliders.threshold : 128}
          disabled={sliders.threshold === null}
          onChange={(e) => patchSlider('threshold', parseInt(e.target.value, 10))}
        />
        <span className="dp-image-val">
          {sliders.threshold !== null ? String(sliders.threshold) : '—'}
        </span>
      </div>

      <div className="dp-image-section-title">Rotate / Deskew</div>
      <div className="dp-image-btn-group">
        <button
          id="dp-image-rotate-ccw-btn"
          type="button"
          className="btn btn-sm btn-outline-secondary"
          title="Rotate 90° counter-clockwise"
          onClick={() => patchSlider('rotate90', (sliders.rotate90 + 3) % 4)}
        >
          <i className="fa-solid fa-rotate-left me-1" />
          90°
        </button>
        <button
          id="dp-image-rotate-cw-btn"
          type="button"
          className="btn btn-sm btn-outline-secondary"
          title="Rotate 90° clockwise"
          onClick={() => patchSlider('rotate90', (sliders.rotate90 + 1) % 4)}
        >
          <i className="fa-solid fa-rotate-right me-1" />
          90°
        </button>
      </div>
      <div className="dp-image-slider-row">
        <label htmlFor="dp-image-rotate-fine">Fine</label>
        <input
          id="dp-image-rotate-fine"
          type="range"
          className="form-range"
          min="-5"
          max="5"
          step="0.1"
          value={sliders.rotateFine}
          onChange={(e) => patchSlider('rotateFine', parseFloat(e.target.value))}
        />
        <span className="dp-image-val">
          {(sliders.rotateFine > 0 ? '+' : '') + sliders.rotateFine.toFixed(1) + '°'}
        </span>
      </div>

      <div id="dp-image-actions">
        <button
          id="dp-image-reset-btn"
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={onReset}
        >
          <i className="fa-solid fa-arrow-rotate-left me-1" />
          Reset
        </button>
      </div>
    </div>
  );
}
