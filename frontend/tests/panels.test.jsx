import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ViewerProvider, useViewerState } from '../src/viewer/state/ViewerContext.jsx';
import ImagePanel from '../src/viewer/panels/ImagePanel.jsx';
import NerPanel from '../src/viewer/panels/NerPanel.jsx';
import { SAMPLE_WORDS } from './helpers.js';

vi.mock('../src/viewer/api/endpoints.js', () => ({
  autoContrastImage: vi.fn(),
}));
import { autoContrastImage } from '../src/viewer/api/endpoints.js';

// Surfaces reducer state so tests can assert on it without reaching into internals.
function StateProbe() {
  const s = useViewerState();
  return <pre data-testid="state">{JSON.stringify({ image: s.image.current, hl: s.nerHighlightKey })}</pre>;
}

const renderWith = (ui, config = {}) =>
  render(
    <ViewerProvider config={{ ocrWords: SAMPLE_WORDS, ...config }}>
      {ui}
      <StateProbe />
    </ViewerProvider>,
  );

const probe = () => JSON.parse(screen.getByTestId('state').textContent);

beforeEach(() => vi.clearAllMocks());

describe('ImagePanel', () => {
  it('slider changes update state and the readout', () => {
    renderWith(<ImagePanel />);
    fireEvent.change(document.getElementById('dp-image-brightness'), { target: { value: '30' } });
    expect(probe().image.brightness).toBe(30);
    expect(screen.getByText('+30')).toBeInTheDocument();
  });

  it('toggle buttons flip booleans; sharpen shows its note', () => {
    renderWith(<ImagePanel />);
    fireEvent.click(screen.getByText('Grayscale'));
    expect(probe().image.grayscale).toBe(true);
    expect(screen.queryByText(/Sharpening is applied on save/)).toBeNull();
    fireEvent.click(screen.getByText('Sharpen'));
    expect(screen.getByText(/Sharpening is applied on save/)).toBeInTheDocument();
  });

  it('threshold checkbox enables the level slider at 128', () => {
    renderWith(<ImagePanel />);
    const slider = document.getElementById('dp-image-threshold');
    expect(slider).toBeDisabled();
    fireEvent.click(document.getElementById('dp-image-threshold-enable'));
    expect(slider).toBeEnabled();
    expect(probe().image.threshold).toBe(128);
  });

  it('rotate buttons wrap modulo 4', () => {
    renderWith(<ImagePanel />);
    fireEvent.click(document.getElementById('dp-image-rotate-ccw-btn'));
    expect(probe().image.rotate90).toBe(3);
    fireEvent.click(document.getElementById('dp-image-rotate-cw-btn'));
    expect(probe().image.rotate90).toBe(0);
  });

  it('reset restores defaults', () => {
    renderWith(<ImagePanel />);
    fireEvent.click(screen.getByText('Invert'));
    fireEvent.click(document.getElementById('dp-image-reset-btn'));
    expect(probe().image.invert).toBe(false);
  });

  it('auto contrast applies server levels', async () => {
    autoContrastImage.mockResolvedValue({ ok: true, black: 12, white: 240 });
    renderWith(<ImagePanel />, { imageAutocontrastUrl: '/ac/' });
    fireEvent.click(document.getElementById('dp-image-autocontrast-btn'));
    await waitFor(() => expect(probe().image).toMatchObject({ black: 12, white: 240 }));
  });

  it('auto contrast alerts on server error and leaves levels alone', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    autoContrastImage.mockResolvedValue({ ok: false, error: 'no image' });
    renderWith(<ImagePanel />, { imageAutocontrastUrl: '/ac/' });
    fireEvent.click(document.getElementById('dp-image-autocontrast-btn'));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('no image'));
    expect(probe().image.black).toBe(0);
  });
});

describe('NerPanel', () => {
  it('lists grouped entities with counts', () => {
    renderWith(<NerPanel />);
    expect(screen.getByText('John Smith')).toBeInTheDocument();
    expect(screen.getByText('Paris')).toBeInTheDocument();
    expect(screen.getByText('(1)', { selector: '[data-type="PER"] .dp-ner-section-count' })).toBeInTheDocument();
    expect(screen.getByText('No entities.')).toBeInTheDocument(); // ORG
  });

  it('clicking an entity toggles the highlight key', () => {
    renderWith(<NerPanel />);
    fireEvent.click(screen.getByText('Paris'));
    expect(probe().hl).toBe('LOC:paris');
    fireEvent.click(screen.getByText('Paris'));
    expect(probe().hl).toBeNull();
  });

  it('section headers collapse', () => {
    renderWith(<NerPanel />);
    fireEvent.click(document.querySelector('[data-type="PER"] .dp-ner-section-header'));
    expect(document.querySelector('[data-type="PER"]')).toHaveClass('collapsed');
  });
});
