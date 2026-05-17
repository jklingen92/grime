# Maintenance Guide

## Releasing to PyPI

### Prerequisites

1. **PyPI Account**: Create an account at https://pypi.org/
2. **TestPyPI Account** (optional but recommended): https://test.pypi.org/
3. **Install build tools**:
   ```bash
   uv tool install build twine
   ```
4. **Configure authentication**: Create a PyPI API token and store it in `~/.pypirc`:
   ```ini
   [distutils]
   index-servers =
       pypi
       testpypi

   [pypi]
   repository = https://upload.pypi.org/legacy/
   username = __token__
   password = pypi-... # Your PyPI API token

   [testpypi]
   repository = https://test.pypi.org/legacy/
   username = __token__
   password = pypi-... # Your TestPyPI API token
   ```

### Release Checklist

1. **Update version** in `pyproject.toml`:
   ```toml
   [project]
   version = "X.Y.Z"  # Follow semantic versioning
   ```

2. **Update CHANGELOG** (if you have one):
   - Document changes in the new version
   - Create a dated entry for the release

3. **Test locally**:
   ```bash
   uv sync --extra dev
   # Run any test suites
   ```

4. **Commit and tag**:
   ```bash
   git add pyproject.toml CHANGELOG.md  # if applicable
   git commit -m "Release version X.Y.Z"
   git tag -a vX.Y.Z -m "Release X.Y.Z"
   ```

5. **Build distributions**:
   ```bash
   uvx --from build pyproject-build
   # This creates dist/grime-X.Y.Z-py3-none-any.whl and dist/grime-X.Y.Z.tar.gz
   ```

6. **Test on TestPyPI** (recommended for first releases):
   ```bash
   uvx twine upload --repository testpypi dist/*
   ```

7. **Install from TestPyPI to verify**:
   ```bash
   uv pip install --index-url https://test.pypi.org/simple/ --extra-index-url https://pypi.org/simple/ grime==X.Y.Z
   ```

8. **Upload to PyPI**:
   ```bash
   uvx twine upload dist/*
   ```

9. **Push to GitHub**:
   ```bash
   git push origin main
   git push origin vX.Y.Z
   ```

10. **Verify release**:
    - Visit https://pypi.org/project/grime/
    - Check that the new version is listed
    - Verify package metadata and description render correctly

### Clean up build artifacts (optional):

```bash
rm -rf build dist *.egg-info
```

## Troubleshooting

- **"Invalid distribution" error**: Check that `pyproject.toml` is valid with `python -c "import tomllib; tomllib.load(open('pyproject.toml', 'rb'))"`
- **"File already exists" error**: Version already exists on PyPI. Increment version and rebuild.
- **Missing package files**: Verify `grime` package is discoverable with `python -m build --sdist` and check the generated `*.tar.gz`

## Customizing the Color Palette

The viewer's color scheme is defined as CSS custom properties (variables) at the top of
`grime/static/grime/viewer.css`. You can override any of them in your own project's
stylesheet — just load your stylesheet after grime's.

### Available variables

| Variable | Default | Role |
|---|---|---|
| `--grime-primary` | `#417690` | Header background, section headings, primary action color |
| `--grime-primary-dark` | `#205067` | Hover state for primary elements |
| `--grime-accent` | `#7842dc` | Label/tag region borders and highlights |
| `--grime-accent-light` | `rgba(120, 66, 220, 0.15)` | Tag region fill color |
| `--grime-ocr-highlight` | `#e67e00` | OCR word selection and draw-rect borders |
| `--grime-ner-per` | `rgba(0, 100, 220, 0.2)` | Person entity overlay fill |
| `--grime-ner-loc` | `rgba(30, 160, 60, 0.2)` | Location entity overlay fill |
| `--grime-ner-org` | `rgba(200, 100, 0, 0.2)` | Organization entity overlay fill |

`document_list.html` also exposes `--grime-primary` and `--grime-primary-dark` in its own
`<style>` block. These control the page header background, the table header row, and the
submit button. Because that page is a standalone Django template, the simplest way to
override it is to extend or replace the template rather than loading an extra stylesheet.

### Example override

Create a CSS file in your project (e.g. `myapp/static/myapp/grime-theme.css`) and load it
after Django's `{% load static %}` call in any template that includes the viewer partial:

```css
:root {
  --grime-primary:      #2c6e49;   /* forest green */
  --grime-primary-dark: #1a4731;
  --grime-accent:       #e63946;   /* red labels */
  --grime-accent-light: rgba(230, 57, 70, 0.15);
  --grime-ocr-highlight: #f4a261;  /* warm orange selection */
}
```

No JavaScript changes are needed — the overlay and highlight colors all reference these
variables at paint time.

### NER entity colors

The NER overlay tints (`--grime-ner-per`, `--grime-ner-loc`, `--grime-ner-org`) are used
for both the image overlay boxes and the legend swatches in the side panel. If you change
them, update the corresponding swatch rules in `viewer.css` as well:

```css
.dp-ner-swatch.ner-PER { background: var(--grime-ner-per); }
.dp-ner-swatch.ner-LOC { background: var(--grime-ner-loc); }
.dp-ner-swatch.ner-ORG { background: var(--grime-ner-org); }
```

### Bootstrap theme integration

The viewer and document list pages load Bootstrap 5 from a CDN. Bootstrap's own color
system is based on `--bs-primary-rgb` and related variables. The viewer sets
`--bs-primary-rgb: 65, 118, 144` (matching `--grime-primary`) so that Bootstrap components
such as range-slider thumbs, focus rings, and primary buttons inherit the project's brand
color automatically. Override `--bs-primary-rgb` alongside `--grime-primary` to keep them
in sync:

```css
:root {
  --grime-primary:  #2c6e49;
  --bs-primary-rgb: 44, 110, 73;   /* same color in r, g, b form */
}
```

## References

- [Python Packaging Guide](https://packaging.python.org/)
- [Twine Documentation](https://twine.readthedocs.io/)
- [PyPI Help](https://pypi.org/help/)
