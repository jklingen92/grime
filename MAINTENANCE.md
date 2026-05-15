# Maintenance Guide

## Releasing to PyPI

### Prerequisites

1. **PyPI Account**: Create an account at https://pypi.org/
2. **TestPyPI Account** (optional but recommended): https://test.pypi.org/
3. **Install build tools**:
   ```bash
   pip install build twine
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
   pip install -e ".[dev]"
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
   python -m build
   # This creates dist/grime-X.Y.Z-py3-none-any.whl and dist/grime-X.Y.Z.tar.gz
   ```

6. **Test on TestPyPI** (recommended for first releases):
   ```bash
   python -m twine upload --repository testpypi dist/*
   ```

7. **Install from TestPyPI to verify**:
   ```bash
   pip install --index-url https://test.pypi.org/simple/ --extra-index-url https://pypi.org/simple/ grime==X.Y.Z
   ```

8. **Upload to PyPI**:
   ```bash
   python -m twine upload dist/*
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

## References

- [Python Packaging Guide](https://packaging.python.org/)
- [Twine Documentation](https://twine.readthedocs.io/)
- [PyPI Help](https://pypi.org/help/)
